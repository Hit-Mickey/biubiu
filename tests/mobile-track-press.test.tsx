import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WebDynamicItem } from "@/service/web-dynamic";

import { trackPressProps } from "@/common/utils/track-press";
import FeedItem from "@/pages/dynamic-feed/item";
import ProfileFeedItem from "@/pages/user-profile/dynamic-list/item";
import { usePlayList } from "@/store/play-list";

let root: Root;
let host: HTMLDivElement;
const play = vi.fn();
const menu = vi.fn();
const tap = (target: Element, y = 50) =>
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1, clientX: 20, clientY: y }));
const row = (n: number) => host.children[n];

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("__BIUBIU_RUNTIME__", { platform: "android" });
  vi.useFakeTimers();
  host = document.createElement("div");
  root = createRoot(host);
  await act(async () =>
    root.render(
      [0, 1].map(id => (
        <div key={id} {...trackPressProps(() => play(id))}>
          <span>标题</span>
          <span>作者</span>
          <button type="button" onClick={menu}>
            操作菜单
          </button>
        </div>
      )),
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("安卓歌曲行触控", () => {
  it("waits for two taps on the same song and plays once across title and author", () => {
    tap(row(0).children[0]);
    expect(play).not.toHaveBeenCalled();
    vi.advanceTimersByTime(180);
    tap(row(0).children[1], 69);
    row(0).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(play.mock.calls).toEqual([[0]]);
  });
  it("ignores distant, expired, cancelled and different-row taps", () => {
    tap(row(0));
    tap(row(1));
    tap(row(1), 110);
    vi.advanceTimersByTime(550);
    tap(row(1), 110);
    row(1).dispatchEvent(new Event("pointercancel", { bubbles: true }));
    tap(row(1), 110);
    row(1).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    tap(row(1), 110);
    expect(play).not.toHaveBeenCalled();
  });
  it("keeps a single tap on the menu independent of row activation", () => {
    tap(row(0));
    tap(row(0).children[2]);
    tap(row(0).children[1]);
    expect(menu).toHaveBeenCalledTimes(1);
    expect(play).not.toHaveBeenCalled();
    row(0).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    expect(play.mock.calls).toEqual([[0]]);
  });
  it.each([
    ["关注动态", FeedItem],
    ["空间动态", ProfileFeedItem],
  ] as const)("plays the %s video from two taps on its rendered title", async (_name, Item) => {
    const fixture = {
      id_str: "fixture",
      modules: {
        module_author: { mid: 8, name: "测试作者", pub_time: "今天" },
        module_dynamic: { major: { archive: { title: "测试视频", bvid: "BV17x411w7KC", stat: { play: "12" } } } },
      },
    } as WebDynamicItem;
    const oldPlay = usePlayList.getState().play;
    const start = vi.fn().mockResolvedValue(undefined);
    usePlayList.setState({ play: start });
    try {
      await act(async () =>
        root.render(
          <MemoryRouter>
            <Item item={fixture} />
          </MemoryRouter>,
        ),
      );
      const title = host.querySelector("h3")!;
      tap(title);
      expect(start).not.toHaveBeenCalled();
      tap(title);
      expect(start).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ bvid: "BV17x411w7KC" }));
    } finally {
      await act(async () => usePlayList.setState({ play: oldPlay }));
    }
  });
  it("retains native desktop double-click and explicit press handlers", () => {
    vi.stubGlobal("__BIUBIU_RUNTIME__", { platform: "windows" });
    expect(trackPressProps(play)).toEqual({ onDoubleClick: play });
    expect(trackPressProps(play, "press")).toEqual({ onPress: play });
  });
});
