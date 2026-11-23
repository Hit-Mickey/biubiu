import { invoke } from "@tauri-apps/api/core";

import type { PlayItem } from "@/store/play-list";

import { parseBiliSearch, type BiliSearchTarget } from "@/common/utils/bili-search";
import { formatUrlProtocol } from "@/common/utils/url";
import { getAudioSongInfo } from "@/service/audio-song-info";
import { getWebInterfaceView } from "@/service/web-interface-view";

export async function resolveSearchTrack(
  target: BiliSearchTarget,
  signal: AbortSignal,
): Promise<{ track: PlayItem; published: number }> {
  let media = target;
  if (media.kind === "short") {
    const url = await invoke<string>("resolve_bili_short_link", { code: media.code });
    signal.throwIfAborted();
    const resolved = parseBiliSearch(url);
    if (resolved?.kind !== "video" && resolved?.kind !== "audio") throw new Error("该短链接没有指向 B 站视频或音频");
    media = resolved;
  }
  if (media.kind === "unsupported") throw new Error("请输入 B 站视频或音频链接");
  if (media.kind === "audio") {
    const { code, data, msg } = await getAudioSongInfo({ sid: media.sid }, { signal });
    if (code !== 0 || !data) throw new Error((code !== 0 && msg) || "该音频暂时无法访问");
    return {
      track: {
        type: "audio",
        sid: data.id,
        title: data.title,
        cover: formatUrlProtocol(data.cover),
        duration: data.duration,
        ownerMid: data.uid,
        ownerName: data.author || data.uname,
        playCount: data.statistic?.play,
      },
      published: data.passtime,
    };
  }
  const params = media.id.startsWith("BV") ? { bvid: media.id } : { aid: Number(media.id.slice(2)) };
  const { code, data, message } = await getWebInterfaceView(params, { signal });
  if (code !== 0 || !data) throw new Error((code !== 0 && message) || "该视频暂时无法访问");
  const totalPage = data.pages?.length || data.videos || 1;
  const requestedPage = media.page;
  const part = requestedPage ? data.pages?.find(part => part.page === requestedPage) : undefined;
  if (requestedPage && !part && !(requestedPage === 1 && totalPage === 1 && data.cid)) {
    throw new Error(`该视频没有第 ${requestedPage} 个分 P`);
  }
  const cid = part?.cid ?? (totalPage === 1 ? data.cid : undefined);
  return {
    track: {
      type: "mv",
      bvid: data.bvid,
      aid: String(data.aid),
      title: data.title,
      cover: formatUrlProtocol(data.pic),
      duration: part?.duration ?? data.duration,
      ownerName: data.owner?.name,
      ownerMid: data.owner?.mid,
      playCount: data.stat?.view,
      ...(cid && {
        cid: String(cid),
        pageIndex: part?.page ?? 1,
        totalPage,
        hasMultiPart: totalPage > 1,
        pageTitle: totalPage > 1 ? part?.part : data.title,
      }),
    },
    published: data.pubdate,
  };
}
