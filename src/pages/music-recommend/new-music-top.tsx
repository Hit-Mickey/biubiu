import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";

import { Card, Spinner, addToast } from "@heroui/react";
import { RiArrowLeftSLine, RiArrowRightSLine, RiMusic2Line, RiPlayFill } from "@remixicon/react";
import { isAxiosError } from "axios";

import { detectPlatform } from "@/bridge/env";
import log from "@/common/utils/logger";
import { formatNumber } from "@/common/utils/number";
import { trackPressProps } from "@/common/utils/track-press";
import IconButton from "@/components/icon-button";
import Image from "@/components/image";
import { MobileTrackMenu } from "@/components/music-list-item/operation";
import { getNewMusic } from "@/service/web-interface-new-music";
import { getNewMusicBanner } from "@/service/web-interface-new-music-banner";
import { usePlayList } from "@/store/play-list";

type UnifiedItem = {
  key: string;
  title: string;
  cover?: string;
  bvid?: string;
  jump_url?: string;
  total_vv?: number;
  wish_count?: number;
  author?: string;
  date?: string;
};

type NewMusicTopProps = {
  ref?: React.Ref<NewMusicTopHandle>;
  onLayoutChange?: () => void;
  onLoadingChange?: (loading: boolean) => void;
};

export type NewMusicRefreshResult = { ok: true; stale?: boolean } | { ok: false; error: string; stale?: false };

export interface NewMusicTopHandle {
  refresh: () => Promise<NewMusicRefreshResult>;
}

function getNewMusicErrorMessage(error: unknown) {
  if (isAxiosError(error)) {
    const status = error.response?.status;
    if (status === 412) return "B 站暂未接受这次推荐请求（HTTP 412）。";
    return status ? `B 站推荐请求失败（HTTP ${status}）。` : "暂时无法连接 B 站推荐服务。";
  }
  return error instanceof Error ? error.message : "无法获取新歌速递。";
}

