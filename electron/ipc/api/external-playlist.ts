import type { ExternalPlaylist, ExternalPlaylistRef, ExternalTrack } from "@shared/external-playlist";

import { isPlaylistId } from "@shared/external-playlist";

import { UserAgent } from "../../network/user-agent";

// Limits apply to one anonymous request, never to the number of playlist positions.
const BATCH_SIZE = 50;
const MAX_BYTES = 4 * 1024 * 1024;
const endpoints = {
  neteaseIndex: "https://music.163.com/api/v6/playlist/detail",
  neteaseSongs: "https://music.163.com/api/song/detail",
  qqPage: "https://c.y.qq.com/v8/fcg-bin/fcg_v8_playlist_cp.fcg",
} as const;
type ReadPublic = (
  endpoint: keyof typeof endpoints,
  params: Record<string, string>,
) => Promise<Record<string, unknown>>;
const unavailable = "歌单不存在、未公开或平台暂不提供匿名访问";
const invalid = "平台返回的歌单格式无法识别";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === "string" ? value.trim().slice(0, 200) : "");
const count = (value: unknown) => {
  const n = typeof value === "string" || typeof value === "number" ? Number(value) : 0;
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

function readTrack(raw: unknown, netease: boolean): ExternalTrack | null {
  const song = record(raw);
  const title = text(song.name) || (!netease && (text(song.title) || text(song.songname)));
  if (!title) return null;
  const artists = netease ? (song.ar ?? song.artists) : song.singer;
  const duration = netease ? count(song.dt ?? song.duration) / 1000 : count(song.interval);
  return {
    title,
    artists: Array.isArray(artists)
      ? artists
          .slice(0, 8)
          .map(a => text(record(a).name))
          .filter(Boolean)
      : [],
    duration: duration || undefined,
  };
}

function trackId(value: unknown) {
  const id = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return isPlaylistId(id) ? id : undefined;
}

function fillSongs(songs: unknown[], byId: Map<string, ExternalTrack | null>, batch?: ReadonlySet<string>) {
  for (const song of songs) {
    const id = trackId(record(song).id);
    if (!id || !byId.has(id) || (batch && !batch.has(id))) continue;
    const track = readTrack(song, true);
    if (track) byId.set(id, track);
  }
}

// Extract only the order and compact metadata; don't retain the raw index during subsequent I/O.
function parseNeteaseIndex(data: Record<string, unknown>, id: string) {
  const list = record(data.playlist ?? data.result);
  if (data.code !== 200 || !Object.keys(list).length || Number(list.privacy ?? 0) !== 0) throw new Error(unavailable);
  if (!Array.isArray(list.tracks) && !Array.isArray(list.trackIds)) throw new Error(invalid);
  const songs = Array.isArray(list.tracks) ? list.tracks : [];
  const order = Array.isArray(list.trackIds) ? list.trackIds.map(entry => trackId(record(entry).id ?? entry)) : [];
  const byId = new Map<string, ExternalTrack | null>();
  const playlist: ExternalPlaylist = {
    title: text(list.name) || `网易云歌单 ${id}`,
    total: Math.max(count(list.trackCount), order.length || songs.length),
    tracks: [],
  };
  if (order.length) {
    for (const key of order) if (key) byId.set(key, null);
    fillSongs(songs, byId);
  } else {
    playlist.tracks = songs.map(song => readTrack(song, true));
  }
  return { playlist, order, byId };
}

async function readNetease(id: string, get: ReadPublic) {
  const { playlist, order, byId } = parseNeteaseIndex(await get("neteaseIndex", { id, n: "10", s: "0" }), id);
  const batch = new Set<string>();
  const fillBatch = async () => {
    const data = await get("neteaseSongs", { ids: `[${[...batch].join(",")}]` });
    if (data.code !== 200) throw new Error("网易云未提供本批曲目的匿名详情，已停止读取");
    if (!Array.isArray(data.songs)) throw new Error(invalid);
    fillSongs(data.songs, byId, batch);
    batch.clear();
  };
  // One request at a time, and only once per missing public ID (even when it occurs repeatedly).
  for (const [key, track] of byId) {
    if (track) continue;
    batch.add(key);
    if (batch.size === BATCH_SIZE) await fillBatch();
  }
  if (batch.size) await fillBatch();
  if (order.length) playlist.tracks = order.map(key => (key && byId.get(key)) || null);
  return playlist;
}

function parseQQPage(data: Record<string, unknown>, offset: number) {
  const lists = record(data.data).cdlist ?? data.cdlist;
  const list = record(Array.isArray(lists) && lists[0]);
  if (data.code !== 0 || !Object.keys(list).length) throw new Error(unavailable);
  if (!Array.isArray(list.songlist)) throw new Error(invalid);
  const paged = list.song_begin !== undefined;
  const matches = (value: unknown, n: number) => value === n || value === String(n);
  const reported = list.total_song_num ?? list.songnum;
  const publicTotal = count(reported);
  if (
    ((paged || offset > 0) && !matches(list.song_begin, offset)) ||
    (paged && !matches(reported, publicTotal)) ||
    (list.cur_song_num !== undefined && !matches(list.cur_song_num, list.songlist.length))
  ) {
    throw new Error("QQ音乐返回的分页位置或曲目数不一致，已停止读取");
  }
  return {
    title: text(list.dissname),
    // total_song_num describes the public sequence; songnum may also include unexposed songs.
    publicTotal,
    declared: count(list.songnum),
    paged,
    tracks: list.songlist.map(song => readTrack(song, false)),
  };
}

async function readQQ(id: string, get: ReadPublic): Promise<ExternalPlaylist> {
  const page = async (offset: number) =>
    parseQQPage(
      await get("qqPage", {
        id,
        format: "json",
        newsong: "1",
        platform: "jqspaframe.json",
        song_begin: String(offset),
        song_num: String(BATCH_SIZE),
      }),
      offset,
    );
  const first = await page(0);
  const { tracks, publicTotal } = first;
  if (first.paged) {
    while (tracks.length < publicTotal) {
      if (!tracks.length) throw new Error("QQ音乐未返回预期的曲目分页，已停止读取");
      const next = await page(tracks.length);
      if (!next.tracks.length || next.publicTotal !== publicTotal || tracks.length + next.tracks.length > publicTotal) {
        throw new Error("QQ音乐曲目分页缺失或歌单已变更，请重新读取");
      }
      for (const track of next.tracks) tracks.push(track);
    }
  }
  return {
    title: first.title || `QQ音乐歌单 ${id}`,
    total: Math.max(publicTotal, first.declared, tracks.length),
    tracks,
  };
}

async function readJson(response: Response) {
  const tooLarge = "平台单次返回的数据超过 4 MiB，已停止读取";
  if (!response.ok || Number(response.headers.get("content-length")) > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error(response.ok ? tooLarge : `无法读取公开歌单（HTTP ${response.status}）`);
  }
  if (!response.body) throw new Error(invalid);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let json = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new Error(tooLarge);
      }
      json += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(json + decoder.decode()) as unknown;
  } catch {
    throw new Error(invalid);
  }
}

