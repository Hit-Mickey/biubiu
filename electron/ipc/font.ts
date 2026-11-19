import { ipcMain } from "electron";

import { channel } from "./channel";

export function registerFontHandlers() {
  ipcMain.handle(channel.font.getFonts, async () => {
    const { getFonts2 } = await import("font-list");
    return getFonts2();
  });
}
