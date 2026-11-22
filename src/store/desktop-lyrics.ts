import { addToast } from "@heroui/react";
import { create } from "zustand";

import { defaultDesktopLyricsAppearance } from "@shared/settings/desktop-lyrics";

export const useDesktopLyrics = create<DesktopLyricsWindowState>(() => ({
  open: false,
  locked: false,
  inlineUnlock: false,
  appearance: defaultDesktopLyricsAppearance,
}));

export async function toggleDesktopLyrics() {
  try {
    await window.electron.setDesktopLyricsVisible(!useDesktopLyrics.getState().open);
  } catch {
    addToast({ title: "桌面歌词窗口操作失败", color: "danger" });
  }
}
