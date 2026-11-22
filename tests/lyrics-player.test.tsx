import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlayData } from "@/store/play-list";

import { listenForAppShortcuts } from "@/common/utils/shortcut";
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
import { defaultShortcutSettings, mergeShortcutSettings } from "@shared/settings/shortcut-settings";

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
function Lyrics({
  visible = true,
  ...props
}: Omit<ComponentProps<typeof LyricsView>, "lyrics"> & { visible?: boolean }) {
  const lyrics = useTrackLyrics(props.item, visible);
  return visible ? <LyricsView key={props.item.id} {...props} lyrics={lyrics} /> : null;
}

const render = (item: PlayData, visible = true) =>
  act(async () => {
    root.render(<Lyrics item={item} visible={visible} />);
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
  it("uses the shared bilingual setting in the playback page without rereading the current song", async () => {
    const getWebDavLyrics = vi.fn().mockResolvedValue("[00:00]We ride all night 我们一路前行\n[00:05]Next");
    setBridge({ getTrackLyrics: vi.fn().mockResolvedValue({}), getWebDavLyrics });
    await render(track("mixed", "webdav"));
    const strips = () => Array.from(host.querySelectorAll(".lyric-strip"), el => el.textContent);
    expect(strips()).toEqual(["We ride all night", "我们一路前行"]);
    const { appearance } = useDesktopLyrics.getState();
    try {
      await act(async () => useDesktopLyrics.setState({ appearance: { ...appearance, splitBilingual: false } }));
      expect(strips()).toEqual(["We ride all night 我们一路前行"]);
      expect(getWebDavLyrics).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => useDesktopLyrics.setState({ appearance }));
    }
  });
  it("reopens at the current line without rereading lyrics and releases them when the hidden player changes songs", async () => {
    const getTrackLyrics = vi
      .fn()
      .mockImplementation(async (key: string) => (key === "local-next" ? { lyrics: "采用的歌词" } : {}));
    const getWebDavLyrics = vi.fn().mockResolvedValue("[00:00]第一行\n[00:05]第二行");
    setBridge({ getTrackLyrics, getWebDavLyrics });
    const remote = track("current", "webdav");
    const next = track("next");
    await render(remote, false);
    expect(getTrackLyrics).not.toHaveBeenCalled();
    await render(remote);
    expect(host.querySelector(".font-extrabold")?.textContent).toBe("第一行");
    await render(remote, false);
    expect(host.childElementCount).toBe(0);
    usePlayProgress.getState().setCurrentTime(6);
    await render({ ...remote, title: "Updated title" });
    expect(host.querySelector(".font-extrabold")?.textContent).toBe("第二行");
    expect(getWebDavLyrics).toHaveBeenCalledTimes(1);

    await render(next, false);
    expect(getTrackLyrics).toHaveBeenCalledTimes(1);
    await render(next);
    await render(next, false);
    await render(next);
    expect(host.textContent).toBe("采用的歌词");
    expect(getTrackLyrics).toHaveBeenCalledTimes(2);
    await render(remote);
    expect(getWebDavLyrics).toHaveBeenCalledTimes(2);
  });
  it("finishes an in-flight lookup for the same song across visibility changes", async () => {
    let finishRecord!: (record: MusicLyrics) => void;
    let finishWebDav!: (text: string) => void;
    const getTrackLyrics = vi.fn(
      () =>
        new Promise<MusicLyrics>(resolve => {
          finishRecord = resolve;
        }),
    );
    const getWebDavLyrics = vi.fn(
      () =>
        new Promise<string>(resolve => {
          finishWebDav = resolve;
        }),
    );
    setBridge({ getTrackLyrics, getWebDavLyrics });
    const remote = track("pending", "webdav");
    await render(remote);
    await render(remote, false);
    await render(remote);
    expect(getTrackLyrics).toHaveBeenCalledTimes(1);
    await act(async () => finishRecord({}));
    await render(remote, false);
    await act(async () => finishWebDav("加载完成"));
    await render(remote);
    expect(host.textContent).toBe("加载完成");
    expect(getWebDavLyrics).toHaveBeenCalledTimes(1);
  });
  it("retries a failed WebDAV lyric read the next time the player opens", async () => {
    const getWebDavLyrics = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue("恢复后的歌词");
    setBridge({ getTrackLyrics: vi.fn().mockResolvedValue({}), getWebDavLyrics });
    const remote = track("retry", "webdav");
    await render(remote);
    expect(host.textContent).toBe("暂无歌词");
    await render(remote, false);
    await render(remote);
    expect(host.textContent).toBe("恢复后的歌词");
    expect(getWebDavLyrics).toHaveBeenCalledTimes(2);
  });
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
    expect(readLocalLyrics).toHaveBeenCalledWith(item.audioUrl, item.id);
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
  it("supports compact desktop lyrics controls and merges default toggleLyrics shortcuts", async () => {
    const setDesktopLyricsVisible = vi.fn().mockResolvedValue(undefined);
    const setDesktopLyricsLocked = vi.fn().mockResolvedValue(undefined);
    const setDesktopLyricsAppearance = vi.fn().mockResolvedValue(undefined);
    setBridge({ setDesktopLyricsVisible, setDesktopLyricsLocked, setDesktopLyricsAppearance });
    document.body.append(host);
    await act(async () => useDesktopLyrics.setState({ open: true, locked: false }));
    await act(async () => root.render(<DesktopLyricsButton compact />));
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="桌面歌词"]')!;
    await act(async () => trigger.click());
    const menu = document.querySelector('[aria-label="桌面歌词设置"]');
    expect(menu?.textContent).toContain("锁定歌词");
    expect(menu?.querySelector('input[type="color"]')).toHaveValue("#ffffff");
    expect(menu?.querySelector("select")).toHaveValue("26");
    const closeBtn = menu?.querySelector<HTMLButtonElement>('button[aria-label="关闭桌面歌词"]');
    expect(closeBtn).not.toBeNull();
    await act(async () => closeBtn!.click());
    expect(setDesktopLyricsVisible).toHaveBeenCalledWith(false);

    const legacy = {
      enableGlobalShortcuts: true,
      shortcuts: defaultShortcutSettings.shortcuts.filter(item => item.id !== "toggleLyrics"),
      globalShortcuts: defaultShortcutSettings.globalShortcuts.filter(item => item.id !== "toggleLyrics"),
    };
    const merged = mergeShortcutSettings(legacy);
    expect(merged.shortcuts.find(item => item.id === "toggleLyrics")?.shortcut).toBe("CommandOrControl+G");
    expect(merged.globalShortcuts.find(item => item.id === "toggleLyrics")?.shortcut).toBe("CommandOrControl+Alt+G");

    const v1Defaults = {
      enableGlobalShortcuts: true,
      shortcuts: defaultShortcutSettings.shortcuts.map(item =>
        item.id === "toggleLyrics" ? { ...item, shortcut: "CommandOrControl+L" } : item,
      ),
      globalShortcuts: defaultShortcutSettings.globalShortcuts.map(item =>
        item.id === "toggleLyrics" ? { ...item, shortcut: "CommandOrControl+Alt+L" } : item,
      ),
    };
    const migrated = mergeShortcutSettings(v1Defaults);
    expect(migrated.shortcuts.find(item => item.id === "toggleLyrics")?.shortcut).toBe("CommandOrControl+G");
    expect(migrated.globalShortcuts.find(item => item.id === "toggleLyrics")?.shortcut).toBe("CommandOrControl+Alt+G");

    const occupied = mergeShortcutSettings({
      ...v1Defaults,
      shortcuts: v1Defaults.shortcuts.map(item =>
        item.id === "next" ? { ...item, shortcut: "CommandOrControl+G" } : item,
      ),
    });
    expect(occupied.shortcuts.find(item => item.id === "toggleLyrics")?.shortcut).toBe("CommandOrControl+L");
    expect(occupied.shortcuts.find(item => item.id === "next")?.shortcut).toBe("CommandOrControl+G");

    const customV2 = mergeShortcutSettings({
      ...migrated,
      shortcuts: migrated.shortcuts.map(item =>
        item.id === "toggleLyrics" ? { ...item, shortcut: "CommandOrControl+L" } : item,
      ),
    });
    expect(customV2.shortcuts.find(item => item.id === "toggleLyrics")?.shortcut).toBe("CommandOrControl+L");
  });
  it("toggles lyrics once from focused controls and leaves editable fields to handle their own keys", () => {
    const button = document.createElement("button");
    const input = document.createElement("input");
    host.append(button, input);
    document.body.append(host);
    button.addEventListener("keydown", event => event.stopPropagation());
    const run = vi.fn();
    const stop = listenForAppShortcuts(run);
    function press(target: HTMLElement, repeat = false) {
      return target.dispatchEvent(
        new KeyboardEvent("keydown", { key: "g", ctrlKey: true, repeat, bubbles: true, cancelable: true }),
      );
    }
    try {
      expect(press(button)).toBe(false);
      expect(press(button, true)).toBe(false);
      expect(press(input)).toBe(true);
      expect(run.mock.calls).toEqual([["toggleLyrics"]]);
    } finally {
      stop();
    }
    expect(press(button)).toBe(true);
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
    const getPlaybackSubtitles = vi.fn().mockResolvedValue([8, null]);
    const savePlaybackSubtitles = vi.fn().mockResolvedValue(undefined);
    setBridge({ getPlaybackSubtitles, savePlaybackSubtitles });
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
    expect(getLyric).toHaveBeenCalledWith("https://subtitle.test/a");
    expect(native.subtitles).toEqual([
      { time: 1000, text: "first" },
      { time: 2000, text: "line [00:42]" },
    ]);
    expect(savePlaybackSubtitles).toHaveBeenCalledWith(8, native.subtitles);
    getPlaybackSubtitles.mockResolvedValue([8, native.subtitles]);
    expect(await getNativeLyrics({ id: "mv", bvid: "BV1", cid: "10", aid: "20" })).toEqual(native);
    expect(getLyric).toHaveBeenCalledTimes(1);
    expect(getWebPlayerInfo).toHaveBeenCalledTimes(1);
  });
});
