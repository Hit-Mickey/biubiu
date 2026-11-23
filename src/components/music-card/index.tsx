import { memo, useMemo, type ReactNode } from "react";
import { Link as RouterLink } from "react-router";

import { Link } from "@heroui/react";
import { RiPlayFill, RiUserLine, RiYoutubeLine } from "@remixicon/react";

import { detectPlatform } from "@/bridge/env";
import { formatNumber } from "@/common/utils/number";
import { formatDuration, formatSecondsToDate } from "@/common/utils/time";
import { trackPressProps } from "@/common/utils/track-press";
import { userProfileOptions } from "@/common/utils/user-profile";
import ContextMenu, { type ContextMenuItem } from "@/components/context-menu";
import Image from "@/components/image";
import OperationMenu from "@/components/music-list-item/operation";
import { useTrackMenu } from "@/components/music-list-item/use-track-menu";

const android = detectPlatform() === "android";

export interface MusicCardProps {
  bvid?: string;
  sid?: number;
  cover: string;
  title: ReactNode;
  playCount?: number;
  duration?: number | string;
  ownerName?: string;
  ownerMid?: number;
  time?: number;
  menus: ContextMenuItem[];
  onMenuAction: (key: string) => void;
  onPress?: () => void;
}

const MusicCard = memo(
  ({
    bvid,
    sid,
    title,
    cover,
    playCount,
    duration,
    ownerName,
    ownerMid,
    time,
    menus,
    onMenuAction,
    onPress,
  }: MusicCardProps) => {
    const menu = useTrackMenu(menus, onMenuAction, { mid: ownerMid, name: ownerName, bvid, sid });
    const durationText = useMemo(() => {
      if (typeof duration === "number") return formatDuration(duration);
      if (typeof duration === "string") return duration;
      return undefined;
    }, [duration]);

    return (
      <div {...trackPressProps(onPress, "click")} className="rounded-medium flex h-full w-full cursor-pointer flex-col">
        <ContextMenu items={menu.items} onAction={menu.onAction} className="grow">
          <div className="group flex h-full grow flex-col">
            <div className="rounded-medium relative overflow-hidden">
              <Image radius="md" removeWrapper src={cover} width="100%" height={140} params="672w_378h_1c.avif" />
              {android || (playCount ?? 0) > 0 || durationText ? (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex items-center justify-between bg-linear-to-t from-black/90 via-black/60 to-transparent p-2 text-xs text-white">
                  {(android || (playCount ?? 0) > 0) && (
                    <div className="flex items-center gap-1">
                      <RiYoutubeLine size={14} />
                      <span aria-label="播放量">{formatNumber(playCount) ?? "—"}</span>
                    </div>
                  )}
                  {durationText && <span className="tabular-nums">{durationText}</span>}
                </div>
              ) : null}
              {!android && typeof onPress === "function" && (
                <div className="pointer-events-none absolute right-2 bottom-8 z-40 opacity-0 transition-opacity duration-200 ease-out group-hover:opacity-100">
                  <div className="bg-primary rounded-full shadow-2xl">
                    <div className="flex h-10 w-10 items-center justify-center">
                      <RiPlayFill className="text-black" size={26} />
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div className="mt-2 flex items-start justify-between">
              <div className="line-clamp-2 min-w-0 overflow-hidden wrap-break-word text-ellipsis">{title}</div>
              {android && menu.items.length > 0 && <OperationMenu items={menu.items} onAction={menu.onAction} />}
            </div>
          </div>
        </ContextMenu>
        {ownerName && (
          <div className="text-foreground-500 mt-1 flex items-center justify-between text-sm leading-none">
            {!android && ownerMid ? (
              <Link
                as={RouterLink}
                to={`/user/${ownerMid}`}
                state={userProfileOptions(ownerMid, ownerName).state}
                className="text-foreground-500 flex min-w-0 items-center gap-1 text-sm hover:underline"
              >
                <RiUserLine size={14} className="shrink-0" />
                <span className="truncate">{ownerName}</span>
              </Link>
            ) : (
              <span className="flex min-w-0 items-center gap-1 text-sm">
                <RiUserLine size={14} className="shrink-0" />
                <span className="truncate">{ownerName}</span>
              </span>
            )}
            {time && <span className="text-tiny shrink-0">{formatSecondsToDate(time)}</span>}
          </div>
        )}
      </div>
    );
  },
);

export default MusicCard;
