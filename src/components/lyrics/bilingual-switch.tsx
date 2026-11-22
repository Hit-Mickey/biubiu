import { addToast, Switch } from "@heroui/react";

import { useDesktopLyrics } from "@/store/desktop-lyrics";

export default function BilingualLyricsSwitch({ compact = false }: { compact?: boolean }) {
  const split = useDesktopLyrics(s => s.appearance.splitBilingual);
  return (
    <Switch
      aria-label="双语歌词分行"
      size={compact ? "sm" : "md"}
      isSelected={split}
      onValueChange={splitBilingual => {
        void window.electron.setDesktopLyricsAppearance({ splitBilingual }).catch(() => {
          addToast({ title: "歌词显示设置保存失败", color: "danger" });
        });
      }}
      classNames={{
        base: compact ? "gap-1 p-0" : "w-full max-w-none flex-row-reverse justify-between",
        wrapper: "m-0",
        label: compact ? "text-xs" : "ms-0",
      }}
    >
      {compact ? "分行" : "双语歌词分行"}
    </Switch>
  );
}
