import { create } from "zustand";
import { persist } from "zustand/middleware";

import { detectPlatform } from "@/bridge/env";
import { defaultShortcutSettings, mergeShortcutSettings } from "@shared/settings/shortcut-settings";
import { StoreNameMap } from "@shared/store";

interface ShortcutActions {
  refresh: () => Promise<void>;
  update: (patch: Partial<ShortcutSettings>) => void;
  reset: () => void;
}

function platformShortcuts(settings: ShortcutSettings): ShortcutSettings {
  if (detectPlatform() !== "android") return settings;
  return {
    ...settings,
    enableGlobalShortcuts: false,
    globalShortcuts: [],
    shortcuts: settings.shortcuts.filter(item => item.id !== "toggleLyrics" && item.id !== "toggleMiniMode"),
  };
}

const defaults = platformShortcuts(defaultShortcutSettings);

export const useShortcutSettings = create<ShortcutSettings & ShortcutActions>()(
  persist(
    set => ({
      ...defaults,
      refresh: async () => {
        const store = await window.electron.getStore(StoreNameMap.ShortcutSettings);
        set(platformShortcuts(mergeShortcutSettings(store)));
      },
      update: (patch: Partial<ShortcutSettings>) => {
        set(patch);
      },
      reset: () => {
        set(defaults);
      },
    }),
    {
      name: "shortcut-settings",
      storage: {
        getItem: async () => {
          const store = await window.electron.getStore(StoreNameMap.ShortcutSettings);

          return {
            state: platformShortcuts(mergeShortcutSettings(store)),
          };
        },

        setItem: async (_, value) => {
          if (value.state) {
            await window.electron.setStore(StoreNameMap.ShortcutSettings, value.state);
          }
        },

        removeItem: async () => {
          await window.electron.clearStore(StoreNameMap.ShortcutSettings);
        },
      },
      partialize: state => ({
        defaultsVersion: state.defaultsVersion,
        shortcuts: state.shortcuts,
        globalShortcuts: state.globalShortcuts,
        enableGlobalShortcuts: state.enableGlobalShortcuts,
      }),
    },
  ),
);
