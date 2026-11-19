import { safeStorage } from "electron";
import log from "electron-log";
import Store from "electron-store";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import PQueue from "p-queue";
import { z } from "zod";

import type {
  WebDavLibrary,
  WebDavList,
  WebDavListConfig,
  WebDavPreferences,
  WebDavRemoveResult,
} from "@shared/webdav";

import { getUserDataPath } from "../utils";
import { audioMimeType, normalizeWebDavUrl, resolveWebDavDirectory, WebDavClient } from "./client";
import { findSidecars, readAudioTags, readCoverFile, readLyricFile, type StoredTrack } from "./metadata";

interface StoredList extends WebDavListConfig {
  id: string;
  tracks: StoredTrack[];
  hiddenIds: string[];
  syncedAt: number;
}

interface LibraryData {
  lists: StoredList[];
  passwords: Record<string, string>;
  preferences: WebDavPreferences;
}

const store = new Store<LibraryData>({
  name: "webdav",
  cwd: getUserDataPath(),
  defaults: { lists: [], passwords: {}, preferences: { cacheAudio: false, debugLog: false } },
});
let data = store.store;
const sessionPasswords = new Map<string, string>();
const listOperations = new Map<string, Promise<unknown>>();
const refreshes = new Map<string, Promise<void>>();
const errors = new Map<string, string>();
const syncing = new Set<string>();
const tagBatches = new Map<string, symbol>();
const tagQueue = new PQueue({ concurrency: 4 });
type AudioTags = Awaited<ReturnType<typeof readAudioTags>>;
const tagRequests = new Map<string, Promise<AudioTags>>();
const tagCache = new Map<string, AudioTags>();

export const webDavLibraryEvents = new EventEmitter();

const listInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(30),
  url: z.string(),
  username: z.string().trim(),
  password: z.string().optional(),
  directory: z.string().trim(),
  includeSubdirectories: z.boolean(),
  lazyMetadata: z.boolean(),
  removeRemoteFiles: z.boolean(),
});

function digest(...parts: unknown[]) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function trackVersion(track: StoredTrack) {
  return digest(track.id, track.etag, track.size, track.modifiedAt);
}

function passwordKey(list: WebDavListConfig) {
  return digest(list.url, list.username);
}

function getPassword(list: WebDavListConfig) {
  const key = passwordKey(list);
  const sessionPassword = sessionPasswords.get(key);
  if (sessionPassword !== undefined) return sessionPassword;
  const encrypted = data.passwords[key];
  if (encrypted) {
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
    } catch {
      log.warn("[WebDAV] 读取已保存的密码失败");
    }
  }
  return "";
}

function createClient(list: WebDavListConfig, password = getPassword(list)) {
  return new WebDavClient(list.url, list.username, password, message => {
    if (data.preferences.debugLog) log.debug(`[WebDAV] ${list.name} ${message}`);
  });
}

function publicTrack({
  id,
  title,
  filename,
  folder,
  format,
  size,
  createdAt,
  modifiedAt,
  artist,
  album,
  duration,
  year,
  disc,
  track,
  lossless,
  hasCover,
}: StoredTrack) {
  return {
    id,
    title,
    filename,
    folder,
    format,
    size,
    createdAt,
    modifiedAt,
    artist,
    album,
    duration,
    year,
    disc,
    track,
    lossless,
    hasCover,
  };
}

function publicList({ hiddenIds, tracks, ...list }: StoredList): WebDavList {
  const hidden = new Set(hiddenIds);
  const key = passwordKey(list);
  return {
    ...list,
    tracks: tracks.filter(track => !hidden.has(track.id)).map(publicTrack),
    hasPassword: Boolean(data.passwords[key] || sessionPasswords.get(key)),
    isSyncing: syncing.has(list.id),
    error: errors.get(list.id),
  };
}

export function getWebDavLibrary(): WebDavLibrary {
  return { lists: data.lists.map(publicList), preferences: data.preferences };
}

export function getWebDavPreferences() {
  return data.preferences;
}

function commit(next: LibraryData, removed: string[] = []) {
  store.store = next;
  data = next;
  webDavLibraryEvents.emit("change", removed);
}

