import React, { useCallback, useEffect, useRef, useState } from "react";

import { Button, Spinner } from "@heroui/react";

import ScrollContainer, { type ScrollRefObject } from "@/components/scroll-container";
import { getRelationFollowings } from "@/service/relation-followings";
import { useUser } from "@/store/user";

import UserItem, { type AuthorItem } from "./user";

interface AuthorListProps {
  selectedAuthorMid: number | null;
  onSelect: (mid: number | null) => void;
  android?: boolean;
}

const VERTICAL_LOAD_MORE_THRESHOLD = 200;
const HORIZONTAL_LOAD_MORE_THRESHOLD = 120;
const MAX_AUTO_FILL_PAGES = 5;

const AuthorList: React.FC<AuthorListProps> = ({ selectedAuthorMid, onSelect, android = false }) => {
  const user = useUser(s => s.user);
  const userMid = user?.mid;
  const scrollRef = useRef<ScrollRefObject>(null);
  const horizontalScrollRef = useRef<HTMLDivElement>(null);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const [list, setList] = useState<AuthorItem[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(Boolean(userMid));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const loadingRef = useRef(false);
  const requestIdRef = useRef(0);
  const listRef = useRef<AuthorItem[]>([]);
  const retryPageRef = useRef(1);
  const autoFillCountRef = useRef(0);

  const fetchFollowings = useCallback(
    async (pageIndex: number = 1, requestId = requestIdRef.current) => {
      if (!userMid || requestId !== requestIdRef.current || loadingRef.current) return;
      loadingRef.current = true;
      retryPageRef.current = pageIndex;
      setLoading(true);
      setError(null);
      try {
        const res = await getRelationFollowings({ vmid: userMid, pn: pageIndex, ps: 20, order_type: "attention" });
        if (requestId !== requestIdRef.current) return;
        if (res.code === 0) {
          const nextList = (res.data.list || []).map(item => ({
            mid: item.mid,
            face: item.face,
            name: item.uname,
          }));
          const total = res.data.total || 0;
          const prev = pageIndex === 1 ? [] : listRef.current;
          const seen = new Set(prev.map(item => item.mid));
          const combined = pageIndex === 1 ? nextList : [...prev, ...nextList.filter(item => !seen.has(item.mid))];
          listRef.current = combined;
          setList(combined);
          setHasMore(nextList.length > 0 && combined.length < total);
          setPage(pageIndex);
          setHasLoadedOnce(true);
        } else {
          setError(res.message || "无法加载关注列表");
        }
      } catch {
        if (requestId !== requestIdRef.current) return;
        setError("无法加载关注列表");
      } finally {
        if (requestId === requestIdRef.current) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    },
    [userMid],
  );

  const isNearEnd = useCallback(
    (element: HTMLElement) => {
      if (android) {
        return element.scrollWidth - element.scrollLeft - element.clientWidth < HORIZONTAL_LOAD_MORE_THRESHOLD;
      }
      return element.scrollHeight - element.scrollTop - element.clientHeight < VERTICAL_LOAD_MORE_THRESHOLD;
    },
    [android],
  );

  const handleScroll = useCallback(() => {
    const element = android ? horizontalScrollRef.current : scrollElement;
    if (!element || loadingRef.current || !hasMore || error) return;
    autoFillCountRef.current = 0;
    if (isNearEnd(element)) {
      void fetchFollowings(page + 1, requestIdRef.current);
    }
  }, [android, scrollElement, hasMore, error, isNearEnd, fetchFollowings, page]);

  useEffect(() => {
    if (android) {
      setScrollElement(horizontalScrollRef.current);
      return;
    }
    const initScrollElement = () => {
      if (scrollRef.current) {
        const instance = scrollRef.current.osInstance();
        if (instance) {
          setScrollElement(instance.elements().viewport);
        }
      }
    };
    initScrollElement();
    const timer = setTimeout(initScrollElement, 100);
    return () => clearTimeout(timer);
  }, [android]);

  useEffect(() => {
    if (android || !scrollElement) return;
    scrollElement.addEventListener("scroll", handleScroll);
    return () => {
      scrollElement.removeEventListener("scroll", handleScroll);
    };
  }, [android, scrollElement, handleScroll]);

  useEffect(() => {
    const element = android ? horizontalScrollRef.current : scrollElement;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setLayoutVersion(version => version + 1);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [android, scrollElement]);

  useEffect(() => {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    loadingRef.current = false;
    listRef.current = [];
    retryPageRef.current = 1;
    autoFillCountRef.current = 0;
    setLoading(false);
    setError(null);
    setList([]);
    setPage(1);
    setHasLoadedOnce(false);
    setHasMore(Boolean(userMid));

    const element = android ? horizontalScrollRef.current : scrollRef.current?.osInstance()?.elements().viewport;
    if (element) {
      element.scrollLeft = 0;
      element.scrollTop = 0;
    }

    if (userMid) {
      void fetchFollowings(1, requestId);
    }

    return () => {
      requestIdRef.current += 1;
      loadingRef.current = false;
    };
  }, [android, fetchFollowings, userMid]);

  useEffect(() => {
    const element = android ? horizontalScrollRef.current : scrollElement;
    if (!userMid || !element || !hasLoadedOnce || loading || loadingRef.current || !hasMore || error) return;
    if (autoFillCountRef.current >= MAX_AUTO_FILL_PAGES) return;
    const viewportSize = android ? element.clientWidth : element.clientHeight;
    if (viewportSize <= 0) return;
    if (isNearEnd(element)) {
      autoFillCountRef.current += 1;
      void fetchFollowings(page + 1, requestIdRef.current);
    }
  }, [
    android,
    scrollElement,
    userMid,
    hasLoadedOnce,
    loading,
    hasMore,
    error,
    list.length,
    page,
    layoutVersion,
    isNearEnd,
    fetchFollowings,
  ]);

  if (android) {
    return (
      <div className="border-divider/40 w-full min-w-0 shrink-0 border-b">
        <div className="px-3 pt-2 pb-1">
          <h1 className="min-w-0 truncate text-base font-semibold">用户动态</h1>
        </div>
        <div
          ref={horizontalScrollRef}
          onScroll={handleScroll}
          className="dynamic-feed-authors-scroll w-full"
          data-testid="dynamic-feed-authors-scroll"
        >
          <div className="flex w-max min-w-full flex-row flex-nowrap items-start gap-1 px-2.5 pb-2">
            <UserItem author={null} isSelected={selectedAuthorMid === null} onSelect={onSelect} horizontal />
            {list.map(author => (
              <UserItem
                key={author.mid}
                author={author}
                isSelected={selectedAuthorMid === author.mid}
                onSelect={onSelect}
                horizontal
              />
            ))}
            {loading && (
              <div className="text-default-500 flex h-16 shrink-0 items-center justify-center px-2">
                <Spinner size="sm" aria-label="加载关注中" />
              </div>
            )}
            {!loading && error && (
              <div className="flex h-16 shrink-0 items-center gap-1.5 px-2">
                <span className="text-danger max-w-28 truncate text-xs" title={error}>
                  {error}
                </span>
                <Button
                  size="sm"
                  variant="flat"
                  onPress={() => void fetchFollowings(retryPageRef.current, requestIdRef.current)}
                >
                  重试
                </Button>
              </div>
            )}
            {!loading && !hasMore && list.length === 0 && !error && Boolean(userMid) && (
              <div className="text-default-400 flex h-16 shrink-0 items-center px-2 text-xs">暂无关注</div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-64">
      <div className="border-divider/40 flex h-full flex-col border-r">
        <div className="mb-2 px-4">
          <h1 className="min-w-0 truncate">用户动态</h1>
        </div>
        <ScrollContainer ref={scrollRef} className="h-full min-h-0 w-full flex-1 px-2">
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <UserItem author={null} isSelected={selectedAuthorMid === null} onSelect={onSelect} />
            {list.map(author => (
              <UserItem
                key={author.mid}
                author={author}
                isSelected={selectedAuthorMid === author.mid}
                onSelect={onSelect}
              />
            ))}
            {loading && (
              <div className="text-default-500 flex items-center gap-2 px-2 py-2">
                <Spinner size="sm" />
                <span>加载中...</span>
              </div>
            )}
            {!loading && error && (
              <div className="flex flex-col items-start gap-2 px-2 py-2">
                <p className="text-danger text-sm">{error}</p>
                <Button size="sm" onPress={() => void fetchFollowings(retryPageRef.current, requestIdRef.current)}>
                  重试
                </Button>
              </div>
            )}
            {!loading && !hasMore && list.length === 0 && !error && Boolean(userMid) && (
              <p className="text-default-400 px-2 text-sm">暂无关注</p>
            )}
          </div>
        </ScrollContainer>
      </div>
    </div>
  );
};

export default AuthorList;
