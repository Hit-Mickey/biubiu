import { create } from "zustand";

import { defaultDesktopLyricsAppearance } from "@shared/settings/desktop-lyrics";

export const useDesktopLyrics = create<DesktopLyricsWindowState>(() => ({
  open: false,
  locked: false,
  inlineUnlock: false,
  appearance: defaultDesktopLyricsAppearance,
}));