function saveList(list: StoredList, passwords = data.passwords) {
  const previous = data.lists.find(item => item.id === list.id);
  const lists = previous ? data.lists.map(item => (item.id === list.id ? list : item)) : [...data.lists, list];
  const activeIds = new Set(list.tracks.map(track => track.id));
  const removed = previous?.tracks.filter(track => !activeIds.has(track.id)).map(track => track.id);
  commit({ ...data, lists, passwords }, removed);
}

export function setWebDavPreferences(preferences: WebDavPreferences) {
  commit({
    ...data,
    preferences: { cacheAudio: preferences?.cacheAudio === true, debugLog: preferences?.debugLog === true },
  });
}

function getList(id: string) {
  const list = data.lists.find(list => list.id === id);
  if (!list) throw new Error("远程列表不存在");
  return list;
}

function runListOperation<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const promise = (listOperations.get(id) ?? Promise.resolve()).catch(() => undefined).then(operation);
  listOperations.set(id, promise);
  return promise.finally(() => {
    if (listOperations.get(id) === promise) listOperations.delete(id);
  });
}

async function scanList(client: WebDavClient, list: WebDavListConfig & { id: string }, previous?: StoredList) {
  const root = resolveWebDavDirectory(client.base, list.directory);
  const oldTracks = new Map(previous?.tracks.map(track => [track.id, track]));
  const tracks = new Map<string, StoredTrack>();
  const scan = async (path: string, depth: number) => {
    const files = await client.list(path);
    const names = new Map(files.filter(item => !item.collection).map(item => [item.filename.toLowerCase(), item.path]));
    for (const file of files) {
      if (file.collection || file.size === 0) continue;
      const dot = file.filename.lastIndexOf(".");
      if (dot < 0) continue;
      const format = file.filename.slice(dot + 1).toLowerCase();
      if (!audioMimeType(format)) continue;
      const id = digest(list.id, list.url, list.username, file.path);
      const sidecars = findSidecars({ ...file, filename: file.filename.toLowerCase() }, names);
      const base: StoredTrack = {
        ...sidecars,
        id,
        path: file.path,
        filename: file.filename,
        title: file.filename.slice(0, dot) || file.filename,
        folder: decodeURIComponent(path.slice(root.length).replace(/\/$/, "")),
        format,
        size: file.size,
        etag: file.etag,
        createdAt: file.createdAt,
        modifiedAt: file.modifiedAt,
        hasCover: Boolean(sidecars.coverPath || sidecars.folderCoverPath),
        lossless: format === "flac" || format === "wav",
      };
      const existing = oldTracks.get(id);
      if (existing?.metadataParsed && trackVersion(existing) === trackVersion(base)) {
        const { title, artist, album, duration, year, track, disc, lossless } = existing;
        Object.assign(base, { title, artist, album, duration, year, track, disc, lossless, metadataParsed: true });
        base.hasCover ||= existing.hasCover && !existing.coverPath && !existing.folderCoverPath;
      }
      tracks.set(id, base);
    }
    if (list.includeSubdirectories && depth < 5) {
      for (const file of files) {
        if (file.collection) await scan(file.path, depth + 1);
      }
    }
  };
  await scan(root, 0);
  const ordered: StoredTrack[] = [];
  for (const previousTrack of oldTracks.keys()) {
    const track = tracks.get(previousTrack);
    if (!track) continue;
    ordered.push(track);
    tracks.delete(previousTrack);
  }
  return [...ordered, ...tracks.values()];
}

function loadTags(client: WebDavClient, track: StoredTrack, priority = 0) {
  const version = trackVersion(track);
  const cached = tagCache.get(version);
  if (cached) return Promise.resolve(cached);
  const pending = tagRequests.get(version);
  if (pending) {
    if (priority > 0) {
      try {
        tagQueue.setPriority(version, priority);
      } catch {
        // Jobs that already started cannot be reprioritized.
      }
    }
    return pending;
  }
  const request = tagQueue
    .add(() => readAudioTags(client, track), { priority, id: version })
    .then(tags => {
      tagCache.set(version, tags);
      if (tagCache.size > 16) tagCache.delete(tagCache.keys().next().value!);
      return tags;
    })
    .finally(() => tagRequests.delete(version));
  tagRequests.set(version, request);
  return request;
}

