import type { IAudioMetadata, TimestampFormat } from "music-metadata";

import { AbstractTokenizer, EndOfStreamError, type IRandomAccessFileInfo, type IReadChunkOptions } from "strtok3";

import type { WebDavTrack } from "@shared/webdav";

import {
  audioMimeType,
  readDavBytes,
  requireDavSuccess,
  WebDavHttpError,
  type DavFile,
  type WebDavClient,
} from "./client";

export interface StoredTrack extends WebDavTrack {
  path: string;
  etag?: string;
  metadataParsed?: boolean;
  coverPath?: string;
  folderCoverPath?: string;
  lyricPath?: string;
}

interface AudioTags {
  fields: Pick<WebDavTrack, "title" | "artist" | "album" | "duration" | "year" | "disc" | "track" | "lossless">;
  cover?: { bytes: Uint8Array; mime: string };
  lyrics?: string;
}

const imageTypes = new Map([
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
]);
const rangeWindow = 64 * 1024;
const maxTagBytes = 4 * 1024 * 1024;

export function findSidecars(file: DavFile, files: Map<string, string>) {
  const stem = file.filename.slice(0, file.filename.lastIndexOf("."));
  const findImage = (name: string) => {
    for (const extension of imageTypes.keys()) {
      const path = files.get(`${name}.${extension}`);
      if (path) return path;
    }
  };
  return {
    coverPath: findImage(stem),
    folderCoverPath: findImage("cover") ?? findImage("folder"),
    lyricPath: files.get(`${stem}.lrc`),
  };
}

async function readRange(client: WebDavClient, path: string, start: number, length: number) {
  const response = await client.request(path, { headers: { Range: `bytes=${start}-${start + length - 1}` } });
  await requireDavSuccess(response);
  const range = /^bytes (\d+)-\d+\/(?:\d+|\*)$/i.exec(response.headers.get("content-range") ?? "");
  if (response.status === 206 ? !range || Number(range[1]) !== start : start !== 0) {
    await response.body?.cancel();
    throw new Error("WebDAV 服务器未返回所请求的文件区段");
  }
  return readDavBytes(response, length, true);
}

// The metadata parser can jump over audio data and read tags at either end of the file.
class WebDavTokenizer extends AbstractTokenizer {
  readonly fileInfo: IRandomAccessFileInfo;
  private window = Buffer.alloc(0);
  private windowStart = 0;
  private remaining = maxTagBytes;
  private requests = 0;

  constructor(
    private readonly client: WebDavClient,
    private readonly track: StoredTrack,
    size: number,
  ) {
    super();
    this.fileInfo = { size, mimeType: audioMimeType(track.format), path: track.filename };
  }

  supportsRandomAccess() {
    return true;
  }

  setPosition(position: number) {
    this.position = position;
  }

  async peekBuffer(buffer: Uint8Array, options?: IReadChunkOptions) {
    const { position, length, mayBeLess } = this.normalizeOptions(buffer, options);
    const available = Math.max(0, Math.min(length, this.fileInfo.size - position));
    if (available < length && !mayBeLess) throw new EndOfStreamError();
    if (available === 0) return 0;
    if (position < this.windowStart || position + available > this.windowStart + this.window.length) {
      if (this.requests >= 16 || available > this.remaining) throw new EndOfStreamError();
      const readLength = Math.min(this.remaining, this.fileInfo.size - position, Math.max(available, rangeWindow));
      this.requests++;
      this.window = await readRange(this.client, this.track.path, position, readLength);
      this.windowStart = position;
      this.remaining -= this.window.length;
    }
    const offset = position - this.windowStart;
    const data = this.window.subarray(offset, offset + available);
    if (data.length < length && !mayBeLess) throw new EndOfStreamError();
    buffer.set(data);
    return data.length;
  }

  async readBuffer(buffer: Uint8Array, options?: IReadChunkOptions) {
    const count = await this.peekBuffer(buffer, options);
    this.position = (options?.position ?? this.position) + count;
    return count;
  }
}

function embeddedLyrics(metadata: IAudioMetadata, milliseconds: TimestampFormat) {
  for (const lyric of metadata.common.lyrics ?? []) {
    if (lyric.timeStampFormat === milliseconds && lyric.syncText?.length) {
      const lines = lyric.syncText.flatMap(({ text, timestamp }) => {
        if (timestamp === undefined || timestamp < 0) return [];
        const minutes = String(Math.floor(timestamp / 60_000)).padStart(2, "0");
        const seconds = ((timestamp % 60_000) / 1000).toFixed(3).padStart(6, "0");
        return [`[${minutes}:${seconds}]${text}`];
      });
      if (lines.length) return lines.join("\n");
    }
    if (lyric.text?.trim()) return lyric.text.trim();
  }
  for (const entries of Object.values(metadata.native)) {
    for (const { id, value } of entries) {
      if (/^(USLT|LYRICS|UNSYNCEDLYRICS|©lyr)$/i.test(id)) {
        const text = typeof value === "object" && value && "text" in value ? value.text : value;
        if (typeof text === "string" && text.trim()) return text.trim();
      }
    }
  }
}

export async function readAudioTags(client: WebDavClient, track: StoredTrack): Promise<AudioTags> {
  const { parseBuffer, parseFromTokenizer, selectCover, TimestampFormat } = await import("music-metadata");
  let metadata: IAudioMetadata | undefined;
  let isComplete = Boolean(track.size);
  if (track.size) {
    try {
      metadata = await parseFromTokenizer(new WebDavTokenizer(client, track, track.size));
    } catch (error) {
      if (error instanceof WebDavHttpError) throw error;
    }
  }
  if (!metadata) {
    const bytes = await readRange(client, track.path, 0, Math.min(track.size ?? maxTagBytes, maxTagBytes));
    isComplete = bytes.length === track.size;
    metadata = await parseBuffer(
      bytes,
      { path: track.filename, mimeType: audioMimeType(track.format) },
      { skipPostHeaders: !isComplete },
    ).catch(() => undefined);
  }
  if (!metadata) return { fields: { title: track.title } };

  const { common, format } = metadata;
  const picture = common.picture?.length ? selectCover(common.picture) : null;
  const mime = picture?.format.toLowerCase().replace(/^image\/jpg$/, "image/jpeg");
  const validCover = mime && (mime === "image/gif" || [...imageTypes.values()].includes(mime));
  return {
    fields: {
      title: common.title?.trim() || track.title,
      artist: common.artists?.join(" / ") || common.artist?.trim(),
      album: common.album?.trim(),
      duration: isComplete && Number.isFinite(format.duration) && format.duration! > 0 ? format.duration : undefined,
      year: common.year,
      disc: common.disk.no ?? undefined,
      track: common.track.no ?? undefined,
      lossless: format.lossless,
    },
    cover: picture && validCover ? { bytes: picture.data, mime } : undefined,
    lyrics: embeddedLyrics(metadata, TimestampFormat.milliseconds),
  };
}

export async function readCoverFile(client: WebDavClient, path: string) {
  const mime = imageTypes.get(path.split(".").at(-1) ?? "");
  if (!mime) return;
  const response = await client.request(path);
  await requireDavSuccess(response);
  const bytes = await readDavBytes(response, 8 * 1024 * 1024);
  return bytes.length ? { mime, bytes } : undefined;
}

export async function readLyricFile(client: WebDavClient, path: string) {
  const response = await client.request(path);
  await requireDavSuccess(response);
  const bytes = await readDavBytes(response, 512 * 1024);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes).trim();
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes).trim();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    return new TextDecoder("gb18030").decode(bytes).trim();
  }
}
