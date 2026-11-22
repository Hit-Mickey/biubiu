import { Suspense, useEffect } from "react";
import { useHref, useNavigate, useRoutes } from "react-router";

import { addToast } from "@heroui/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import log from "@/common/utils/logger";

import AppShell from "./app-shell";
import { isTauriRuntime } from "./bridge/env";
import { loadBilibiliCookies } from "./common/utils/cookie";
import { stopMiniPlayerMainSync, toggleMiniMode } from "./common/utils/mini-player";
import { listenForAppShortcuts } from "./common/utils/shortcut";
import routes from "./routes";
import { useAppUpdateStore } from "./store/app-update";
import { toggleDesktopLyrics } from "./store/desktop-lyrics";
import { pauseForSleep } from "./store/play-list";
import { usePlayList } from "./store/play-list";
import { usePlayProgress } from "./store/play-progress";
import { useSleepTimer } from "./store/sleep-timer";

function handleShortcut(command: ShortcutCommand) {
  const { prev, next, togglePlay, setVolume, volume } = usePlayList.getState();

  switch (command) {
    case "togglePlay":
      void togglePlay();
      break;
    case "prev":
      void prev();
      break;
    case "next":
      void next();
      break;
    case "volumeUp":
      setVolume(Math.min(1, volume + 0.05));
      break;
    case "volumeDown":
      setVolume(Math.max(0, volume - 0.05));
      break;
    case "toggleMiniMode":
      void toggleMiniMode();
      break;
    case "toggleLyrics":
      void toggleDesktopLyrics();
      break;
  }
}

export function App() {
  const routeElement = useRoutes(routes);
  const navigate = useNavigate();
  const setUpdate = useAppUpdateStore(s => s.setUpdate);

  useEffect(() => {
    const notice = window.__BIUBIU_RUNTIME__?.migrationNotice;
    if (notice) addToast({ title: "旧版数据迁移", description: notice });
    void loadBilibiliCookies().catch(error => {
      log.warn("[user] 加载 B 站会话失败", error instanceof Error ? error.message : String(error));
    });
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const timer = listen("sleep://expired", () => {
      useSleepTimer.setState({ deadline: null });
      pauseForSleep();
    });
    void timer
      .then(() => invoke<number>("sleep_timer_get"))
      .then(value => useSleepTimer.setState({ deadline: value || null }));
    const history = listen("history://changed", () => window.dispatchEvent(new Event("biubiu:listening-history")));
    return () => {
      void timer.then(off => off());
      void history.then(off => off());
    };
  }, []);

  useEffect(() => window.electron.onMiniPlayerClosed(stopMiniPlayerMainSync), []);

  useEffect(
    () =>
      window.electron.onWebDavChange(removed => {
        if (removed.length) usePlayList.getState().removeWebDavItems(removed);
      }),
    [],
  );

  useEffect(() => {
    if (window.electron && window.electron.navigate) {
      const removeListener = window.electron.navigate(path => navigate(path));
      return removeListener;
    }
  }, [navigate]);

  // 订阅来自主进程的任务栏缩略按钮命令
  useEffect(() => window.electron.onPlayerCommand(cmd => handleShortcut(cmd === "toggle" ? "togglePlay" : cmd)), []);

  // 订阅来自主进程的全局快捷键命令
  useEffect(() => window.electron.onShortcutCommand(handleShortcut), []);

  // 监听应用内快捷键
  useEffect(() => listenForAppShortcuts(handleShortcut), []);

  useEffect(() => {
    const removeListener = window.electron.onUpdateAvailable(updateInfo => {
      setUpdate({
        isUpdateAvailable: true,
        latestVersion: updateInfo.latestVersion,
        releaseNotes: updateInfo.releaseNotes,
      });
    });

    return () => {
      removeListener();
    };
  }, [setUpdate]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      if (usePlayProgress.getState().currentTime) {
        usePlayProgress.getState().saveCurrentTime();
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    // 清理函数
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);

  return (
    <AppShell navigate={navigate} useHref={useHref}>
      <Suspense fallback={null}>{routeElement}</Suspense>
    </AppShell>
  );
}
