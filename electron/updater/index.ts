import type { BrowserWindow } from "electron";
import type { AppUpdater } from "electron-updater";

import isDev from "electron-is-dev";
import log from "electron-log";
import path from "node:path";

import { updateRepository } from "@shared/app";

import { channel } from "../ipc/channel";

let updater: AppUpdater | undefined;
let updaterPromise: Promise<AppUpdater> | undefined;
let getMainWindow: () => BrowserWindow | null = () => null;
let checkForUpdatesInterval: NodeJS.Timeout | undefined;
const noPublishedReleasesMessage = "No published versions on GitHub";

function noPublishedReleases(error: unknown) {
  if (typeof error === "string") {
    // electron-updater's default listener logs the formatted stack as a string.
    const [firstLine] = error.split(/\r?\n/, 1);
    return firstLine.replace(/^(?:Error: )+/, "") === noPublishedReleasesMessage;
  }
  return (
    error instanceof Error &&
    (error.message === noPublishedReleasesMessage ||
      ("code" in error && error.code === "ERR_UPDATER_NO_PUBLISHED_VERSIONS"))
  );
}

function configure(autoUpdater: AppUpdater) {
  autoUpdater.logger = {
    info: log.info,
    warn: log.warn,
    debug: log.debug,
    error: message => {
      if (!noPublishedReleases(message)) log.error(message);
    },
  };
  log.transports.file.level = "info";
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.allowPrerelease = true;
  autoUpdater.setFeedURL({ provider: "github", ...updateRepository });

  if (isDev) {
    autoUpdater.updateConfigPath = path.resolve(process.cwd(), "electron/updater/dev-app-update.yml");
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.autoRunAppAfterInstall = false;
  }

  const send = (name: string, value: object) => {
    const window = getMainWindow();
    if (window && !window.isDestroyed()) window.webContents.send(name, value);
  };

  autoUpdater.on("update-available", info => {
    send(channel.app.onUpdateAvailable, {
      latestVersion: info.version,
      releaseNotes: info.releaseNotes,
    });
  });

  autoUpdater.on("download-progress", progressObj => {
    send(channel.app.updateMessage, {
      status: "downloading",
      processInfo: progressObj,
    });
  });

  autoUpdater.on("error", error => {
    if (noPublishedReleases(error)) return;
    send(channel.app.updateMessage, {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  });

  autoUpdater.on("update-downloaded", info => {
    send(channel.app.updateMessage, {
      status: "downloaded",
      downloadInfo: {
        filePath: info.downloadedFile,
      },
    });
  });

  return autoUpdater;
}

export function getAutoUpdater() {
  updaterPromise ??= import("electron-updater")
    .then(({ default: electronUpdater }) => (updater = configure(electronUpdater.autoUpdater)))
    .catch(error => {
      updaterPromise = undefined;
      throw error;
    });
  return updaterPromise;
}

export async function checkForAppUpdates(): Promise<CheckAppUpdateResult> {
  try {
    const result = await (await getAutoUpdater()).checkForUpdates();
    if (result?.isUpdateAvailable) {
      return {
        isUpdateAvailable: true,
        latestVersion: result.updateInfo.version,
        releaseNotes: result.updateInfo.releaseNotes as string,
      };
    }
    return { isUpdateAvailable: false };
  } catch (error) {
    if (noPublishedReleases(error)) {
      log.info("[updater] GitHub 暂无已发布版本");
      return { isUpdateAvailable: false, noPublishedReleases: true };
    }
    throw error;
  }
}

export function setupAutoUpdater(getWindow: () => BrowserWindow | null) {
  getMainWindow = getWindow;
  const check = () => void checkForAppUpdates().catch(error => log.warn("[updater] 检查更新失败", error));
  check();
  checkForUpdatesInterval = setInterval(check, 60 * 60 * 1000).unref();
}

export function stopCheckForUpdates() {
  clearInterval(checkForUpdatesInterval);
  checkForUpdatesInterval = undefined;
  updater?.removeAllListeners();
}
