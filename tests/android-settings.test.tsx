import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/pages/settings/system-settings", () => ({
  SystemSettingsTab: () => <div data-testid="system-panel">常规设置内容</div>,
}));
vi.mock("@/pages/settings/menu-settings", () => ({
  default: () => <div data-testid="menu-panel">菜单设置内容</div>,
}));
vi.mock("@/pages/settings/shortcut-settings", () => ({
  default: () => <div data-testid="shortcut-panel">快捷键设置内容</div>,
}));
vi.mock("@/pages/settings/listening-history", () => ({
  default: () => <div data-testid="records-panel">听歌统计内容</div>,
}));
vi.mock("@/pages/settings/backup-panel", () => ({
  default: () => <div data-testid="backups-panel">数据备份内容</div>,
}));
vi.mock("@/pages/settings/proxy-settings", () => ({
  default: () => <div data-testid="proxy-panel">代理设置内容</div>,
}));

import SettingsPage from "@/pages/settings";

let host: HTMLDivElement;
let root: Root;

const setPlatform = (platform: "android" | "windows") => {
  vi.stubGlobal("__BIUBIU_RUNTIME__", { platform });
  (window as any).electron = {
    getPlatform: () => platform,
    getAppVersion: vi.fn().mockResolvedValue("2.0.0"),
    setProxySettings: vi.fn(),
  };
};

const renderSettings = async () => {
  await act(async () => {
    root.render(<SettingsPage />);
  });
};

const pressTab = async (tab: HTMLElement | undefined) => {
  expect(tab).toBeDefined();
  await act(async () => {
    tab!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    tab!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    tab!.click();
  });
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  (window as any).electron = undefined;
});

describe("Android 设置页标签与横滑容器结构", () => {
  it("removes 快捷键设置 tab on Android and keeps panel outside settings-tab-row", async () => {
    setPlatform("android");
    await renderSettings();

    const mainTabList = host.querySelector<HTMLElement>('[role="tablist"][aria-label="设置选项"]');
    expect(mainTabList).not.toBeNull();
    expect(mainTabList?.classList.contains("settings-tab-list")).toBe(true);

    const mainTabRow = mainTabList?.parentElement;
    expect(mainTabRow?.getAttribute("data-slot")).toBe("base");
    expect(mainTabRow?.classList.contains("settings-tab-row")).toBe(true);

    const tabs = Array.from(mainTabList!.querySelectorAll<HTMLElement>('[role="tab"]'));
    expect(tabs.map(tab => tab.textContent?.trim())).toEqual(["常规设置", "菜单设置", "曲库与备份", "代理设置"]);
    expect(host.querySelector('[data-testid="shortcut-panel"]')).toBeNull();

    const panel = host.querySelector<HTMLElement>('[role="tabpanel"]');
    expect(panel).not.toBeNull();
    expect(panel?.classList.contains("settings-panel")).toBe(true);
    expect(mainTabRow?.contains(panel!)).toBe(false);
    expect(panel?.parentElement).toBe(mainTabRow?.parentElement);

    await pressTab(tabs.find(tab => tab.textContent?.trim() === "代理设置"));
    expect(host.querySelector('[data-testid="proxy-panel"]')).not.toBeNull();

    await pressTab(tabs.find(tab => tab.textContent?.trim() === "曲库与备份"));
    const libraryTabList = host.querySelector<HTMLElement>('[role="tablist"][aria-label="曲库工具"]');
    expect(libraryTabList).not.toBeNull();
    expect(libraryTabList?.classList.contains("settings-tab-list")).toBe(true);
    expect(libraryTabList?.parentElement?.classList.contains("settings-tab-row")).toBe(true);

    const innerPanel = libraryTabList?.parentElement?.nextElementSibling;
    expect(innerPanel?.getAttribute("role")).toBe("tabpanel");
    expect(innerPanel?.classList.contains("settings-panel")).toBe(true);
    expect(libraryTabList?.parentElement?.contains(innerPanel!)).toBe(false);
  });

  it("keeps 快捷键设置 tab and content on desktop", async () => {
    setPlatform("windows");
    await renderSettings();

    const mainTabList = host.querySelector<HTMLElement>('[role="tablist"][aria-label="设置选项"]');
    const tabs = Array.from(mainTabList!.querySelectorAll<HTMLElement>('[role="tab"]'));
    expect(tabs.map(tab => tab.textContent?.trim())).toEqual([
      "常规设置",
      "菜单设置",
      "快捷键设置",
      "曲库与备份",
      "代理设置",
    ]);

    await pressTab(tabs.find(tab => tab.textContent?.trim() === "快捷键设置"));
    expect(host.querySelector('[data-testid="shortcut-panel"]')).not.toBeNull();
  });

  it("scopes Android horizontal tab scroll rules to settings-tab-row/settings-tab-list without broad tablist override", () => {
    const css = fs.readFileSync(path.resolve(process.cwd(), "src/layout/android.css"), "utf8");

    expect(css).not.toMatch(/\.settings-page\s+\[role="tablist"\]/);
    expect(css).toMatch(
      /html\[data-platform="android"\]\s+\.settings-page\s+\.settings-tab-row\s*\{[^}]*display:\s*block;[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*overflow:\s*auto hidden;/s,
    );
    expect(css).toMatch(
      /html\[data-platform="android"\]\s+\.settings-page\s+\.settings-tab-list\s*\{[^}]*width:\s*max-content;[^}]*max-width:\s*none;[^}]*overflow:\s*visible;/s,
    );
    expect(css).toMatch(
      /html\[data-platform="android"\]\s+\.settings-page\s+\.settings-tab-list\s*>\s*\[role="tab"\]\s*\{[^}]*flex-shrink:\s*0;[^}]*white-space:\s*nowrap;/s,
    );
  });
});