function applyTagsToList(id: string, updates: Map<string, { version: string; tags: AudioTags }>) {
  const list = data.lists.find(list => list.id === id);
  if (!list || !updates.size) return;
  let changed = false;
  const tracks = list.tracks.map(track => {
    const update = updates.get(track.id);
    if (!update || trackVersion(track) !== update.version) return track;
    changed = true;
    return {
      ...track,
      ...update.tags.fields,
      lossless: update.tags.fields.lossless ?? track.lossless,
      metadataParsed: true,
      hasCover: Boolean(track.coverPath || track.folderCoverPath || update.tags.cover),
    };
  });
  if (changed) saveList({ ...list, tracks });
}

function readListTags(list: StoredList, client: WebDavClient) {
  tagBatches.delete(list.id);
  if (list.lazyMetadata) return;
  const batch = Symbol();
  tagBatches.set(list.id, batch);
  const tracks = list.tracks.filter(track => !track.metadataParsed);
  const read = async () => {
    for (let offset = 0; offset < tracks.length; offset += 32) {
      if (tagBatches.get(list.id) !== batch) return;
      const updates = new Map<string, { version: string; tags: AudioTags }>();
      await Promise.all(
        tracks.slice(offset, offset + 32).map(async track => {
          try {
            const tags = await loadTags(client, track);
            updates.set(track.id, { version: trackVersion(track), tags });
          } catch (error) {
            if (data.preferences.debugLog)
              log.debug("[WebDAV] 读取歌曲标签失败", error instanceof Error && error.message);
          }
        }),
      );
      if (tagBatches.get(list.id) !== batch) return;
      applyTagsToList(list.id, updates);
    }
  };
  void read()
    .catch(() => log.warn("[WebDAV] 保存歌曲标签失败"))
    .finally(() => {
      if (tagBatches.get(list.id) === batch) tagBatches.delete(list.id);
    });
}

function readListInput(value: unknown) {
  const input = listInputSchema.safeParse(value);
  if (!input.success) throw new Error("请填写远程列表配置，列表名称为 1 至 30 个字符");
  const { id, password, ...fields } = input.data;
  const config = { ...fields, url: normalizeWebDavUrl(fields.url) };
  if (config.username.includes(":")) throw new Error("WebDAV 账号不能包含冒号");
  if (!config.username && password) throw new Error("请填写 WebDAV 账号");
  return { id, password, config };
}

export async function testWebDavList(value: unknown) {
  const { config, password } = readListInput(value);
  const client = createClient(config, password);
  await client.list(resolveWebDavDirectory(client.base, config.directory));
}

export function saveWebDavList(value: unknown) {
  const { id, password, config } = readListInput(value);
  const listId = id ?? randomUUID();
  return runListOperation(listId, async () => {
    const previous = id ? getList(id) : undefined;
    const client = createClient(config, password);
    const tracks = await scanList(client, { ...config, id: listId }, previous);
    const list = { ...config, id: listId, tracks, hiddenIds: [], syncedAt: Date.now() };
    const passwords = { ...data.passwords };
    const key = passwordKey(config);
    if (password !== undefined) {
      delete passwords[key];
      if (password) {
        try {
          if (safeStorage.isEncryptionAvailable())
            passwords[key] = safeStorage.encryptString(password).toString("base64");
        } catch {
          log.warn("[WebDAV] 系统凭据存储不可用");
        }
      }
    }
    errors.delete(listId);
    saveList(list, passwords);
    if (password !== undefined) {
      if (password && !passwords[key]) sessionPasswords.set(key, password);
      else sessionPasswords.delete(key);
    }
    readListTags(list, client);
    return { id: listId, passwordSessionOnly: Boolean(password && !passwords[key]) };
  });
}

