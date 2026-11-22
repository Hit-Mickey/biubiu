import { describe, expect, it } from "vitest";

import { displayLyricLine, firstPlainLyric, plainLyricText } from "@/components/lyrics/line-layout";
import { activeLineAt, lastStarted, parseLyrics } from "@/components/lyrics/timeline";
import { adoptedLyrics, applyLyricChange, assertLyricsKey, lyricsCacheKey, maxLyricLength } from "@shared/lyrics";

describe("lyric timeline", () => {
  it("separates bilingual phrases while keeping punctuation, explicit translations and karaoke timings", () => {
    const [line] = parseLyrics({ lyrics: "[00:01]I ride <00:02>all night 我要<00:03>策马奔腾" }).lines;
    const parts = displayLyricLine(line, true);
    expect([parts.text, parts.translation]).toEqual(["I ride all night", "我要策马奔腾"]);
    expect(parts.words?.map(w => [w.time, w.text])).toEqual([
      [1000, "I ride "],
      [2000, "all night"],
    ]);
    expect(parts.translationWords?.map(w => [w.time, w.text])).toEqual([
      [2000, "我要"],
      [3000, "策马奔腾"],
    ]);
    expect(displayLyricLine(line, false)).toBe(line);
    for (const text of ["我在 New York 的夜里", "We met in 北京", "短句", "just English"]) {
      const mono = { time: 0, text };
      expect(displayLyricLine(mono, true)).toBe(mono);
    }
    expect(displayLyricLine({ time: 0, text: "你好世界 Hello world" }, true).translation).toBe("Hello world");
    expect(displayLyricLine({ time: 0, text: "Hello（你好）" }, true)).toMatchObject({
      text: "Hello",
      translation: "（你好）",
    });
    expect(displayLyricLine({ time: 0, text: "Hello / 你好" }, true).text).toBe("Hello");
    expect(displayLyricLine({ ...line, translation: "独立译文" }, true).text).toBe(line.text);
    expect(plainLyricText("We ride on一路前行\n\nsolo", true)).toBe("We ride on\n一路前行\n\nsolo");
    expect(firstPlainLyric("First line\n第一行\nNext line", "", "").translation).toBe("第一行");
  });
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
