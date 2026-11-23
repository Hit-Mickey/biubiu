import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";

import { Spinner, Button } from "@heroui/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "classnames";

import { detectPlatform } from "@/bridge/env";
import ScrollContainer, { type ScrollRefObject } from "@/components/scroll-container";
import { getWebDynamicFeedAll, getWebDynamicFeedSpace, type WebDynamicItem } from "@/service/web-dynamic";
import { useUser } from "@/store/user";

import AuthorList from "./author-list";
import DynamicItem from "./item";

import "./android.css";

const LOAD_MORE_THRESHOLD = 200;
const MAX_AUTO_FILL_PAGES = 5;

const DynamicFeedPage = () => {
  const android = (window.electron?.getPlatform?.() ?? detectPlatform()) === "android";
  const userMid = useUser(s => s.user?.mid ?? null);
  const [items, setItems] = useState<WebDynamicItem[]>([]);
  const [offset, setOffset] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const isLoadingRef = useRef(false);
  const [hasMore, setHasMore] = useState(true);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [autoFillCapped, setAutoFillCapped] = useState(false);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selectedAuthorMid, setSelectedAuthorMid] = useState<number | null>(null);
  const selectedAuthorMidRef = useRef<number | null>(null);
  const offsetRef = useRef<string>("");
  const requestIdRef = useRef(0);
  const autoFillCountRef = useRef(0);
  const pendingScrollResetRef = useRef(false);
  const lastContainerWidthRef = useRef(0);

  const scrollRef = useRef<ScrollRefObject>(null);
  const androidScrollRef = useRef<HTMLDivElement>(null);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const scrollElementRef = useRef<HTMLElement | null>(null);
  const androidRef = useRef(android);
  androidRef.current = android;

  const invalidateRequests = useCallback(() => {
    requestIdRef.current += 1;
    isLoadingRef.current = false;
    setIsLoading(false);
    return requestIdRef.current;
  }, []);

  const getViewportElement = useCallback((): HTMLElement | null => {
    if (androidRef.current) return androidScrollRef.current;
    return scrollRef.current?.osInstance()?.elements().viewport ?? scrollElementRef.current;
  }, []);

  const resetScrollPosition = useCallback(() => {
    const viewport = getViewportElement();
    if (!viewport) return;
    viewport.scrollTop = 0;
  }, [getViewportElement]);

  const fetchData = useCallback(
    async (currentOffset: string = "", hostMid: number | null = null, requestId = requestIdRef.current) => {
      if (requestId !== requestIdRef.current || isLoadingRef.current) return;
      isLoadingRef.current = true;
      setIsLoading(true);
      setError(null);

      try {
        const res = hostMid
          ? await getWebDynamicFeedSpace({
              host_mid: hostMid,
              offset: currentOffset,
              type: "video",
              platform: "web",
            })
          : await getWebDynamicFeedAll({
              type: "video",
              offset: currentOffset,
              platform: "web",
            });

        if (requestId !== requestIdRef.current) return;

        if (res.code === 0) {
          const incomingItems = res.data.items || [];
          const nextOffset = res.data.offset || "";
          const nextHasMore = Boolean(res.data.has_more && nextOffset && nextOffset !== currentOffset);
          setItems(prev => {
            if (currentOffset === "") return incomingItems;
            const seen = new Set(prev.map(item => item.id_str));
            const deduped = incomingItems.filter(item => !seen.has(item.id_str));
            return [...prev, ...deduped];
          });
          offsetRef.current = nextOffset;
          setOffset(nextOffset);
          setHasMore(nextHasMore);
          setHasLoadedOnce(true);
        } else {
          setError(res.message || "无法加载动态");
        }
      } catch {
        if (requestId !== requestIdRef.current) return;
        setError("无法获取动态数据");
      } finally {
        if (requestId === requestIdRef.current) {
          isLoadingRef.current = false;
          setIsLoading(false);
        }
      }
    },
    [],
  );

  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => (android ? 340 : 280),
    overscan: 5,
    getItemKey: index => `${selectedAuthorMid ?? "all"}:${items[index]?.id_str ?? index}:${index}`,
  });
  const totalSize = rowVirtualizer.getTotalSize();

  useLayoutEffect(() => {
    if (!hasLoadedOnce || !pendingScrollResetRef.current || !scrollElement) return;
    // 新作者的首屏挂载后，虚拟列表还会校正一次测量结果。
    resetScrollPosition();
    const frame = requestAnimationFrame(() => {
      resetScrollPosition();
      pendingScrollResetRef.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [hasLoadedOnce, resetScrollPosition, scrollElement, selectedAuthorMid, userMid]);

  const resetFeedScroll = useCallback(() => {
    resetScrollPosition();
    const viewport = getViewportElement();
    if (viewport && typeof viewport.scrollTo === "function") {
      rowVirtualizer.scrollToOffset(0);
    }
    rowVirtualizer.measure();
  }, [getViewportElement, resetScrollPosition, rowVirtualizer]);

  useEffect(() => {
    const requestId = invalidateRequests();
    selectedAuthorMidRef.current = null;
    offsetRef.current = "";
    autoFillCountRef.current = 0;
    pendingScrollResetRef.current = true;
    setSelectedAuthorMid(null);
    setOffset("");
    setHasMore(true);
    setHasLoadedOnce(false);
    setAutoFillCapped(false);
    setItems([]);
    setError(null);
    resetFeedScroll();
    void fetchData("", null, requestId);
    return () => {
      invalidateRequests();
    };
  }, [fetchData, invalidateRequests, resetFeedScroll, userMid]);

  useEffect(() => {
    if (android) {
      scrollElementRef.current = androidScrollRef.current;
      setScrollElement(androidScrollRef.current);
      return;
    }
    const initScrollElement = () => {
      if (scrollRef.current) {
        const instance = scrollRef.current.osInstance();
        if (instance) {
          const viewport = instance.elements().viewport;
          scrollElementRef.current = viewport;
          setScrollElement(viewport);
        }
      }
    };
    initScrollElement();
    const timer = setTimeout(initScrollElement, 100);
    return () => clearTimeout(timer);
  }, [android]);

  const handleScroll = useCallback(() => {
    const viewport = getViewportElement();
    if (!viewport || isLoadingRef.current || !hasMore || error) return;
    autoFillCountRef.current = 0;
    setAutoFillCapped(false);
    const { scrollTop, scrollHeight, clientHeight } = viewport;
    if (scrollHeight - scrollTop - clientHeight < LOAD_MORE_THRESHOLD) {
      void fetchData(offsetRef.current, selectedAuthorMidRef.current, requestIdRef.current);
    }
  }, [getViewportElement, hasMore, error, fetchData]);

  const handleSelectAuthor = useCallback(
    (mid: number | null) => {
      const nextMid = mid === null ? null : selectedAuthorMidRef.current === mid ? null : mid;
      const requestId = invalidateRequests();
      selectedAuthorMidRef.current = nextMid;
      offsetRef.current = "";
      autoFillCountRef.current = 0;
      pendingScrollResetRef.current = true;
      setSelectedAuthorMid(nextMid);
      setOffset("");
      setHasMore(true);
      setHasLoadedOnce(false);
      setAutoFillCapped(false);
      setItems([]);
      setError(null);
      resetFeedScroll();
      void fetchData("", nextMid, requestId);
    },
    [fetchData, invalidateRequests, resetFeedScroll],
  );

  useEffect(() => {
    if (android || !scrollElement) return;
    scrollElement.addEventListener("scroll", handleScroll);
    return () => {
      scrollElement.removeEventListener("scroll", handleScroll);
    };
  }, [android, scrollElement, handleScroll]);

  useEffect(() => {
    if (!scrollElement || typeof ResizeObserver === "undefined") return;
    lastContainerWidthRef.current = scrollElement.clientWidth;
    const observer = new ResizeObserver(() => {
      const width = scrollElement.clientWidth;
      if (android && width > 0 && width !== lastContainerWidthRef.current) {
        lastContainerWidthRef.current = width;
        rowVirtualizer.measure();
      }
      setLayoutVersion(version => version + 1);
    });
    observer.observe(scrollElement);
    return () => observer.disconnect();
  }, [android, rowVirtualizer, scrollElement]);

  useEffect(() => {
    const viewport = getViewportElement();
    if (!viewport || !hasLoadedOnce || isLoading || isLoadingRef.current || !hasMore || error) return;
    const { scrollTop, scrollHeight, clientHeight } = viewport;
    if (clientHeight <= 0) return;
    if (scrollHeight - scrollTop - clientHeight < LOAD_MORE_THRESHOLD) {
      if (autoFillCountRef.current >= MAX_AUTO_FILL_PAGES) {
        setAutoFillCapped(true);
        return;
      }
      autoFillCountRef.current += 1;
      void fetchData(offsetRef.current, selectedAuthorMidRef.current, requestIdRef.current);
    }
  }, [
    getViewportElement,
    hasLoadedOnce,
    isLoading,
    hasMore,
    error,
    items.length,
    offset,
    totalSize,
    layoutVersion,
    fetchData,
  ]);

  const feedContent = (
    <>
      <div className={android ? "py-2" : undefined}>
        <div
          className={android ? "relative w-full" : "relative w-full px-4 py-4"}
          style={{
            height: `${totalSize}px`,
          }}
        >
          {rowVirtualizer.getVirtualItems().map(virtualItem => {
            const item = items[virtualItem.index];
            if (!item) return null;
            return (
              <div
                key={virtualItem.key}
                data-index={virtualItem.index}
                ref={rowVirtualizer.measureElement}
                className="absolute top-0 left-0 w-full"
                style={{
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                <DynamicItem item={item} className={virtualItem.index === 0 ? "pt-0" : ""} />
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex w-full justify-center py-4">
        {isLoading && (
          <div className="text-default-500 flex items-center gap-2">
            <Spinner size="sm" />
            <span>Loading...</span>
          </div>
        )}
        {!isLoading && error && (
          <div className="flex flex-col items-center gap-2">
            <p className="text-danger">{error}</p>
            <Button
              size="sm"
              onPress={() => {
                autoFillCountRef.current = 0;
                setAutoFillCapped(false);
                void fetchData(offsetRef.current, selectedAuthorMidRef.current, requestIdRef.current);
              }}
            >
              Retry
            </Button>
          </div>
        )}
        {!isLoading && !error && hasMore && autoFillCapped && (
          <Button
            size="sm"
            variant="flat"
            onPress={() => {
              autoFillCountRef.current = 0;
              setAutoFillCapped(false);
              void fetchData(offsetRef.current, selectedAuthorMidRef.current, requestIdRef.current);
            }}
          >
            加载更多
          </Button>
        )}
        {!isLoading && !hasMore && items.length > 0 && <p className="text-default-400 text-sm">No more dynamics</p>}
        {!isLoading && !hasMore && items.length === 0 && !error && <p className="text-default-400 text-sm">Empty</p>}
      </div>
    </>
  );

  return (
    <div
      data-platform={android ? "android" : undefined}
      className={clsx("dynamic-feed-page flex h-full w-full min-w-0", android ? "flex-col" : "flex-row")}
    >
      <AuthorList selectedAuthorMid={selectedAuthorMid} onSelect={handleSelectAuthor} android={android} />

      <div className="flex min-h-0 min-w-0 flex-1">
        {android ? (
          <div
            ref={androidScrollRef}
            onScroll={handleScroll}
            className="dynamic-feed-scroll h-full w-full px-2.5"
            data-testid="dynamic-feed-scroll"
          >
            {feedContent}
          </div>
        ) : (
          <ScrollContainer ref={scrollRef} className="h-full w-full px-4">
            {feedContent}
          </ScrollContainer>
        )}
      </div>
    </div>
  );
};

export default DynamicFeedPage;
