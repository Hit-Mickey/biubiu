import type { ReactNode } from "react";

import { Button } from "@heroui/react";
import clx from "classnames";

import { detectPlatform } from "@/bridge/env";
import { formatDuration } from "@/common/utils/time";
import { trackPressProps } from "@/common/utils/track-press";
import ContextMenu, { type ContextMenuItem } from "@/components/context-menu";
import Image from "@/components/image";
import OperationMenu from "@/components/music-list-item/operation";
import { useTrackMenu } from "@/components/music-list-item/use-track-menu";
import { isSame, usePlayList } from "@/store/play-list";

interface Props {
  index: number;
  title: ReactNode;
  cover?: string;
  upName?: string;
  upMid?: number;
  progress?: number;
  duration?: number;
  viewAt?: string;
  bvid?: string;
  type?: "audio" | "mv";
  onPress?: () => void;
  menus: ContextMenuItem[];
  onMenuAction?: (key: string) => void;
  isCompact?: boolean;
}

const HistoryListItem = ({
  index,
  title,
  cover,
  upName,
  upMid,
  progress = 0,
  duration = 0,
  viewAt,
  bvid,
  type = "mv",
  onPress,
  menus,
  onMenuAction,
  isCompact,
}: Props) => {
  const android = detectPlatform() === "android";
  const menu = useTrackMenu(menus, onMenuAction, { mid: upMid, name: upName, bvid });
  const author = (
    <span
      className={clx("text-foreground-500 max-w-full truncate", isCompact ? "text-sm" : "text-xs", {
        "cursor-pointer hover:underline": !android && upMid,
      })}
      onClick={
        android || !upMid
          ? undefined
          : event => {
              event.stopPropagation();
              menu.openProfile();
            }
      }
    >
      {upName || "未知"}
    </span>
  );
  const playId = usePlayList(state => state.playId);
  const list = usePlayList(state => state.list);
  const playItem = list.find(item => item.id === playId);
  const isPlay = isSame(playItem, { type, bvid });

  const gridCols = isCompact ? "grid-cols-[40px_1fr_150px_150px_150px_40px]" : "grid-cols-[40px_1fr_150px_150px_40px]";

  const formatProgress = (prog: number, dur: number) => {
    const p = formatDuration(prog > 0 ? prog : 0);
    const d = formatDuration(dur > 0 ? dur : 0);
    return `${p} / ${d}`;
  };

  return (
    <ContextMenu items={menu.items} onAction={menu.onAction}>
      <Button
        as="div"
        fullWidth
        disableAnimation
        variant={isPlay ? "flat" : "light"}
        color={isPlay ? "primary" : "default"}
        {...trackPressProps(onPress)}
        className={clx(
          "group flex w-full items-center justify-between rounded-md",
          isCompact ? "h-9 min-h-9 min-w-0 px-0 text-sm" : "h-auto min-h-auto min-w-auto space-y-2 p-2",
        )}
      >
        <div className={clx("browse-track grid w-full items-center gap-4", gridCols)}>
          {/* 1. # */}
          <div className="text-foreground-500 text-center text-xs tabular-nums">{index}</div>

          {/* 2. Title (Cover + Title) */}
          <div className="flex min-w-0 items-center overflow-hidden">
            {!isCompact && (
              <div className="relative h-12 w-12 flex-none">
                <Image
                  removeWrapper
                  radius="md"
                  src={cover}
                  width="100%"
                  height="100%"
                  className="m-0"
                  params="760w_428h_1c.avif"
                />
              </div>
            )}
            <div className={clx("flex min-w-0 flex-col items-start justify-center space-y-1", { "ml-2": !isCompact })}>
              <span
                className={clx("w-full truncate text-left text-sm font-medium", {
                  "text-primary": isPlay,
                })}
                title={typeof title === "string" ? title : undefined}
              >
                {title}
              </span>
              {!isCompact && author}
            </div>
          </div>

          {/* 3. UP (Compact only) */}
          {isCompact && <div className="min-w-0 truncate text-left">{author}</div>}

          {/* 4. Progress/Duration */}
          <div className="text-foreground-500 text-right text-xs tabular-nums">
            {formatProgress(progress, duration)}
          </div>

          {/* 5. View Time */}
          <div className="text-foreground-500 text-right text-xs">{viewAt}</div>

          {/* 6. Actions */}
          <div className="flex h-full items-center justify-end">
            <OperationMenu items={menu.items} onAction={menu.onAction} />
          </div>
        </div>
      </Button>
    </ContextMenu>
  );
};

export default HistoryListItem;
