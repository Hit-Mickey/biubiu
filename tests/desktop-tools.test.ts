import { afterEach, describe, expect, it, vi } from "vitest";

import { mediaHost, sampleMirror, selectMirror, streamCandidates } from "@/common/utils/audio-cdn";
import { parseBackup } from "@/pages/settings/library-backup";
import { completedTrack, historyLimit, listeningDate, listeningSummary, parseHistory } from "@/store/listening-history";
import { cancelSleepTimer, setSleepTimer, useSleepTimer } from "@/store/sleep-timer";
import { backupFormat, backupNamePattern } from "@shared/desktop-backup";

const backup = {
  format: backupFormat,
  version: 1,
  settings: {},
  playlists: { version: 1, playlists: [] },
  history: [],
  queue: [],
};
afterEach(() => {
  cancelSleepTimer();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("桌面曲库工具", () => {
  it("睡眠定时器可替换、取消；到时只暂停一次，不反转播放状态", () => {
    vi.useFakeTimers();
    const pause = vi.fn();
    setSleepTimer(15, "minutes", pause);
    setSleepTimer(1.5, "hours", pause);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(90 * 60_000 - 1);
    expect(pause).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(useSleepTimer.getState().deadline).toBeNull();
    setSleepTimer(5, "seconds", pause);
    cancelSleepTimer();
    vi.runAllTimers();
    expect(pause).toHaveBeenCalledTimes(1);
  });
  it("按输入的秒数暂停；无效输入不会覆盖现有定时", () => {
    vi.useFakeTimers();
    const pause = vi.fn();
    const deadline = Date.now() + 2500;
    expect(setSleepTimer(2.5, "seconds", pause)).toBe(true);
    for (const n of [0, -1, 0.1, NaN, Infinity, 1e20]) expect(setSleepTimer(n, "seconds", pause)).toBe(false);
    expect(useSleepTimer.getState().deadline).toBe(deadline);
    vi.advanceTimersByTime(2499);
    expect(pause).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(pause).toHaveBeenCalledOnce();
  });
  it("长于单个浏览器定时器的时长不会溢出或提前暂停", () => {
    vi.useFakeTimers();
    const pause = vi.fn();
    setSleepTimer(600, "hours", pause);
    vi.advanceTimersByTime(0x7fffffff);
    expect(pause).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(600 * 3_600_000 - 0x7fffffff);
    expect(pause).toHaveBeenCalledOnce();
  });
  it("保留原签名和音质，首选节点不存在时回落主地址", () => {
    const primary = "https://a.bilivideo.com/a?token=x",
      backupUrl = "https://b.bilivideo.com/b?token=y";
    const urls = streamCandidates({ base_url: primary, backup_url: [primary, backupUrl] });
    expect(urls).toEqual([primary, backupUrl]);
    expect(selectMirror(urls, "b.bilivideo.com")).toBe(backupUrl);
    expect(selectMirror(urls, "none")).toBe(primary);
    expect(mediaHost("https://user:pass@host/a")).toBe("");
  });
  it("测速只流式读取限定样本，即使对方忽略 Range 也会停止", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      pull(c) {
        c.enqueue(new Uint8Array(65536));
      },
      cancel,
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await sampleMirror("https://media.test/a", new AbortController().signal)).toBeGreaterThan(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: "omit", headers: { Range: "bytes=0-131071" } });
  });
  it("统计按稳定曲目键和本地日期汇总，不存媒体地址", () => {
    const row = completedTrack(
      {
        id: "temp",
        bvid: "BV1234567890",
        cid: "11",
        type: "mv",
        title: "演唱会",
        pageTitle: "第一首",
        audioUrl: "https://signed.test/token",
      },
      3.9,
      new Date(2026, 0, 5, 23).getTime(),
    )!;
    expect(row.title).toBe("第一首");
    expect(row).not.toHaveProperty("audioUrl");
    const summary = listeningSummary([row, { ...row, key: "BV1234567890:22" }, row]);
    expect(summary.seconds).toBe(12);
    expect(summary.days.get(listeningDate(row.at))).toBe(3);
    expect(summary.top.map(t => t.count)).toEqual([2, 1]);
    expect(() => parseHistory(Array(historyLimit + 1))).toThrow();
    expect(() => parseHistory([{ ...row, seconds: -1 }])).toThrow();
  });
  it("备份保留重复曲目与顺序，忽略 URL、凭据以及机器路径", () => {
    const track = {
      type: "mv",
      bvid: "BV1234567890",
      cid: "11",
      title: "歌曲",
      audioUrl: "https://signed.test/?auth=secret",
      videoUrl: "secret",
    };
    const parsed = parseBackup(
      JSON.stringify({
        ...backup,
        queue: [track, track],
        settings: { audioQuality: "high", proxySettings: { password: "secret" }, ffmpegPath: "secret" },
      }),
    );
    expect(parsed.queue).toHaveLength(2);
    expect(parsed.settings).toEqual({ audioQuality: "high" });
    expect(JSON.stringify(parsed)).not.toContain("secret");
  });
  it("恢复前拒绝错误版本、缺失数据或无效曲目", () => {
    for (const data of [
      { ...backup, version: 2 },
      { ...backup, history: null },
      { ...backup, queue: [{ type: "audio", source: "local", id: "file:///outside", title: "x" }] },
    ])
      expect(() => parseBackup(JSON.stringify(data))).toThrow();
    expect(backupNamePattern.test("biubiu-2026-11-19T05-04-03-000Z-a1234567.json")).toBe(true);
    expect(backupNamePattern.test("../other.json")).toBe(false);
  });
});
