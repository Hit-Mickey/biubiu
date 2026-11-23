import { useState } from "react";

import { Button, Dropdown, DropdownItem, DropdownMenu, DropdownTrigger } from "@heroui/react";
import { RiMoreFill, RiMusic2Line, RiPlayFill } from "@remixicon/react";
import clx from "classnames";

import { detectPlatform } from "@/bridge/env";
import { formatNumber } from "@/common/utils/number";
import { trackPressProps } from "@/common/utils/track-press";
import Image from "@/components/image";
import { useTrackMenu } from "@/components/music-list-item/use-track-menu";
import { isBilibiliSource, type PlayData } from "@/store/play-list";

import { getMenus } from "./menu";

interface Props {
  data: PlayData;
  isLogin: boolean;
  isPlaying?: boolean;
  onAction: (key: string) => void;
  onClose: VoidFunction;
  onPress?: VoidFunction;
}

const ListItem = ({ data, isLogin, isPlaying, onAction, onClose, onPress }: Props) => {
  const android = detectPlatform() === "android";
  const isBilibili = isBilibiliSource(data.source);
  const menu = useTrackMenu(
    getMenus({ isLogin, isBilibili }),
    onAction,
    isBilibili ? { mid: data.ownerMid, name: data.ownerName, bvid: data.bvid, sid: data.sid } : undefined,
    onClose,
  );
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Button
      as="div"
      key={data.id}
      fullWidth
      disableAnimation
      variant={isPlaying ? "flat" : "light"}
      color={isPlaying ? "primary" : "default"}
      {...trackPressProps(onPress, "press")}
      className="group flex h-auto min-h-auto w-full min-w-auto items-center justify-between space-y-2 rounded-md p-2"
    >
      <div className="m-0 flex min-w-0 flex-1 items-center">
        <div className="relative h-12 w-12 flex-none">
          <Image
            removeWrapper
            radius="md"
            src={data.cover}
            alt={data.title}
            width={48}
            height={48}
            emptyPlaceholder={<RiMusic2Line className="text-default-500" />}
          />
          {!android && !isPlaying && (
            <div className="absolute inset-0 z-20 flex items-center justify-center rounded-md bg-[rgba(0,0,0,0.35)] opacity-0 group-hover:opacity-100">
              <RiPlayFill size={20} className="text-white transition-transform duration-200 group-hover:scale-110" />
            </div>
          )}
        </div>
        <div className="ml-2 flex min-w-0 flex-auto flex-col items-start space-y-1">
          <span className="w-full min-w-0 truncate text-base">{data.title}</span>
          <span
            className={clx("text-foreground-500 w-fit truncate text-sm", {
              "cursor-pointer hover:underline": !android && Boolean(data.ownerMid),
            })}
            onClick={
              android || !data.ownerMid
                ? undefined
                : e => {
                    e.stopPropagation();
                    menu.openProfile();
                  }
            }
          >
            {data.source === "local" ? "本地音乐" : data.ownerName || (data.source === "webdav" ? "WebDAV" : "未知")}
          </span>
        </div>
        {android && isBilibili && (
          <span className="text-default-500 shrink-0 px-1 text-xs tabular-nums" aria-label="播放量">
            {formatNumber(data.playCount) ?? "—"} 播放
          </span>
        )}
        <Dropdown
          disableAnimation
          isOpen={isOpen}
          onOpenChange={setIsOpen}
          classNames={{
            content: "min-w-fit",
          }}
        >
          <DropdownTrigger>
            <Button
              isIconOnly
              aria-label="歌曲操作"
              variant="light"
              size="sm"
              className={`flex-none transition-opacity duration-200 ${android || isOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"} group-hover:pointer-events-auto group-hover:opacity-100`}
            >
              <RiMoreFill size={16} />
            </Button>
          </DropdownTrigger>

          <DropdownMenu aria-label="播放列表操作菜单" items={menu.items} onAction={key => menu.onAction?.(String(key))}>
            {item => (
              <DropdownItem key={item.key} color={item.color} startContent={item.icon}>
                {item.label}
              </DropdownItem>
            )}
          </DropdownMenu>
        </Dropdown>
      </div>
    </Button>
  );
};

export default ListItem;
