import { ipcMain } from "electron";

import { channel } from "./channel";

export function registerLyricsHandlers() {
  ipcMain.handle(channel.lyrics.searchNeteaseSongs, async (_, params: SearchSongByNeteaseParams) => {
    const { getSongByNetease } = await import("./api/netease-lyric");
    return getSongByNetease(params);
  });

  ipcMain.handle(channel.lyrics.getNeteaseLyrics, async (_, params: GetLyricsByNeteaseParams) => {
    const { getLyricsByNetease } = await import("./api/netease-lyric");
    return getLyricsByNetease(params);
  });

  ipcMain.handle(channel.lyrics.searchLrclib, async (_, params: SearchSongByLrclibParams) => {
    const { getLyricsByLrclib } = await import("./api/lrclib-lyric");
    return getLyricsByLrclib(params);
  });
}
