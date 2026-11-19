import { transaction, type Entries } from "./database";
import {
  favoriteDiff,
  parseDesktopPlaylistsBackup,
  playlistName,
  sourceIds,
  type DesktopPlaylistsBackup,
  type FavoriteLink,
  type NormalPlaylist,
  type Playlist,
} from "./model";
import { addUniqueTracks, compactPlayData, mergeTracks, trackKey, type PlaylistTrack } from "./tracks";

export { onDesktopPlaylistsChange } from "./database";
export {
  favoriteDiff,
  parseDesktopPlaylistsBackup,
  type DesktopPlaylistsBackup,
  type FavoriteLink,
  type NormalPlaylist,
  type Playlist,
} from "./model";

// The small catalog is separate from track lists and sync baselines. Dynamic lists never have a track record.
const catalogKey = "catalog";
const readCatalog = async (db: Entries) => (await db.get<Playlist[]>(catalogKey)) ?? [];
const readTracks = async (db: Entries, id: string) => (await db.get<PlaylistTrack[]>(`tracks:${id}`)) ?? [];
const readBaseline = async (db: Entries, id: string) => (await db.get<string[]>(`favorite:${id}`)) ?? [];

function normal(catalog: Playlist[], id: string): NormalPlaylist {
  const list = catalog.find(p => p.id === id);
  if (list?.kind !== "normal") throw new Error("请选择现有的普通歌单");
  return list;
}

function compactItems(items: readonly unknown[]) {
  const tracks: PlaylistTrack[] = [];
  for (const item of items) {
    const track = compactPlayData(item);
    if (track) tracks.push(track);
  }
  return tracks;
}

export async function readPlaylistPage(id?: string) {
  return transaction("readonly", async db => {
    const catalog = await readCatalog(db);
    const selected = catalog.find(p => p.id === id) ?? catalog[0];
    let tracks: PlaylistTrack[] = [];
    if (selected?.kind === "normal") tracks = await readTracks(db, selected.id);
    else if (selected) {
      const merged = new Map<string, PlaylistTrack>();
      for (const source of selected.sourceIds) addUniqueTracks(merged, await readTracks(db, source));
      tracks = Array.from(merged.values());
    }
    return { catalog, selected, tracks };
  });
}

export function savePlaylist(input: { id?: string; name: string; sourceIds?: string[]; items?: readonly unknown[] }) {
  const name = playlistName(input.name);
  return transaction("readwrite", async db => {
    const catalog = await readCatalog(db);
    const id = input.id ?? crypto.randomUUID();
    const existing = catalog.find(p => p.id === id);
    if (!existing && input.id) throw new Error("该歌单已被移除");
    const list: Playlist =
      input.sourceIds !== undefined
        ? { id, name, kind: "dynamic", sourceIds: sourceIds(input.sourceIds, catalog) }
        : { ...existing, id, name, kind: "normal" };
    if (existing && existing.kind !== list.kind) throw new Error("不能更改已有歌单的类型");
    if (input.items) {
      if (existing || list.kind !== "normal") throw new Error("请选择新建普通歌单");
      const tracks = mergeTracks(compactItems(input.items));
      if (!tracks.length) throw new Error("没有可以导入的曲目");
      db.put(`tracks:${id}`, tracks);
    }
    db.put(catalogKey, existing ? catalog.map(p => (p.id === id ? list : p)) : [...catalog, list]);
    return id;
  });
}

export function deletePlaylist(id: string) {
  return transaction("readwrite", async db => {
    const catalog = await readCatalog(db);
    db.put(
      catalogKey,
      catalog
        .filter(p => p.id !== id)
        .map(p =>
          p.kind === "dynamic" && p.sourceIds.includes(id)
            ? { ...p, sourceIds: p.sourceIds.filter(source => source !== id) }
            : p,
        ),
    );
    db.delete(`tracks:${id}`);
    db.delete(`favorite:${id}`);
  });
}

