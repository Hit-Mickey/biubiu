import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";

import { expect, it, vi } from "vitest";

import SearchInput from "@/layout/navbar/search";
import Search from "@/pages/search";
import { getWebInterfaceView } from "@/service/web-interface-view";
import { usePlayList } from "@/store/play-list";
import { useSearchHistory } from "@/store/search-history";

vi.mock("overlayscrollbars-react", () => ({
  OverlayScrollbarsComponent: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/scroll-container", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/service/main-suggest", () => ({ getSearchSuggestMain: vi.fn() }));
vi.mock("@/service/web-interface-view", () => ({ getWebInterfaceView: vi.fn() }));

it("opens the exact result from the main search field and leaves the current queue alone", async () => {
  const bvid = "BV17x411w7KC";
  vi.mocked(getWebInterfaceView).mockResolvedValue({
    code: 0,
    data: { bvid, aid: 1, cid: 2, title: "现场歌曲", videos: 1, duration: 70, owner: { name: "测试作者", mid: 3 } },
  } as Awaited<ReturnType<typeof getWebInterfaceView>>);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const mount = document.body.appendChild(document.createElement("div"));
  const root = createRoot(mount);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <SearchInput />
          <Routes>
            <Route path="/" element={null} />
            <Route path="/search" element={<Search />} />
          </Routes>
        </MemoryRouter>,
      ),
    );
    const input = mount.querySelector("input")!;
    expect(input.placeholder).toMatch(/关键词.*BV.*链接/);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, `【现场】 https://m.bilibili.com/video/${bvid}?share_source=copy`);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }));
    });
    expect(useSearchHistory.getState().keyword).toBe("");
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(useSearchHistory.getState().keyword).toBe(bvid);
    expect(getWebInterfaceView).toHaveBeenCalledOnce();
    expect(mount.textContent).toContain("现场歌曲");
    expect(usePlayList.getState().list).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    mount.remove();
    vi.unstubAllGlobals();
  }
});
