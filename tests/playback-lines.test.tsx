import { act } from "react";
import { createRoot } from "react-dom/client";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlayData } from "@/store/play-list";

import { getDashUrl } from "@/common/utils/audio";
import PlaybackLinesPanel from "@/components/playback-lines-button/panel";
import { useSettings } from "@/store/settings";

const api = vi.hoisted(() => ({ dash: vi.fn(), audio: vi.fn(), sample: vi.fn(), track: vi.fn() }));
vi.mock("@/service/player-playurl", () => ({ getPlayerPlayurl: api.dash }));
vi.mock("@/service/audio-web-url", () => ({ getAudioWebStreamUrl: api.audio }));
vi.mock("@/store/play-list", () => ({ usePlayList: { getState: () => ({ getPlayItem: api.track }) } }));
vi.mock("@/common/utils/audio-cdn", async original => ({
  ...(await original<typeof import("@/common/utils/audio-cdn")>()),
  sampleMirror: api.sample,
}));

const url = (label: string) => `https://cdn.test/${label}`;
const stream = (label: string, bandwidth: number) => ({ id: bandwidth, baseUrl: url(label), bandwidth });
const before = useSettings.getState().audioQuality;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("electron", { setStore: vi.fn().mockResolvedValue(undefined) });
  api.dash.mockResolvedValue({
    data: { dash: { audio: [stream("high", 192000), stream("low", 64000)], flac: { audio: stream("flac", 800000) } } },
  });
  api.audio.mockResolvedValue({ data: { cdns: [url("au")], type: 2 } });
  api.sample.mockResolvedValue(100);
});
afterEach(() => {
  useSettings.setState({ audioQuality: before });
  vi.unstubAllGlobals();
});
describe("B 站的实际播放线路", () => {
  it("uses the saved video audio quality even when a lossless stream is available", async () => {
    useSettings.setState({ audioQuality: "low" });
    expect(await getDashUrl("BV1", 42)).toMatchObject({ audioUrl: url("low"), isLossless: false });
    useSettings.setState({ audioQuality: "auto" });
    expect(await getDashUrl("BV1", 42)).toMatchObject({ audioUrl: url("flac"), isLossless: true });
  });
  it.each([
    [{ type: "mv", bvid: "BV1", cid: "42", sid: 123 }, "low"],
    [{ type: "audio", sid: 7, bvid: "BV1" }, "au"],
    [{ type: "mv", bvid: "BV1", sid: 123 }, null],
  ] as const)("only tests the stream used by the current track %j", async (track: Partial<PlayData>, expected) => {
    useSettings.setState({ audioQuality: "low" });
    api.track.mockReturnValue(track);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<PlaybackLinesPanel />));
      const button = Array.from(document.querySelectorAll("button")).find(b => b.textContent === "测试当前歌曲线路");
      expect(button).toBeDefined();
      await act(async () => button!.click());
      if (expected) expect(api.sample).toHaveBeenCalledWith(url(expected), expect.any(AbortSignal));
      else expect(api.sample).not.toHaveBeenCalled();
      expect(api.dash).toHaveBeenCalledTimes(expected === "low" ? 1 : 0);
      expect(api.audio).toHaveBeenCalledTimes(expected === "au" ? 1 : 0);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
