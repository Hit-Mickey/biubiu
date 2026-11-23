import { useNavigate } from "react-router";

import { addToast } from "@heroui/react";
import { RiUserLine } from "@remixicon/react";

import type { ContextMenuItem } from "@/components/context-menu";

import { detectPlatform } from "@/bridge/env";
import { userProfileOptions } from "@/common/utils/user-profile";
import { getAudioSongInfo } from "@/service/audio-song-info";
import { getWebInterfaceView } from "@/service/web-interface-view";

export interface TrackOwner {
  mid?: number;
  name?: string;
  bvid?: string;
  sid?: number;
}
const openProfileItem: ContextMenuItem = { key: "open-owner", label: "打开 UP 主主页", icon: <RiUserLine size={18} /> };

export function useTrackMenu(
  items: ContextMenuItem[],
  onAction?: (key: string) => void,
  owner?: TrackOwner,
  afterNavigate?: VoidFunction,
) {
  const navigate = useNavigate();
  const openProfile = async () => {
    if (!owner) return;
    let { mid, name } = owner;
    try {
      if (!mid && owner.bvid) {
        const { data } = await getWebInterfaceView({ bvid: owner.bvid });
        mid = data?.owner?.mid;
        name = data?.owner?.name;
      } else if (!mid && owner.sid) {
        const { data } = await getAudioSongInfo({ sid: owner.sid });
        mid = data?.uid;
        name = data?.uname;
      }
      if (!mid) throw new Error();
      navigate(`/user/${mid}`, userProfileOptions(mid, name));
      afterNavigate?.();
    } catch {
      addToast({ title: "暂时无法获取 UP 主信息", color: "warning" });
    }
  };
  if (detectPlatform() !== "android" || !(owner?.mid || owner?.bvid || owner?.sid))
    return { items, onAction, openProfile };
  return {
    items: [...items, openProfileItem],
    openProfile,
    onAction: (key: string) => {
      if (key === openProfileItem.key) void openProfile();
      else onAction?.(key);
    },
  };
}
