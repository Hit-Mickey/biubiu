import type { FavoriteSnapshot } from "@/store/desktop-playlists";

import { getFavFolderCreatedListAll } from "@/service/fav-folder-created-list-all";
import { getFavResourceList } from "@/service/fav-resource";
import { getUserInfo } from "@/service/user-info";
import {
  compactPlayData,
  displayName,
  positiveInt,
  trackKey,
  type PlaylistTrack,
} from "@/store/desktop-playlists/tracks";

async function requireLogin(mid: number) {
  const res = await getUserInfo();
  if (!positiveInt(mid) || res.code !== 0 || !res.data?.isLogin || res.data.mid !== mid) {
    throw new Error("登录已失效或账号已切换，请先登录关联收藏夹的 B 站账号");
  }
}

export async function readFavoriteFolders(mid: number) {
  await requireLogin(mid);
  const res = await getFavFolderCreatedListAll({ up_mid: mid });
  if (res.code !== 0 || !res.data) throw new Error(res.message || "无法读取收藏夹");
  return (res.data.list ?? [])
    .filter(folder => folder.mid === mid)
    .map(folder => ({ id: folder.id, title: folder.title }));
}

/** Fetch one page at a time. Never treat an inaccessible or partial response as an empty folder. */
export async function readFavoriteSnapshot(
  mid: number,
  folderId: number,
  signal: AbortSignal,
): Promise<FavoriteSnapshot> {
  await requireLogin(mid);
  const tracks = new Map<string, PlaylistTrack>();
  let count: number | undefined;
  let seen = 0;
  let skipped = 0;
  for (let pn = 1; ; pn++) {
    signal.throwIfAborted();
    const res = await getFavResourceList({ media_id: String(folderId), ps: 20, pn, platform: "web", order: "mtime" });
    signal.throwIfAborted();
    if (res.code !== 0 || !res.data) throw new Error(res.message || "无法读取收藏夹内容");
    const { info, medias, has_more: more } = res.data;
    if (info?.mid !== mid || info.id !== folderId) throw new Error("该收藏夹不属于当前账号");
    count ??= info.media_count;
    if (
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count !== info.media_count ||
      typeof more !== "boolean" ||
      (!Array.isArray(medias) && !(count === 0 && medias == null))
    ) {
      throw new Error("收藏夹内容不完整，请稍后重试");
    }
    for (const item of medias ?? []) {
      const input =
        item?.attr === 0 &&
        (item.type === 2
          ? { type: "mv", bvid: item.bvid || item.bv_id, aid: String(item.id), title: item.title }
          : item.type === 12
            ? { type: "audio", sid: item.id, title: item.title }
            : undefined);
      const track = compactPlayData(input);
      if (track) {
        const key = trackKey(track);
        if (tracks.has(key)) throw new Error("分页期间收藏夹发生了变化，请重新预览");
        tracks.set(key, track);
      } else skipped++;
    }
    seen += medias?.length ?? 0;
    if (more ? !medias?.length || seen >= count : seen !== count)
      throw new Error("分页期间收藏夹发生了变化，请重新预览");
    if (!more)
      return {
        mid,
        folderId,
        title: displayName(info.title) || `收藏夹 ${folderId}`,
        tracks: Array.from(tracks.values()),
        skipped,
      };
  }
}
