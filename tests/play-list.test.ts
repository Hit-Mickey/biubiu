import { describe, expect, test, beforeEach, vi } from "vitest";

import { PlayMode } from "@/common/constants/audio";
import { setPlaybackVolume, stepPlaybackVolume, togglePlaybackMute } from "@/common/utils/playback-volume";
import { pauseForSleep, usePlayList } from "@/store/play-list";

vi.mock("@/common/utils/audio", () => ({
  getAudioUrl: vi.fn(async () => ({ audioUrl: "https://audio.test/a.mp3", isLossless: false })),
  getDashUrl: vi.fn(async () => ({
    audioUrl: "https://video.test/a.mp3",
    videoUrl: "https://video.test/v.mp4",
    isLossless: false,
  })),
  getMVUrl: vi.fn(async () => ({
    audioUrl: "https://video.test/a.mp3",
    videoUrl: "https://video.test/v.mp4",
    isLossless: false,
  })),
  isUrlValid: vi.fn(url => typeof url === "string" && url.length > 0),
}));

vi.mock("@/service/audio-song-info", () => ({
  getAudioSongInfo: vi.fn(async ({ sid }) => ({
    data: {
      id: sid,
      uid: 1,
      uname: "owner",
      author: "owner",
      title: "audio-title",
      cover: "https://cover.test/c.png",
      intro: "",
      crtype: 1,
      duration: 123,
      passtime: Date.now(),
      curtime: Date.now(),
      aid: 0,
    },
  })),
}));

vi.mock("@/service/web-interface-view", () => ({
  getWebInterfaceView: vi.fn(async () => ({
    data: {
      aid: 100,
      title: "mv-title",
      pic: "https://cover.test/m.png",
      owner: { name: "owner", mid: 1 },
      pages: [
        { cid: 11, page: 1, part: "p1", duration: 60, first_frame: "https://ff.test/1.png" },
        { cid: 12, page: 2, part: "p2", duration: 60, first_frame: "https://ff.test/2.png" },
      ],
    },
  })),
}));

vi.mock("@heroui/react", async () => {
  const actual: any = await vi.importActual("@heroui/react");
  return { ...actual, addToast: vi.fn() };
});

beforeEach(() => {
  vi.clearAllMocks();
  usePlayList.getState().clear();
});

