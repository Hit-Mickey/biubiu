import { addToast } from "@heroui/react";
import {
  RiExternalLinkLine,
  RiFileMusicLine,
  RiFileVideoLine,
  RiPlayCircleLine,
  RiPlayListAddLine,
  RiStarLine,
} from "@remixicon/react";

import { openBiliVideoLink } from "@/common/utils/url";
import { useModalStore } from "@/store/modal";
import { usePlayList, type PlayItem } from "@/store/play-list";

const videoMenus = [
  {
    icon: <RiPlayCircleLine size={18} />,
    key: "play-next",
    label: "下一首播放",
  },
  {
    icon: <RiPlayListAddLine size={18} />,
    key: "add-to-playlist",
    label: "添加到播放列表",
  },
  {
    icon: <RiStarLine size={18} />,
    key: "favorite",
    label: "收藏",
  },
  {
    icon: <RiFileMusicLine size={18} />,
    key: "download-audio",
    label: "下载音频",
  },
  {
    icon: <RiFileVideoLine size={18} />,
    key: "download-video",
    label: "下载视频",
  },
  {
    icon: <RiExternalLinkLine size={18} />,
    key: "bililink",
    label: "在 B 站打开",
  },
];
const audioMenus = videoMenus.filter(item => item.key !== "download-video");
export const getContextMenus = (type: PlayItem["type"] = "mv") => (type === "audio" ? audioMenus : videoMenus);

export async function handleSearchTrackAction(key: string, track: PlayItem) {
  switch (key) {
    case "play-next":
      await usePlayList.getState().addToNext(track);
      addToast({ title: "已添加到下一首播放", color: "success" });
      break;
    case "add-to-playlist": {
      const queue = usePlayList.getState();
      const partKey = (item: PlayItem) => (item.bvid === track.bvid ? item.cid : undefined);
      await queue.addList([track], track.hasMultiPart && queue.list.length ? partKey : undefined);
      addToast({ title: "已添加到播放列表", color: "success" });
      break;
    }
    case "favorite": {
      const rid = track.type === "audio" ? track.sid : track.aid;
      if (rid)
        useModalStore
          .getState()
          .onOpenFavSelectModal({ rid, type: track.type === "audio" ? 12 : 2, title: `收藏 ${track.title}` });
      break;
    }
    case "download-audio":
    case "download-video":
      await window.electron.addMediaDownloadTask({
        outputFileType: key === "download-audio" ? "audio" : "video",
        title: track.pageTitle || track.title,
        cover: track.cover,
        bvid: track.bvid,
        sid: track.sid,
        cid: track.cid,
      });
      addToast({ title: "已添加下载任务", color: "success" });
      break;
    case "bililink":
      openBiliVideoLink(track);
      break;
  }
}
