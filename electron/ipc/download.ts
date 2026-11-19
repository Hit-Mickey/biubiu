import { ipcMain } from "electron";

import type { DownloadQueue } from "./download/download-queue";
import type { IpcHandlerProps } from "./types";

import { channel } from "./channel";

let downloadQueue: DownloadQueue | undefined;

export function registerDownloadHandlers({ getMainWindow }: IpcHandlerProps) {
  let queuePromise: Promise<DownloadQueue> | undefined;
  const getQueue = () => {
    queuePromise ??= import("./download/download-queue")
      .then(({ DownloadQueue }) => (downloadQueue = new DownloadQueue(getMainWindow)))
      .catch(error => {
        queuePromise = undefined;
        throw error;
      });
    return queuePromise;
  };

  ipcMain.handle(channel.download.getList, async () => {
    return (await getQueue()).getTaskList();
  });

  ipcMain.handle(channel.download.add, async (_, task: MediaDownloadTask) => {
    return (await getQueue()).addTask(task);
  });

  ipcMain.handle(channel.download.addList, async (_, tasks: MediaDownloadTask[]) => {
    return (await getQueue()).addTasks(tasks);
  });

  ipcMain.handle(channel.download.pause, async (_, id: string) => {
    (await getQueue()).pauseTask(id);
  });

  ipcMain.handle(channel.download.resume, async (_, id: string) => {
    (await getQueue()).resumeTask(id);
  });

  ipcMain.handle(channel.download.cancel, async (_, id: string) => {
    await (await getQueue()).cancelTask(id);
  });

  ipcMain.handle(channel.download.retry, async (_, id: string) => {
    (await getQueue()).retryTask(id);
  });

  ipcMain.handle(channel.download.clear, async () => {
    await (await getQueue()).clearTasks();
  });
}

export function quitAndSaveTasks() {
  downloadQueue?.quitAndSave();
}