describe("play-list store", () => {
  test("initial state", () => {
    const s = usePlayList.getState();
    expect(s.isPlaying).toBe(false);
    expect(s.isMuted).toBe(false);
    expect(s.volume).toBe(0.5);
    expect(s.playMode).toBe(PlayMode.Loop);
    expect(s.rate).toBe(1);
    expect(s.list.length).toBe(0);
  });

  test("init sets audio props and handlers", async () => {
    const s = usePlayList.getState();
    await s.init();
    const audio = s.getAudio();
    expect(audio.volume).toBe(0.5);
    expect(audio.muted).toBe(false);
    expect(audio.playbackRate).toBe(1);
    expect(typeof audio.onplay).toBe("function");
  });

  test("setVolume, setRate, setPlayMode", async () => {
    const s = usePlayList.getState();
    await s.init();
    s.setVolume(0.8);
    s.setRate(1.25);
    s.togglePlayMode();
    s.togglePlayMode();
    const audio = s.getAudio();
    expect(usePlayList.getState().volume).toBe(0.8);
    expect(audio.volume).toBe(0.8);
    expect(usePlayList.getState().rate).toBe(1.25);
    expect(audio.playbackRate).toBe(1.25);
    expect(usePlayList.getState().playMode).toBe(PlayMode.Single);
    expect(audio.loop).toBe(true);
  });

  test("volume button actions share mute restore, slider and wheel behavior", async () => {
    await usePlayList.getState().init();
    const audio = usePlayList.getState().getAudio();
    setPlaybackVolume(0.73);
    togglePlaybackMute();
    expect(audio.muted).toBe(true);
    togglePlaybackMute();
    expect(audio.muted).toBe(false);
    expect(audio.volume).toBe(0.73);
    stepPlaybackVolume(0.05);
    expect(audio.volume).toBe(0.78);
    setPlaybackVolume(0);
    expect(audio.muted).toBe(true);
    stepPlaybackVolume(0.05);
    expect(audio.muted).toBe(false);
    expect(audio.volume).toBe(0.05);
    stepPlaybackVolume(-0.05);
    expect(audio.muted).toBe(true);
    setPlaybackVolume(0.5);
  });

  test("play audio adds item and toggles playing", async () => {
    const s = usePlayList.getState();
    await s.init();
    await s.play({ type: "audio", sid: 101, title: "a", cover: "", ownerName: "", ownerMid: 0 });
    expect(usePlayList.getState().list.length).toBe(1);
    const id = usePlayList.getState().playId as string;
    expect(typeof id).toBe("string");
    const audio = s.getAudio();
    expect(audio.src).toContain("audio.test");
    expect(navigator.mediaSession.playbackState).toBe("playing");
  });

  test("plays and queues WebDAV tracks by their own IDs", async () => {
    const player = usePlayList.getState();
    await player.init();
    const first = {
      id: "dav-first",
      source: "webdav",
      type: "audio",
      title: "第一首",
      audioUrl: "biu-webdav://audio/list/first",
    } as const;
    const second = { ...first, id: "dav-second", title: "第二首", audioUrl: "biu-webdav://audio/list/second" };
    await player.play(first);
    player.addList([first, second]);
    expect(usePlayList.getState().list.map(item => item.id)).toEqual([first.id, second.id]);
    expect(player.getAudio().src).toBe(first.audioUrl);
    player.addToNext(second);
    await player.next();
    expect(player.getAudio().src).toBe(second.audioUrl);
    player.removeWebDavItems([second.id]);
    expect(usePlayList.getState().playId).toBe(first.id);
  });

  test("playlist enqueue can distinguish expanded video parts without changing legacy whole-video matching", async () => {
    const { compactPlayData, trackKey } = await import("@/store/desktop-playlists/tracks");
    const player = usePlayList.getState();
    const first = { type: "mv", bvid: "BV17x411w7KC", cid: "11", title: "P1", totalPage: 2 } as const;
    const second = { ...first, cid: "12", title: "P2" };
    await player.playList([first]);
    player.addList([second]);
    expect(usePlayList.getState().list).toHaveLength(1);
    player.addList([first, second, second], row => {
      const track = compactPlayData(row);
      return track && trackKey(track);
    });
    expect(usePlayList.getState().list.map(row => row.cid)).toEqual(["11", "12"]);
  });

  test("playList sets list and next/prev in sequence", async () => {
    const s = usePlayList.getState();
    await s.init();
    await s.playList([
      { type: "audio", sid: 1, title: "a1" },
      { type: "audio", sid: 2, title: "a2" },
    ]);
    const firstId = usePlayList.getState().playId as string;
    await s.next();
    const secondId = usePlayList.getState().playId as string;
    expect(secondId).not.toBe(firstId);
    await s.prev();
    expect(usePlayList.getState().playId).toBe(firstId);
  });

  test("sleep pause also stops a stream that finishes resolving after the deadline, until an explicit play", async () => {
    const player = usePlayList.getState();
    await player.init();
    const { getAudioUrl } = await import("@/common/utils/audio");
    const stream = Promise.withResolvers<Awaited<ReturnType<typeof getAudioUrl>>>();
    vi.mocked(getAudioUrl).mockReturnValueOnce(stream.promise);
    await player.playList([{ type: "audio", sid: 102, title: "slow" }]);
    pauseForSleep();
    stream.resolve({ audioUrl: "https://audio.test/slow", audioCodecs: "", isLossless: false, mirrors: [] });
    await vi.waitFor(() => expect(player.getAudio().src).toBe("https://audio.test/slow"));
    expect(player.getAudio().paused).toBe(true);
    await player.togglePlay();
    expect(player.getAudio().paused).toBe(false);
  });

  test("explicitly enqueueing a named playlist into an empty queue does not start it", async () => {
    const player = usePlayList.getState();
    await player.init();
    player.addList([{ type: "audio", sid: 5, title: "queued" }], item => String(item.sid));
    expect(usePlayList.getState().list).toHaveLength(1);
    expect(usePlayList.getState().playId).toBeUndefined();
    expect(player.getAudio().paused).toBe(true);
    await player.togglePlay();
    expect(usePlayList.getState().playId).toBe(usePlayList.getState().list[0].id);
  });

  test("random mode keeps pages order", async () => {
    const s = usePlayList.getState();
    await s.init();
    await s.playList([{ type: "mv", bvid: "BVx", title: "m1" }]);
    const mv = usePlayList.getState().list[0];
    const { getWebInterfaceView } = await import("@/service/web-interface-view");
    const pages = await getWebInterfaceView({ bvid: mv.bvid as string });
    usePlayList.setState(() => ({
      list: pages.data.pages.map(p => ({
        id: `${p.page}-id`,
        type: "mv",
        bvid: mv.bvid,
        aid: "100",
        cid: String(p.cid),
        title: "mv-title",
        cover: "",
        ownerName: "owner",
        ownerMid: 1,
        hasMultiPart: true,
        pageIndex: p.page,
        pageTitle: p.part,
        pageCover: p.first_frame,
        totalPage: pages.data.pages.length,
        duration: p.duration,
      })),
      playId: "1-id",
    }));
    s.togglePlayMode();
    s.setShouldKeepPagesOrderInRandomPlayMode(true);
    await s.next();
    expect(usePlayList.getState().playId).toBe("2-id");
  });

  test("addToNext inserts after current", async () => {
    const s = usePlayList.getState();
    await s.init();
    await s.playList([{ type: "audio", sid: 10, title: "a10" }]);
    const currentId = usePlayList.getState().playId as string;
    await s.addToNext({ type: "audio", sid: 20, title: "a20" });
    const idx = usePlayList.getState().list.findIndex(i => i.id === currentId);
    const nextItem = usePlayList.getState().list[idx + 1];
    expect(usePlayList.getState().nextId).toBe(nextItem.id);
    expect(nextItem.sid).toBe(20);
  });

  test("addList deduplicates and preserves playing item", async () => {
    const s = usePlayList.getState();
    await s.init();
    await s.playList([{ type: "audio", sid: 1, title: "a1" }]);
    await s.addList([
      { type: "audio", sid: 1, title: "a1" },
      { type: "audio", sid: 3, title: "a3" },
    ]);
    expect(usePlayList.getState().list.some(i => i.sid === 1)).toBe(true);
    expect(usePlayList.getState().list.some(i => i.sid === 3)).toBe(true);
    const newId = usePlayList.getState().playId as string;
    const newItem = usePlayList.getState().list.find(i => i.id === newId);
    expect(newItem?.sid).toBe(1);
  });

  test("del removes by id and clear works", async () => {
    const s = usePlayList.getState();
    await s.init();
    await s.playList([
      { type: "audio", sid: 1, title: "a1" },
      { type: "audio", sid: 2, title: "a2" },
    ]);
    const otherId = usePlayList.getState().list.find(i => i.sid === 2)?.id as string;
    await s.del(otherId);
    expect(usePlayList.getState().list.some(i => i.id === otherId)).toBe(false);
    s.clear();
    expect(usePlayList.getState().list.length).toBe(0);
    expect(usePlayList.getState().playId).toBeUndefined();
  });

  test("play handles data fetch failure gracefully", async () => {
    const s = usePlayList.getState();
    await s.init();
    // Mock getWebInterfaceView to return empty/error structure
    const { getWebInterfaceView } = await import("@/service/web-interface-view");
    vi.mocked(getWebInterfaceView).mockResolvedValueOnce({ code: -1 } as any);

    // This should not crash
    await s.play({ type: "mv", bvid: "BV_fail", title: "fail" });
    expect(usePlayList.getState().list.length).toBe(0);
  });

  test("addToNext handles data fetch failure gracefully", async () => {
    const s = usePlayList.getState();
    await s.init();
    await s.playList([{ type: "audio", sid: 1, title: "a1" }]);

    const { getWebInterfaceView } = await import("@/service/web-interface-view");
    vi.mocked(getWebInterfaceView).mockResolvedValueOnce({ code: -1 } as any);

    await s.addToNext({ type: "mv", bvid: "BV_fail", title: "fail" });
    expect(usePlayList.getState().list.length).toBe(1);
  });

  test("does not rewrite the saved queue when only playback state changes", () => {
    const write = vi.spyOn(Storage.prototype, "setItem");
    try {
      // The setup has already saved the current queue and settings.
      usePlayList.setState({ isPlaying: true });
      usePlayList.setState({ isPlaying: false });
      expect(write).not.toHaveBeenCalled();

      usePlayList.getState().setVolume(0.25);
      expect(write).toHaveBeenCalledOnce();
      expect(JSON.parse(localStorage.getItem("play-list-store")!)).toMatchObject({ state: { volume: 0.25 } });
    } finally {
      write.mockRestore();
    }
  });

  test("restores a saved queue and seek position before loading the media", async () => {
    const audioUrl = "file:///music/track.wav";
    localStorage.setItem(
      "play-list-store",
      JSON.stringify({
        version: 0,
        state: {
          list: [{ id: "saved-song", type: "audio", source: "local", title: "Saved song", duration: 123, audioUrl }],
          playId: "saved-song",
        },
      }),
    );
    localStorage.setItem("play-current-time", "17");

    vi.resetModules();
    const { usePlayList: restored } = await import("@/store/play-list");
    const { usePlayProgress } = await import("@/store/play-progress");
    const player = restored.getState();
    try {
      await player.init();
      expect(restored.getState().duration).toBe(123);
      expect(usePlayProgress.getState().currentTime).toBe(17);
      expect(player.getAudio().src).toBe("");

      player.seek(29);
      await player.togglePlay();
      expect(player.getAudio().src).toBe(audioUrl);
      expect(player.getAudio().currentTime).toBe(29);
      expect(restored.getState().isPlaying).toBe(true);
    } finally {
      player.clear();
      localStorage.removeItem("play-current-time");
    }
  });
});
