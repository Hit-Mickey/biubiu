import { addToast, Button, Popover, PopoverContent, PopoverTrigger } from "@heroui/react";
import { RiClosedCaptioningLine } from "@remixicon/react";

import { useDesktopLyrics } from "@/store/desktop-lyrics";

import IconButton from "../icon-button";

export default function DesktopLyricsButton({
  className,
  onOpenChange,
}: {
  className?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const open = useDesktopLyrics(s => s.open);
  const locked = useDesktopLyrics(s => s.locked);
  const update = (request: Promise<void>) =>
    request.catch(() => addToast({ title: "桌面歌词窗口操作失败", color: "danger" }));

  return (
    <Popover placement="top-end" disableAnimation onOpenChange={onOpenChange}>
      <PopoverTrigger>
        <IconButton aria-label="桌面歌词" title="桌面歌词" className={className} color={open ? "primary" : "default"}>
          <RiClosedCaptioningLine size={16} />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent aria-label="桌面歌词" className="items-stretch gap-1 p-2">
        <Button size="sm" variant="light" onPress={() => void update(window.electron.setDesktopLyricsVisible(!open))}>
          {open ? "关闭桌面歌词" : "开启桌面歌词"}
        </Button>
        {open && (
          <Button
            size="sm"
            variant="light"
            onPress={() => void update(window.electron.setDesktopLyricsLocked(!locked))}
          >
            {locked ? "解锁歌词" : "锁定歌词（鼠标穿透）"}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
