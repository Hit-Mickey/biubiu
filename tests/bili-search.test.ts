import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { biliSearchTerm, parseBiliSearch } from "@/common/utils/bili-search";
import { resolveSearchTrack } from "@/pages/search/resolve-track";
import { getAudioSongInfo } from "@/service/audio-song-info";
import { getWebInterfaceView } from "@/service/web-interface-view";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/service/audio-song-info", () => ({ getAudioSongInfo: vi.fn() }));
vi.mock("@/service/web-interface-view", () => ({ getWebInterfaceView: vi.fn() }));

const bv = "BV17x411w7KC";
const url = `https://www.bilibili.com/video/${bv}`;
const video = {
  aid: 12,
  bvid: bv,
  title: "现场",
  pic: "//pic.test/poster",
  duration: 75,
  videos: 2,
  owner: { name: "UP", mid: 7 },
  stat: { view: 321 },
  pubdate: 1700000000,
  pages: [
    { page: 1, cid: 101, part: "上", duration: 30 },
    { page: 2, cid: 102, part: "下", duration: 45 },
  ],
};

describe("Bilibili search input", () => {
  it.each([
    [`  bv${bv.slice(2)} `, bv],
    [`m.bilibili.com/video/${bv}/?share_source=copy`, bv],
    [`【现场】（${url}?p=2&share_source=copy）`, `${url}?p=2`],
    ["【分享】 https://b23.tv/kS44BYx", "https://b23.tv/kS44BYx"],
    ["bilibili.com/video/av12", "av12"],
    ["https://www.bilibili.com/audio/au123/", "au123"],
  ])("recognizes %s and stores its media identifier", (input, expected) => {
    const target = parseBiliSearch(input);
    expect(target && target.kind !== "unsupported" && biliSearchTerm(target)).toBe(expected);
  });
  it.each(["普通关键词", "BV 音乐", "https://notbilibili.com/video/" + bv, "https://b23.tv.example/song"])(
    "keeps %s on the keyword search path",
    input => expect(parseBiliSearch(input)).toBeUndefined(),
  );
  it("distinguishes a non-media Bilibili page", () => {
    expect(parseBiliSearch("https://space.bilibili.com/123")).toEqual({ kind: "unsupported" });
  });
});

describe("exact track lookup", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getWebInterfaceView).mockResolvedValue({ code: 0, data: video } as Awaited<
      ReturnType<typeof getWebInterfaceView>
    >);
  });
  it("resolves the shared short link to the selected part", async () => {
    vi.mocked(invoke).mockResolvedValue(url + "?p=2");
    const signal = new AbortController().signal;
    const { track } = await resolveSearchTrack({ kind: "short", code: "kS44BYx" }, signal);
    expect(invoke).toHaveBeenCalledWith("resolve_bili_short_link", { code: "kS44BYx" });
    expect(getWebInterfaceView).toHaveBeenCalledWith({ bvid: bv }, { signal });
    expect(track).toMatchObject({
      cid: "102",
      pageIndex: 2,
      pageTitle: "下",
      totalPage: 2,
      duration: 45,
      playCount: 321,
    });
  });
  it("retains whole-video playback for a link without a part", async () => {
    const { track } = await resolveSearchTrack({ kind: "video", id: "av12" }, new AbortController().signal);
    expect(getWebInterfaceView).toHaveBeenCalledWith({ aid: 12 }, expect.anything());
    expect(track.bvid).toBe(bv);
    expect(track.cid).toBeUndefined();
  });
  it("reports missing parts and non-video short links", async () => {
    const signal = new AbortController().signal;
    await expect(resolveSearchTrack({ kind: "video", id: bv, page: 3 }, signal)).rejects.toThrow("第 3 个分 P");
    vi.mocked(invoke).mockResolvedValue("https://space.bilibili.com/7");
    await expect(resolveSearchTrack({ kind: "short", code: "kS44BYx" }, signal)).rejects.toThrow("短链接");
  });
  it("stops a previous short-link lookup before fetching metadata", async () => {
    const controller = new AbortController();
    vi.mocked(invoke).mockResolvedValue(url);
    const result = resolveSearchTrack({ kind: "short", code: "kS44BYx" }, controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(getWebInterfaceView).not.toHaveBeenCalled();
  });
  it("uses the audio metadata endpoint for AU links", async () => {
    vi.mocked(getAudioSongInfo).mockResolvedValue({
      code: 0,
      data: { id: 123, uid: 6, uname: "音乐人", title: "新歌", duration: 70 },
    } as Awaited<ReturnType<typeof getAudioSongInfo>>);
    const { track } = await resolveSearchTrack({ kind: "audio", sid: 123 }, new AbortController().signal);
    expect(track).toMatchObject({ type: "audio", sid: 123, duration: 70, ownerName: "音乐人" });
    expect(getWebInterfaceView).not.toHaveBeenCalled();
  });
});
