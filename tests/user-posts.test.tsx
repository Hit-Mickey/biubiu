import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { verifyGeetest } from "@/common/utils/geetest";
import VideoPost from "@/pages/user-profile/post";

const api = vi.hoisted(() => ({ posts: vi.fn(), toast: vi.fn() }));
vi.mock("@/service/space-wbi-arc-search", () => ({ getSpaceWbiArcSearch: api.posts }));
vi.mock("@heroui/react", async original => ({
  ...(await original<typeof import("@heroui/react")>()),
  addToast: api.toast,
}));
vi.mock("@/pages/user-profile/post/list", () => ({
  default: ({
    items,
    hasMore,
    onLoadMore,
  }: {
    items: { title: string }[];
    hasMore: boolean;
    onLoadMore: () => void;
  }) => (
    <section>
      {items.map(item => (
        <p key={item.title}>{item.title}</p>
      ))}
      {hasMore && (
        <button type="button" onClick={onLoadMore}>
          下一页
        </button>
      )}
    </section>
  ),
}));

let host: HTMLDivElement;
let root: Root;
const mount = () =>
  act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/user/8"]}>
        <Routes>
          <Route path="/user/:id" element={<VideoPost getScrollElement={() => host} />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
const click = async (label: string) => {
  const button = Array.from(host.querySelectorAll("button")).find(b => b.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
};
const page = (title: string, count: number) => ({
  code: 0,
  message: "OK",
  data: { list: { vlist: [{ title }] }, page: { count } },
});
const gated = { code: -352, data: { v_voucher: "fixture" } };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("投稿验证与分页", () => {
  it("loads public posts quietly and keeps them when the next page requires verification", async () => {
    api.posts
      .mockResolvedValueOnce(page("第一首", 31))
      .mockResolvedValueOnce(gated)
      .mockResolvedValueOnce(page("最后一首", 31));
    await mount();
    expect(host.textContent).toContain("第一首");
    expect(api.posts.mock.calls[0][1].passive).toBe(true);
    await click("下一页");
    expect(host.textContent).toContain("第一首");
    expect(host.textContent).toContain("查看投稿需要验证");
    expect(api.toast).not.toHaveBeenCalled();
    await click("去验证");
    expect(api.posts.mock.calls[2][0].pn).toBe(2);
    expect(api.posts.mock.calls[2][1].passive).toBe(false);
    expect(host.textContent).toContain("最后一首");
    expect(host.textContent).not.toContain("去验证");
  });
  it("shows a retry for a network failure and accepts a genuinely empty list", async () => {
    api.posts
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ code: 0, message: "OK", data: { list: { vlist: [] }, page: { count: 0 } } });
    await mount();
    expect(host.textContent).toContain("投稿加载失败");
    await click("重试");
    expect(api.posts.mock.calls[1][1].passive).toBe(true);
    expect(host.textContent).not.toContain("投稿加载失败");
    expect(api.toast).not.toHaveBeenCalled();
  });
  it("never presents the successful registration text as a captcha error", async () => {
    expect(await verifyGeetest(async () => ({ code: 0, message: "OK", data: {} }))).toBeNull();
    expect(api.toast).toHaveBeenCalledWith({ title: expect.stringContaining("验证方式"), color: "warning" });
    expect(await verifyGeetest(async () => ({ code: -1, message: "请求失败", data: null }))).toBeNull();
    expect(api.toast).toHaveBeenLastCalledWith({ title: "请求失败", color: "danger" });
  });
});
