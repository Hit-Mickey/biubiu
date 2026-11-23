import { useState } from "react";

import { Checkbox } from "@heroui/react";
import { RiDeleteBinLine, RiFileCopyLine, RiPlayCircleLine, RiPlayFill, RiPlayListAddLine } from "@remixicon/react";
import clsx from "classnames";
import { filesize } from "filesize";

import type { WebDavTrack } from "@shared/webdav";

import { detectPlatform } from "@/bridge/env";
import { formatDuration, formatMillisecond } from "@/common/utils/time";
import { trackPressProps } from "@/common/utils/track-press";
import ContextMenu from "@/components/context-menu";
import IconButton from "@/components/icon-button";

import OperationMenu, { type LocalOperationItem } from "../local-music/operation";

const grid =
  "remote-track grid w-full grid-cols-[32px_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_54px_64px_54px_86px_36px] items-center gap-3 px-2";

interface HeaderProps {
  selecting: boolean;
  allSelected: boolean;
  someSelected: boolean;
  onSelectAll: (selected: boolean) => void;
}

export function RemoteTracksHeader({ selecting, allSelected, someSelected, onSelectAll }: HeaderProps) {
  return (
    <div className={clsx(grid, "text-default-500 min-h-9 text-xs")}>
      <span className="text-center">
        {selecting ? (
          <Checkbox
            aria-label="选择当前结果"
            size="sm"
            isSelected={allSelected}
            isIndeterminate={someSelected && !allSelected}
            onValueChange={onSelectAll}
          />
        ) : (
          "#"
        )}
      </span>
      <span>标题</span>
      <span>歌手</span>
      <span>专辑</span>
      <span className="text-right">格式</span>
      <span className="text-right">大小</span>
      <span className="text-right">时长</span>
      <span className="text-right">更新时间</span>
    </div>
  );
}

const menus: LocalOperationItem[] = [
  { key: "play", label: "播放", icon: <RiPlayFill size={18} /> },
  { key: "next", label: "下一首播放", icon: <RiPlayCircleLine size={18} /> },
  { key: "queue", label: "添加到播放列表", icon: <RiPlayListAddLine size={18} /> },
  { key: "copy", label: "复制歌曲名", icon: <RiFileCopyLine size={18} /> },
  { key: "remove", label: "移除歌曲", color: "danger", icon: <RiDeleteBinLine size={18} /> },
];

interface RowProps {
  track: WebDavTrack;
  number: number;
  active: boolean;
  selecting: boolean;
  selected: boolean;
  onSelect: (selected: boolean) => void;
  onAction: (key: string) => void;
}

export function RemoteTrackRow({ track, number, active, selecting, selected, onSelect, onAction }: RowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const filename = track.folder ? `${track.folder}/${track.filename}` : track.filename;
  return (
    <ContextMenu items={menus} onAction={onAction} disabled={menuOpen} contentClassName="w-[168px]">
      <div
        className={clsx(
          grid,
          "group h-11 rounded-md text-sm",
          active ? "bg-primary/15 text-primary" : "hover:bg-default-100",
        )}
        {...trackPressProps(selecting && detectPlatform() === "android" ? undefined : () => onAction("play"))}
      >
        {selecting ? (
          <Checkbox
            size="sm"
            aria-label={`选择 ${track.title}`}
            isSelected={selected}
            onValueChange={onSelect}
            onDoubleClick={event => event.stopPropagation()}
          />
        ) : detectPlatform() === "android" ? (
          <span className="text-center text-xs tabular-nums">{number}</span>
        ) : (
          <IconButton
            aria-label={`播放 ${track.title}`}
            onPress={() => onAction("play")}
            className="h-7 w-7 min-w-7 tabular-nums"
          >
            <span className="text-xs group-focus-within:hidden group-hover:hidden">{number}</span>
            <RiPlayFill size={16} className="hidden group-focus-within:block group-hover:block" />
          </IconButton>
        )}
        <span className="truncate font-medium" title={filename}>
          {track.title}
        </span>
        <span className="text-default-500 truncate" title={track.artist}>
          {track.artist || "—"}
        </span>
        <span className="text-default-500 truncate" title={track.album}>
          {track.album || "—"}
        </span>
        <span className="text-default-500 text-right text-xs uppercase">{track.format}</span>
        <span className="text-default-500 text-right text-xs tabular-nums">
          {track.size === undefined ? "—" : filesize(track.size)}
        </span>
        <span className="text-default-500 text-right text-xs tabular-nums">
          {track.duration ? formatDuration(Math.round(track.duration)) : "—"}
        </span>
        <span className="text-default-500 text-right text-xs tabular-nums">
          {formatMillisecond(track.modifiedAt) || "—"}
        </span>
        <div className="flex justify-end" onDoubleClick={event => event.stopPropagation()}>
          <OperationMenu items={menus} onOpenChange={setMenuOpen} onAction={onAction} />
        </div>
      </div>
    </ContextMenu>
  );
}
