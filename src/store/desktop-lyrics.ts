import { create } from "zustand";

export const useDesktopLyrics = create<DesktopLyricsWindowState>(() => ({ open: false, locked: false }));
