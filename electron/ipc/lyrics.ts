import { ipcMain } from "electron";

import { applyLyricChange, assertLyricsKey } from "@shared/lyrics";

import { appSettingsStore, getLyricsCacheStore } from "../store";
import { channel } from "./channel";

export function registerLyricsHandlers() {
  ipcMain.handle(channel.lyrics.getTrack, (_, key: string) => {
    assertLyricsKey(key);
    return getLyricsCacheStore().get(key);
  });
  ipcMain.handle(channel.lyrics.updateTrack, (_, key: string, change: TrackLyricChange) => {
    assertLyricsKey(key);
    const store = getLyricsCacheStore();
    const next = applyLyricChange(store.get(key) ?? {}, change);
    if (Object.keys(next).length) store.set(key, next);
    else store.delete(key);
  });
  ipcMain.handle(channel.lyrics.readLocal, async (_, audioUrl: string) => {
    const { readLocalLyrics } = await import("./api/local-lyrics");
    return readLocalLyrics(audioUrl, appSettingsStore.get("appSettings").localMusicDirs);
  });
  ipcMain.handle(channel.lyrics.searchQQ, async (_, keyword: string) => {
    const { searchQQ } = await import("./api/qq-lyrics");
    return searchQQ(keyword);
  });
  ipcMain.handle(channel.lyrics.getQQ, async (_, mid: string) => {
    const { getQQLyrics } = await import("./api/qq-lyrics");
    return getQQLyrics(mid);
  });
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