export function refreshWebDavList(id: string) {
  const current = refreshes.get(id);
  if (current) return current;
  const refresh = runListOperation(id, async () => {
    const list = getList(id);
    syncing.add(id);
    errors.delete(id);
    webDavLibraryEvents.emit("change");
    try {
      const client = createClient(list);
      const tracks = await scanList(client, list, list);
      const next = { ...list, tracks, hiddenIds: [], syncedAt: Date.now() };
      saveList(next);
      readListTags(next, client);
    } catch (error) {
      const message = error instanceof Error ? error.message : "更新远程列表失败";
      errors.set(id, message);
      if (data.preferences.debugLog) log.debug(`[WebDAV] ${list.name} ${message}`);
      throw error;
    } finally {
      syncing.delete(id);
      webDavLibraryEvents.emit("change");
    }
  }).finally(() => refreshes.delete(id));
  refreshes.set(id, refresh);
  return refresh;
}

export function startWebDavSync() {
  const refreshAll = async () => {
    for (const { id } of data.lists) await refreshWebDavList(id).catch(() => undefined);
  };
  const scheduleNext = () => {
    const next = new Date();
    next.setHours(11, 0, 0, 0);
    if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
    setTimeout(() => {
      void refreshAll();
      scheduleNext();
    }, next.getTime() - Date.now()).unref();
  };
  void refreshAll();
  scheduleNext();
}

export function deleteWebDavList(id: string) {
  return runListOperation(id, async () => {
    const list = getList(id);
    const removed = list.tracks.map(track => track.id);
    commit({ ...data, lists: data.lists.filter(list => list.id !== id) }, removed);
    tagBatches.delete(id);
    errors.delete(id);
  });
}

export function removeWebDavTracks(id: string, ids: string[], deleteFiles: boolean): Promise<WebDavRemoveResult> {
  return runListOperation(id, async () => {
    const list = getList(id);
    if (!Array.isArray(ids)) throw new Error("请选择要移除的歌曲");
    if (deleteFiles !== list.removeRemoteFiles) throw new Error("远程列表的删除设置已更改，请重新操作");
    const requested = new Set(ids);
    const removed = new Set<string>();
    const client = deleteFiles ? createClient(list) : undefined;
    let error: string | undefined;
    for (const track of list.tracks) {
      if (!requested.has(track.id)) continue;
      try {
        if (client) await client.remove(track.path);
        removed.add(track.id);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : "无法删除远程文件";
        break;
      }
    }
    if (removed.size) {
      const latest = getList(id);
      saveList({
        ...latest,
        tracks: deleteFiles ? latest.tracks.filter(track => !removed.has(track.id)) : latest.tracks,
        hiddenIds: deleteFiles
          ? latest.hiddenIds.filter(id => !removed.has(id))
          : [...new Set([...latest.hiddenIds, ...removed])],
      });
    }
    return { removed: [...removed], error };
  });
}

export function findWebDavTrack(listId: string, trackId: string) {
  return data.lists.find(list => list.id === listId)?.tracks.find(track => track.id === trackId);
}

export function openWebDavTrack(listId: string, trackId: string) {
  const list = getList(listId);
  const track = findWebDavTrack(listId, trackId);
  if (!track) throw new Error("远程列表中的歌曲不存在");
  return { track, client: createClient(list) };
}

export async function getWebDavTrackMetadata(listId: string, trackId: string) {
  const { track, client } = openWebDavTrack(listId, trackId);
  if (!track.metadataParsed) {
    const tags = await loadTags(client, track, 1);
    applyTagsToList(listId, new Map([[track.id, { version: trackVersion(track), tags }]]));
  }
  return publicTrack(findWebDavTrack(listId, trackId) ?? track);
}

export async function getWebDavLyrics(listId: string, trackId: string) {
  const { client, track } = openWebDavTrack(listId, trackId);
  if (track.lyricPath) {
    const lyrics = await readLyricFile(client, track.lyricPath).catch(() => undefined);
    if (lyrics) return lyrics;
  }
  const tags = await loadTags(client, track, 1);
  return tags.lyrics;
}

export async function getWebDavCover(listId: string, trackId: string) {
  const { client, track } = openWebDavTrack(listId, trackId);
  if (track.coverPath) {
    const cover = await readCoverFile(client, track.coverPath).catch(() => undefined);
    if (cover) return cover;
  }
  const tags = await loadTags(client, track, 1).catch(() => undefined);
  if (tags?.cover) return tags.cover;
  if (track.folderCoverPath) return readCoverFile(client, track.folderCoverPath);
}
