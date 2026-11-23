import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useForm } from "react-hook-form";
import { MemoryRouter } from "react-router";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MusicRecommend from "@/pages/music-recommend";
import { SystemSettingsTab } from "@/pages/settings/system-settings";
import { usePlayList } from "@/store/play-list";
import { useSettings } from "@/store/settings";

const mocks = vi.hoisted(() => ({
  regionFeed: vi.fn(),
  webRank: vi.fn(),
  newMusic: vi.fn(),
  newMusicBanner: vi.fn(),
  toast: vi.fn(),
  play: vi.fn(),
  addList: vi.fn(),
  lastVirtualListProps: null as null | { rowHeight: number; hasMore?: boolean; loading: boolean },
  lastVirtualGridProps: null as null | { hasMore?: boolean; loading: boolean },
}));

vi.mock("@/service/web-interface-region-feed-rcmd", () => ({ getRegionFeedRcmd: mocks.regionFeed }));
vi.mock("@/service/music-comprehensive-web-rank", () => ({ getMusicComprehensiveWebRank: mocks.webRank }));
vi.mock("@/service/web-interface-new-music", () => ({ getNewMusic: mocks.newMusic }));
vi.mock("@/service/web-interface-new-music-banner", () => ({ getNewMusicBanner: mocks.newMusicBanner }));

vi.mock("@heroui/react", async original => ({
  ...(await original<typeof import("@heroui/react")>()),
  addToast: mocks.toast,
}));

