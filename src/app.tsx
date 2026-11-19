import { Suspense, useEffect } from "react";
import { useHref, useNavigate, useRoutes } from "react-router";

import log from "electron-log/renderer";

import AppShell from "./app-shell";
import { loadBilibiliCookies } from "./common/utils/cookie";
import { stopMiniPlayerMainSync, toggleMiniMode } from "./common/utils/mini-player";
import { getShortcutCommand } from "./common/utils/shortcut";
import routes from "./routes";
import { useAppUpdateStore } from "./store/app-update";
import { usePlayList } from "./store/play-list";
import { usePlayProgress } from "./store/play-progress";

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
  }
}

export function App() {
  const routeElement = useRoutes(routes);
  const navigate = useNavigate();
  const setUpdate = useAppUpdateStore(s => s.setUpdate);

  useEffect(() => {
    void loadBilibiliCookies().catch(error => {
      log.warn("[user] 加载 B 站会话失败", error instanceof Error ? error.message : String(error));
    });
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
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const command = getShortcutCommand(e);
      if (command) {
        e.preventDefault();
        handleShortcut(command);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

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
