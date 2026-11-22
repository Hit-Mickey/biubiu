import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";

import { addToast, Button, Link, Spinner, Tab, Tabs } from "@heroui/react";
import { RiPlayFill } from "@remixicon/react";
import { isAxiosError } from "axios";

import log from "@/common/utils/logger";
import AsyncButton from "@/components/async-button";
import Empty from "@/components/empty";
import ScrollContainer, { type ScrollRefObject } from "@/components/scroll-container";
import { getMusicComprehensiveWebRank, type Data as MusicItem } from "@/service/music-comprehensive-web-rank";
import { getRegionFeedRcmd, type Archive } from "@/service/web-interface-region-feed-rcmd";
import { useModalStore } from "@/store/modal";
import { usePlayList } from "@/store/play-list";
import { useSettings } from "@/store/settings";

import type { RecommendItem } from "./types";

import MusicRecommendGridList from "./grid-list";
import MusicRecommendList from "./list";

const NewMusicTop = lazy(() => import("./new-music-top"));

const PAGE_SIZE = 20;
const REGION_PAGE_SIZE = 15;
const REGION_WEB_LOCATION = "333.40138";

type RecommendTabKey = "music" | "guichu" | "pop";

const REGION_MAP: Record<Exclude<RecommendTabKey, "pop">, number> = {
  music: 1003,
  guichu: 1007,
};

const normalizeRankItem = (item: MusicItem): RecommendItem => {
  const archive = item.related_archive;
  return {
    id: item.id,
    aid: Number(item.aid) || undefined,
    bvid: archive?.bvid || item.bvid,
    title: archive?.title || item.music_title,
    cover: archive?.cover || item.cover,
    author: archive?.username || item.author,
    authorMid: archive?.uid,
    playCount: archive?.vv_count,
    duration: archive?.duration,
  };
};

const normalizeRegionItem = (item: Archive, fallbackId: string | number): RecommendItem => {
  return {
    id: item.aid ?? item.bvid ?? item.trackid ?? fallbackId,
    aid: item.aid,
    bvid: item.bvid,
    title: item.title || "",
    cover: item.cover,
    author: item.author?.name,
    authorMid: item.author?.mid,
    playCount: item.stat?.view,
    duration: item.duration,
  };
};

async function fetchPage(tab: RecommendTabKey, page: number) {
  if (tab === "pop") {
    const result = await getMusicComprehensiveWebRank({ pn: page, ps: PAGE_SIZE, web_location: "333.1351" });
    if (result.code !== 0) throw new Error(result.message || "获取流行音乐推荐失败");
    const items = result.data?.list ?? [];
    return { items: items.map(normalizeRankItem), hasMore: items.length === PAGE_SIZE };
  }

  const result = await getRegionFeedRcmd({
    display_id: page,
    request_cnt: REGION_PAGE_SIZE,
    from_region: REGION_MAP[tab],
    device: "web",
    plat: 30,
    web_location: REGION_WEB_LOCATION,
  });
  if (result.code !== 0) throw new Error(result.message || "获取音乐推荐失败");
  const items = result.data?.archives ?? [];
  return {
    items: items.map((item, index) => normalizeRegionItem(item, `${page}-${index}`)),
    hasMore: items.length === REGION_PAGE_SIZE,
  };
}

function getLoadErrorMessage(error: unknown) {
  if (isAxiosError(error)) {
    const status = error.response?.status;
    if (status === 412) return "B 站暂未接受这次推荐请求（HTTP 412）。";
    return status ? `B 站推荐请求失败（HTTP ${status}）。` : "暂时无法连接 B 站推荐服务。";
  }
  return error instanceof Error ? error.message : "无法获取推荐内容。";
}

