import { z } from "zod";

import { exportDesktopPlaylists, importDesktopPlaylists, parseDesktopPlaylistsBackup } from "@/store/desktop-playlists";
import { compactPlayData, resolvePlaylistTracks } from "@/store/desktop-playlists/tracks";
import { getListeningHistory, parseHistory, replaceListeningHistory } from "@/store/listening-history";
import { usePlayList } from "@/store/play-list";
import { useSettings } from "@/store/settings";
import { backupFormat, isDesktopBackup, maxBackupBytes } from "@shared/desktop-backup";

// Positive list: never export login/proxy credentials, machine paths, media URLs or executables.
const portableSettings = z
  .object({
    themeMode: z.enum(["light", "dark", "system"]),
    displayMode: z.enum(["card", "list", "compact"]),
    audioQuality: z.enum(["auto", "lossless", "high", "medium", "low"]),
    pageTransition: z.enum(["none", "fade", "slide", "scale", "slideUp"]),
    primaryColor: z.string().regex(/^#[\da-f]{3,8}$/i),
    backgroundColor: z.string().regex(/^(#[\da-f]{3,8})?$/i),
    borderRadius: z.number().min(0).max(64),
    showSearchHistory: z.boolean(),
  })
  .partial();

function compactQueue(queue: unknown) {
  if (!Array.isArray(queue) || queue.length > 10000) throw new Error("备份队列无效（最多一万首）");
  return queue.map(row => {
    const track = compactPlayData(row);
    if (!track) throw new Error("备份包含无法识别的曲目");
    return track;
  });
}

function checkSize(text: string) {
  if (text.length > maxBackupBytes || new Blob([text]).size > maxBackupBytes) throw new Error("备份超过 8 MiB");
}

export function parseBackup(text: string) {
  checkSize(text);
  const raw = JSON.parse(text);
  if (!isDesktopBackup(raw)) throw new Error("不是支持的 BiuBiu 桌面曲库备份；旧版设置请使用“导入配置”");
  return {
    playlists: parseDesktopPlaylistsBackup(raw.playlists),
    history: parseHistory(raw.history),
    settings: portableSettings.parse(raw.settings),
    queue: compactQueue(raw.queue),
  };
}
export type LibraryBackup = ReturnType<typeof parseBackup>;

export async function createBackup() {
  const [playlists, history] = await Promise.all([exportDesktopPlaylists(), getListeningHistory()]);
  const text = JSON.stringify({
    format: backupFormat,
    version: 1,
    createdAt: new Date().toISOString(),
    playlists,
    history,
    settings: portableSettings.parse(useSettings.getState().getSettings()),
    queue: compactQueue(usePlayList.getState().list),
  });
  checkSize(text);
  return text;
}

export async function restoreBackup(backup: LibraryBackup) {
  const tracks = await resolvePlaylistTracks(backup.queue);
  if (tracks.length !== backup.queue.length)
    throw new Error("部分队列曲目无法定位，请先连接原音乐目录，再恢复。现有数据未修改。");
  const [oldPlaylists, oldHistory] = await Promise.all([exportDesktopPlaylists(), getListeningHistory()]);
  const oldQueue = usePlayList.getState();
  const oldPreferences = portableSettings.parse(useSettings.getState().getSettings());
  await importDesktopPlaylists(backup.playlists);
  try {
    await replaceListeningHistory(backup.history);
    // No restored file may start playing or trigger a network fetch without the user's action.
    oldQueue.clear();
    usePlayList.setState({ list: tracks });
    useSettings.getState().update(backup.settings);
  } catch (error) {
    await importDesktopPlaylists(oldPlaylists);
    await replaceListeningHistory(oldHistory);
    if (usePlayList.getState().list !== oldQueue.list) {
      usePlayList.getState().clear();
      usePlayList.setState({ list: oldQueue.list });
    }
    useSettings.getState().update(oldPreferences);
    throw error;
  }
}
