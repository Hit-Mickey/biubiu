import { create } from "zustand";
import { persist } from "zustand/middleware";

import { defaultAppSettings } from "@shared/settings/app-settings";
import { lyricSearchSources } from "@shared/settings/lyric-search-sources";
import { StoreNameMap } from "@shared/store";

interface SettingsActions {
  getSettings: () => AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  reset: () => void;
}

export const useSettings = create<AppSettings & SettingsActions>()(
  persist(
    (set, get) => ({
      ...defaultAppSettings,
      getSettings: () => {
        return Object.keys(defaultAppSettings).reduce((acc, key) => {
          acc[key] = get()[key];
          return acc;
        }, {} as AppSettings);
      },
      update: (patch: Partial<AppSettings>) => {
        set(patch);
      },
      reset: () => {
        set(defaultAppSettings);
      },
    }),
    {
      name: "settings",
      storage: {
        getItem: async () => {
          const settings = (await window.electron.getStore(StoreNameMap.AppSettings))?.appSettings;
          if (settings) {
            if (settings.fontFamily === "system-default") {
              settings.fontFamily = "system-ui";
            }
            const storedPrimary = typeof settings.primaryColor === "string" ? settings.primaryColor.toLowerCase() : "";
            if (storedPrimary === "#1ed760" || storedPrimary === "#002fa7") {
              settings.primaryColor = defaultAppSettings.primaryColor;
            }
            if (!Object.hasOwn(lyricSearchSources, settings.lyricSearchSource)) {
              settings.lyricSearchSource = defaultAppSettings.lyricSearchSource;
            }
          }

          return { state: settings };
        },

        setItem: async (_, value) => {
          if (value.state) {
            await window.electron.setStore(StoreNameMap.AppSettings, {
              appSettings: value.state,
            });
          }
        },

        removeItem: async () => {
          await window.electron.clearStore(StoreNameMap.AppSettings);
        },
      },
      partialize: state => {
        return {
          downloadPath: state.downloadPath,
          closeWindowOption: state.closeWindowOption,
          autoStart: state.autoStart,
          fontFamily: state.fontFamily,
          primaryColor: state.primaryColor,
          backgroundColor: state.backgroundColor,
          borderRadius: state.borderRadius,
          audioQuality: state.audioQuality,
          hiddenMenuKeys: state.hiddenMenuKeys,
          displayMode: state.displayMode,
          ffmpegPath: state.ffmpegPath,
          themeMode: state.themeMode,
          pageTransition: state.pageTransition,
          showSearchHistory: state.showSearchHistory,
          proxySettings: state.proxySettings,
          sideMenuCollapsed: state.sideMenuCollapsed,
          sideMenuWidth: state.sideMenuWidth,
          sideMenuCollectionFolded: state.sideMenuCollectionFolded,
          reportPlayHistory: state.reportPlayHistory,
          recordLocalHistory: state.recordLocalHistory,
          preferredAudioHost: state.preferredAudioHost,
          lyricSearchSource: state.lyricSearchSource,
          localMusicDirs: state.localMusicDirs,
        };
      },
    },
  ),
);