const MusicRecommend = () => {
  const scrollerRef = useRef<ScrollRefObject>(null);

  const [list, setList] = useState<RecommendItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [initialError, setInitialError] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  const pageRef = useRef(1);
  const requestId = useRef(0);
  const [activeTab, setActiveTab] = useState<RecommendTabKey>("music");
  const [listSource, setListSource] = useState<RecommendTabKey>("music");
  const scrollRestoreRef = useRef<{ tab: RecommendTabKey; top: number } | null>(null);
  const [popLayoutVersion, setPopLayoutVersion] = useState(0);

  const displayMode = useSettings(state => state.displayMode);
  const listKey = `${activeTab}-${displayMode}-${activeTab === "pop" ? popLayoutVersion : 0}`;

  const getScrollElement = useCallback(() => {
    return (scrollerRef.current?.osInstance()?.elements().viewport as HTMLElement | null) ?? null;
  }, []);

  const handlePopLayoutChange = useCallback(() => {
    setPopLayoutVersion(prev => prev + 1);
  }, []);

  const loadMore = async () => {
    if (initialLoading || loadingMore || !hasMore) return;
    const current = ++requestId.current;
    try {
      setLoadingMore(true);
      const nextPage = pageRef.current + 1;
      const result = await fetchPage(listSource, nextPage);
      if (current !== requestId.current) return;
      setList(previous => [...previous, ...result.items]);
      setHasMore(result.hasMore);
      pageRef.current = nextPage;
    } catch (error) {
      if (current !== requestId.current) return;
      setHasMore(false);
      log.warn("[recommend] 加载更多推荐失败", error instanceof Error ? error.message : String(error));
    } finally {
      if (current === requestId.current) setLoadingMore(false);
    }
  };

  const init = useCallback(async () => {
    const current = ++requestId.current;
    pageRef.current = 1;
    setInitialLoading(true);
    setList([]);
    setInitialError(undefined);
    setHasMore(false);
    setLoadingMore(false);
    try {
      let source = activeTab;
      let result = await fetchPage(source, 1).catch(error => {
        if (activeTab !== "music") throw error;
        log.warn("[recommend] 加载音乐分区失败", error instanceof Error ? error.message : String(error));
        return undefined;
      });
      if (current !== requestId.current) return;
      if (!result || (activeTab === "music" && result.items.length === 0)) {
        source = "pop";
        result = await fetchPage(source, 1);
      }
      if (current !== requestId.current) return;
      setListSource(source);
      setList(result.items);
      setHasMore(result.hasMore);
    } catch (error) {
      if (current !== requestId.current) return;
      setInitialError(getLoadErrorMessage(error));
      log.warn("[recommend] 加载推荐失败", error instanceof Error ? error.message : String(error));
    } finally {
      if (current === requestId.current) setInitialLoading(false);
    }
  }, [activeTab]);

  useEffect(() => {
    void init();
    return () => {
      requestId.current += 1;
    };
  }, [init]);

  useEffect(() => {
    if (initialLoading) return;
    const restore = scrollRestoreRef.current;
    if (!restore || restore.tab !== activeTab) return;
    const viewport = getScrollElement();
    if (!viewport) return;
    const top = restore.top;
    requestAnimationFrame(() => {
      viewport.scrollTop = top;
      scrollRestoreRef.current = null;
    });
  }, [activeTab, getScrollElement, initialLoading, list.length]);

  const handlePlayAll = useCallback(async () => {
    const items = list
      .map(item => {
        return {
          type: "mv" as const,
          bvid: item.bvid,
          title: item.title,
          cover: item.cover,
          ownerName: item.author,
          ownerMid: item.authorMid,
        };
      })
      .filter(item => Boolean(item.bvid));

    if (!items.length) {
      addToast({ title: "暂无可播放内容", color: "warning" });
      return;
    }

    await usePlayList.getState().addList(items);
    addToast({ title: `已添加 ${items.length} 首到播放列表`, color: "success" });
  }, [list]);

  const handleMenuAction = useCallback(async (key: string, item: RecommendItem) => {
    if (!item.bvid && key !== "favorite") {
      addToast({ title: "暂无可播放内容", color: "warning" });
      return;
    }
    switch (key) {
      case "favorite":
        if (!item.aid) {
          addToast({ title: "该项目无法收藏", color: "warning" });
          return;
        }
        useModalStore.getState().onOpenFavSelectModal({
          rid: Number(item.aid),
          type: 2,
          title: item.title,
        });
        break;
      case "play-next":
        usePlayList.getState().addToNext({
          type: "mv",
          title: item.title,
          cover: item.cover,
          bvid: item.bvid,
          sid: Number(item.id) || undefined,
          ownerName: item.author,
        });
        break;
      case "add-to-playlist":
        usePlayList.getState().addList([
          {
            type: "mv",
            title: item.title,
            cover: item.cover,
            bvid: item.bvid,
            sid: Number(item.id) || undefined,
            ownerName: item.author,
          },
        ]);
        break;
      case "download-audio":
        await window.electron.addMediaDownloadTask({
          outputFileType: "audio",
          title: item.title,
          cover: item.cover,
          bvid: item.bvid,
        });
        addToast({
          title: "已添加下载任务",
          color: "success",
        });
        break;
      case "download-video":
        await window.electron.addMediaDownloadTask({
          outputFileType: "video",
          title: item.title,
          cover: item.cover,
          bvid: item.bvid,
        });
        addToast({
          title: "已添加下载任务",
          color: "success",
        });
        break;
      case "bililink":
        if (item.bvid) {
          window.electron.openExternal(`https://www.bilibili.com/video/${item.bvid}`);
        }
        break;
      default:
        break;
    }
  }, []);

  return (
    <ScrollContainer enableBackToTop ref={scrollerRef} className="h-full w-full px-4">
      <div className="mb-2 flex items-center justify-between">
        <Tabs
          variant="solid"
          size="lg"
          radius="md"
          classNames={{
            cursor: "rounded-medium",
          }}
          selectedKey={activeTab}
          onSelectionChange={key => {
            const nextTab = key as RecommendTabKey;
            const viewport = getScrollElement();
            if (viewport) {
              scrollRestoreRef.current = { tab: nextTab, top: viewport.scrollTop };
            }
            setActiveTab(nextTab);
          }}
        >
          <Tab key="music" title="音乐" />
          <Tab key="guichu" title="鬼畜" />
          <Tab key="pop" title="流行" />
        </Tabs>
        <AsyncButton
          color="primary"
          size="md"
          startContent={<RiPlayFill size={18} />}
          isDisabled={initialLoading || list.length === 0}
          onPress={handlePlayAll}
          className="dark:text-black"
        >
          全部播放
        </AsyncButton>
      </div>
      {activeTab === "pop" && (
        <Suspense fallback={null}>
          <NewMusicTop onLayoutChange={handlePopLayoutChange} />
        </Suspense>
      )}
      <div className="relative">
        {!initialLoading && activeTab === "music" && listSource === "pop" && list.length > 0 && (
          <p className="text-default-500 mb-2 text-sm" role="status">
            当前展示 B 站流行音乐榜
          </p>
        )}
        {initialLoading ? (
          <div className="flex h-[40vh] items-center justify-center">
            <Spinner size="lg" label="正在加载推荐" />
          </div>
        ) : list.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-20">
            <div role="status" className="text-center">
              <Empty title={initialError ? "推荐加载失败" : "暂无推荐内容"} className="py-0" />
              {initialError && <p className="text-default-500 mt-2 text-sm">{initialError}</p>}
            </div>
            <div className="flex flex-wrap items-center justify-center gap-4">
              <Button size="sm" color="primary" variant="flat" onPress={() => void init()}>
                重新加载
              </Button>
              <Link size="sm" href="/local-music">
                本地音乐
              </Link>
              <Link size="sm" href="/remote-music">
                远程列表
              </Link>
            </div>
          </div>
        ) : displayMode === "card" ? (
          <MusicRecommendGridList
            key={listKey}
            items={list}
            hasMore={hasMore}
            loading={loadingMore}
            onLoadMore={loadMore}
            getScrollElement={getScrollElement}
            onMenuAction={handleMenuAction}
          />
        ) : (
          <MusicRecommendList
            key={listKey}
            items={list}
            hasMore={hasMore}
            loading={loadingMore}
            onLoadMore={loadMore}
            getScrollElement={getScrollElement}
            onMenuAction={handleMenuAction}
          />
        )}
      </div>
    </ScrollContainer>
  );
};

export default MusicRecommend;
