import { ipcMain } from "electron";

import type { WebDavListInput, WebDavPreferences } from "@shared/webdav";

import type { IpcHandlerProps } from "./types";

import { clearWebDavCache } from "../webdav/cache";
import {
  deleteWebDavList,
  getWebDavLibrary,
  getWebDavLyrics,
  getWebDavTrackMetadata,
  refreshWebDavList,
  removeWebDavTracks,
  saveWebDavList,
  setWebDavPreferences,
  startWebDavSync,
  testWebDavList,
  webDavLibraryEvents,
} from "../webdav/library";
import { channel } from "./channel";

export function registerWebDavHandlers({ getMainWindow }: IpcHandlerProps) {
  const dav = channel.webdav;
  ipcMain.handle(dav.library, () => getWebDavLibrary());
  ipcMain.handle(dav.testList, (_, list: WebDavListInput) => testWebDavList(list));
  ipcMain.handle(dav.saveList, (_, list: WebDavListInput) => saveWebDavList(list));
  ipcMain.handle(dav.refreshList, (_, id: string) => refreshWebDavList(id));
  ipcMain.handle(dav.deleteList, (_, id: string) => deleteWebDavList(id));
  ipcMain.handle(dav.removeTracks, (_, id: string, tracks: string[], deleteFiles: boolean) =>
    removeWebDavTracks(id, tracks, deleteFiles),
  );
  ipcMain.handle(dav.metadata, (_, listId: string, trackId: string) => getWebDavTrackMetadata(listId, trackId));
  ipcMain.handle(dav.lyrics, (_, listId: string, trackId: string) => getWebDavLyrics(listId, trackId));
  ipcMain.handle(dav.preferences, (_, settings: WebDavPreferences) => setWebDavPreferences(settings));
  ipcMain.handle(dav.clearCache, () => clearWebDavCache());
  webDavLibraryEvents.on("change", (removed: string[] = []) => {
    const window = getMainWindow();
    if (window && !window.isDestroyed()) window.webContents.send(dav.changed, removed);
  });
  startWebDavSync();
}
