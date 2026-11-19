import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { localMediaUrl } from "@/common/utils/local-media-url";
import { activeLineAt, lastStarted, parseLyrics } from "@/components/lyrics/timeline";
import { adoptedLyrics, applyLyricChange, assertLyricsKey, lyricsCacheKey, maxLyricLength } from "@shared/lyrics";

import { readLocalLyrics } from "../electron/ipc/api/local-lyrics";
import { getQQLyrics, searchQQ } from "../electron/ipc/api/qq-lyrics";

describe("lyric timeline", () => {
  it("distinguishes leading repeats from SPL word markers, ends and delayed first words", () => {
    const { lines } = parseLyrics({
      lyrics:
        "[ar:Example]\n[00:01.0][00:20.01]refrain\r\n[00:05.000]<00:05.200>你[00:05.650]好<00:06.000>\n[00:07.00]line\n[00:08.00]",
    });
    expect(lines.map(row => [row.time, row.text])).toEqual([
      [1000, "refrain"],
      [5000, "你好"],
      [7000, "line"],
      [20010, "refrain"],
    ]);
    expect(lines[1].words).toEqual([
      { time: 5200, end: 5650, text: "你" },
      { time: 5650, end: 6000, text: "好" },
    ]);
    expect(lastStarted(lines[1].words!, 5199)).toBe(-1);
    expect(lastStarted(lines[1].words!, 5650)).toBe(1);
    expect(activeLineAt(lines, 6100)).toBe(-1);
    expect(activeLineAt(lines, 7500)).toBe(2);
    expect(activeLineAt(lines, 9000)).toBe(-1);
    expect(activeLineAt(lines, 5300)).toBe(1);
    expect(lines[0].words).toBeUndefined();
  });
  it("preserves punctuation, inter-word spaces and absolute YRC durations", () => {
    const { lines } = parseLyrics({
      lyrics: '[offset:+100]\n{"t":0,"c":[]}\n[1000,1500](1100,200,0)hey (you) (1600,400,0)there!',
      tLyrics: "[00:00.900]你好",
      romaLyrics: "[00:00.900]ni hao",
    });
    expect(lines[0]).toMatchObject({
      time: 900,
      end: 2400,
      text: "hey (you) there!",
      translation: "你好",
      romanization: "ni hao",
      words: [
        { time: 1000, end: 1200, text: "hey (you) " },
        { time: 1500, end: 1900, text: "there!" },
      ],
    });
  });
  it("aligns translations and romanization by timestamp, not array position", () => {
    const { lines } = parseLyrics({
      lyrics: "[00:01]one\n[00:02]two\n[00:02]二\n[00:03]three\n三",
      tLyrics: "[00:03]第三\n[00:01]第一",
      romaLyrics: "[00:02]èr",
    });
    expect(lines.map(row => [row.text, row.translation, row.romanization])).toEqual([
      ["one", "第一", undefined],
      ["two", "二", "èr"],
      ["three", "第三", undefined],
    ]);
  });
  it("keeps plain-text line breaks and companions, without fabricating word timings", () => {
    expect(
      parseLyrics({ lyrics: "[ar:artist]\nfirst\n\nsecond", tLyrics: "一\n\n二", romaLyrics: "yi\n\ner" }),
    ).toEqual({ lines: [], plain: "first\n\nsecond", plainTranslation: "一\n\n二", plainRomanization: "yi\n\ner" });
    expect(parseLyrics({ lyrics: "[00:01]song" }).lines[0].words).toBeUndefined();
  });
});

