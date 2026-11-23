import type { ToViewVideoItem } from "@/service/history-toview-list";
import type { PlayItem } from "@/store/play-list";

export function toPlayItem(item: ToViewVideoItem): PlayItem {
  return {
    type: "mv",
    bvid: item.bvid,
    title: item.title,
    cover: item.pic,
    playCount: item.stat?.view,
    ownerName: item.owner?.name,
    ownerMid: item.owner?.mid,
    // The list already identifies the only part. Multi-part videos still need the full page list.
    ...(item.videos === 1 &&
      Number.isSafeInteger(item.cid) &&
      item.cid > 0 && {
        aid: String(item.aid),
        cid: String(item.cid),
        duration: item.duration,
        pageIndex: 1,
        totalPage: 1,
      }),
  };
}