const NewMusicTop = ({ ref, onLayoutChange, onLoadingChange }: NewMusicTopProps) => {
  const android = detectPlatform() === "android";
  const [items, setItems] = useState<UnifiedItem[]>([]);
  const [newLoading, setNewLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [newPage, setNewPage] = useState(1);
  const gridRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);
  const itemsCountRef = useRef(0);
  const onLoadingChangeRef = useRef(onLoadingChange);
  const [colCount, setColCount] = useState(2);

  useEffect(() => {
    onLoadingChangeRef.current = onLoadingChange;
  }, [onLoadingChange]);

  const handlePlay = React.useCallback((item: UnifiedItem) => {
    usePlayList
      .getState()
      .play({
        type: "mv",
        bvid: item.bvid,
        title: item.title,
        cover: item.cover,
        playCount: item.total_vv,
        ownerName: item.author,
      })
      .catch(error => {
        log.error("[new-music-top] play error", error);
        addToast({ title: "播放失败", color: "danger" });
      });
  }, []);

  const fetchNewMusic = useCallback(async (preserveItems: boolean): Promise<NewMusicRefreshResult> => {
    const current = ++requestIdRef.current;
    onLoadingChangeRef.current?.(true);
    if (!preserveItems) {
      setNewLoading(true);
      setLoadError(undefined);
    }
    try {
      const [bannerOutcome, listOutcome] = await Promise.allSettled([getNewMusicBanner(), getNewMusic()]);
      if (current !== requestIdRef.current) return { ok: true, stale: true };

      const bannerOk =
        bannerOutcome.status === "fulfilled" &&
        bannerOutcome.value != null &&
        (bannerOutcome.value.code === undefined || bannerOutcome.value.code === 0);
      const listOk =
        listOutcome.status === "fulfilled" &&
        listOutcome.value != null &&
        (listOutcome.value.code === undefined || listOutcome.value.code === 0);

      const firstError =
        (listOutcome.status === "rejected" && listOutcome.reason) ||
        (bannerOutcome.status === "rejected" && bannerOutcome.reason) ||
        new Error(
          (listOutcome.status === "fulfilled" && listOutcome.value?.message) ||
            (bannerOutcome.status === "fulfilled" && bannerOutcome.value?.message) ||
            "获取新歌速递失败",
        );

      if (!bannerOk && !listOk) {
        throw firstError;
      }

      const bannerList = bannerOk ? (bannerOutcome.value.data?.list ?? []) : [];
      const musicList = listOk ? (listOutcome.value.data?.list ?? []) : [];

      const normalizedBanner: UnifiedItem[] = bannerList.map((b, index) => ({
        key: b.bvid || b.music_id || b.jump_url || (b.cover ? `cover:${b.cover}` : `banner:${index}`),
        title: b.archive_title || "",
        cover: b.cover,
        bvid: b.bvid,
        jump_url: b.jump_url,
        author: b.author,
        date: b.publish_time ? String(b.publish_time).slice(0, 10) : undefined,
      }));

      const normalizedMusic: UnifiedItem[] = musicList.map((m, index) => ({
        key:
          m.bvid ||
          (typeof m.id === "number" ? String(m.id) : "") ||
          m.music_id ||
          m.jump_url ||
          (m.cover ? `cover:${m.cover}` : `music:${index}`),
        title: m.music_title || "",
        cover: m.cover,
        bvid: m.bvid,
        jump_url: m.jump_url,
        total_vv: m.total_vv,
        wish_count: m.wish_count,
        author: m.author,
        date: m.publish_time || undefined,
      }));

      const seen = new Set<string>();
      const merged: UnifiedItem[] = [];
      [...normalizedBanner, ...normalizedMusic].forEach(it => {
        if (!seen.has(it.key)) {
          seen.add(it.key);
          merged.push(it);
        }
      });

      if ((!bannerOk || !listOk) && merged.length === 0) {
        throw firstError;
      }

      itemsCountRef.current = merged.length;
      setItems(merged);
      setLoadError(undefined);
      setNewPage(1);
      return { ok: true };
    } catch (error) {
      if (current !== requestIdRef.current) return { ok: true, stale: true };
      const message = getNewMusicErrorMessage(error);
      log.error("[new-music-top] fetchNewMusic error", error);
      if (!preserveItems) {
        setLoadError(message);
      }
      return { ok: false, error: message };
    } finally {
      if (current === requestIdRef.current) {
        setNewLoading(false);
        onLoadingChangeRef.current?.(false);
      }
    }
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      refresh: () => fetchNewMusic(itemsCountRef.current > 0),
    }),
    [fetchNewMusic],
  );

  useEffect(() => {
    void fetchNewMusic(false);
    return () => {
      requestIdRef.current += 1;
      onLoadingChangeRef.current?.(false);
    };
  }, [fetchNewMusic]);

  useEffect(() => {
    if (!onLayoutChange) return;
    const target = containerRef.current;
    if (!target) return;
    let frameId: number | null = null;
    const observer = new ResizeObserver(() => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      frameId = requestAnimationFrame(() => {
        onLayoutChange();
      });
    });
    observer.observe(target);
    return () => {
      observer.disconnect();
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [onLayoutChange]);

  useEffect(() => {
    const computeColsByBreakpoint = () => {
      const w = window.innerWidth;
      if (w >= 1280) return 6;
      if (w >= 1024) return 5;
      if (w >= 768) return 4;
      if (w >= 640) return 3;
      return 2;
    };
    const update = () => {
      try {
        setColCount(computeColsByBreakpoint());
      } catch (err) {
        log.error("[new-music-top] compute cols error", err);
        setColCount(2);
      }
    };
    update();
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
    };
  }, []);

  const pageSize = useMemo(() => Math.max(1, colCount) * 2, [colCount]);
  const totalPages = useMemo(() => (items.length > 0 ? Math.ceil(items.length / pageSize) : 0), [items, pageSize]);

  useEffect(() => {
    if (totalPages > 0 && newPage > totalPages) {
      setNewPage(totalPages);
    }
    // eslint-disable-next-line
  }, [totalPages]);

  const pageItems = useMemo(() => {
    const start = (newPage - 1) * pageSize;
    const end = start + pageSize;
    return items.slice(start, end);
  }, [items, newPage, pageSize]);

  return (
    <div ref={containerRef} className="mb-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <RiMusic2Line className="text-primary" />
          <h1>新歌速递</h1>
        </div>
        {newLoading ? null : (
          <div className="flex items-center gap-2">
            <IconButton
              isDisabled={newPage <= 1 || totalPages === 0}
              onPress={() => setNewPage(p => Math.max(1, p - 1))}
              variant="flat"
              className="bg-foreground/10 hover:bg-foreground/20 shadow-none"
            >
              <RiArrowLeftSLine size={16} />
            </IconButton>
            <span className="text-foreground text-sm">{`${newPage} / ${totalPages}`}</span>
            <IconButton
              isDisabled={newPage >= totalPages || totalPages === 0}
              onPress={() => setNewPage(p => Math.min(totalPages, p + 1))}
              variant="flat"
              className="bg-foreground/10 hover:bg-foreground/20 shadow-none"
            >
              <RiArrowRightSLine size={16} />
            </IconButton>
          </div>
        )}
      </div>
      {newLoading ? (
        <div className="flex h-[200px] items-center justify-center">
          <Spinner size="lg" label="Loading..." />
        </div>
      ) : (
        <div
          ref={gridRef}
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"
        >
          {pageItems.length === 0 ? (
            <Card className="rounded-medium col-span-full flex h-[200px] flex-col items-center justify-center gap-1 px-4 text-center">
              <span className="text-foreground-500">{loadError ? "新歌速递加载失败" : "暂无数据"}</span>
              {loadError && <span className="text-default-500 text-xs">{loadError}</span>}
            </Card>
          ) : (
            pageItems.map(item => {
              return (
                <div
                  key={item.key}
                  role="button"
                  tabIndex={0}
                  {...trackPressProps(() => handlePlay(item), "click")}
                  className="group w-full cursor-pointer select-none"
                >
                  <div className="relative aspect-square w-full">
                    <Image
                      radius="md"
                      src={item.cover || ""}
                      width="100%"
                      height="100%"
                      params="672w_378h_1c.avif"
                      emptyPlaceholder={<RiMusic2Line />}
                      removeWrapper
                      className="rounded-medium shadow-md"
                    />
                    {(android || typeof item.total_vv === "number") && (
                      <div className="absolute inset-x-0 bottom-0 z-10 bg-linear-to-t from-black/80 via-black/40 to-transparent p-2 text-white">
                        <div className="line-clamp-1 text-xs">{`${formatNumber(item.total_vv) ?? "—"}播放`}</div>
                      </div>
                    )}
                    {!android && (
                      <div className="pointer-events-none absolute right-2 bottom-8 z-40 opacity-0 transition-opacity duration-200 ease-out group-hover:opacity-100">
                        <div className="bg-primary rounded-full shadow-2xl">
                          <div className="flex h-10 w-10 items-center justify-center">
                            <RiPlayFill className="text-black" size={26} />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="mt-2 flex items-start justify-between">
                    <div className="min-w-0 text-left">
                      <div className="group-hover:text-primary line-clamp-1 text-base font-medium transition-colors">
                        {item.title}
                      </div>
                      {(item.author || item.date) && (
                        <div className="text-foreground-500 group-hover:text-primary mt-1 text-xs transition-colors">
                          {`${item.author ?? ""}${item.author && item.date ? " · " : ""}${item.date ?? ""}`}
                        </div>
                      )}
                    </div>
                    {android && item.bvid && <MobileTrackMenu items={[]} owner={{ bvid: item.bvid }} />}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};

export default NewMusicTop;
