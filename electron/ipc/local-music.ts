import { ipcMain } from "electron";
import log from "electron-log";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { appSettingsStore } from "../store";
import { channel } from "./channel";

const exts = new Set([".mp3", ".flac", ".wav", ".m4a", ".aac", ".ogg", ".wma", ".aiff"]);

async function* musicFiles(dir: string) {
  try {
    for await (const entry of await fsp.opendir(dir)) {
      if ((entry.isFile() || entry.isSymbolicLink()) && exts.has(path.extname(entry.name).toLowerCase()))
        yield path.join(dir, entry.name);
    }
  } catch (err) {
    log.error("[local-music] walk error:", err);
  }
}

async function localFileId(file: string) {
  const canonical = await fsp.realpath(file).catch(() => file);
  return crypto.createHash("md5").update(canonical.toLowerCase(), "utf8").digest("hex");
}

// Find only the requested IDs. Don't parse tags, decode covers or return a copy of the whole library.
async function resolveFiles(ids: string[]) {
  const wanted = new Set(
    Array.isArray(ids) ? ids.filter(id => typeof id === "string" && /^[a-f0-9]{32}$/.test(id)) : [],
  );
  const result: Pick<LocalMusicItem, "id" | "path">[] = [];
  if (!wanted.size) return result;
  for (const dir of appSettingsStore.get("appSettings").localMusicDirs ?? []) {
    for await (const file of musicFiles(dir)) {
      const id = await localFileId(file);
      if (wanted.delete(id)) result.push({ id, path: file });
      if (!wanted.size) return result;
    }
  }
  return result;
}

function toSafeTitle(filePath: string, metaTitle?: string) {
  if (metaTitle && metaTitle.trim()) return metaTitle.trim();
  return path.parse(filePath).name;
}

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return typeof value === "object" && value !== null && "code" in value;
}

export function registerLocalMusicHandlers() {
  ipcMain.handle(channel.localMusic.resolve, (_, ids: string[]) => resolveFiles(ids));
  ipcMain.handle(channel.localMusic.scan, async (_, dirs: string[]) => {
    const result: LocalMusicItem[] = [];
    if (!Array.isArray(dirs) || !dirs.length) return result;
    try {
      const { parseFile } = await import("music-metadata");
      for (const dir of dirs) {
        for await (const file of musicFiles(dir)) {
          try {
            const stat = await fsp.stat(file);
            const id = await localFileId(file);
            const meta = await parseFile(file, { skipCovers: true }).catch(() => null);
            const duration =
              meta?.format?.duration && Number.isFinite(meta.format.duration) ? meta.format.duration : undefined;
            const format = (path.extname(file).slice(1) || "").toLowerCase();
            result.push({
              id,
              path: file,
              dir,
              title: toSafeTitle(file, meta?.common?.title),
              size: stat.size,
              format,
              duration,
              createdTime: stat.birthtimeMs || stat.mtimeMs,
            });
          } catch (err) {
            log.error("[local-music] parse file error:", file, err);
          }
        }
      }
    } catch (err) {
      log.error("[local-music] scan error:", err);
    }
    return result;
  });

  ipcMain.handle(channel.localMusic.deleteFile, async (_, filePath: string) => {
    if (!filePath) return false;
    try {
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) return false;
      await fsp.unlink(filePath);
      return true;
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") return false;
      log.error("[local-music] delete file error:", filePath, err);
      return false;
    }
  });
}