vi.mock("@/components/scroll-container", () => ({
  default: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

vi.mock("@/components/virtual-page-list", () => ({
  default: ({
    items,
    renderItem,
    rowHeight,
    hasMore,
    loading,
  }: {
    items: any[];
    renderItem: (item: any, index: number) => React.ReactNode;
    rowHeight: number;
    hasMore?: boolean;
    loading: boolean;
  }) => {
    mocks.lastVirtualListProps = { rowHeight, hasMore, loading };
    return (
      <div data-testid="virtual-list" data-row-height={rowHeight}>
        {items.map((item, index) => (
          <div key={item.id ?? index}>{renderItem(item, index)}</div>
        ))}
      </div>
    );
  },
}));

vi.mock("@/components/virtual-grid-page-list", () => ({
  default: ({
    items,
    renderItem,
    hasMore,
    loading,
  }: {
    items: any[];
    renderItem: (item: any, index: number) => React.ReactNode;
    hasMore?: boolean;
    loading: boolean;
  }) => {
    mocks.lastVirtualGridProps = { hasMore, loading };
    return (
      <div data-testid="virtual-grid">
        {items.map((item, index) => (
          <div key={item.id ?? index}>{renderItem(item, index)}</div>
        ))}
      </div>
    );
  },
}));

vi.mock("@/components/music-list-item", () => ({
  default: ({ title, onPress }: { title: string; onPress?: () => void }) => (
    <button type="button" data-testid="list-track" onClick={onPress}>
      {title}
    </button>
  ),
}));

vi.mock("@/components/music-list-item/header", () => ({
  default: () => <div data-testid="list-header" />,
}));

vi.mock("@/components/music-card", () => ({
  default: ({ title, onPress }: { title: string; onPress?: () => void }) => (
    <button type="button" data-testid="card-track" onClick={onPress}>
      {title}
    </button>
  ),
}));

vi.mock("@/components/image", () => ({
  default: ({ src }: { src?: string }) => <img alt="" src={src} />,
}));

vi.mock("@/components/font-select", () => ({ default: () => <div /> }));
vi.mock("@/components/update-check-button", () => ({ default: () => <div /> }));
vi.mock("@/pages/settings/color-settings", () => ({ default: () => <div /> }));
vi.mock("@/pages/settings/export-import", () => ({ default: () => <div /> }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const regionResponse = (titles: string[]) => ({
  code: 0,
  message: "OK",
  data: {
    archives: titles.map((title, index) => ({
      aid: 100 + index,
      bvid: `BV1REG${index}`,
      title,
      cover: `https://example.com/${index}.jpg`,
      duration: 180,
      stat: { view: 1200 },
      author: { mid: 10 + index, name: `UP${index}` },
    })),
  },
});

const rankResponse = (titles: string[]) => ({
  code: 0,
  message: "OK",
  ttl: 1,
  data: {
    list: titles.map((title, index) => ({
      id: 200 + index,
      aid: String(200 + index),
      bvid: `BV1POP${index}`,
      music_title: title,
      cover: `https://example.com/pop-${index}.jpg`,
      author: `Singer${index}`,
      related_archive: {
        aid: String(200 + index),
        bvid: `BV1POP${index}`,
        cid: "1",
        cover: `https://example.com/pop-${index}.jpg`,
        title,
        uid: 20 + index,
        username: `Singer${index}`,
        vt_display: "",
        vv_count: 5000,
        is_vt: 0,
        fname: "",
        duration: 210,
      },
    })),
  },
});

const newMusicResponse = (titles: string[]) => ({
  code: 0,
  message: "OK",
  data: {
    list: titles.map((title, index) => ({
      id: 300 + index,
      bvid: `BV1NEW${index}`,
      music_title: title,
      cover: `https://example.com/new-${index}.jpg`,
      author: `NewArtist${index}`,
      total_vv: 8000,
      publish_time: "2026-11-23",
    })),
  },
});

let host: HTMLDivElement;
let root: Root;

const flushPromises = async () => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const mountRecommend = async () => {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <MusicRecommend />
      </MemoryRouter>,
    );
  });
  await flushPromises();
};

const getRefreshButton = () => host.querySelector('button[aria-label="刷新推荐"]') as HTMLButtonElement | null;

const clickTab = async (label: string) => {
  const tab = Array.from(host.querySelectorAll('[role="tab"]')).find(el => el.textContent?.trim() === label) as
    | HTMLElement
    | undefined;
  expect(tab).toBeDefined();
  await act(async () => {
    tab!.click();
  });
  await flushPromises();
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
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  (window as any).electron = {
    getPlatform: () => "win32",
    selectDirectory: vi.fn(),
    selectFile: vi.fn(),
    setStore: vi.fn().mockResolvedValue(undefined),
    getStore: vi.fn().mockResolvedValue(undefined),
  };

  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);

  mocks.play.mockResolvedValue(undefined);
  mocks.addList.mockResolvedValue(undefined);
  usePlayList.setState({ play: mocks.play, addList: mocks.addList } as any);
  useSettings.setState({ displayMode: "list" });
  mocks.lastVirtualListProps = null;
  mocks.lastVirtualGridProps = null;

  mocks.regionFeed.mockResolvedValue(regionResponse(["初版音乐"]));
  mocks.webRank.mockResolvedValue(rankResponse(["初版流行"]));
  mocks.newMusicBanner.mockResolvedValue({ code: 0, data: { list: [] } });
  mocks.newMusic.mockResolvedValue(newMusicResponse(["初版新歌"]));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("推荐音乐页面刷新与设置提示", () => {
  it("refreshes music tab, preserves list on failure, ignores repeated clicks, and keeps playback working", async () => {
    const pendingRefresh = deferred<ReturnType<typeof regionResponse>>();
    mocks.regionFeed
      .mockResolvedValueOnce(regionResponse(["第一批音乐"]))
      .mockReturnValueOnce(pendingRefresh.promise)
      .mockRejectedValueOnce(new Error("music failed"));
    mocks.webRank.mockRejectedValueOnce(new Error("fallback failed"));

    await mountRecommend();
    expect(host.textContent).toContain("第一批音乐");

    const refreshBtn = getRefreshButton();
    expect(refreshBtn).not.toBeNull();
    expect(refreshBtn!.disabled).toBe(false);

    // Rapid repeated clicks while in-flight only trigger a single request
    await act(async () => {
      refreshBtn!.click();
      refreshBtn!.click();
      refreshBtn!.click();
    });
    expect(mocks.regionFeed).toHaveBeenCalledTimes(2);
    expect(getRefreshButton()!.disabled).toBe(true);
    expect(getRefreshButton()!.getAttribute("data-loading")).toBe("true");
    expect(host.textContent).toContain("第一批音乐");

    pendingRefresh.resolve(regionResponse(["刷新后音乐"]));
    await flushPromises();
    expect(host.textContent).toContain("刷新后音乐");
    expect(getRefreshButton()!.disabled).toBe(false);

    // Playback still works after refresh
    const trackButton = host.querySelector('[data-testid="list-track"]') as HTMLButtonElement;
    await act(async () => trackButton.click());
    expect(mocks.play).toHaveBeenCalledWith(expect.objectContaining({ bvid: "BV1REG0", title: "刷新后音乐" }));

    const playAllButton = Array.from(host.querySelectorAll("button")).find(b => b.textContent?.includes("全部播放"));
    expect(playAllButton).toBeDefined();
    await act(async () => playAllButton!.click());
    expect(mocks.addList).toHaveBeenCalledWith([expect.objectContaining({ bvid: "BV1REG0", title: "刷新后音乐" })]);

    // Refresh failure preserves existing list and notifies with danger toast
    await act(async () => getRefreshButton()!.click());
    await flushPromises();
    expect(host.textContent).toContain("刷新后音乐");
    expect(getRefreshButton()!.disabled).toBe(false);
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "刷新失败", description: "fallback failed", color: "danger" }),
    );
  });

  it("recovers from music fallback and empty error state via refresh", async () => {
    mocks.regionFeed
      .mockRejectedValueOnce(new Error("music down"))
      .mockResolvedValueOnce(regionResponse(["恢复后的音乐"]));
    mocks.webRank.mockResolvedValueOnce(rankResponse(["兜底流行曲"]));

    await mountRecommend();
    expect(host.textContent).toContain("当前展示 B 站流行音乐榜");
    expect(host.textContent).toContain("兜底流行曲");

    await act(async () => getRefreshButton()!.click());
    await flushPromises();
    expect(host.textContent).toContain("恢复后的音乐");
    expect(host.textContent).not.toContain("当前展示 B 站流行音乐榜");
  });

  it("recovers from initial error empty state via both top refresh and reload button", async () => {
    mocks.regionFeed
      .mockRejectedValueOnce(new Error("region offline"))
      .mockRejectedValueOnce(new Error("region offline 2"))
      .mockResolvedValueOnce(regionResponse(["重连后歌曲"]));
    mocks.webRank.mockRejectedValueOnce(new Error("rank offline")).mockRejectedValueOnce(new Error("rank offline 2"));

    await mountRecommend();
    expect(host.textContent).toContain("推荐加载失败");
    expect(host.textContent).toContain("rank offline");

    await act(async () => getRefreshButton()!.click());
    await flushPromises();
    expect(host.textContent).toContain("rank offline 2");

    const reloadButton = Array.from(host.querySelectorAll("button")).find(b => b.textContent?.trim() === "重新加载");
    expect(reloadButton).toBeDefined();
    await act(async () => reloadButton!.click());
    await flushPromises();
    expect(host.textContent).toContain("重连后歌曲");
    expect(host.textContent).not.toContain("推荐加载失败");
  });

  it("refreshes guichu tab and cancels stale in-flight refresh cleanly on tab switch", async () => {
    const staleMusicRefresh = deferred<ReturnType<typeof regionResponse>>();
    mocks.regionFeed
      .mockResolvedValueOnce(regionResponse(["音乐初始"]))
      .mockReturnValueOnce(staleMusicRefresh.promise)
      .mockResolvedValueOnce(regionResponse(["鬼畜初始"]))
      .mockResolvedValueOnce(regionResponse(["鬼畜刷新后"]));

    await mountRecommend();
    await act(async () => getRefreshButton()!.click());
    expect(getRefreshButton()!.disabled).toBe(true);

    // Switch to guichu while music refresh is still pending
    await clickTab("鬼畜");
    expect(host.textContent).toContain("鬼畜初始");
    expect(getRefreshButton()!.disabled).toBe(false);

    // Stale music refresh fails later and must not overwrite or toast
    staleMusicRefresh.reject(new Error("stale error"));
    await flushPromises();
    expect(host.textContent).toContain("鬼畜初始");
    expect(mocks.toast).not.toHaveBeenCalled();

    // Refresh guichu tab
    await act(async () => getRefreshButton()!.click());
    await flushPromises();
    expect(mocks.regionFeed).toHaveBeenLastCalledWith(expect.objectContaining({ from_region: 1007, display_id: 1 }));
    expect(host.textContent).toContain("鬼畜刷新后");
  });

  it("refreshes both rank list and NewMusicTop on pop tab and preserves items on partial failure", async () => {
    await import("@/pages/music-recommend/new-music-top");
    mocks.webRank
      .mockResolvedValueOnce(rankResponse(["流行榜单1"]))
      .mockResolvedValueOnce(rankResponse(["流行榜单2"]))
      .mockResolvedValueOnce(rankResponse(["流行榜单3"]));
    mocks.newMusic
      .mockResolvedValueOnce(newMusicResponse(["新歌A"]))
      .mockResolvedValueOnce(newMusicResponse(["新歌B"]))
      .mockRejectedValueOnce(new Error("new music offline"));
    mocks.newMusicBanner
      .mockResolvedValueOnce({ code: 0, data: { list: [] } })
      .mockResolvedValueOnce({ code: 0, data: { list: [] } })
      .mockRejectedValueOnce(new Error("banner offline"));

    await mountRecommend();
    await clickTab("流行");
    await flushPromises();
    expect(host.textContent).toContain("流行榜单1");
    expect(host.textContent).toContain("新歌A");

    // Both sections refresh on button press
    await act(async () => getRefreshButton()!.click());
    await flushPromises();
    expect(host.textContent).toContain("流行榜单2");
    expect(host.textContent).toContain("新歌B");

    // NewMusicTop failure preserves existing NewMusicTop items while rank list still updates
    await act(async () => getRefreshButton()!.click());
    await flushPromises();
    expect(host.textContent).toContain("流行榜单3");
    expect(host.textContent).toContain("新歌B");
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "新歌速递刷新失败", color: "danger" }));
  });

  it("blocks repeated clicks while pop tab NewMusicTop is loading and recovers from initial NewMusicTop failure", async () => {
    await import("@/pages/music-recommend/new-music-top");
    const pendingNewMusic = deferred<ReturnType<typeof newMusicResponse>>();
    mocks.webRank.mockResolvedValueOnce(rankResponse(["流行榜单A"])).mockResolvedValueOnce(rankResponse(["流行榜单B"]));
    mocks.newMusicBanner
      .mockRejectedValueOnce(new Error("banner init fail"))
      .mockResolvedValueOnce({ code: 0, data: { list: [] } });
    mocks.newMusic.mockReturnValueOnce(pendingNewMusic.promise).mockResolvedValueOnce(newMusicResponse(["恢复新歌"]));

    await mountRecommend();
    await clickTab("流行");
    await flushPromises();
    expect(host.textContent).toContain("流行榜单A");
    expect(getRefreshButton()!.disabled).toBe(true);

    await act(async () => getRefreshButton()!.click());
    expect(mocks.webRank).toHaveBeenCalledTimes(1);

    pendingNewMusic.reject(new Error("new music init fail"));
    await flushPromises();
    expect(host.textContent).toContain("新歌速递加载失败");
    expect(getRefreshButton()!.disabled).toBe(false);

    await act(async () => getRefreshButton()!.click());
    await flushPromises();
    expect(host.textContent).toContain("流行榜单B");
    expect(host.textContent).toContain("恢复新歌");
    expect(host.textContent).not.toContain("新歌速递加载失败");
  });

  it("supports refresh across list, compact, and card display layouts", async () => {
    mocks.regionFeed
      .mockResolvedValueOnce(regionResponse(["列表曲1"]))
      .mockResolvedValueOnce(regionResponse(["列表曲2"]))
      .mockResolvedValueOnce(regionResponse(["紧凑曲2"]))
      .mockResolvedValueOnce(regionResponse(["卡片曲2"]));

    await mountRecommend();
    expect(mocks.lastVirtualListProps?.rowHeight).toBe(64);
    await act(async () => getRefreshButton()!.click());
    await flushPromises();
    expect(host.textContent).toContain("列表曲2");

    await act(async () => useSettings.setState({ displayMode: "compact" }));
    expect(mocks.lastVirtualListProps?.rowHeight).toBe(36);
    await act(async () => getRefreshButton()!.click());
    await flushPromises();
    expect(host.textContent).toContain("紧凑曲2");

    await act(async () => useSettings.setState({ displayMode: "card" }));
    expect(host.querySelector('[data-testid="virtual-grid"]')).not.toBeNull();
    await act(async () => getRefreshButton()!.click());
    await flushPromises();
    expect(host.textContent).toContain("卡片曲2");
    const cardButton = host.querySelector('[data-testid="card-track"]') as HTMLButtonElement;
    await act(async () => cardButton.click());
    expect(mocks.play).toHaveBeenCalledWith(expect.objectContaining({ bvid: "BV1REG0", title: "卡片曲2" }));
  });

  it("explains audio quality preference only affects Bilibili tracks while keeping tier hints", async () => {
    const Harness = ({ quality }: { quality: AudioQuality }) => {
      const { control, setValue } = useForm<AppSettings>({
        defaultValues: {
          displayMode: "list",
          themeMode: "system",
          fontFamily: "",
          borderRadius: 12,
          audioQuality: quality,
          lyricSearchSource: "qq",
          reportPlayHistory: false,
          downloadPath: "",
          ffmpegPath: "",
          showSearchHistory: true,
          closeWindowOption: "hide",
          autoStart: false,
        } as AppSettings,
      });
      return (
        <SystemSettingsTab
          appVersion="2.0.0"
          audioQuality={quality}
          control={control}
          isUpdateAvailable={false}
          setValue={setValue}
        />
      );
    };

    for (const [quality, hint] of [
      ["auto", "自动选择最高音质"],
      ["lossless", "FLAC / Hi-Res"],
      ["high", "180-320 kbps"],
      ["medium", "100-140 kbps"],
      ["low", "60-80 kbps"],
    ] as const) {
      await act(async () => root.render(<Harness quality={quality} />));
      expect(host.textContent).toContain("音质偏好");
      expect(host.textContent).toContain(hint);
      expect(host.textContent).toContain("仅影响 B 站歌曲，本地、WebDAV 音质由源文件决定");
    }
  });
});
