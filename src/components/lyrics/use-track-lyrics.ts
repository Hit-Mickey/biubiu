import { useEffect, useMemo, useState } from "react";

import { addToast } from "@heroui/react";

import type { PlayData } from "@/store/play-list";

import { adoptedLyrics, applyLyricChange, lyricsCacheKey } from "@shared/lyrics";

import { getNativeLyrics, type NativeLyrics } from "./get-lyrics";
import { parseLyrics } from "./timeline";

const emptyText: LyricText = {};
const emptySheet = { lines: [], plain: "", plainTranslation: "", plainRomanization: "" };

export function useTrackLyrics(item: PlayData | undefined) {
  const key = item ? lyricsCacheKey(item) : undefined;
  const { id, source, cid, bvid, aid, webDavListId } = item ?? {};
  const localUrl = source === "local" ? item?.audioUrl : undefined;
  const request = useMemo(
    () => (id ? { id, source, cid, bvid, aid, webDavListId, audioUrl: localUrl } : undefined),
    [id, source, cid, bvid, aid, webDavListId, localUrl],
  );
  const [saved, setSaved] = useState<{ key: string; cache: MusicLyrics }>();
  const [loaded, setLoaded] = useState<{ request: typeof request; native: NativeLyrics }>();
  const cache = saved?.key === key ? saved?.cache : undefined;
  const override = cache?.edited ?? adoptedLyrics(cache);
  const native = loaded?.request === request ? loaded?.native : undefined;
  const needNative = !!cache && !override;

  useEffect(() => {
    setSaved(undefined);
    if (!key) return;
    let current = true;
    window.electron
      .getTrackLyrics(key)
      .catch(() => undefined)
      .then(cache => {
        if (current) setSaved({ key, cache: cache ?? {} });
      });
    return () => {
      current = false;
    };
  }, [key]);

  useEffect(() => {
    setLoaded(undefined);
    if (!request || !needNative) return;
    let current = true;
    getNativeLyrics(request)
      .catch(() => emptyText)
      .then(native => {
        if (current) setLoaded({ request, native });
      });
    return () => {
      current = false;
    };
  }, [needNative, request]);

  const { lyrics, tLyrics, romaLyrics } = override ?? native ?? emptyText;
  const subtitles = override ? undefined : native?.subtitles;
  const getSheet = useMemo(() => {
    // Parse on the first display, after the opening animation if only the full-screen player is open.
    let sheet: ReturnType<typeof parseLyrics> | undefined;
    return () =>
      (sheet ??= subtitles ? { ...emptySheet, lines: subtitles } : parseLyrics({ lyrics, tLyrics, romaLyrics }));
  }, [lyrics, tLyrics, romaLyrics, subtitles]);

  const preview = (patch: Pick<MusicLyrics, "offset" | "fontSize">) => {
    setSaved(previous =>
      previous && previous.key === key ? { key, cache: { ...previous.cache, ...patch } } : previous,
    );
  };

  const commit = async (change: TrackLyricChange) => {
    if (!key) return false;
    try {
      await window.electron.updateTrackLyrics(key, change);
      if (change.type !== "preferences") {
        setSaved(previous =>
          previous?.key === key ? { key, cache: applyLyricChange(previous.cache, change) } : previous,
        );
      }
      return true;
    } catch {
      addToast({ title: "歌词保存失败", color: "danger" });
      return false;
    }
  };

  return {
    getSheet,
    preview,
    commit,
    hasCache: !!cache,
    isLoading: !!item && (!cache || (needNative && !native)),
    offset: cache?.offset ?? 0,
    fontSize: cache?.fontSize || 20,
  };
}

export type TrackLyrics = ReturnType<typeof useTrackLyrics>;
