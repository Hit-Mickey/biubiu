import { BrowserWindow, ipcMain, screen } from "electron";
import { fileURLToPath } from "node:url";

import { channel } from "./ipc/channel";

const entry = fileURLToPath(new URL("../dist/web/desktop-lyrics.html", import.meta.url));
const preload = fileURLToPath(new URL("./preload.cjs", import.meta.url));

export function registerDesktopLyricsHandlers(getMainWindow: () => BrowserWindow | null | undefined) {
  let overlay: BrowserWindow | undefined;
  let open = false;
  let locked = false;

  const notify = (owner: BrowserWindow) => {
    if (!owner.isDestroyed()) owner.webContents.send(channel.desktopLyrics.state, { open, locked });
  };

  ipcMain.handle(channel.desktopLyrics.visible, async (event, visible: boolean) => {
    const owner = getMainWindow();
    if (!owner || event.sender !== owner.webContents || typeof visible !== "boolean") return;
    if (!visible) {
      overlay?.destroy();
      return;
    }
    if (overlay) return;

    const area = screen.getDisplayMatching(owner.getBounds()).workArea;
    const width = Math.min(800, area.width - 24);
    const height = 108;
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
    } catch (error) {
      if (lyricsWindow.isDestroyed()) return;
      close();
      throw error;
    }
  });

  ipcMain.handle(channel.desktopLyrics.locked, (event, next: boolean) => {
    const owner = getMainWindow();
    if (!owner || !overlay || !open || event.sender !== owner.webContents || typeof next !== "boolean") return;
    overlay.setIgnoreMouseEvents(next);
    locked = next;
    notify(owner);
  });

  ipcMain.on(channel.desktopLyrics.line, (event, line: DesktopLyricLine) => {
    if (open && event.sender === getMainWindow()?.webContents) {
      overlay?.webContents.send(channel.desktopLyrics.line, line);
    }
  });
}
