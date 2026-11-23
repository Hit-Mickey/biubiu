import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CollectionType } from "@/common/constants/collection";
import SideNav from "@/layout/side";
import { useFavoritesStore, type FavoriteItem } from "@/store/favorite";
import { useSettings } from "@/store/settings";
import { useUser } from "@/store/user";

vi.mock("@/assets/icons/logo.svg", () => ({
  ReactComponent: (props: Record<string, unknown>) => <svg data-testid="logo" {...props} />,
}));

const makeFavorites = (count: number, offset: number, prefix: string, type?: number): FavoriteItem[] =>
  Array.from({ length: count }, (_, index) => ({
    id: offset + index + 1,
    title: `${prefix}${index + 1}`,
    cover: `https://example.com/${offset + index + 1}.jpg`,
    type,
    mid: 42,
  }));

const dispatchTouch = (
  target: EventTarget,
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  x: number,
  y: number,
) => {
  const point = { identifier: 1, target, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y };
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: type === "touchend" || type === "touchcancel" ? [] : [point] },
    changedTouches: { value: [point] },
    targetTouches: { value: type === "touchend" || type === "touchcancel" ? [] : [point] },
  });
  target.dispatchEvent(event);
  return event;
};

let host: HTMLDivElement;
let root: Root;
const updateCreatedFavorites = vi.fn().mockResolvedValue(undefined);
const updateCollectedFavorites = vi.fn().mockResolvedValue(undefined);

const initialUser = useUser.getState();
const initialFavorites = useFavoritesStore.getState();
const initialSettings = useSettings.getState();

const setPlatform = (platform: "android" | "windows") => {
  vi.stubGlobal("__BIUBIU_RUNTIME__", { platform });
  (window as any).electron = {
    getPlatform: () => platform,
    getStore: vi.fn().mockResolvedValue(undefined),
    setStore: vi.fn().mockResolvedValue(undefined),
    clearStore: vi.fn().mockResolvedValue(undefined),
  };
};

const renderSideNav = async () => {
  await import("@/layout/side/collection");
  await act(async () => {
    root.render(
      <MemoryRouter>
        <SideNav />
      </MemoryRouter>,
    );
  });
  await vi.waitFor(() => {
    expect(updateCreatedFavorites).toHaveBeenCalled();
  });
};

const getCollectionLinks = () =>
  Array.from(host.querySelectorAll<HTMLAnchorElement>('#sidebar-navigation a[href^="/collection/"]'));

const findButtonByText = (text: string) =>
  Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent?.trim() === text);

