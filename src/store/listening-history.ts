import { invoke } from "@tauri-apps/api/core";

import { isTauriRuntime } from "@/bridge/env";

import type { PlayData } from "./play-list";

export interface ListeningEntry {
  at: number;
  key: string;
  title: string;
  source: "B 站" | "本地" | "WebDAV";
  seconds: number;
}
export const historyLimit = 2000;
export const historyChanged = "biubiu:listening-history";
export function completedTrack(track: PlayData, seconds: number, at = Date.now()): ListeningEntry | undefined {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  const source = track.source === "local" ? "本地" : track.source === "webdav" ? "WebDAV" : "B 站";
  const key = source === "B 站" ? (track.bvid ? `${track.bvid}:${track.cid ?? ""}` : `au${track.sid}`) : track.id;
  return {
    at,
    source,
    key: key.slice(0, 160),
    title: (track.pageTitle || track.title).slice(0, 384),
    seconds: Math.round(seconds),
  };
}

export function parseHistory(value: unknown): ListeningEntry[] {
  if (!Array.isArray(value) || value.length > historyLimit) throw new Error("听歌记录格式或数量无效");
  return value.map(value => {
    const row = value as Partial<ListeningEntry> | null;
    if (
      !row ||
      typeof row.at !== "number" ||
      !Number.isSafeInteger(row.at) ||
      row.at <= 0 ||
      row.at > 8.64e15 ||
      (row.source !== "B 站" && row.source !== "本地" && row.source !== "WebDAV") ||
      typeof row.key !== "string" ||
      row.key.length > 160 ||
      typeof row.title !== "string" ||
      row.title.length > 384 ||
      typeof row.seconds !== "number" ||
      !Number.isFinite(row.seconds) ||
      row.seconds < 0 ||
      row.seconds > 864000
    )
      throw new Error("听歌记录无效");
    const { at, key, title, source, seconds } = row;
    return { at, key, title, source, seconds };
  });
}

// A disk-backed ring. Nothing is loaded at startup or on play/pause/progress updates.
async function withHistory<T>(
  mode: IDBTransactionMode,
  run: (rows: IDBObjectStore, done: (value: T) => void) => void,
): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open("biubiu-listening-history", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("entries", { autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction("entries", mode);
      let result: T;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error ?? new Error("听歌记录操作已取消"));
      run(tx.objectStore("entries"), value => {
        result = value;
      });
    });
  } finally {
    db.close();
  }
}

export async function saveCompletion(entry: ListeningEntry) {
  if (isTauriRuntime()) {
    await invoke("sqlite_history_add", { entry, limit: historyLimit });
    window.dispatchEvent(new Event(historyChanged));
    return;
  }
  await withHistory<void>("readwrite", rows => {
    const put = rows.add(entry);
    put.onsuccess = () => {
      const oldest = Number(put.result) - historyLimit;
      if (oldest > 0) rows.delete(IDBKeyRange.upperBound(oldest));
    };
  });
  window.dispatchEvent(new Event(historyChanged));
}

export function getListeningHistory() {
  if (isTauriRuntime()) {
    return invoke<ListeningEntry[]>("sqlite_history_get_all", { limit: historyLimit });
  }
  return withHistory<ListeningEntry[]>("readonly", (rows, done) => {
    const req = rows.getAll(undefined, historyLimit);
    req.onsuccess = () => done(req.result);
  });
}

export async function replaceListeningHistory(entries: ListeningEntry[]) {
  if (isTauriRuntime()) {
    await invoke("sqlite_history_replace", { entries, limit: historyLimit });
    window.dispatchEvent(new Event(historyChanged));
    return;
  }
  await withHistory<void>("readwrite", rows => {
    rows.clear();
    for (const entry of entries) rows.add(entry);
  });
  window.dispatchEvent(new Event(historyChanged));
}

export function listeningDate(time: number) {
  const day = new Date(time);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

export function listeningSummary(entries: ListeningEntry[]) {
  const days = new Map<string, number>();
  const ranks = new Map<string, { title: string; count: number }>();
  let seconds = 0;
  for (const entry of entries) {
    seconds += entry.seconds;
    const day = listeningDate(entry.at);
    days.set(day, (days.get(day) ?? 0) + 1);
    const id = `${entry.source}:${entry.key}`;
    const item = ranks.get(id);
    if (item) item.count++;
    else ranks.set(id, { title: entry.title, count: 1 });
  }
  return { seconds, days, top: [...ranks.values()].sort((a, b) => b.count - a.count).slice(0, 10) };
}
