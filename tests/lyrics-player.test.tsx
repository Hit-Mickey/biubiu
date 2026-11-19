import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlayData } from "@/store/play-list";

import DesktopLyricsButton from "@/components/desktop-lyrics-button";
import LyricsView from "@/components/lyrics";
import LyricsSearchModal from "@/components/lyrics-search-modal";
import DesktopLyricsOutput from "@/components/lyrics/desktop-output";
import { getNativeLyrics } from "@/components/lyrics/get-lyrics";
import { useTrackLyrics } from "@/components/lyrics/use-track-lyrics";
import { getLyric } from "@/service/ai-lyrics";
import { getWebPlayerInfo } from "@/service/web-player";
import { useDesktopLyrics } from "@/store/desktop-lyrics";
import { usePlayProgress } from "@/store/play-progress";
import { useSettings } from "@/store/settings";

let media: HTMLAudioElement;
vi.mock("@/store/play-list", () => ({ usePlayList: { getState: () => ({ getAudio: () => media }) } }));
vi.mock("@/service/web-player", () => ({ getWebPlayerInfo: vi.fn() }));
vi.mock("@/service/ai-lyrics", () => ({ getLyric: vi.fn() }));

let host: HTMLDivElement;
let root: Root;
const track = (id: string, source: PlayData["source"] = "local"): PlayData => ({
  id,
  source,
  type: "audio",
  title: id,
  audioUrl: `file:///music/${id}.mp3`,
  webDavListId: source === "webdav" ? "list" : undefined,
});
function Lyrics(props: Omit<ComponentProps<typeof LyricsView>, "lyrics">) {
  return <LyricsView {...props} lyrics={useTrackLyrics(props.item)} />;
}

const render = (item: PlayData) =>
  act(async () => {
    root.render(<Lyrics key={item.id} item={item} />);
  });