const pressButton = async (button: HTMLButtonElement | null | undefined) => {
  expect(button).toBeTruthy();
  await act(async () => {
    button!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    button!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    button!.click();
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
  setPlatform("android");
  updateCreatedFavorites.mockClear();
  updateCollectedFavorites.mockClear();

  useUser.setState({
    user: { isLogin: true, mid: 42, uname: "tester" } as any,
  });
  useFavoritesStore.setState({
    createdFavorites: makeFavorites(32, 1000, "创建歌单"),
    collectedFavorites: makeFavorites(32, 2000, "收藏歌单", CollectionType.Favorite),
    createdOrder: [],
    collectedOrder: [],
    updateCreatedFavorites,
    updateCollectedFavorites,
  });
  useSettings.setState({
    sideMenuCollapsed: false,
    sideMenuWidth: 200,
    hiddenMenuKeys: [],
    sideMenuCollectionFolded: { created: false, collected: false },
  });

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  useUser.setState(initialUser, true);
  useFavoritesStore.setState(initialFavorites, true);
  useSettings.setState(initialSettings, true);
  await Promise.resolve();
  vi.unstubAllGlobals();
  (window as any).electron = undefined;
});

describe("Android 侧边栏收藏夹滚动与收起", () => {
  it("keeps pan-y touch scrolling on 32+32 items and separates swipe scroll from long-press drag", async () => {
    await renderSideNav();

    const links = getCollectionLinks();
    expect(links).toHaveLength(64);

    for (const link of links) {
      const sortableWrapper = link.parentElement?.parentElement;
      expect(sortableWrapper?.style.touchAction).toBe("pan-y");
    }

    vi.useFakeTimers();
    try {
      for (const link of [links[0], links[32]]) {
        let moveEvent!: Event;
        await act(async () => {
          dispatchTouch(link, "touchstart", 48, 400);
          moveEvent = dispatchTouch(link, "touchmove", 48, 360);
          vi.advanceTimersByTime(300);
          dispatchTouch(link, "touchend", 48, 360);
          vi.advanceTimersByTime(60);
        });
        expect(moveEvent.defaultPrevented).toBe(false);
        expect(link.getAttribute("data-no-contextmenu")).toBeNull();
      }

      // Holding still for >= 250ms activates touch drag and prevents native scroll & context menu
      const draggableLink = links[0];
      await act(async () => {
        dispatchTouch(draggableLink, "touchstart", 48, 200);
        vi.advanceTimersByTime(260);
      });
      expect(draggableLink.getAttribute("data-no-contextmenu")).toBe("true");
      expect(draggableLink.parentElement?.parentElement?.style.opacity).toBe("0.7");

      let dragMove!: Event;
      await act(async () => {
        dragMove = dispatchTouch(draggableLink, "touchmove", 48, 260);
      });
      expect(dragMove.defaultPrevented).toBe(true);

      await act(async () => {
        dispatchTouch(draggableLink, "touchend", 48, 260);
        vi.advanceTimersByTime(60);
      });
      expect(draggableLink.getAttribute("data-no-contextmenu")).toBeNull();
      const onOpen = vi.fn((event: Event) => event.preventDefault());
      draggableLink.addEventListener("click", onOpen);
      try {
        await act(async () => draggableLink.click());
        expect(onOpen).not.toHaveBeenCalled();
        await act(async () => {
          dispatchTouch(draggableLink, "touchstart", 48, 200);
          dispatchTouch(draggableLink, "touchend", 48, 200);
          draggableLink.click();
        });
        expect(onOpen).toHaveBeenCalledTimes(1);
      } finally {
        draggableLink.removeEventListener("click", onOpen);
      }
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it("hides both groups and all 64 links on collapse, preserves manual fold prefs, and avoids duplicate fetches", async () => {
    await renderSideNav();

    expect(updateCreatedFavorites).toHaveBeenCalledTimes(1);
    expect(updateCollectedFavorites).toHaveBeenCalledTimes(1);
    expect(getCollectionLinks()).toHaveLength(64);

    // Manually fold "我收藏的" while keeping "我创建的" expanded
    const collectedToggle = findButtonByText("我收藏的");
    expect(collectedToggle).toBeDefined();
    await act(async () => {
      collectedToggle?.click();
    });
    expect(useSettings.getState().sideMenuCollectionFolded).toEqual({ created: false, collected: true });
    expect(getCollectionLinks()).toHaveLength(32);

    // Collapse outer sidebar on Android
    const collapseButton = host.querySelector<HTMLButtonElement>('button[aria-label="收起侧栏文字"]');
    await pressButton(collapseButton);

    expect(host.querySelector("#main-sidebar")?.getAttribute("data-collapsed")).toBe("true");
    expect(findButtonByText("我创建的")).toBeUndefined();
    expect(findButtonByText("我收藏的")).toBeUndefined();
    expect(getCollectionLinks()).toHaveLength(0);
    expect(useSettings.getState().sideMenuCollectionFolded).toEqual({ created: false, collected: true });

    // Re-expand outer sidebar: preserved manual fold state returns without re-fetching favorites
    const expandButton = host.querySelector<HTMLButtonElement>('button[aria-label="展开侧栏文字"]');
    await pressButton(expandButton);

    expect(findButtonByText("我创建的")?.getAttribute("aria-expanded")).toBe("true");
    expect(findButtonByText("我收藏的")?.getAttribute("aria-expanded")).toBe("false");
    expect(getCollectionLinks()).toHaveLength(32);
    expect(updateCreatedFavorites).toHaveBeenCalledTimes(1);
    expect(updateCollectedFavorites).toHaveBeenCalledTimes(1);

    // Manually re-expand "我收藏的" so both groups coexist again, then collapse & expand once more
    await act(async () => {
      findButtonByText("我收藏的")?.click();
    });
    expect(getCollectionLinks()).toHaveLength(64);

    await pressButton(host.querySelector<HTMLButtonElement>('button[aria-label="收起侧栏文字"]'));
    expect(getCollectionLinks()).toHaveLength(0);

    await pressButton(host.querySelector<HTMLButtonElement>('button[aria-label="展开侧栏文字"]'));
    expect(getCollectionLinks()).toHaveLength(64);
    expect(updateCreatedFavorites).toHaveBeenCalledTimes(1);
    expect(updateCollectedFavorites).toHaveBeenCalledTimes(1);
  });

  it("keeps collection links unmounted when starting collapsed on Android and fetches only once on expand", async () => {
    useSettings.setState({ sideMenuCollapsed: true });
    await renderSideNav();

    expect(getCollectionLinks()).toHaveLength(0);
    expect(updateCreatedFavorites).toHaveBeenCalledTimes(1);
    expect(updateCollectedFavorites).toHaveBeenCalledTimes(1);

    await pressButton(host.querySelector<HTMLButtonElement>('button[aria-label="展开侧栏文字"]'));
    expect(getCollectionLinks()).toHaveLength(64);
    expect(updateCreatedFavorites).toHaveBeenCalledTimes(1);
    expect(updateCollectedFavorites).toHaveBeenCalledTimes(1);
  });

  it("preserves desktop touch-action and collapsed collection rendering", async () => {
    setPlatform("windows");
    await renderSideNav();

    const expandedLinks = getCollectionLinks();
    expect(expandedLinks).toHaveLength(64);
    expect(expandedLinks[0].parentElement?.parentElement?.style.touchAction).toBe("none");

    await pressButton(host.querySelector<HTMLButtonElement>('button[aria-label="收起侧栏文字"]'));
    expect(host.querySelector("#main-sidebar")?.getAttribute("data-collapsed")).toBe("true");
    expect(getCollectionLinks()).toHaveLength(64);
  });

  it("keeps the sidebar toggle above the navigation in both modes", async () => {
    await renderSideNav();
    const sidebar = host.querySelector("#main-sidebar");
    const firstChild = sidebar?.firstElementChild;
    expect(firstChild?.getAttribute("aria-label")).toBe("收起侧栏文字");
    await pressButton(sidebar?.querySelector('button[aria-label="收起侧栏文字"]'));
    expect(sidebar?.firstElementChild).toBe(firstChild);
    expect(firstChild?.getAttribute("aria-label")).toBe("展开侧栏文字");
  });
});
