import { useEffect, useState } from "react";

import { Button, Spinner } from "@heroui/react";

import type { BiliSearchTarget } from "@/common/utils/bili-search";

import { formatSecondsToDate } from "@/common/utils/time";
import MusicCard from "@/components/music-card";
import MusicListItem from "@/components/music-list-item";
import MusicListHeader from "@/components/music-list-item/header";
import { usePlayList } from "@/store/play-list";
import { useSettings } from "@/store/settings";

import { resolveSearchTrack } from "./resolve-track";
import { getContextMenus, handleSearchTrackAction } from "./video-list/menu";

type Result = Awaited<ReturnType<typeof resolveSearchTrack>>;

export default function DirectTrack({ target }: { target: BiliSearchTarget }) {
  const displayMode = useSettings(s => s.displayMode);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    resolveSearchTrack(target, controller.signal).then(
      result => {
        if (!controller.signal.aborted) setResult(result);
      },
      reason => {
        if (!controller.signal.aborted) {
          setError(
            (reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "") || "歌曲信息加载失败",
          );
        }
      },
    );
    return () => controller.abort();
  }, [target, attempt]);

  if (error)
    return (
      <div className="flex min-h-[200px] flex-col items-center justify-center gap-3 px-4">
        <span role="alert" className="text-foreground-500 text-center">
          {error}
        </span>
        <Button
          size="sm"
          onPress={() => {
            setError("");
            setAttempt(n => n + 1);
          }}
        >
          重试
        </Button>
      </div>
    );
  if (!result)
    return (
      <div className="flex min-h-[200px] items-center justify-center">
        <Spinner label="正在获取歌曲信息" />
      </div>
    );

  const { track, published } = result;
  const props = {
    ...track,
    cover: track.cover ?? "",
    title:
      (track.totalPage ?? 1) > 1 && track.pageIndex
        ? `${track.title} · P${track.pageIndex} ${track.pageTitle ?? ""}`.trim()
        : track.title,
    menus: getContextMenus(track.type),
    onMenuAction: (key: string) => handleSearchTrackAction(key, track),
    onPress: () => usePlayList.getState().play(track),
  };
  if (displayMode === "card")
    return (
      <div className="w-full max-w-72 px-4">
        <MusicCard {...props} time={published} />
      </div>
    );
  return (
    <div className="w-full px-4">
      <MusicListHeader />
      <MusicListItem
        {...props}
        index={1}
        upName={track.ownerName}
        upMid={track.ownerMid}
        pubTime={formatSecondsToDate(published)}
      />
    </div>
  );
}
