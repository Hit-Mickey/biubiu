import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";

import { ipcMain } from "electron";

import type { ExternalPlaylistRef } from "@shared/external-playlist";

import type { IpcHandlerProps } from "./types";

import { channel } from "./channel";

export function registerExternalPlaylistHandlers({ getMainWindow }: IpcHandlerProps) {
  const isMainFrame = (event: IpcMainInvokeEvent | IpcMainEvent) =>
    event.sender === getMainWindow()?.webContents && event.senderFrame === event.sender.mainFrame;
  let active: { requestId: string; controller: AbortController } | undefined;

  ipcMain.handle(channel.externalPlaylist.read, async (event, ref: ExternalPlaylistRef, requestId: string) => {
    if (!isMainFrame(event) || typeof requestId !== "string" || !/^[\da-f-]{36}$/i.test(requestId)) {
      throw new Error("无效的歌单读取请求");
    }
    if (active && !active.controller.signal.aborted) throw new Error("已有歌单正在读取");
    const job = { requestId, controller: new AbortController() };
    active = job;
    const abort = () => job.controller.abort();
    event.sender.once("destroyed", abort);
    try {
      const { fetchPublicPlaylist } = await import("./api/external-playlist");
      return await fetchPublicPlaylist(ref, job.controller.signal);
    } finally {
      event.sender.removeListener("destroyed", abort);
      if (active === job) active = undefined;
    }
  });

  ipcMain.on(channel.externalPlaylist.cancel, (event, requestId: string) => {
    if (isMainFrame(event) && active && active.requestId === requestId) active.controller.abort();
  });
}