describe("per-track raw lyric cache", () => {
  it("preserves historical keys and isolates local, WebDAV and online audio", () => {
    const keys = [
      lyricsCacheKey({ id: "same", bvid: "BV1", cid: "12" }),
      lyricsCacheKey({ source: "webdav", id: "same" }),
      lyricsCacheKey({ source: "local", id: "same" }),
      lyricsCacheKey({ id: "new", sid: 42 }),
    ];
    expect(keys).toEqual(["BV1-12", "webdav-same", "local-same", "audio-42"]);
    for (const key of keys) expect(() => assertLyricsKey(key)).not.toThrow();
    expect(() => assertLyricsKey("local-foo.bar")).toThrow();
    expect(() => assertLyricsKey("__proto__")).toThrow();
  });
  it("preserves cached text when changing preferences and retains preferences when adopting a new source", () => {
    const original = {
      lyrics: "legacy",
      tLyrics: "译",
      edited: { lyrics: "old manual text", romaLyrics: "romaji" },
      offset: 50,
      fontSize: 24,
    };
    const changed = applyLyricChange(original, { type: "preferences", offset: -250 });
    expect(changed).toEqual({ ...original, offset: -250 });
    const next = applyLyricChange(changed, { type: "adopt", text: { lyrics: "new result" } });
    expect(next).toEqual({ lyrics: "new result", offset: -250, fontSize: 24 });
    expect(adoptedLyrics(next)).toEqual(next);
    expect(adoptedLyrics({ fontSize: 24 })).toBeUndefined();
    expect(() => applyLyricChange(next, { type: "adopt", text: { lyrics: " ", tLyrics: "译" } })).toThrow();
    expect(() => applyLyricChange(next, { type: "adopt", text: { lyrics: "x".repeat(maxLyricLength + 1) } })).toThrow();
  });
});

it("loads only a configured track's same-stem sidecar, without decoding a large or arbitrary file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "biubiu-lyrics-"));
  try {
    const stem = path.join(dir, "曲 #100%");
    const audio = stem + ".mp3";
    const url = `file://${audio.replace(/\\/g, "/")}`;
    await writeFile(audio, "");
    await writeFile(stem + ".lrc", Buffer.from("﻿[00:01]歌词", "utf16le"));
    await writeFile(stem + ".spl", "[00:02]word<00:03>end");
    expect(await readLocalLyrics(url, [dir])).toBe("[00:02]word<00:03>end");
    expect(await readLocalLyrics(localMediaUrl(audio)!, [dir])).toBe("[00:02]word<00:03>end");
    await writeFile(stem + ".spl", Buffer.alloc(maxLyricLength + 1));
    expect(await readLocalLyrics(url, [dir])).toBe("[00:01]歌词");
    expect(await readLocalLyrics(url, [path.join(dir, "other")])).toBeUndefined();
    expect(await readLocalLyrics(url.replace(/\.mp3$/, ".lrc"), [dir])).toBeUndefined();
    expect(await readLocalLyrics("https://example.org/test.mp3", [dir])).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("on-demand QQ lyric source", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("uses fixed HTTPS endpoints with no credentials, limits results and decodes selected lyrics", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const song = { mid: "ABC123", name: "song", album: { name: "album" }, singer: [{ name: "artist" }], interval: 12 };
    fetcher.mockResolvedValueOnce(
      Response.json({ req: { code: 0, data: { body: { song: { list: Array(30).fill(song) } } } } }),
    );
    const rows = await searchQQ(" song ");
    expect(rows).toHaveLength(12);
    expect(rows[0]).toMatchObject({ mid: "ABC123", artist: "artist" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe("https://u.y.qq.com/cgi-bin/musicu.fcg");
    const encoded = Buffer.from("[00:01.000]你好").toString("base64");
    fetcher.mockResolvedValueOnce(Response.json({ retcode: 0, lyric: encoded, trans: encoded }));
    expect(await getQQLyrics(rows[0].mid)).toMatchObject({ lyrics: "[00:01.000]你好", tLyrics: "[00:01.000]你好" });
    expect(new URL(String(fetcher.mock.calls[1][0])).hostname).toBe("i.y.qq.com");
    for (const [, options] of fetcher.mock.calls) {
      expect(options).toMatchObject({ redirect: "error", credentials: "omit" });
      expect(options?.signal).toBeDefined();
      const headers = new Headers(options?.headers);
      expect(headers.has("cookie")).toBe(false);
      expect(headers.has("authorization")).toBe(false);
    }
  });
  it("rejects arbitrary URLs and oversized or unsuccessful responses", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    await expect(getQQLyrics("https://other.example/")).rejects.toThrow();
    expect(await searchQQ("x".repeat(129))).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(new Response("", { headers: { "content-length": String(2 * 1024 * 1024) } }));
    await expect(searchQQ("track")).rejects.toThrow();
    fetcher.mockResolvedValueOnce(new Response(new Uint8Array(1024 * 1024 + 1)));
    await expect(getQQLyrics("id")).rejects.toThrow();
  });
});