export function addPlaylistItems(id: string, items: readonly unknown[]) {
  return transaction("readwrite", async db => {
    normal(await readCatalog(db), id);
    const current = await readTracks(db, id);
    const incoming = compactItems(items);
    const tracks = mergeTracks(current, incoming);
    if (tracks.length !== current.length) db.put(`tracks:${id}`, tracks);
    return { added: tracks.length - current.length, skipped: items.length - incoming.length };
  });
}

export function removePlaylistTrack(id: string, key: string) {
  return transaction("readwrite", async db => {
    normal(await readCatalog(db), id);
    db.put(
      `tracks:${id}`,
      (await readTracks(db, id)).filter(t => trackKey(t) !== key),
    );
  });
}

export const readFavoriteBaseline = (id: string) => transaction("readonly", db => readBaseline(db, id));

export interface FavoriteSnapshot extends Omit<FavoriteLink, "syncedAt"> {
  tracks: PlaylistTrack[];
  skipped: number;
}

/** Apply only a complete, previewed snapshot. Local-only entries survive every sync. */
export function applyFavoriteSync(
  id: string,
  expected: FavoriteLink | undefined,
  remote: FavoriteSnapshot,
  removeMissing: boolean,
) {
  return transaction("readwrite", async db => {
    const catalog = await readCatalog(db);
    const list = normal(catalog, id);
    if (
      list.favorite?.syncedAt !== expected?.syncedAt ||
      list.favorite?.mid !== expected?.mid ||
      list.favorite?.folderId !== expected?.folderId ||
      (expected && (expected.mid !== remote.mid || expected.folderId !== remote.folderId))
    ) {
      throw new Error("收藏夹关联已变化，请重新预览");
    }
    const local = await readTracks(db, id);
    const diff = favoriteDiff(await readBaseline(db, id), local, remote.tracks);
    const removed = new Set(removeMissing ? diff.removed.map(t => t.key) : []);
    const titles = new Map(diff.renamed.map(t => [trackKey(t), t.title]));
    const kept = local
      .filter(t => !removed.has(trackKey(t)))
      .map(t => {
        const title = titles.get(trackKey(t));
        return title ? { ...t, title } : t;
      });
    db.put(`tracks:${id}`, mergeTracks(kept, diff.added));
    db.put(`favorite:${id}`, remote.tracks.map(trackKey));
    list.favorite = {
      mid: remote.mid,
      folderId: remote.folderId,
      title: remote.title,
      syncedAt: Math.max(Date.now(), (expected?.syncedAt ?? 0) + 1),
    };
    db.put(catalogKey, catalog);
  });
}

export function unlinkFavorite(id: string) {
  return transaction("readwrite", async db => {
    const catalog = await readCatalog(db);
    delete normal(catalog, id).favorite;
    db.delete(`favorite:${id}`);
    db.put(catalogKey, catalog);
  });
}

export function exportDesktopPlaylists(): Promise<DesktopPlaylistsBackup> {
  return transaction("readonly", async db => {
    const playlists: DesktopPlaylistsBackup["playlists"] = [];
    for (const p of await readCatalog(db)) {
      playlists.push(
        p.kind === "dynamic"
          ? p
          : {
              ...p,
              tracks: await readTracks(db, p.id),
              ...(p.favorite && { favoriteKeys: await readBaseline(db, p.id) }),
            },
      );
    }
    return { version: 1, playlists };
  });
}

/** Replaces local playlists atomically. Caller must explicitly confirm restore; no queue or remote changes. */
export async function importDesktopPlaylists(value: unknown): Promise<void> {
  const backup = parseDesktopPlaylistsBackup(value);
  await transaction("readwrite", async db => {
    const catalog: Playlist[] = [];
    db.clear();
    for (const p of backup.playlists) {
      if (p.kind === "dynamic") catalog.push(p);
      else {
        const { tracks, favoriteKeys, ...meta } = p;
        catalog.push(meta);
        db.put(`tracks:${p.id}`, tracks);
        if (favoriteKeys) db.put(`favorite:${p.id}`, favoriteKeys);
      }
    }
    db.put(catalogKey, catalog);
  });
}
