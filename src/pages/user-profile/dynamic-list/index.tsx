import React, { useRef, useState, useCallback, useEffect } from "react";

import { Button, Spinner } from "@heroui/react";
import { useInViewport } from "ahooks";

import { DynamicType } from "@/common/constants/feed";
import Empty from "@/components/empty";
import { getWebDynamicFeedSpace, type ModuleAuthor, type WebDynamicItem } from "@/service/web-dynamic";

import DynamicItem from "./item";

interface DynamicListProps {
  mid: number;
  guest: boolean;
  onOwner: (author: Pick<ModuleAuthor, "mid" | "name" | "face">) => void;
  getScrollElement: () => HTMLElement | null;
}

const DynamicList: React.FC<DynamicListProps> = ({ mid, guest, onOwner, getScrollElement }) => {
  const [items, setItems] = useState<WebDynamicItem[]>([]);
  const [offset, setOffset] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  const [failure, setFailure] = useState("");
  const [hasMore, setHasMore] = useState(true);
  const [initialized, setInitialized] = useState(false);

  // Sentinel for infinite scroll
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const [inViewport] = useInViewport(loadMoreRef, { root: getScrollElement() });

  // Fetch data function
  const fetchData = useCallback(
    async (currentOffset = "", interactive = false) => {
      if (request.current) return;
      const controller = new AbortController();
      request.current = controller;
      setFailure("");
      setIsLoading(true);

      try {
        const res = await getWebDynamicFeedSpace(
          {
            host_mid: mid,
            offset: currentOffset,
            type: "video",
            platform: "web",
          },
          { passive: guest && !interactive, signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (res.code === 0 && Array.isArray(res.data?.items)) {
          if (!currentOffset) {
            const author = res.data.items.find(item => Number(item.modules?.module_author?.mid) === mid)?.modules
              .module_author;
            if (author) onOwner({ mid: author.mid, name: author.name, face: author.face });
          }
          const videos = res.data.items.filter(item => item.type === DynamicType.Av);
          setItems(prev => (currentOffset === "" ? videos : [...prev, ...videos]));
          setOffset(res.data.offset);
          setHasMore(res.data.has_more && !!res.data.offset && res.data.offset !== currentOffset);
        } else {
          setFailure(res.data?.v_voucher || res.code === -352 ? "查看动态需要验证" : res.message || "动态加载失败");
        }
      } catch {
        if (!controller.signal.aborted) setFailure("动态加载失败");
      } finally {
        if (request.current === controller) {
          request.current = null;
          setIsLoading(false);
          setInitialized(true);
        }
      }
    },
    [mid, guest, onOwner],
  );

  // Initial load
  useEffect(() => {
    void fetchData();
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [fetchData]);

  // Load more when sentinel is in viewport
  useEffect(() => {
    if (!failure && inViewport && hasMore && !isLoading && initialized) {
      fetchData(offset);
    }
  }, [failure, inViewport, hasMore, isLoading, fetchData, offset, initialized]);

  if (!initialized && isLoading) {
    return (
      <div className="flex h-64 w-full items-center justify-center">
        <Spinner size="lg" color="primary" />
      </div>
    );
  }

  if (!failure && initialized && items.length === 0) {
    return <Empty title="暂无动态" />;
  }

  return (
    <div className="w-full">
      <div className="flex flex-col">
        {items.map((item, index) => (
          <DynamicItem key={`${item.id_str}-${index}`} item={item} />
        ))}
      </div>

      <div ref={loadMoreRef} className="flex w-full justify-center py-4">
        {isLoading && (
          <div className="text-default-500 flex items-center gap-2">
            <Spinner size="sm" />
            <span>Loading...</span>
          </div>
        )}
        {failure && (
          <div role="status" className="text-default-500 flex items-center gap-2 text-sm">
            {failure}
            <Button size="sm" variant="flat" onPress={() => void fetchData(offset, true)}>
              {failure === "查看动态需要验证" ? "去验证" : "重试"}
            </Button>
          </div>
        )}
        {!hasMore && items.length > 0 && <div className="text-default-500 text-sm">没有更多了</div>}
      </div>
    </div>
  );
};

export default DynamicList;
