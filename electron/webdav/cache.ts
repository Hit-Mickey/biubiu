import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";

import { getUserDataPath } from "../utils";

const transfers = new Map<string, { stop: () => void; done: Promise<void> }>();
let clearing: Promise<void> | undefined;
let cacheGeneration = 0;

function cacheDirectory() {
  return path.join(getUserDataPath(), "webdav-cache");
}

function cacheFile(version: string) {
  return path.join(cacheDirectory(), `${version}.audio`);
}

function parseRange(range: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
  if (!match || (!match[1] && !match[2])) return;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return;
  return { start, end };
}

export async function cachedAudioResponse(version: string, request: Request, headers: Headers) {
  if (clearing) return;
  const file = cacheFile(version);
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile() || info.size === 0) return;
  const range = request.headers.get("range");
  const interval = range ? parseRange(range, info.size) : { start: 0, end: info.size - 1 };
  headers.set("accept-ranges", "bytes");
  if (!interval) {
    headers.set("content-range", `bytes */${info.size}`);
    return new Response(null, { status: 416, headers });
  }
  const { start, end } = interval;
  headers.set("content-length", String(end - start + 1));
  if (range) headers.set("content-range", `bytes ${start}-${end}/${info.size}`);
  const body = request.method === "HEAD" ? null : Readable.toWeb(createReadStream(file, { start, end }));
  return new Response(body as ReadableStream<Uint8Array> | null, { status: range ? 206 : 200, headers });
}

function completeLength(response: Response) {
  const lengthHeader = response.headers.get("content-length");
  const length = lengthHeader ? Number(lengthHeader) : undefined;
  if (response.status === 200) return { complete: true, length };
  const match = /^bytes 0-(\d+)\/(\d+)$/i.exec(response.headers.get("content-range") ?? "");
  const total = match && Number(match[2]);
  return { complete: Boolean(match && Number(match[1]) + 1 === total), length: total || undefined };
}

export async function cacheAudioStream(response: Response, version: string, expectedSize?: number) {
  const { body } = response;
  const { complete, length } = completeLength(response);
  if (!body || !complete || transfers.has(version) || clearing) return body;
  const generation = cacheGeneration;
  try {
    await mkdir(cacheDirectory(), { recursive: true });
  } catch {
    return body;
  }
  if (transfers.has(version) || generation !== cacheGeneration || clearing) return body;

  const target = cacheFile(version);
  const temporary = `${target}.${randomUUID()}.part`;
  const input = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
  const output = new PassThrough();
  const writer = createWriteStream(temporary, { flags: "wx" });
  const stream = Readable.toWeb(output, { strategy: { highWaterMark: 128 * 1024, size: chunk => chunk.length } });
  let stopped = false;
  const stop = () => {
    stopped = true;
    input.unpipe(writer);
    writer.destroy();
  };
  const done = new Promise<void>(resolve => {
    writer.once("close", () => {
      const finish = async () => {
        const expected = length ?? expectedSize ?? writer.bytesWritten;
        if (!stopped && writer.writableFinished && writer.bytesWritten === expected && expected > 0) {
          await rename(temporary, target);
        }
      };
      void finish()
        .catch(() => undefined)
        .finally(async () => {
          await rm(temporary, { force: true }).catch(() => undefined);
          transfers.delete(version);
          resolve();
        });
    });
  });
  transfers.set(version, { stop, done });
  writer.on("error", stop);
  input.on("error", error => {
    stop();
    output.destroy(error);
  });
  output.on("close", () => {
    if (!input.readableEnded) {
      stop();
      input.destroy();
    }
  });
  input.pipe(writer);
  input.pipe(output);
  return stream as ReadableStream<Uint8Array>;
}

export function clearWebDavCache() {
  if (clearing) return clearing;
  cacheGeneration++;
  clearing = (async () => {
    const active = [...transfers.values()];
    active.forEach(transfer => transfer.stop());
    await Promise.all(active.map(transfer => transfer.done));
    const directory = cacheDirectory();
    const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    await Promise.all(
      entries
        .filter(name => /^[a-f\d]{64}\.audio(?:\.[a-f\d-]+\.part)?$/.test(name))
        .map(name => rm(path.join(directory, name), { force: true })),
    );
  })().finally(() => {
    clearing = undefined;
  });
  return clearing;
}
