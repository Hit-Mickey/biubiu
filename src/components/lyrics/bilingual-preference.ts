import { invoke } from "@tauri-apps/api/core";

import { detectPlatform } from "@/bridge/env";
import { useDesktopLyrics } from "@/store/desktop-lyrics";
import { useFullScreenPlayerSettings } from "@/store/full-screen-player-settings";

const android = detectPlatform() === "android";

export const useSplitBilingual = android
  ? () => useFullScreenPlayerSettings(s => s.splitBilingual ?? true)
  : () => useDesktopLyrics(s => s.appearance.splitBilingual);

export async function setSplitBilingual(splitBilingual: boolean) {
  if (android) useFullScreenPlayerSettings.getState().update({ splitBilingual });
  else await window.electron.setDesktopLyricsAppearance({ splitBilingual });
}

export async function migrateMobileLyricsPreference() {
  if (useFullScreenPlayerSettings.getState().splitBilingual !== undefined) return;
  const saved = await invoke<Partial<DesktopLyricsAppearance> | null>("store_get", { name: "desktop-lyrics" });
  if (useFullScreenPlayerSettings.getState().splitBilingual === undefined) {
    useFullScreenPlayerSettings.getState().update({ splitBilingual: saved?.splitBilingual ?? true });
  }
}
