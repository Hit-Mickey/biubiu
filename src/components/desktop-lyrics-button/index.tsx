import { useEffect, useState } from "react";

import { addToast, Button, Popover, PopoverContent, PopoverTrigger } from "@heroui/react";
import { RiClosedCaptioningLine } from "@remixicon/react";

import { useDesktopLyrics } from "@/store/desktop-lyrics";
import { desktopLyricsFontSizes } from "@shared/settings/desktop-lyrics";

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
  const appearance = useDesktopLyrics(s => s.appearance);
  const [menuOpen, setMenuOpen] = useState(false);
  const update = (request: Promise<void>) =>
    request.catch(() => addToast({ title: "桌面歌词窗口操作失败", color: "danger" }));

  useEffect(() => {
    if (!open && menuOpen) {
      setMenuOpen(false);
      onOpenChange?.(false);
    }
  }, [menuOpen, onOpenChange, open]);

  return (
    <Popover
      placement="top-end"
      disableAnimation
      shouldCloseOnBlur={false}
      isOpen={open && menuOpen}
      onOpenChange={next => {
        if (next && !open) {
          void update(window.electron.setDesktopLyricsVisible(true));
          return;
        }
        setMenuOpen(next);
        onOpenChange?.(next);
      }}
    >
      <PopoverTrigger>
        <IconButton aria-label="桌面歌词" title="桌面歌词" className={className} color={open ? "primary" : "default"}>
          <RiClosedCaptioningLine size={16} />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent aria-label="桌面歌词设置" className="min-w-44 items-stretch gap-1 p-2">
        <Button size="sm" variant="light" onPress={() => void update(window.electron.setDesktopLyricsLocked(!locked))}>
          {locked ? "解锁歌词" : "锁定歌词"}
        </Button>
        <label className="flex min-h-8 items-center justify-between gap-3 px-3 text-sm">
          颜色
          <input
            type="color"
            aria-label="桌面歌词颜色"
            className="h-6 w-10 cursor-pointer rounded border-0 bg-transparent"
            value={appearance.color}
            onChange={event =>
              void update(window.electron.setDesktopLyricsAppearance({ color: event.currentTarget.value }))
            }
          />
        </label>
        <label className="flex min-h-8 items-center justify-between gap-3 px-3 text-sm">
          字体大小
          <select
            aria-label="桌面歌词字体大小"
            className="bg-default-100 text-foreground rounded px-2 py-1 text-sm"
            value={appearance.fontSize}
            onChange={event =>
              void update(window.electron.setDesktopLyricsAppearance({ fontSize: Number(event.currentTarget.value) }))
            }
          >
            {desktopLyricsFontSizes.map(size => (
              <option key={size} value={size}>
                {size} px
              </option>
            ))}
          </select>
        </label>
        <Button size="sm" variant="light" onPress={() => void update(window.electron.setDesktopLyricsVisible(false))}>
          关闭桌面歌词
        </Button>
      </PopoverContent>
    </Popover>
  );
}
