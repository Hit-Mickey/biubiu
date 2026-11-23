import React, { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";

import { addToast, Button, Spinner } from "@heroui/react";
import { RiPlayFill } from "@remixicon/react";

import AsyncButton from "@/components/async-button";
import SearchWithSort from "@/components/search-with-sort";
import { getSpaceWbiArcSearch, type SpaceArcVListItem } from "@/service/space-wbi-arc-search";
import { useModalStore } from "@/store/modal";
import { usePlayList } from "@/store/play-list";
import { useSettings } from "@/store/settings";

import PostGridList from "./grid-list";
import PostList from "./list";

interface VideoPostProps {
  getScrollElement: () => HTMLElement | null;
}

const VideoPost: React.FC<VideoPostProps> = ({ getScrollElement }) => {
  const { id } = useParams();
  const displayMode = useSettings(state => state.displayMode);

  const [keyword, setKeyword] = useState("");
  const [order, setOrder] = useState("pubdate");

  const [items, setItems] = useState<SpaceArcVListItem[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [initialLoading, setInitialLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [total, setTotal] = useState(0);

  const pageRef = useRef(0);
  const request = useRef<AbortController | null>(null);
  const [failure, setFailure] = useState<"verification" | "load">();

  const fetchPage = useCallback(
    async (pn: number, interactive = false) => {
      if (!id || request.current) return;
      const controller = new AbortController();
      request.current = controller;
      setFailure(undefined);
      if (pn === 1) setInitialLoading(true);
      else setLoadingMore(true);
      try {
        const pageSize = 30;
        const res = await getSpaceWbiArcSearch(
          {
            mid: Number(id),
            ps: pageSize,
            pn,
            keyword: keyword.trim() || undefined,
            order,
          },
          { passive: !interactive, signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        const rows = res.data?.list?.vlist;
        if (res.code !== 0 || !Array.isArray(rows)) {
          setFailure(res.code === -352 || res.data?.v_voucher ? "verification" : "load");
          setHasMore(false);
          return;
        }
        const count = res.data.page?.count ?? rows.length;
        setTotal(count);
        setItems(previous => (pn === 1 ? rows : [...previous, ...rows]));
        pageRef.current = pn;
        setHasMore(rows.length > 0 && pn * pageSize < count);
      } catch {
        if (!controller.signal.aborted) {
          setFailure("load");
          setHasMore(false);
        }
      } finally {
        if (request.current === controller) {
          request.current = null;
          setInitialLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [id, keyword, order],
  );

  useEffect(() => {
    setItems([]);
    setTotal(0);
    pageRef.current = 0;
    setHasMore(false);
    setLoadingMore(false);
    void fetchPage(1);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [fetchPage]);

  const handleLoadMore = useCallback(() => {
    if (hasMore && !failure) void fetchPage(pageRef.current + 1);
  }, [fetchPage, hasMore, failure]);

  const handleMenuAction = useCallback((key: string, item: SpaceArcVListItem) => {
    switch (key) {
      case "play-next":
        usePlayList.getState().addToNext({
          type: "mv",
          title: item.title,
          cover: item.pic,
          bvid: item.bvid,
          playCount: item.play,
          ownerName: item.author,
          ownerMid: item.mid,
        });
        break;
      case "add-to-playlist":
        usePlayList.getState().addList([
          {
            type: "mv",
            title: item.title,
            cover: item.pic,
            bvid: item.bvid,
            playCount: item.play,
            ownerName: item.author,
            ownerMid: item.mid,
          },
        ]);
        break;
      case "download-audio":
        window.electron?.addMediaDownloadTask({
          outputFileType: "audio",
          title: item.title,
          cover: item.pic,
          bvid: item.bvid,
        });
        addToast({
          title: "已添加下载任务",
          color: "success",
        });
        break;
      case "download-video":
        window.electron?.addMediaDownloadTask({
          outputFileType: "video",
          title: item.title,
          cover: item.pic,
          bvid: item.bvid,
        });
        addToast({
          title: "已添加下载任务",
          color: "success",
        });
        break;
      case "favorite":
        useModalStore.getState().onOpenFavSelectModal({
          rid: item.aid,
          type: 2,
          title: item.title,
        });
        break;
    }
  }, []);

  const handlePlayAll = useCallback(async () => {
    if (!id) {
      addToast({ title: "缺少用户信息", color: "warning" });
      return;
    }

    try {
      const pageSize = 30;
      const maxItems = 200;
      const collected = items.slice(0, maxItems);
      let pn = pageRef.current;
      let incomplete = false;
      while (collected.length < Math.min(total, maxItems)) {
        const res = await getSpaceWbiArcSearch(
          {
            mid: Number(id),
            ps: pageSize,
            pn: ++pn,
            keyword: keyword.trim() || undefined,
            order,
          },
          { passive: true },
        ).catch(() => null);
        const rows = res?.data?.list?.vlist;
        if (res?.code !== 0 || !rows?.length) {
          incomplete = true;
          break;
        }
        collected.push(...rows);
      }

      const limited = collected.slice(0, maxItems);
      const playItems = limited
        .map(item => ({
          type: "mv" as const,
          bvid: item.bvid,
          title: item.title,
          cover: item.pic,
          playCount: item.play,
          ownerName: item.author,
          ownerMid: item.mid,
        }))
        .filter(item => Boolean(item.bvid));

      if (!playItems.length) {
        addToast({ title: "暂无可播放内容", color: "warning" });
        return;
      }

      await usePlayList.getState().playList(playItems);
      addToast({
        title: `已添加 ${playItems.length} 个投稿到播放列表`,
        description: incomplete ? "其余投稿暂时无法加载，已保留可播放的歌曲" : "最多播放前 200 条投稿",
        color: incomplete ? "warning" : "success",
      });
    } catch {
      addToast({ title: "播放列表生成失败", color: "danger" });
    }
  }, [id, items, keyword, order, total]);

  return (
    <div className="h-full w-full">
      <div className="mb-4 flex flex-col items-start justify-between gap-4 md:flex-row md:items-center">
        <div className="flex items-center">
          <AsyncButton
            color="primary"
            startContent={<RiPlayFill size={18} />}
            isDisabled={initialLoading || items.length === 0}
            onPress={handlePlayAll}
            className="dark:text-black"
          >
            播放
          </AsyncButton>
          <div className="text-default-500 pl-2 text-sm">共 {total} 条</div>
        </div>
        <div className="flex items-center gap-3">
          <SearchWithSort
            onKeywordSearch={setKeyword}
            order={order}
            orderOptions={[
              { key: "pubdate", label: "最新发布" },
              { key: "click", label: "最多播放" },
              { key: "stow", label: "最多收藏" },
            ]}
            onOrderChange={setOrder}
          />
        </div>
      </div>
      {initialLoading ? (
        <div className="flex h-[280px] items-center justify-center">
          <Spinner label="加载中" />
        </div>
      ) : failure && !items.length ? null : displayMode === "card" ? (
        <PostGridList
          items={items}
          hasMore={hasMore}
          loading={loadingMore}
          getScrollElement={getScrollElement}
          onLoadMore={handleLoadMore}
          onMenuAction={handleMenuAction}
        />
      ) : (
        <PostList
          items={items}
          hasMore={hasMore}
          loading={loadingMore}
          getScrollElement={getScrollElement}
          onLoadMore={handleLoadMore}
          onMenuAction={handleMenuAction}
        />
      )}
      {failure && (
        <div role="status" className="text-default-500 flex flex-wrap items-center justify-center gap-2 py-6 text-sm">
          {failure === "verification" ? "查看投稿需要验证" : "投稿加载失败"}
          <Button
            size="sm"
            variant="flat"
            onPress={() => void fetchPage(pageRef.current + 1, failure === "verification")}
          >
            {failure === "verification" ? "去验证" : "重试"}
          </Button>
        </div>
      )}
    </div>
  );
};

export default VideoPost;