/** Node fetch has no Chromium session/cookie jar. Construct every destination and header here. */
export async function fetchPublicPlaylist(ref: ExternalPlaylistRef, signal: AbortSignal, request = fetch) {
  if ((ref?.source !== "netease" && ref?.source !== "qq") || !isPlaylistId(ref.id)) throw new Error("无效的歌单 ID");
  signal.throwIfAborted();
  const get: ReadPublic = async (endpoint, params) => {
    signal.throwIfAborted();
    const url = new URL(endpoints[endpoint]);
    url.search = new URLSearchParams(params).toString();
    const timeout = AbortSignal.timeout(15_000);
    const requestSignal = AbortSignal.any([signal, timeout]);
    try {
      const response = await request(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Referer: endpoint === "qqPage" ? "https://y.qq.com/" : "https://music.163.com/",
          "User-Agent": UserAgent,
        },
        credentials: "omit",
        redirect: "error",
        signal: requestSignal,
      });
      const data = await readJson(response);
      requestSignal.throwIfAborted();
      return record(data);
    } catch (error) {
      signal.throwIfAborted();
      if (timeout.aborted) throw new Error("读取公开歌单超时，请稍后再试");
      if (error instanceof TypeError) throw new Error("无法连接平台的公开歌单接口");
      throw error;
    }
  };
  const playlist = await (ref.source === "netease" ? readNetease(ref.id, get) : readQQ(ref.id, get));
  signal.throwIfAborted();
  return playlist;
}
