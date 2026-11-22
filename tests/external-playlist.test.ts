// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PreviewRow } from "@/pages/desktop-playlists/external-match";
import type { ExternalPlaylistRef, ExternalTrack } from "@shared/external-playlist";

import {
  makePreview,
  matchRows,
  resolveVideo,
  selectedItems,
  withVideoChoice,
} from "@/pages/desktop-playlists/external-match";
import { getWebInterfaceWbiSearchType } from "@/service/web-interface-search-type";
import { getWebInterfaceView } from "@/service/web-interface-view";
import { parseExternalPlaylist } from "@shared/external-playlist";

vi.mock("@/service/web-interface-search-type", () => ({ getWebInterfaceWbiSearchType: vi.fn() }));
vi.mock("@/service/web-interface-view", () => ({ getWebInterfaceView: vi.fn() }));
vi.mock("@/store/user", () => ({ useUser: { getState: () => ({ user: null }) } }));
vi.mock("@/store/token", () => ({
  useToken: {
    getState: () => {
      throw new Error("Passive lookup accessed token store");
    },
  },
}));
const search = vi.mocked(getWebInterfaceWbiSearchType);
const view = vi.mocked(getWebInterfaceView);
const netease: ExternalPlaylistRef = { source: "netease", id: "123" };
const qq: ExternalPlaylistRef = { source: "qq", id: "456" };
const signal = () => new AbortController().signal;

const ids241 = Array.from({ length: 241 }, (_, i) => 1001 + i);
const tracks241: ExternalTrack[] = ids241.map(id => ({ title: `曲目${id}`, artists: ["歌手"], duration: 188 }));

describe("public playlist boundary", () => {
  it.each([
    ["https://music.163.com/#/playlist?id=123&userid=abc", netease],
    ["https://music.163.com/playlist?id=123&token=private", netease],
    ["http://y.music.163.com/m/playlist/123/", netease],
    ["https://y.qq.com/n/ryqq/playlist/456", qq],
    ["https://y.qq.com/n/yqq/playlist/456.html", qq],
    ["https://i.y.qq.com/n2/m/share/details/taoge.html?id=456&ADTAG=x", qq],
    ["netease:123", netease],
    [" qq:456 ", qq],
  ])("extracts only the platform and id from %s", (input, ref) => {
    expect(parseExternalPlaylist(input as string)).toEqual(ref);
  });
  it.each([
    "file:///playlist?id=123",
    "https://music.163.com.example/playlist?id=123",
    "https://music.163.com@other.test/playlist?id=123",
    "https://user:pw@music.163.com/playlist?id=123",
    "https://music.163.com:9000/playlist?id=123",
    "https://music.163.com/song?id=123",
    "https://music.163.com/#//other.test/playlist?id=123",
    "https://music.163.com/playlist?id=1&id=2",
    "https://y.qq.com/n/ryqq/songDetail/456",
    "https://c.y.qq.com/base/fcgi-bin/u?__=short",
    "https://other.test/?url=https://music.163.com/playlist?id=123",
    "qq:0",
    "123",
    "qq:12?token=abc",
  ])("rejects ambiguous, non-playlist or non-allowlisted input %s", input =>
    expect(parseExternalPlaylist(input)).toBeNull(),
  );
});

const track: ExternalTrack = { title: "夜曲", artists: ["歌手"], duration: 188 };
const bv1 = "BV1xx411c7mD",
  bv2 = "BV17x411w7KC",
  bv3 = "BV1Q541167Qg";
const hit = (bvid: string, title: string, duration = "03:08", typeid = 193) => ({
  bvid,
  title,
  author: "歌手",
  pic: "//i0.hdslb.com/bfs/archive/pic.jpg",
  mid: 9,
  duration,
  typeid,
  stream: "https://audio.invalid",
});
const response = (hits: ReturnType<typeof hit>[]) => ({
  code: 0,
  message: "",
  ttl: 1,
  data: { seid: 1, page: 1, pagesize: 20, numResults: hits.length, numPages: 1, result: hits },
});
const apply = (rows: PreviewRow[]) => (index: number, row: PreviewRow) => {
  rows[index] = row;
};

