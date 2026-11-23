import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DynamicType } from "@/common/constants/feed";
import UserProfile from "@/pages/user-profile";

const api = vi.hoisted(() => ({
  profile: vi.fn(),
  feed: vi.fn(),
  privacy: vi.fn(),
  relation: vi.fn(),
  stats: vi.fn(),
}));
vi.mock("@/service/space-wbi-acc-info", () => ({ getSpaceWbiAccInfo: api.profile }));
vi.mock("@/service/web-dynamic", () => ({ getWebDynamicFeedSpace: api.feed }));
vi.mock("@/service/space-setting", () => ({ getXSpaceSettings: api.privacy }));
vi.mock("@/service/space-wbi-acc-relation", () => ({ getSpaceWbiAccRelation: api.relation }));
vi.mock("@/service/relation-stat", () => ({ getRelationStat: api.stats }));
vi.mock("@/pages/user-profile/post", () => ({ default: () => null }));
vi.mock("@/pages/user-profile/favorites", () => ({ default: () => null }));
vi.mock("@/pages/user-profile/series", () => ({ default: () => null }));
vi.mock("@/pages/user-profile/dynamic-list/item", () => ({ default: () => <article>公开视频</article> }));

let host: HTMLDivElement;
let root: Root;
const challenge = { code: -352, data: { v_voucher: "test-challenge" } };
const openProfile = async (state?: unknown) => {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[{ pathname: "/user/8", state }]}>
        <Routes>
          <Route path="/user/:id" element={<UserProfile />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
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
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  api.profile.mockResolvedValue(challenge);
  api.privacy.mockResolvedValue({ code: 0, data: {} });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("访客浏览 UP 主空间", () => {
  it("uses the matching public author while optional profile verification awaits a user action", async () => {
    const item = (mid: number, name: string) => ({
      id_str: String(mid),
      type: DynamicType.Av,
      modules: { module_author: { mid, name, face: `/${mid}.png` } },
    });
    api.feed.mockResolvedValue({
      code: 0,
      data: { items: [item(9, "其他作者"), item(8, "空间作者")], has_more: false },
    });
    await openProfile();
    expect(api.profile).toHaveBeenCalledWith({ mid: "8" }, { passive: true });
    expect(api.privacy.mock.calls[0][1]).toEqual({ passive: true });
    expect(api.stats).not.toHaveBeenCalled();
    expect(api.relation).not.toHaveBeenCalled();
    expect(host.querySelector("h1")).toHaveTextContent("空间作者");
    expect(host.querySelectorAll("article")).toHaveLength(2);
    const button = Array.from(host.querySelectorAll("button")).find(b => b.textContent === "验证并查看完整资料");
    expect(button).toBeDefined();
    await act(async () => button?.click());
    expect(api.profile).toHaveBeenLastCalledWith({ mid: "8" }, { passive: false });
  });
  it("keeps the public name from navigation when an author has no posts", async () => {
    api.feed.mockResolvedValue({ code: 0, data: { items: [], has_more: false } });
    await openProfile({ profileOwner: { mid: 8, name: "列表中的作者", face: "" } });
    expect(host.querySelector("h1")).toHaveTextContent("列表中的作者");
    expect(host).toHaveTextContent("暂无动态");
  });
  it("stops paging when the feed itself requires verification", async () => {
    api.feed.mockResolvedValue(challenge);
    await openProfile();
    expect(api.feed).toHaveBeenCalledTimes(1);
    expect(api.feed.mock.calls[0][1].passive).toBe(true);
    expect(host).toHaveTextContent("查看动态需要验证");
    expect(host.querySelector("h1")).toHaveTextContent("UID 8");
    expect(host).not.toHaveTextContent("暂无动态");
    const verify = Array.from(host.querySelectorAll("button")).find(b => b.textContent === "去验证");
    await act(async () => verify?.click());
    expect(api.feed).toHaveBeenCalledTimes(2);
    expect(api.feed.mock.calls[1][1].passive).toBe(false);
  });
});
