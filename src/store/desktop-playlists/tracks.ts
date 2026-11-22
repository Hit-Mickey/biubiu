import type { PlayData } from "@/store/play-list";

import { localMediaUrl } from "@/common/utils/local-media-url";
import { webDavMediaUrl } from "@shared/webdav";

/** The only track fields allowed on disk. Local files and WebDAV servers are resolved by ID at playback. */
export type PlaylistTrack = { title: string } & (
  | { source: "local"; type: "audio"; id: string }
  | { source: "webdav"; type: "audio"; id: string; webDavListId: string }
  | { source?: undefined; type: "audio"; sid: number }
  | {
      source?: undefined;
      type: "mv";
      bvid: string;
      aid?: string;
      cid?: string;
      pageIndex?: number;
      totalPage?: number;
      pageTitle?: string;
      hasMultiPart?: true;
    }
);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const isOpaqueId = (value: unknown): value is string =>
  typeof value === "string" && /^[\w-]{1,100}$/.test(value);
export const positiveInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const numericId = (s: unknown): s is string => typeof s === "string" && /^[1-9]\d{0,18}$/.test(s);
const isBvid = (s: unknown): s is string => typeof s === "string" && /^BV[a-zA-Z0-9]{10}$/.test(s);

// Don't accidentally save a locator or a pasted credential as a display-name fallback.
export const displayName = (value: unknown) =>
  typeof value === "string" &&
  !/(?:\b(?:file|https?|blob|biu-webdav):\/\/|\bdata:|\b(?:cookie\s*:|sessdata=|bili_jct=|dedeuserid=))/i.test(value)
    ? value.trim().slice(0, 512)
    : "";

/** Accepts both live PlayData and untrusted backup data. Never copy unknown fields or an online queue row ID. */
export function compactPlayData(value: unknown): PlaylistTrack | undefined {
  if (!isRecord(value)) return;
  const title = displayName(value.title);
  if (value.source === "local" || value.source === "webdav") {
    if (value.type !== "audio" || !isOpaqueId(value.id)) return;
    if (value.source === "local") return { source: "local", type: "audio", id: value.id, title: title || "本地歌曲" };
    if (isOpaqueId(value.webDavListId)) {
      return {
        source: "webdav",
        type: "audio",
        id: value.id,
        webDavListId: value.webDavListId,
        title: title || "WebDAV 歌曲",
      };
    }
    return;
  }
  if (value.source !== undefined && value.source !== "online") return;
  if (value.type === "audio" && positiveInt(value.sid))
    return { type: "audio", sid: value.sid, title: title || `au${value.sid}` };
  if (value.type !== "mv" || !isBvid(value.bvid)) return;
  if (value.cid !== undefined && !numericId(value.cid)) return; // never turn a malformed part into a whole video
  const pageTitle = displayName(value.pageTitle);
  return {
    type: "mv",
    bvid: value.bvid,
    title: title || value.bvid,
    ...(numericId(value.aid) && { aid: value.aid }),
    ...(value.cid && { cid: value.cid }),
    ...(positiveInt(value.pageIndex) && { pageIndex: value.pageIndex }),
    ...(positiveInt(value.totalPage) && { totalPage: value.totalPage }),
    ...(pageTitle && pageTitle !== title && { pageTitle }),
    ...(value.hasMultiPart === true && { hasMultiPart: true as const }),
  };
}

export function trackKey(track: PlaylistTrack): string {
  if (track.source === "webdav") return `dav:${track.webDavListId}:${track.id}`;
  if (track.source === "local") return `local:${track.id}`;
  if (track.type === "audio") return `au:${track.sid}`;
  return track.cid && track.totalPage !== 1 ? `${track.bvid}:${track.cid}` : track.bvid;
}

export function findPlayingTrackIndex(tracks: PlaylistTrack[], item: PlayData): number {
  if (item.source === "local") return tracks.findIndex(track => track.source === "local" && track.id === item.id);
  if (item.source === "webdav") {
    return tracks.findIndex(
      track =>
        track.source === "webdav" &&
        track.id === item.id &&
        (!item.webDavListId || track.webDavListId === item.webDavListId),
    );
  }
  if (item.type === "audio")
    return tracks.findIndex(track => !track.source && track.type === "audio" && track.sid === item.sid);
  let wholeVideo = -1;
  for (const [index, track] of tracks.entries()) {
    if (track.type !== "mv" || track.bvid !== item.bvid) continue;
    if (track.cid === item.cid) return index;
    if (wholeVideo < 0 && (!track.cid || (!item.cid && track.totalPage === 1))) wholeVideo = index;
  }
  return wholeVideo;
}

export function addUniqueTracks(unique: Map<string, PlaylistTrack>, tracks: readonly PlaylistTrack[]) {
  for (const track of tracks) {
    const key = trackKey(track);
    if (!unique.has(key)) unique.set(key, track);
  }
}

export function mergeTracks(...groups: (readonly PlaylistTrack[])[]): PlaylistTrack[] {
  const unique = new Map<string, PlaylistTrack>();
  for (const tracks of groups) addUniqueTracks(unique, tracks);
  return Array.from(unique.values());
}

/** localPath must come from the configured local library, never from an imported backup or a URL. */
export function restorePlayData(track: PlaylistTrack, localPath?: string): PlayData | undefined {
  if (track.source === "webdav") return { ...track, audioUrl: webDavMediaUrl("audio", track.webDavListId, track.id) };
  if (track.source === "local") {
    const audioUrl = localPath && localMediaUrl(localPath);
    return audioUrl ? { ...track, audioUrl } : undefined;
  }
  return { ...track, id: crypto.randomUUID() };
}

/** Resolve paths only on play/restore, never while browsing. No tags or unrelated library rows cross IPC. */
export async function resolvePlaylistTracks(tracks: readonly PlaylistTrack[]): Promise<PlayData[]> {
  const paths = new Map<string, string | undefined>();
  for (const track of tracks) if (track.source === "local") paths.set(track.id, undefined);
  if (paths.size) {
    for (const song of await window.electron.resolveLocalMusic([...paths.keys()])) paths.set(song.id, song.path);
  }
  const items: PlayData[] = [];
  for (const track of tracks) {
    const item = restorePlayData(track, track.source === "local" ? paths.get(track.id) : undefined);
    if (item) items.push(item);
  }
  return items;
}
