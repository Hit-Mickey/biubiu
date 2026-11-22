const SHORTCUT_DEFAULTS_VERSION = 2;

export const defaultShortcutSettings: ShortcutSettings = {
  defaultsVersion: SHORTCUT_DEFAULTS_VERSION,
  enableGlobalShortcuts: true,
  shortcuts: [
    {
      id: "togglePlay",
      name: "播放/暂停",
      shortcut: "CommandOrControl+P",
    },
    {
      id: "prev",
      name: "上一首",
      shortcut: "CommandOrControl+Left",
    },
    {
      id: "next",
      name: "下一首",
      shortcut: "CommandOrControl+Right",
    },
    {
      id: "volumeUp",
      name: "音量加",
      shortcut: "CommandOrControl+Up",
    },
    {
      id: "volumeDown",
      name: "音量减",
      shortcut: "CommandOrControl+Down",
    },
    {
      id: "toggleMiniMode",
      name: "切换mini/完整模式",
      shortcut: "CommandOrControl+M",
    },
    {
      id: "toggleLyrics",
      name: "打开/关闭桌面歌词",
      shortcut: "CommandOrControl+G",
    },
  ],
  globalShortcuts: [
    {
      id: "togglePlay",
      name: "播放/暂停",
      shortcut: "CommandOrControl+Alt+P",
    },
    {
      id: "prev",
      name: "上一首",
      shortcut: "CommandOrControl+Alt+Left",
    },
    {
      id: "next",
      name: "下一首",
      shortcut: "CommandOrControl+Alt+Right",
    },
    {
      id: "volumeUp",
      name: "音量加",
      shortcut: "CommandOrControl+Alt+Up",
    },
    {
      id: "volumeDown",
      name: "音量减",
      shortcut: "CommandOrControl+Alt+Down",
    },
    {
      id: "toggleMiniMode",
      name: "切换mini/完整模式",
      shortcut: "CommandOrControl+Alt+M",
    },
    {
      id: "toggleLyrics",
      name: "打开/关闭桌面歌词",
      shortcut: "CommandOrControl+Alt+G",
    },
  ],
};

function mergeShortcutList(
  stored: ShortcutItem[] | undefined,
  defaults: ShortcutItem[],
  markInAppConflicts: boolean,
  migrateLegacyLyrics: boolean,
): ShortcutItem[] {
  const items = Array.isArray(stored) ? stored.map(item => ({ ...item })) : [];

  for (const fallback of defaults) {
    const saved = items.find(item => item.id === fallback.id);
    if (saved) {
      const oldKey = markInAppConflicts ? "CommandOrControl+L" : "CommandOrControl+Alt+L";
      if (
        migrateLegacyLyrics &&
        saved.id === "toggleLyrics" &&
        saved.shortcut === oldKey &&
        !items.some(item => item.shortcut === fallback.shortcut)
      ) {
        saved.shortcut = fallback.shortcut;
        saved.isConflict = false;
        delete saved.error;
      }
      continue;
    }
    const next: ShortcutItem = { ...fallback };
    if (markInAppConflicts && next.shortcut) {
      const conflict = items.find(item => item.shortcut === next.shortcut);
      if (conflict) {
        next.isConflict = true;
        next.error = `与“${conflict.name}”冲突`;
      }
    }
    items.push(next);
  }

  return items;
}

export function mergeShortcutSettings(stored?: Partial<ShortcutSettings> | null): ShortcutSettings {
  if (!stored || typeof stored !== "object") {
    return {
      defaultsVersion: SHORTCUT_DEFAULTS_VERSION,
      enableGlobalShortcuts: defaultShortcutSettings.enableGlobalShortcuts,
      shortcuts: defaultShortcutSettings.shortcuts.map(item => ({ ...item })),
      globalShortcuts: defaultShortcutSettings.globalShortcuts.map(item => ({ ...item })),
    };
  }

  const migrateLegacyLyrics =
    typeof stored.defaultsVersion !== "number" || stored.defaultsVersion < SHORTCUT_DEFAULTS_VERSION;

  return {
    defaultsVersion: migrateLegacyLyrics ? SHORTCUT_DEFAULTS_VERSION : stored.defaultsVersion,
    enableGlobalShortcuts:
      typeof stored.enableGlobalShortcuts === "boolean"
        ? stored.enableGlobalShortcuts
        : defaultShortcutSettings.enableGlobalShortcuts,
    shortcuts: mergeShortcutList(stored.shortcuts, defaultShortcutSettings.shortcuts, true, migrateLegacyLyrics),
    globalShortcuts: mergeShortcutList(
      stored.globalShortcuts,
      defaultShortcutSettings.globalShortcuts,
      false,
      migrateLegacyLyrics,
    ),
  };
}