describe("Bilibili preview", () => {
  afterEach(() => vi.useRealTimers());
  it("ranks title/artist/time, strips markup, drops foreign covers, and never autosaves weak matches", async () => {
    const rows = makePreview([track]);
    search.mockResolvedValue(
      response([
        hit(bv1, "无关歌曲"),
        hit(bv3, "夜曲 翻唱", "03:08", 31),
        { ...hit(bv2, '歌手《<em class="keyword">夜曲</em>》 &amp; MV'), pic: "https://foreign.test/track.jpg" },
        hit(bv1, "同一 BV"),
        hit("not-a-BV", "夜曲"),
      ]),
    );
    const s = signal();
    await matchRows(rows, "pending", s, apply(rows));
    expect(search).toHaveBeenCalledWith(
      { search_type: "video", keyword: "夜曲 歌手", page: 1 },
      { signal: s, passive: true },
    );
    expect(rows[0].selected).toBe(bv2);
    expect(rows[0].candidates).toHaveLength(3);
    expect(selectedItems(rows)).toEqual([
      {
        type: "mv",
        source: "online",
        title: "歌手《夜曲》 & MV",
        bvid: bv2,
        ownerName: "歌手",
        ownerMid: 9,
        duration: 188,
        cover: undefined,
      },
    ]);
    search.mockResolvedValue(
      response([hit(bv1, "无关歌曲"), hit(bv2, "夜曲", "03:56"), hit(bv3, "夜曲", "03:08", 31)]),
    );
    const weak = makePreview([track]);
    await matchRows(weak, "pending", s, apply(weak));
    expect(weak[0].candidates).toHaveLength(3);
    expect(selectedItems(weak)).toEqual([]);
  });
  it("can match and select all 241 positions with an offline search fixture", async () => {
    const rows = makePreview(tracks241);
    expect(search).not.toHaveBeenCalled();
    vi.useFakeTimers();
    let cursor = 0;
    search.mockImplementation(async q => response([hit(`BV1${String(++cursor).padStart(9, "0")}`, q.keyword)]));
    const run = matchRows(rows, "pending", signal(), apply(rows));
    await vi.advanceTimersByTimeAsync(rows.length * 1200);
    await run;
    expect(search).toHaveBeenCalledTimes(241);
    expect(selectedItems(rows).map(v => v.title)).toEqual(ids241.map(id => `曲目${id} 歌手`));
  });
  it("paces successive searches in order, preserves failed positions and lets users correct, skip and save repeated choices", async () => {
    vi.useFakeTimers();
    const rows = makePreview([track, null, { ...track, title: "二" }, track]);
    search
      .mockResolvedValueOnce(response([hit(bv1, "夜曲")]))
      .mockRejectedValueOnce(new Error("离线"))
      .mockResolvedValueOnce(response([hit(bv2, "夜曲")]));
    const run = matchRows(rows, "pending", signal(), apply(rows));
    await vi.advanceTimersByTimeAsync(1100);
    expect(search).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1400);
    await run;
    expect(search.mock.calls.map(([q]) => q.keyword)).toEqual(["夜曲 歌手", "二 歌手", "夜曲 歌手"]);
    expect(rows.map(row => row.state)).toEqual(["ready", "unavailable", "failed", "ready"]);
    expect(rows[2].note).toBe("离线");
    rows[2] = withVideoChoice(rows[2], rows[3].candidates[0]);
    expect(selectedItems(rows).map(v => v.bvid)).toEqual([bv1, bv2, bv2]);
    rows[0].selected = "";
    expect(selectedItems(rows).map(v => v.bvid)).toEqual([bv2, bv2]);
  });
  it("stops on a verification response rather than refreshing credentials or requesting another track", async () => {
    const rows = makePreview([track, track]);
    search.mockResolvedValue({ ...response([]), data: { ...response([]).data, v_voucher: "verify" } } as ReturnType<
      typeof response
    >);
    await expect(matchRows(rows, "pending", signal(), apply(rows))).rejects.toThrow("限制");
    expect(rows.map(row => row.state)).toEqual(["failed", "pending"]);
    expect(search).toHaveBeenCalledTimes(1);
  });
  it("propagates passive mode and cancellation through the real search and WBI interceptors", async () => {
    const { apiRequest } = await import("@/service/request");
    const { getWebInterfaceWbiSearchType: lookup } = await vi.importActual<
      typeof import("@/service/web-interface-search-type")
    >("@/service/web-interface-search-type");
    const s = signal();
    const visited: string[] = [];
    const previous = apiRequest.defaults.adapter;
    apiRequest.defaults.adapter = async config => {
      expect(config.baseURL).toBe("https://api.bilibili.com");
      expect(config.passive).toBe(true);
      expect(config.signal).toBe(s);
      visited.push(config.url!);
      return {
        config,
        status: 200,
        statusText: "OK",
        headers: {},
        data:
          config.url === "/x/web-interface/nav"
            ? {
                code: -101,
                data: { wbi_img: { img_url: "https://i0.hdslb.com/abc.png", sub_url: "https://i0.hdslb.com/def.png" } },
              }
            : { code: -352, data: { v_voucher: "verification required" } },
      };
    };
    try {
      // No backend cookie API or interactive captcha is available in this offline renderer.
      const res = await lookup({ search_type: "video", keyword: "a song" }, { signal: s, passive: true });
      expect(res.code).toBe(-352);
      expect(visited).toEqual(["/x/web-interface/nav", "/x/web-interface/wbi/search/type"]);
    } finally {
      apiRequest.defaults.adapter = previous;
    }
  });
  it("ignores a late result after cancellation", async () => {
    const c = new AbortController();
    const deferred = Promise.withResolvers<ReturnType<typeof response>>();
    search.mockReturnValue(deferred.promise);
    const rows = makePreview([track, track]);
    const run = matchRows(rows, "pending", c.signal, apply(rows));
    c.abort();
    deferred.resolve(response([hit(bv1, "夜曲")]));
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(search.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(rows.map(row => row.state)).toEqual(["pending", "pending"]);
    expect(search).toHaveBeenCalledTimes(1);
  });
  it("cancels the gap between searches without discarding earlier candidates", async () => {
    vi.useFakeTimers();
    search.mockResolvedValue(response([hit(bv1, "夜曲")]));
    const rows = makePreview([track, track]);
    const c = new AbortController();
    const run = matchRows(rows, "pending", c.signal, apply(rows));
    await vi.advanceTimersByTimeAsync(300);
    c.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(search).toHaveBeenCalledTimes(1);
    expect(rows.map(row => row.state)).toEqual(["ready", "pending"]);
  });
  it("manual correction resolves only an exact BV id and whitelists the resulting PlayItem", async () => {
    const s = signal();
    await expect(resolveVideo("https://other.test/?bvid=" + bv1, s)).rejects.toThrow("BV");
    expect(view).not.toHaveBeenCalled();
    view.mockResolvedValue({
      code: 0,
      data: {
        bvid: bv1,
        title: "正确版本",
        duration: 199,
        owner: { mid: 9, name: "歌手" },
        pic: "file:///local",
        audioUrl: "https://audio.invalid",
      },
    } as unknown as Awaited<ReturnType<typeof view>>);
    const result = await resolveVideo(bv1, s);
    expect(view).toHaveBeenCalledWith({ bvid: bv1 }, { signal: s, passive: true });
    expect(result).toMatchObject({ bvid: bv1, title: "正确版本", duration: 199, cover: undefined });
    expect(result).not.toHaveProperty("audioUrl");
    await expect(resolveVideo(bv2, s)).rejects.toThrow("未能确认");
  });
});
