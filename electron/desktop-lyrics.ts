import { app, BrowserWindow, ipcMain, screen } from "electron";
import Store from "electron-store";
import { fileURLToPath } from "node:url";

import { defaultDesktopLyricsAppearance, normalizeDesktopLyricsAppearance } from "@shared/settings/desktop-lyrics";

import { channel } from "./ipc/channel";
import { getUserDataPath } from "./utils";

const entry = fileURLToPath(new URL("../dist/web/desktop-lyrics.html", import.meta.url));
const preload = fileURLToPath(new URL("./preload.cjs", import.meta.url));
const inlineUnlock = process.platform === "win32" || process.platform === "darwin";

function watchLyricsHover(window: BrowserWindow) {
  const platform = app.commandLine.getSwitchValue("ozone-platform");
  if (process.platform === "linux" && platform !== "x11") {
    if (platform === "wayland" || process.env.XDG_SESSION_TYPE === "wayland") return;
  }

  // Native drag regions do not deliver DOM mouse events.
  let previous: boolean | undefined;
  const sample = () => {
    const cursor = screen.getCursorScreenPoint();
    const { x, y, width, height } = window.getBounds();
    const hovered =
      window.isVisible() && cursor.x >= x && cursor.x < x + width && cursor.y >= y && cursor.y < y + height;
    if (hovered === previous) return;
    previous = hovered;
    window.webContents.send(channel.desktopLyrics.hover, hovered);
  };
  const timer = setInterval(sample, 80);
  window.once("closed", () => clearInterval(timer));
  sample();
}

export function registerDesktopLyricsHandlers(getMainWindow: () => BrowserWindow | null | undefined) {
  let overlay: BrowserWindow | undefined;
  let open = false;
  let locked = false;
  let preferences: Store<DesktopLyricsAppearance> | undefined;
  let appearance = defaultDesktopLyricsAppearance;

  const notify = (owner: BrowserWindow) => {
    const state: DesktopLyricsWindowState = { open, locked, inlineUnlock, appearance };
    if (!owner.isDestroyed()) owner.webContents.send(channel.desktopLyrics.state, state);
    if (open) overlay?.webContents.send(channel.desktopLyrics.state, state);
  };

  const acceptsControls = (sender: Electron.WebContents, owner: BrowserWindow) =>
    sender === owner.webContents || sender === overlay?.webContents;

  ipcMain.handle(channel.desktopLyrics.visible, async (event, visible: boolean) => {
    const owner = getMainWindow();
    if (!owner || event.sender !== owner.webContents || typeof visible !== "boolean") return;
    if (!visible) {
      overlay?.destroy();
      return;
    }
    if (overlay) return;

    preferences ??= new Store<DesktopLyricsAppearance>({
      name: "desktop-lyrics",
      cwd: getUserDataPath(),
      defaults: defaultDesktopLyricsAppearance,
    });
    appearance = normalizeDesktopLyricsAppearance(preferences.store);

    const area = screen.getDisplayMatching(owner.getBounds()).workArea;
    const width = Math.min(800, area.width - 24);
    const height = 144;
    const lyricsWindow = new BrowserWindow({
      title: "桌面歌词",
      x: area.x + Math.round((area.width - width) / 2),
      y: area.y + area.height - height - 20,
      width,
      height,
      frame: false,
      transparent: true,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      webPreferences: {
        preload,
        additionalArguments: ["--biubiu-desktop-lyrics"],
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    overlay = lyricsWindow;
    const close = () => lyricsWindow.destroy();
    owner.once("closed", close);
    lyricsWindow.once("closed", () => {
      owner.removeListener("closed", close);
      overlay = undefined;
      open = false;
      locked = false;
      notify(owner);
    });
    lyricsWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    lyricsWindow.webContents.on("will-navigate", event => event.preventDefault());

    try {
      await lyricsWindow.loadFile(entry);
      if (lyricsWindow.isDestroyed()) return;
      lyricsWindow.showInactive();
      lyricsWindow.setAlwaysOnTop(true);
      open = true;
      notify(owner);
      watchLyricsHover(lyricsWindow);
    } catch (error) {
      if (lyricsWindow.isDestroyed()) return;
      close();
      throw error;
    }
  });

  ipcMain.handle(channel.desktopLyrics.locked, (event, next: boolean) => {
    const owner = getMainWindow();
    if (!owner || !overlay || !open || !acceptsControls(event.sender, owner) || typeof next !== "boolean") return;
    if (locked === next) return;
    locked = next;
    overlay.setIgnoreMouseEvents(locked, { forward: locked && inlineUnlock });
    notify(owner);
  });

  ipcMain.on(channel.desktopLyrics.unlockHovered, (event, hovered: boolean) => {
    if (inlineUnlock && open && locked && event.sender === overlay?.webContents && typeof hovered === "boolean") {
      overlay.setIgnoreMouseEvents(!hovered, { forward: !hovered });
    }
  });

  ipcMain.handle(channel.desktopLyrics.appearance, (event, patch: Partial<DesktopLyricsAppearance>) => {
    const owner = getMainWindow();
    if (!owner || !open || !preferences || !acceptsControls(event.sender, owner)) return;
    const next = normalizeDesktopLyricsAppearance(patch, appearance);
    if (next.color === appearance.color && next.fontSize === appearance.fontSize) return;
    preferences.set(next);
    appearance = next;
    notify(owner);
  });

  ipcMain.on(channel.desktopLyrics.line, (event, line: DesktopLyricLine) => {
    if (open && event.sender === getMainWindow()?.webContents) {
      overlay?.webContents.send(channel.desktopLyrics.line, line);
    }
  });
}
