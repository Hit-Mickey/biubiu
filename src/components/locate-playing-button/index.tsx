import type { RefObject } from "react";

import { addToast } from "@heroui/react";
import { RiFocus3Line } from "@remixicon/react";

import type { ScrollRefObject } from "@/components/scroll-container";

import IconButton from "@/components/icon-button";

interface Props {
  currentIndex: number | undefined;
  missingMessage: string;
  scrollRef: RefObject<ScrollRefObject | null>;
  listRef?: RefObject<HTMLElement | null>;
  rowHeight: number;
  size?: "sm" | "md";
}

export default function LocatePlayingButton({
  currentIndex,
  missingMessage,
  scrollRef,
  listRef,
  rowHeight,
  size,
}: Props) {
  const locate = () => {
    if (currentIndex === undefined || currentIndex < 0) {
      addToast({ title: currentIndex === undefined ? "当前没有正在播放的歌曲" : missingMessage, color: "warning" });
      return;
    }
    const viewport = scrollRef.current?.osInstance()?.elements().viewport;
    if (!viewport) return;
    const list = listRef?.current;
    const offset = list
      ? list.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop
      : 0;
    viewport.scrollTo({
      top: offset + (currentIndex + 0.5) * rowHeight - viewport.clientHeight / 2,
      behavior: "smooth",
    });
  };

  return (
    <IconButton aria-label="定位当前播放" tooltip="定位当前播放" variant="flat" size={size ?? "sm"} onPress={locate}>
      <RiFocus3Line size={18} />
    </IconButton>
  );
}
