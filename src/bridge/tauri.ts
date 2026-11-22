import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { BackupTarget } from "@shared/desktop-backup";
import type { ExternalPlaylist, ExternalPlaylistRef } from "@shared/external-playlist";
import type { WebDavLibrary, WebDavRemoveResult, WebDavTrack } from "@shared/webdav";

import { detectPlatform } from "./env";

function subscribeEvent<T>(eventName: string, cb: (payload: T) => void): VoidFunction {
  let active = true;
  let unlisten: UnlistenFn | null = null;

  void listen<T>(eventName, event => {
    if (active) cb(event.payload);
  }).then(fn => {
    if (active) unlisten = fn;
    else fn();
  });

  return () => {
    active = false;
    unlisten?.();
    unlisten = null;
  };
}

export function createTauriElectronAPI(): ElectronAPI {
  const platform = detectPlatform();

  return {
    getStore: name => invoke("store_get", { name }),
    setStore: (name, value) => invoke("store_set", { name, value }),
    clearStore: name => invoke("store_clear", { name }),

    selectDirectory: title => invoke<string | null>("dialog_select_directory", { title }),
    selectFile: () => invoke<string | null>("dialog_select_file"),
    showFileInFolder: filePath => invoke<boolean>("shell_show_file_in_folder", { filePath }),
    openDirectory: path => invoke<boolean>("shell_open_directory", { path }),
    openExternal: url => invoke<boolean>("shell_open_external", { url }),

    getFonts: () => invoke<IFontInfo[]>("font_get_list"),

    navigate: cb => subscribeEvent<string>("router://navigate", cb),

    getCookie: key => invoke<string | undefined>("cookie_get", { key }),
    setCookie: (name, value, expirationDate) => invoke("cookie_set", { name, value, expirationDate }),

    externalPlaylist: {
      read: (ref: ExternalPlaylistRef, requestId: string) =>
        invoke<ExternalPlaylist>("external_playlist_read", { playlistRef: ref, requestId }),
      cancel: (requestId: string) => {
        void invoke("external_playlist_cancel", { requestId }).catch(() => undefined);
      },
    },

    searchNeteaseSongs: params => invoke<SearchSongByNeteaseResponse>("lyrics_search_netease", { params }),
    getNeteaseLyrics: params => invoke<GetLyricsByNeteaseResponse>("lyrics_get_netease", { params }),
    searchLrclibLyrics: params => invoke<SearchSongByLrclibResponse[]>("lyrics_search_lrclib", { params }),
    searchQQLyricSongs: keyword => invoke<QQLyricSong[]>("lyrics_search_qq", { keyword }),
    getQQLyrics: mid => invoke<LyricText>("lyrics_get_qq", { mid }),
    getTrackLyrics: key => invoke<MusicLyrics | undefined>("lyrics_get_track", { key }),
    updateTrackLyrics: (key, change) => invoke("lyrics_update_track", { key, change }),
    readLocalLyrics: (audioUrl, trackId) => invoke<string | undefined>("lyrics_read_local", { audioUrl, trackId }),
    getPlaybackSubtitles: (trackId, sourceKey) => invoke("lyrics_get_playback_subtitles", { trackId, sourceKey }),
    savePlaybackSubtitles: (revision, lines) => invoke("lyrics_save_playback_subtitles", { revision, lines }),

    getPlatform: () => platform,
    setProxySettings: proxySettings => invoke("app_set_proxy", { proxySettings }),

    updatePlaybackState: isPlaying => {
      void invoke("player_update_playback_state", { isPlaying }).catch(() => undefined);
    },

    onShortcutCommand: cb => subscribeEvent<ShortcutCommand>("shortcut://command", cb),
    registerShortcut: ({ id, accelerator }) => invoke<boolean>("shortcut_register", { id, accelerator }),
    unregisterShortcut: id => invoke("shortcut_unregister", { id }),
    registerAllShortcuts: () => invoke("shortcut_register_all"),
    unregisterAllShortcuts: () => invoke("shortcut_unregister_all"),

    onPlayerCommand: cb => subscribeEvent<"prev" | "next" | "toggle">("player://command", cb),

    getAppVersion: () => invoke<string>("app_get_version"),
    isSupportAutoUpdate: () => !window.__BIUBIU_RUNTIME__?.portable,
    checkAppUpdate: () => invoke<CheckAppUpdateResult>("updater_check"),
    onUpdateAvailable: cb => subscribeEvent<AppUpdateReleaseInfo>("updater://available", cb),
    downloadAppUpdate: () => invoke("updater_download"),
    onDownloadAppProgress: cb => subscribeEvent<DownloadAppMessage>("updater://progress", cb),
    quitAndInstall: () => invoke("updater_install"),

    toggleMiniPlayer: () => invoke("mini_player_toggle"),
    onMiniPlayerClosed: listener => subscribeEvent<void>("mini://closed", () => listener()),

    setDesktopLyricsVisible: open => invoke("desktop_lyrics_set_visible", { open }),
    setDesktopLyricsLocked: locked => invoke("desktop_lyrics_set_locked", { locked }),
    setDesktopLyricsAppearance: appearance => invoke("desktop_lyrics_set_appearance", { appearance }),
    onDesktopLyricsState: listener => {
      const unlisten = subscribeEvent<DesktopLyricsWindowState>("desktop-lyrics://state", listener);
      void invoke<DesktopLyricsWindowState>("desktop_lyrics_get_state")
        .then(state => {
          if (state) listener(state);
        })
        .catch(() => undefined);
      return unlisten;
    },
    showDesktopLyricLine: line => {
      void invoke("desktop_lyrics_show_line", { line }).catch(() => undefined);
    },

    minimizeWindow: () => {
      void invoke("window_minimize").catch(() => undefined);
    },
    toggleMaximizeWindow: () => {
      void invoke("window_toggle_maximize").catch(() => undefined);
    },
    closeWindow: () => {
      void invoke("window_close").catch(() => undefined);
    },
    isMaximized: () => invoke<boolean>("window_is_maximized"),
    onWindowMaximizeChange: cb => subscribeEvent<boolean>("window://maximize-change", cb),
    isFullScreen: () => invoke<boolean>("window_is_fullscreen"),
    onWindowFullScreenChange: cb => subscribeEvent<boolean>("window://fullscreen-change", cb),

    getMediaDownloadTaskList: () => invoke<MediaDownloadTask[]>("download_get_list"),
    syncMediaDownloadTaskList: cb => subscribeEvent<MediaDownloadBroadcastPayload>("download://sync", cb),
    addMediaDownloadTask: media => invoke("download_add_task", { media }),
    addMediaDownloadTaskList: mediaList => invoke("download_add_task_list", { mediaList }),
    pauseMediaDownloadTask: id => invoke("download_pause_task", { id }),
    resumeMediaDownloadTask: id => invoke("download_resume_task", { id }),
    cancelMediaDownloadTask: id => invoke("download_cancel_task", { id }),
    retryMediaDownloadTask: id => invoke("download_retry_task", { id }),
    clearMediaDownloadTaskList: () => invoke("download_clear_list"),

    scanLocalMusic: dirs => invoke<LocalMusicItem[]>("local_music_scan", { dirs }),
    resolveLocalMusic: ids => invoke<Pick<LocalMusicItem, "id" | "path">[]>("local_music_resolve", { ids }),
    deleteLocalMusicFile: filePath => invoke<boolean>("local_music_delete_file", { filePath }),

    getWebDavLibrary: () => invoke<WebDavLibrary>("webdav_get_library"),
    onWebDavChange: listener => {
      let active = true;
      let unlisten: UnlistenFn | null = null;

      void listen<string[]>("webdav://change", event => {
        if (active) listener(event.payload ?? []);
      }).then(fn => {
        if (active) {
          unlisten = fn;
          listener([]);
        } else {
          fn();
        }
      });

      return () => {
        active = false;
        unlisten?.();
        unlisten = null;
      };
    },
    testWebDavList: list => invoke("webdav_test_list", { list }),
    saveWebDavList: list => invoke<{ id: string; passwordSessionOnly: boolean }>("webdav_save_list", { list }),
    refreshWebDavList: id => invoke("webdav_refresh_list", { id }),
    deleteWebDavList: id => invoke("webdav_delete_list", { id }),
    removeWebDavTracks: (id, trackIds, deleteFiles) =>
      invoke<WebDavRemoveResult>("webdav_remove_tracks", { id, trackIds, deleteFiles }),
    getWebDavTrackMetadata: (listId, trackId) => invoke<WebDavTrack>("webdav_get_track_metadata", { listId, trackId }),
    getWebDavLyrics: (listId, trackId) => invoke<string | undefined>("webdav_get_lyrics", { listId, trackId }),
    setWebDavPreferences: preferences => invoke("webdav_set_preferences", { preferences }),
    clearWebDavCache: () => invoke("webdav_clear_cache"),

    getBackupTargets: () => invoke<BackupTarget[]>("webdav_get_backup_targets"),
    listBackups: id => invoke<string[]>("webdav_list_backups", { id }),
    uploadBackup: (id, text) => invoke<string>("webdav_upload_backup", { id, text }),
    downloadBackup: (id, name) => invoke<string>("webdav_download_backup", { id, name }),
  };
}

export function createTauriDesktopLyricsAPI(): DesktopLyricsRendererAPI {
  return {
    onLine: listener => subscribeEvent<DesktopLyricLine>("desktop-lyrics://line", listener),
    onHover: listener => subscribeEvent<boolean>("desktop-lyrics://hover", listener),
    onState: listener => {
      const unlisten = subscribeEvent<DesktopLyricsWindowState>("desktop-lyrics://state", listener);
      void invoke<DesktopLyricsWindowState>("desktop_lyrics_get_state")
        .then(state => {
          if (state) listener(state);
        })
        .catch(() => undefined);
      return unlisten;
    },
    setLocked: locked => invoke("desktop_lyrics_set_locked", { locked }),
    setUnlockHovered: hovered => {
      void invoke("desktop_lyrics_set_unlock_hovered", { hovered }).catch(() => undefined);
    },
    setAppearance: appearance => invoke("desktop_lyrics_set_appearance", { appearance }),
    close: () => {
      void invoke("desktop_lyrics_set_visible", { open: false }).catch(() => undefined);
    },
  };
}
