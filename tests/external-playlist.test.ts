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

import { fetchPublicPlaylist } from "../electron/ipc/api/external-playlist";

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
const json = (value: unknown) => vi.fn<typeof fetch>().mockResolvedValue(Response.json(value));

// Synthetic IDs only. The public index exposes every position, but embeds just ten songs.
const song = (id: number) => ({ id, name: `曲目${id}`, ar: [{ name: "歌手" }], dt: 188000 });
const ids241 = Array.from({ length: 241 }, (_, i) => 1001 + i);
const index241 = {
  code: 200,
  playlist: { trackCount: 241, trackIds: ids241.map(id => ({ id })), tracks: ids241.slice(0, 10).map(song) },
};
const batchIds = (input: RequestInfo | URL) => JSON.parse(new URL(String(input)).searchParams.get("ids")!) as number[];
const pageData = (offset: number, songs: unknown[], total: number) => ({
  code: 0,
  cdlist: [{ song_begin: offset, cur_song_num: songs.length, total_song_num: total, songnum: total, songlist: songs }],
});

const neteaseData = {
  code: 200,
  result: {
    name: "公开歌单",
    trackCount: 5,
    trackIds: [{ id: 2 }, { id: 3 }, { id: 1 }, { id: 2 }],
    tracks: [
      { id: 1, name: "第二首", duration: 192000, artists: [{ name: "合唱团" }], mp3Url: "https://audio.invalid/1" },
      { id: 2, name: "第一首", dt: 188000, ar: [{ name: "歌手" }], al: { picUrl: "https://img.invalid/2" } },
    ],
  },
};
const qqData = {
  code: 0,
  data: {
    cdlist: [
      {
        dissname: "合辑",
        songnum: 2,
        songlist: [
          {
            name: "甲",
            singer: [{ name: "A" }, { name: "B" }],
            interval: 120,
            file: { url: "https://audio.invalid/2" },
          },
          { songname: "乙", singer: [], interval: 0 },
        ],
      },
    ],
  },
};

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

  it("requests only a fixed metadata URL, does not forward headers/credentials or share parameters, returns no media URLs", async () => {
    for (const [link, data, host, path, referer] of [
      [
        "https://music.163.com/playlist?id=123&token=SENSITIVE",
        neteaseData,
        "music.163.com",
        "/api/v6/playlist/detail",
        "https://music.163.com/",
      ],
      [
        "https://i.y.qq.com/n2/m/share/details/taoge.html?id=456&uin=SENSITIVE",
        qqData,
        "c.y.qq.com",
        "/v8/fcg-bin/fcg_v8_playlist_cp.fcg",
        "https://y.qq.com/",
      ],
    ] as const) {
      const request = json({ code: 200, songs: [] }).mockResolvedValueOnce(Response.json(data));
      const ref = {
        ...parseExternalPlaylist(link)!,
        url: "http://localhost/",
        headers: { Cookie: "SESSDATA=SENSITIVE", Authorization: "Basic SENSITIVE" },
      };
      const playlist = await fetchPublicPlaylist(ref, signal(), request);
      expect(request).toHaveBeenCalledTimes(ref.source === "netease" ? 2 : 1);
      for (const [i, [input, init]] of request.mock.calls.entries()) {
        const url = new URL(String(input));
        expect(url.origin + url.pathname).toBe(`https://${host}${i === 0 ? path : "/api/song/detail"}`);
        if (i === 0) expect(url.searchParams.get("id")).toBe(ref.id);
        else expect([...url.searchParams]).toEqual([["ids", "[3]"]]);
        expect(init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit" });
        expect(new Headers(init?.headers).get("referer")).toBe(referer);
        const headerNames: string[] = [];
        new Headers(init?.headers).forEach((_, name) => headerNames.push(name));
        expect(headerNames.sort()).toEqual(["accept", "referer", "user-agent"]);
        expect(url.href + JSON.stringify(init)).not.toContain("SENSITIVE");
      }
      expect(JSON.stringify(playlist)).not.toMatch(/https?:|SENSITIVE|mp3Url/);
    }
  });
  it("retains declared NetEase positions, holes and repetitions instead of reordering shortened metadata", async () => {
    const request = json({ code: 200, songs: [song(999)] }).mockResolvedValueOnce(Response.json(neteaseData));
    const data = await fetchPublicPlaylist(netease, signal(), request);
    expect(batchIds(request.mock.calls[1][0])).toEqual([3]);
    expect(data).toEqual({
      title: "公开歌单",
      total: 5,
      tracks: [
        { title: "第一首", artists: ["歌手"], duration: 188 },
        null,
        { title: "第二首", artists: ["合唱团"], duration: 192 },
        { title: "第一首", artists: ["歌手"], duration: 188 },
      ],
    });
  });
  it("normalizes QQ seconds and old/new song fields", async () => {
    const data = await fetchPublicPlaylist(qq, signal(), json(qqData));
    expect(data).toEqual({
      title: "合辑",
      total: 2,
      tracks: [
        { title: "甲", artists: ["A", "B"], duration: 120 },
        { title: "乙", artists: [], duration: undefined },
      ],
    });
  });
  it("expands 10 embedded NetEase tracks to all 241 positions using bounded, sequential missing-ID requests", async () => {
    const batches: number[][] = [];
    let inFlight = 0;
    const request = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v6/playlist/detail") {
        expect(url.searchParams.get("n")).toBe("10");
        return Response.json(index241);
      }
      expect(url.origin + url.pathname).toBe("https://music.163.com/api/song/detail");
      expect(++inFlight).toBe(1);
      const ids = batchIds(input);
      batches.push(ids);
      await Promise.resolve();
      inFlight--;
      return Response.json({ code: 200, songs: ids.toReversed().map(song) });
    });
    const data = await fetchPublicPlaylist(netease, signal(), request);
    expect(batches.map(batch => batch.length)).toEqual([50, 50, 50, 50, 31]);
    expect(batches.flat()).toEqual(ids241.slice(10));
    expect(data.total).toBe(241);
    expect(data.tracks.map(t => t?.title)).toEqual(ids241.map(id => `曲目${id}`));
    expect(search).not.toHaveBeenCalled();
  });
  it("requests a repeated missing ID just once, does not request invalid IDs, and keeps their positions", async () => {
    const order = [30, { id: "bad&id=2" }, 10, "30", 20, 10, 0];
    const request = json({ code: 200, songs: [song(10), song(30)] }).mockResolvedValueOnce(
      Response.json({ code: 200, playlist: { trackIds: order } }),
    );
    const data = await fetchPublicPlaylist(netease, signal(), request);
    expect(request).toHaveBeenCalledTimes(2);
    expect(batchIds(request.mock.calls[1][0])).toEqual([30, 10, 20]);
    expect(data.tracks.map(t => t?.title ?? null)).toEqual(["曲目30", null, "曲目10", "曲目30", null, "曲目10", null]);
  });
  it("keeps a complete unpaged QQ response even past position 200", async () => {
    const songlist = ids241.map(i => ({ name: String(i) }));
    const data = await fetchPublicPlaylist(qq, signal(), json({ code: 0, cdlist: [{ songlist }] }));
    expect(data.tracks.map(t => t?.title)).toEqual(ids241.map(String));
    expect(data.total).toBe(241);
  });
  it("reads QQ pages in official song_begin order, preserving duplicates and unavailable positions across boundaries", async () => {
    const songs = ids241.map((id, i) => (i === 49 || i === 210 ? null : { name: i % 50 === 0 ? "重复" : String(id) }));
    const offsets: number[] = [];
    const request = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe("https://c.y.qq.com/v8/fcg-bin/fcg_v8_playlist_cp.fcg");
      const begin = Number(url.searchParams.get("song_begin"));
      const size = Number(url.searchParams.get("song_num"));
      expect(size).toBe(50);
      offsets.push(begin);
      return Response.json(pageData(begin, songs.slice(begin, begin + size), songs.length));
    });
    const data = await fetchPublicPlaylist(qq, signal(), request);
    expect(data.total).toBe(songs.length);
    expect(data.tracks.map(t => t?.title ?? null)).toEqual(songs.map(s => s?.name ?? null));
    expect(offsets).toEqual([0, 50, 100, 150, 200]);
    expect(search).not.toHaveBeenCalled();
  });
  it.each([
    ["repeated first page", pageData(0, [{ name: "a" }], 3)],
    ["missing offset", { code: 0, cdlist: [{ songnum: 3, songlist: [{ name: "a" }] }] }],
    ["empty page", pageData(1, [], 3)],
    ["changed count", pageData(1, [{ name: "b" }], 4)],
  ])("doesn't claim completion after an inconsistent QQ page (%s)", async (_, next) => {
    const request = json(next).mockResolvedValueOnce(Response.json(pageData(0, [{ name: "a" }], 3)));
    await expect(fetchPublicPlaylist(qq, signal(), request)).rejects.toThrow("分页");
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each([
    [new Response(null, { status: 429 }), "HTTP 429"],
    [Response.json({ code: 403 }), "匿名详情"],
    [Response.json({ code: 200 }), "格式"],
    [new Response(null, { headers: { "Content-Length": "9000000" } }), "4 MiB"],
  ] as const)(
    "stops rather than turning a failed NetEase batch into unavailable (or successful) tracks: %s",
    async (res, message) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(index241))
        .mockImplementationOnce(async input => Response.json({ code: 200, songs: batchIds(input).map(song) }))
        .mockResolvedValueOnce(res);
      await expect(fetchPublicPlaylist(netease, signal(), request)).rejects.toThrow(message);
      expect(request).toHaveBeenCalledTimes(3);
      expect(search).not.toHaveBeenCalled();
    },
  );
  it.each([
    [netease, index241],
    [qq, pageData(0, [{ name: "a" }], 241)],
  ] as const)(
    "doesn't schedule another batch or accept a late response after cancelling $source",
    async (ref, index) => {
      const started = Promise.withResolvers<void>();
      const late = Promise.withResolvers<Response>();
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(index))
        .mockImplementationOnce(() => {
          started.resolve();
          return late.promise;
        });
      const controller = new AbortController();
      const run = fetchPublicPlaylist(ref, controller.signal, request);
      await started.promise;
      controller.abort();
      expect(request.mock.calls[1][1]?.signal?.aborted).toBe(true);
      late.resolve(Response.json({}));
      await expect(run).rejects.toMatchObject({ name: "AbortError" });
      expect(request).toHaveBeenCalledTimes(2);
    },
  );
  it("validates IPC arguments before any I/O", async () => {
    const request = vi.fn<typeof fetch>();
    for (const ref of [
      { source: "qq", id: "1&url=http://host/" },
      { source: "http://host", id: "1" },
      { source: "qq", id: ["1"] },
    ]) {
      await expect(fetchPublicPlaylist(ref as ExternalPlaylistRef, signal(), request)).rejects.toThrow("无效");
    }
    expect(request).not.toHaveBeenCalled();
  });
  it("distinguishes empty playlists, denied/private responses and unexpected bodies", async () => {
    await expect(
      fetchPublicPlaylist(qq, signal(), json({ code: 0, cdlist: [{ songlist: [] }] })),
    ).resolves.toMatchObject({ tracks: [], total: 0 });
    for (const data of [{ code: 403 }, { code: 200 }, { code: 200, playlist: { privacy: 10, tracks: [] } }]) {
      await expect(fetchPublicPlaylist(netease, signal(), json(data))).rejects.toThrow("未公开");
    }
    await expect(fetchPublicPlaylist(qq, signal(), json({ code: 0, cdlist: [{ songnum: 4 }] }))).rejects.toThrow(
      "格式",
    );
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("not json"));
    await expect(fetchPublicPlaylist(qq, signal(), request)).rejects.toThrow("格式");
    request.mockResolvedValue(new Response(null, { status: 429 }));
    await expect(fetchPublicPlaylist(qq, signal(), request)).rejects.toThrow("HTTP 429");
    request.mockResolvedValue(new Response(null, { headers: { "Content-Length": "9000000" } }));
    await expect(fetchPublicPlaylist(qq, signal(), request)).rejects.toThrow("4 MiB");
  });
  it("reports unexposed QQ positions without inventing requests or padding from a declared total", async () => {
    const page = pageData(0, [{ name: "公开" }], 1);
    page.cdlist[0].songnum = 9999999;
    const request = json(page);
    const data = await fetchPublicPlaylist(qq, signal(), request);
    expect(data.total).toBe(9999999);
    expect(data.tracks).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("enforces the byte limit on a streamed batch without Content-Length", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
      },
      cancel,
    });
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(index241))
      .mockResolvedValueOnce(new Response(body));
    await expect(fetchPublicPlaylist(netease, signal(), request)).rejects.toThrow("4 MiB");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("aborts an in-flight anonymous request and never starts a pre-cancelled one", async () => {
    const request = vi.fn<typeof fetch>(
      (_, init) =>
        new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }),
        ),
    );
    const c = new AbortController();
    const run = fetchPublicPlaylist(qq, c.signal, request);
    c.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
    await expect(fetchPublicPlaylist(netease, c.signal, request)).rejects.toMatchObject({ name: "AbortError" });
    expect(request).toHaveBeenCalledTimes(1);
  });
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
    const request = vi
      .fn<typeof fetch>(async input => Response.json({ code: 200, songs: batchIds(input).map(song) }))
      .mockResolvedValueOnce(Response.json(index241));
    const playlist = await fetchPublicPlaylist(netease, signal(), request);
    const rows = makePreview(playlist.tracks);
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
      // No Electron cookie API or interactive captcha is available in this offline renderer.
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
