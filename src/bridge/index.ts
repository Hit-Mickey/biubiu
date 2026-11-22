import { installWindowDragHandler } from "./drag";
import { isTauriRuntime } from "./env";
import { createTauriDesktopLyricsAPI, createTauriElectronAPI } from "./tauri";

function installDesktopBridge(mode: "main" | "mini" | "desktop-lyrics" = "main") {
  if (!isTauriRuntime() || typeof window === "undefined") return;

  if (!window.electron) {
    window.electron = createTauriElectronAPI();
  }

  if (mode === "desktop-lyrics" && !window.desktopLyrics) {
    window.desktopLyrics = createTauriDesktopLyricsAPI();
  }

  if (mode === "main") {
    installWindowDragHandler({ allowMaximizeDoubleClick: true, dragSelector: ".window-drag" });
  } else if (mode === "mini") {
    installWindowDragHandler({ allowMaximizeDoubleClick: false, dragSelector: ".window-drag" });
  } else if (mode === "desktop-lyrics") {
    installWindowDragHandler({ allowMaximizeDoubleClick: false, dragSelector: ".lyrics" });
  }
}

// Auto-install on import so top-level `window.electron.getPlatform()` calls succeed synchronously.
if (isTauriRuntime() && typeof window !== "undefined") {
  const label = window.__BIUBIU_RUNTIME__?.windowLabel;
  const mode = label === "mini" ? "mini" : label === "desktop-lyrics" ? "desktop-lyrics" : "main";
  installDesktopBridge(mode);
}
