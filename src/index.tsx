import "./bridge";

import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router";

import { invoke } from "@tauri-apps/api/core";

async function start() {
  if (window.__BIUBIU_RUNTIME__?.pendingLegacyStorage) {
    try {
      const saved = await invoke<Record<string, string>>("store_get", { name: "legacy-renderer" });
      for (const [key, value] of Object.entries(saved ?? {})) {
        if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
      }
      await invoke("store_clear", { name: "legacy-renderer" });
    } catch (error) {
      console.warn("旧版播放队列将在下次启动时继续迁移", error);
    }
  }
  // Zustand reads its persisted stores as soon as the application module is imported.
  const { App } = await import("./app");

  const root = createRoot(document.getElementById("root") as Element);
  root.render(
    <HashRouter>
      <App />
    </HashRouter>,
  );
}

void start();
