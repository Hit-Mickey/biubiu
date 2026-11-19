import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { lyricTimestamp, maxLyricLength } from "@shared/lyrics";

const audioExtension = /\.(mp3|flac|wav|m4a|aac|ogg|wma|aiff)$/i;

async function sidecar(file: string, root: string) {
  const actual = await realpath(file);
  if (path.relative(root, path.dirname(actual)) || !/\.(spl|lrc)$/i.test(actual)) return;
  const info = await stat(actual);
  if (!info.isFile() || !info.size || info.size > maxLyricLength) return;
  const handle = await open(actual, "r");
  try {
    // Bound the actual read, even if the file grows after stat().
    const bytes = Buffer.alloc(info.size);
    let pos = 0;
    while (pos < bytes.length) {
      const { bytesRead } = await handle.read(bytes, pos, bytes.length - pos, pos);
      if (!bytesRead) break;
      pos += bytesRead;
    }
    const data = bytes.subarray(0, pos);
    if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder("utf-16le").decode(data).trim();
    if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder("utf-16be").decode(data).trim();
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(data).trim();
    } catch {
      return new TextDecoder("gb18030").decode(data).trim();
    }
  } finally {
    await handle.close();
  }
}

/** Accept only the local library's audio URL, not an arbitrary file to read. */
export async function readLocalLyrics(audioUrl: string, roots: string[]) {
  if (typeof audioUrl !== "string" || !audioUrl.startsWith("file://")) return;
  // New queue entries use escaped file URLs; older queues stored the literal path after file://.
  let legacy = audioUrl.slice(7);
  if (process.platform === "win32" && /^\/[a-z]:\//i.test(legacy)) legacy = legacy.slice(1);
  let decoded: string | undefined;
  try {
    if (!/[?#]/.test(audioUrl)) decoded = fileURLToPath(audioUrl);
  } catch {
    /* An unescaped percent sign in a legacy filename is valid. */
  }
  for (const file of new Set([decoded, legacy])) {
    if (!file || !path.isAbsolute(file) || !audioExtension.test(file)) continue;
    const dir = path.dirname(path.resolve(file));
    if (!roots?.some(root => !path.relative(path.resolve(root), dir))) continue;
    const audio = await realpath(file).catch(() => undefined);
    if (!audio) continue;
    const root = await realpath(dir);
    if (path.relative(root, path.dirname(audio)) || !audioExtension.test(audio) || !(await stat(audio)).isFile())
      continue;
    return lyricsForFile(file, audio, root);
  }
}

async function lyricsForFile(file: string, audio: string, root: string) {
  const stem = file.slice(0, -path.extname(file).length);
  for (const ext of [".spl", ".lrc"]) {
    const text = await sidecar(stem + ext, root).catch(() => undefined);
    if (text) return text;
  }
  // No directory scan and no cover decoding; inspect tags only for this song.
  const { parseFile, TimestampFormat } = await import("music-metadata");
  const metadata = await parseFile(audio, { skipCovers: true, duration: false }).catch(() => undefined);
  for (const lyric of metadata?.common.lyrics ?? []) {
    if (lyric.timeStampFormat === TimestampFormat.milliseconds && lyric.syncText?.length) {
      const lines: string[] = [];
      let length = 0;
      for (const { text, timestamp } of lyric.syncText) {
        if (!text || timestamp === undefined || timestamp < 0) continue;
        const line = lyricTimestamp(timestamp) + text;
        length += line.length + 1;
        if (length > maxLyricLength) break;
        lines.push(line);
      }
      if (lines.length) return lines.join("\n");
    }
    if (lyric.text?.trim()) return lyric.text.slice(0, maxLyricLength).trim();
  }
}
