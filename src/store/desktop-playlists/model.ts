import {
  compactPlayData,
  displayName,
  isOpaqueId,
  isRecord,
  mergeTracks,
  positiveInt,
  trackKey,
  type PlaylistTrack,
} from "./tracks";

export interface FavoriteLink {
  mid: number;
  folderId: number;
  title: string;
  syncedAt: number;
}

export interface NormalPlaylist {
  id: string;
  name: string;
  kind: "normal";
  favorite?: FavoriteLink;
}
export interface DynamicPlaylist {
  id: string;
  name: string;
  kind: "dynamic";
  sourceIds: string[];
}
export type Playlist = NormalPlaylist | DynamicPlaylist;
type SavedPlaylist = (NormalPlaylist & { tracks: PlaylistTrack[]; favoriteKeys?: string[] }) | DynamicPlaylist;
export interface DesktopPlaylistsBackup {
  version: 1;
  playlists: SavedPlaylist[];
}

export function playlistName(value: unknown) {
  const name = displayName(value);
  if (!name || name.length > 80) throw new Error("歌单名称需为 1 至 80 个字符，不能是链接或凭据");
  return name;
}

export function sourceIds(value: unknown, catalog: readonly Pick<Playlist, "id" | "kind">[]) {
  const available = new Set(catalog.filter(p => p.kind === "normal").map(p => p.id));
  if (!Array.isArray(value) || !value.every((id): id is string => typeof id === "string" && available.has(id))) {
    throw new Error("动态歌单只能引用存在的普通歌单");
  }
  return [...new Set<string>(value)];
}

export function parseDesktopPlaylistsBackup(value: unknown): DesktopPlaylistsBackup {
  const invalid = () => new Error("无效的本地歌单备份");
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.playlists)) throw invalid();
  const ids = new Set<string>();
  const playlists: SavedPlaylist[] = value.playlists.map((p: unknown) => {
    if (!isRecord(p) || !isOpaqueId(p.id) || ids.has(p.id)) throw invalid();
    ids.add(p.id);
    const name = playlistName(p.name);
    if (p.kind === "dynamic" && Array.isArray(p.sourceIds) && p.sourceIds.every(isOpaqueId)) {
      return { kind: "dynamic", id: p.id, name, sourceIds: [...new Set<string>(p.sourceIds)] };
    }
    if (p.kind !== "normal" || !Array.isArray(p.tracks)) throw invalid();
    const tracks = mergeTracks(
      p.tracks.map(t => {
        const track = compactPlayData(t);
        if (!track) throw invalid();
        return track;
      }),
    );
    const list = { kind: "normal" as const, id: p.id, name, tracks };
    if (p.favorite === undefined && p.favoriteKeys === undefined) return list;
    const fav = p.favorite;
    if (
      !isRecord(fav) ||
      !positiveInt(fav.mid) ||
      !positiveInt(fav.folderId) ||
      !positiveInt(fav.syncedAt) ||
      !Array.isArray(p.favoriteKeys)
    )
      throw invalid();
    if (
      !p.favoriteKeys.every(
        (k): k is string => typeof k === "string" && /^(?:BV[a-zA-Z0-9]{10}|au:[1-9]\d{0,15})$/.test(k),
      )
    )
      throw invalid();
    return {
      ...list,
      favorite: {
        mid: fav.mid,
        folderId: fav.folderId,
        title: displayName(fav.title) || `收藏夹 ${fav.folderId}`,
        syncedAt: fav.syncedAt,
      },
      favoriteKeys: [...new Set<string>(p.favoriteKeys)],
    };
  });
  // Check references only after reading every ID (the target may be later in the backup).
  const normal = new Set(playlists.filter(p => p.kind === "normal").map(p => p.id));
  if (playlists.some(p => p.kind === "dynamic" && p.sourceIds.some(id => !normal.has(id)))) throw invalid();
  return { version: 1, playlists };
}

/** Compare with the last complete remote snapshot, not with unrelated locally-added tracks. */
export function favoriteDiff(
  previousKeys: readonly string[],
  local: readonly PlaylistTrack[],
  remote: readonly PlaylistTrack[],
) {
  const previous = new Set(previousKeys);
  const current = new Set(remote.map(trackKey));
  const localByKey = new Map(local.map(t => [trackKey(t), t]));
  return {
    added: remote.filter(t => !previous.has(trackKey(t))),
    removed: previousKeys
      .filter(key => !current.has(key))
      .map(key => ({ key, title: localByKey.get(key)?.title ?? key })),
    renamed: remote.filter(t => {
      const key = trackKey(t);
      const song = localByKey.get(key);
      return previous.has(key) && song && song.title !== t.title;
    }),
  };
}