const setBridge = (api: Partial<ElectronAPI>) => {
  window.electron = api as ElectronAPI;
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
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  host = document.createElement("div");
  root = createRoot(host);
  media = document.createElement("audio");
  usePlayProgress.getState().setCurrentTime(0);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

describe("current-track lyric view", () => {
  it("does not run online search on playback, reuses adopted/edited text and discards a stale native read", async () => {
    let finish!: (s: string) => void;
    const delayed = new Promise<string>(resolve => {
      finish = resolve;
    });
    const readLocalLyrics = vi.fn().mockReturnValueOnce(delayed);
    const getWebDavLyrics = vi.fn().mockResolvedValue("[ar:tag]\n远程原文");
    const getTrackLyrics = vi
      .fn()
      .mockImplementation(async (key: string) =>
        key === "local-current"
          ? { lyrics: "adopted", edited: { lyrics: "edited", tLyrics: "译", romaLyrics: "romaji" } }
          : { offset: 50 },
      );
    const searchQQLyricSongs = vi.fn();
    setBridge({ readLocalLyrics, getWebDavLyrics, getTrackLyrics, searchQQLyricSongs });
    await render(track("slow"));
    await render(track("current"));
    expect(host.textContent).toBe("edited译romaji");
    await act(async () => finish("stale song"));
    expect(host.textContent).toBe("edited译romaji");
    expect(readLocalLyrics).toHaveBeenCalledTimes(1);
    await render(track("dav", "webdav"));
    expect(getWebDavLyrics).toHaveBeenCalledWith("list", "dav");
    expect(host.textContent).toBe("远程原文");
    expect(searchQQLyricSongs).not.toHaveBeenCalled();
  });
  it("reads lyrics during the opening animation and renders them when it ends without a second read", async () => {
    const getTrackLyrics = vi.fn().mockResolvedValue({});
    const readLocalLyrics = vi.fn().mockResolvedValue("[00:00]ready before the animation ends");
    setBridge({ getTrackLyrics, readLocalLyrics });
    const item = track("deferred");
    await act(async () => root.render(<Lyrics item={item} deferRendering />));
    expect(readLocalLyrics).toHaveBeenCalledWith(item.audioUrl);
    expect(host.childElementCount).toBe(0);
    await act(async () => root.render(<Lyrics item={item} />));
    expect(host.textContent).toBe("ready before the animation ends");
    expect(getTrackLyrics).toHaveBeenCalledTimes(1);
    expect(readLocalLyrics).toHaveBeenCalledTimes(1);
  });

  it("only creates word spans on the active row and resynchronizes to the media clock after a backward seek", async () => {
    setBridge({
      getTrackLyrics: vi.fn().mockResolvedValue({ lyrics: "[00:01]one <00:02>two\n[00:05]next <00:06>line" }),
    });
    media.currentTime = 1.5;
    usePlayProgress.getState().setCurrentTime(1.5);
    await render(track("timed"));
    expect(Array.from(host.querySelectorAll("span"), node => node.textContent)).toEqual(["one ", "two"]);
    expect(host.querySelector("span.underline")?.textContent).toBe("one ");
    await act(async () => {
      media.currentTime = 2.4;
      media.dispatchEvent(new Event("timeupdate"));
    });
    expect(host.querySelector("span.underline")?.textContent).toBe("two");
    await act(async () => {
      media.currentTime = 6;
      usePlayProgress.getState().setCurrentTime(6);
    });
    expect(host.querySelector("span.underline")?.textContent).toBe("line");
    await act(async () => {
      media.currentTime = 1.25;
      usePlayProgress.getState().setCurrentTime(1.25);
      media.dispatchEvent(new Event("seeked"));
    });
    expect(host.querySelector("span.underline")?.textContent).toBe("one ");
  });
  it("only queries the selected provider, then previews and adopts a single clicked result", async () => {
    const searchNeteaseSongs = vi.fn().mockResolvedValue({ result: { songs: [] } });
    const searchQQLyricSongs = vi
      .fn()
      .mockResolvedValue([{ mid: "qq1", title: "fixture", album: "album", artist: "artist", duration: 12 }]);
    const text = { lyrics: "[00:01]original", tLyrics: "[00:01]译", romaLyrics: "[00:01]roma" };
    const getQQLyrics = vi.fn().mockResolvedValue(text);
    const onAdopt = vi.fn().mockResolvedValue(true);
    setBridge({ searchNeteaseSongs, searchQQLyricSongs, getQQLyrics });
    await act(async () => root.render(<LyricsSearchModal title="fixture" onClose={() => {}} onAdopt={onAdopt} />));
    expect(searchQQLyricSongs).toHaveBeenCalledTimes(1);
    expect(searchNeteaseSongs).not.toHaveBeenCalled();
    const click = async (selector: string, label: string) =>
      act(async () => {
        Array.from(document.querySelectorAll<HTMLElement>(selector))
          .find(node => node.textContent === label)!
          .click();
      });
    await click('[role="tab"]', "网易云");
    expect(searchNeteaseSongs).toHaveBeenCalledTimes(1);
    expect(searchQQLyricSongs).toHaveBeenCalledTimes(1);
    await click('[role="tab"]', "QQ 音乐");
    expect(searchQQLyricSongs).toHaveBeenCalledWith("fixture");
    expect(getQQLyrics).not.toHaveBeenCalled();
    await click("td", "fixture");
    expect(getQQLyrics).toHaveBeenCalledTimes(1);
    await click("button", "采用歌词");
    expect(onAdopt).toHaveBeenCalledWith(text);
  });
  it("reads the saved search source each time the search modal opens", async () => {
    const getStore = vi.fn().mockResolvedValue({ appSettings: { lyricSearchSource: "lrclib" } });
    const searchLrclibLyrics = vi.fn().mockResolvedValue([]);
    const searchQQLyricSongs = vi.fn().mockResolvedValue([]);
    setBridge({ getStore, searchLrclibLyrics, searchQQLyricSongs });
    await useSettings.persist.rehydrate();
    await act(async () =>
      root.render(<LyricsSearchModal key="saved" title="fixture" onClose={() => {}} onAdopt={vi.fn()} />),
    );
    expect(searchLrclibLyrics).toHaveBeenCalledWith({ q: "fixture" });
    expect(searchQQLyricSongs).not.toHaveBeenCalled();
    getStore.mockResolvedValue({ appSettings: {} });
    await useSettings.persist.rehydrate();
    await act(async () =>
      root.render(<LyricsSearchModal key="legacy" title="fixture" onClose={() => {}} onAdopt={vi.fn()} />),
    );
    expect(searchQQLyricSongs).toHaveBeenCalledWith("fixture");
    expect(searchLrclibLyrics).toHaveBeenCalledTimes(1);
  });
  it("shares one lyric read and sends desktop updates only when the offset-adjusted line changes", async () => {
    const getTrackLyrics = vi.fn().mockResolvedValue({ offset: 500 });
    const readLocalLyrics = vi.fn().mockResolvedValue("[00:01]first\n[00:03]second");
    const showDesktopLyricLine = vi.fn();
    setBridge({ getTrackLyrics, readLocalLyrics, showDesktopLyricLine });
    const item = track("shared");
    function BothViews() {
      const lyrics = useTrackLyrics(item);
      return (
        <>
          <LyricsView item={item} lyrics={lyrics} />
          <DesktopLyricsOutput lyrics={lyrics} />
        </>
      );
    }
    usePlayProgress.getState().setCurrentTime(0.6);
    await act(async () => root.render(<BothViews />));
    expect(getTrackLyrics).toHaveBeenCalledTimes(1);
    expect(readLocalLyrics).toHaveBeenCalledTimes(1);
    expect(showDesktopLyricLine).toHaveBeenLastCalledWith(expect.objectContaining({ text: "first" }));
    showDesktopLyricLine.mockClear();
    await act(async () => usePlayProgress.getState().setCurrentTime(0.7));
    expect(showDesktopLyricLine).not.toHaveBeenCalled();
    await act(async () => usePlayProgress.getState().setCurrentTime(2.6));
    expect(showDesktopLyricLine).toHaveBeenLastCalledWith(expect.objectContaining({ text: "second" }));
    await act(async () => usePlayProgress.getState().setCurrentTime(0.6));
    expect(showDesktopLyricLine).toHaveBeenLastCalledWith(expect.objectContaining({ text: "first" }));
  });
  it("opens desktop lyrics on the first click and shows settings only when the window is open", async () => {
    const setDesktopLyricsVisible = vi.fn().mockResolvedValue(undefined);
    const menuChanged = vi.fn();
    setBridge({ setDesktopLyricsVisible });
    document.body.append(host);
    await act(async () => root.render(<DesktopLyricsButton onOpenChange={menuChanged} />));
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="桌面歌词"]')!;
    const findMenu = () => document.querySelector('[aria-label="桌面歌词设置"]');
    await act(async () => trigger.click());
    expect(setDesktopLyricsVisible).toHaveBeenCalledWith(true);
    expect(findMenu()).toBeNull();

    await act(async () => useDesktopLyrics.setState({ open: true }));
    await act(async () => trigger.click());
    expect(setDesktopLyricsVisible).toHaveBeenCalledTimes(1);
    expect(findMenu()?.textContent).toContain("锁定歌词");
    expect(findMenu()?.querySelector('input[type="color"]')).toHaveValue("#ffffff");
    expect(findMenu()?.querySelector("select")).toHaveValue("26");
    expect(findMenu()?.textContent).toContain("关闭桌面歌词");

    await act(async () => useDesktopLyrics.setState({ open: false }));
    expect(findMenu()).toBeNull();
    expect(menuChanged).toHaveBeenLastCalledWith(false);
  });
  it("offers search and lyric preferences without a text editor", async () => {
    setBridge({ getTrackLyrics: vi.fn().mockResolvedValue({ lyrics: "original" }) });
    await act(async () => root.render(<Lyrics item={track("controls")} showControls />));
    expect(host.querySelector('button[aria-label="搜索歌词"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="调整字体大小"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="调整歌词偏移"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="编辑歌词"]')).toBeNull();
  });
  it("leaves cleaned Bilibili subtitles as literal text rather than interpreting timing-like subtitle content", async () => {
    vi.mocked(getWebPlayerInfo).mockResolvedValue({
      data: { subtitle: { subtitles: [{ subtitle_url: "//subtitle.test/a" }] } },
    } as Awaited<ReturnType<typeof getWebPlayerInfo>>);
    vi.mocked(getLyric).mockResolvedValue({
      body: [
        { from: 2, content: "♫line [00:42]♫" },
        { from: 1, content: "♪first♪" },
      ],
    });
    const native = await getNativeLyrics({ id: "mv", bvid: "BV1", cid: "10", aid: "20" });
    expect(getWebPlayerInfo).toHaveBeenCalledWith({ bvid: "BV1", cid: 10, aid: 20 });
    expect(getLyric).toHaveBeenCalledWith("//subtitle.test/a");
    expect(native.subtitles).toEqual([
      { time: 1000, text: "first" },
      { time: 2000, text: "line [00:42]" },
    ]);
  });
});
