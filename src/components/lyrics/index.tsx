import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { addToast } from "@heroui/react";
import { RiTBoxLine } from "@remixicon/react";
import clsx from "classnames";

import type { PlayData } from "@/store/play-list";

import { usePlayProgress } from "@/store/play-progress";
import { adoptedLyrics, applyLyricChange, lyricsCacheKey } from "@shared/lyrics";

import IconButton from "../icon-button";
import ActiveWords from "./active-words";
import FontSizeControl from "./font-size-control";
import { getNativeLyrics, type NativeLyrics } from "./get-lyrics";
import OffsetControl from "./offset-control";
import { activeLineAt, parseLyrics } from "./timeline";

const SearchModal = lazy(() => import("../lyrics-search-modal"));
const emptyText: LyricText = {};
const emptySheet = { lines: [], plain: "", plainTranslation: "", plainRomanization: "" };
const mask =
  "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.15) 6%, rgba(0,0,0,0.5) 12%, black 24%, black 76%, rgba(0,0,0,0.5) 88%, rgba(0,0,0,0.15) 94%, transparent 100%)";

interface Props {
  item: PlayData;
  color?: string;
  centered?: boolean;
  showControls?: boolean;
  deferRendering?: boolean;
}

/** FullScreenPlayer keys this component by song and unmounts it when lyrics are hidden. */
export default function Lyrics({ item, color, centered, showControls, deferRendering }: Props) {
  const { id, source, cid, bvid, aid, webDavListId } = item;
  const localUrl = source === "local" ? item.audioUrl : undefined;
  const key = lyricsCacheKey(item);
  const [cache, setCache] = useState<MusicLyrics>();
  const [native, setNative] = useState<NativeLyrics>();
  const [searchOpen, setSearchOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const override = cache?.edited ?? adoptedLyrics(cache);
  const needNative = !!cache && !override;
  const text = override ?? native ?? emptyText;
  const isLoading = !cache || (needNative && !native);
  const offset = cache?.offset ?? 0;
  const fontSize = cache?.fontSize || 20;

  useEffect(() => {
    let current = true;
    window.electron
      .getTrackLyrics(key)
      .catch(() => undefined)
      .then(result => {
        if (current) setCache(result ?? {});
      });
    return () => {
      current = false;
    };
  }, [key]);

  useEffect(() => {
    setNative(undefined);
    if (!needNative) return;
    let current = true;
    getNativeLyrics({ source, id, webDavListId, cid, bvid, aid, audioUrl: localUrl })
      .catch(() => emptyText)
      .then(result => {
        if (current) setNative(result);
      });
    return () => {
      current = false;
    };
  }, [needNative, source, id, webDavListId, cid, bvid, aid, localUrl]);

  const { lyrics, tLyrics, romaLyrics } = text;
  const subtitles = override ? undefined : native?.subtitles;
  const sheet = useMemo(() => {
    if (deferRendering) return emptySheet;
    if (subtitles) return { ...emptySheet, lines: subtitles };
    return parseLyrics({ lyrics, tLyrics, romaLyrics });
  }, [deferRendering, subtitles, lyrics, tLyrics, romaLyrics]);
  // Zustand only notifies React when the selected line changes, not on each timeupdate/word.
  const activeIndex = usePlayProgress(s => activeLineAt(sheet.lines, s.currentTime * 1000 + offset));

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const rows = rowsRef.current;
    const row = rows?.children[activeIndex] as HTMLElement | undefined;
    if (!wrapper || !rows || !row) return;
    const center = () => {
      rows.style.paddingBlock = `${Math.max(0, (wrapper.clientHeight - row.clientHeight) / 2)}px`;
      wrapper.scrollTo({
        top: Math.max(0, row.offsetTop - (wrapper.clientHeight - row.clientHeight) / 2),
        behavior: "smooth",
      });
    };
    center();
    const observer = new ResizeObserver(center);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [activeIndex, sheet, fontSize]);

  const commit = async (change: TrackLyricChange) => {
    try {
      await window.electron.updateTrackLyrics(key, change);
      if (change.type !== "preferences") {
        setCache(prev => applyLyricChange(prev ?? {}, change));
        setSearchOpen(false);
      }
      return true;
    } catch {
      addToast({ title: "歌词保存失败", color: "danger" });
      return false;
    }
  };
  if (deferRendering) return null;
  const title = item.pageTitle || item.title;
  return (
    <>
      <div className="group/lyrics relative flex h-full w-full items-center justify-center overflow-hidden">
        <div
          ref={wrapperRef}
          className="no-scrollbar relative h-full w-full max-w-4xl overflow-y-auto"
          style={{ WebkitMaskImage: mask, maskImage: mask }}
        >
          {sheet.lines.length ? (
            <div ref={rowsRef} className="space-y-2">
              {sheet.lines.map((line, index) => {
                const active = index === activeIndex;
                return (
                  <div
                    key={`${line.time}-${index}`}
                    className={clsx(
                      "w-full transform-none py-2 transition-all duration-300 ease-out",
                      centered ? "text-center" : "text-left",
                      active ? "opacity-100" : "opacity-60",
                    )}
                    style={{ fontSize: active ? fontSize * 1.5 : fontSize, transform: "none" }}
                  >
                    <div
                      className={clsx(
                        "leading-snug break-words whitespace-pre-wrap",
                        active ? "font-extrabold text-white drop-shadow-[0_4px_24px_rgba(0,0,0,0.35)]" : "font-normal",
                      )}
                      style={{ color: color || undefined }}
                    >
                      {active && line.words?.length ? <ActiveWords words={line.words} offset={offset} /> : line.text}
                    </div>
                    {line.translation && (
                      <div className="mt-1 text-sm break-words whitespace-pre-wrap text-white/80">
                        {line.translation}
                      </div>
                    )}
                    {line.romanization && (
                      <div className="mt-1 text-sm break-words whitespace-pre-wrap text-white/70">
                        {line.romanization}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : sheet.plain ? (
            <div className="py-20 leading-relaxed break-words whitespace-pre-wrap" style={{ color, fontSize }}>
              {sheet.plain}
              {sheet.plainTranslation && <div className="mt-2 text-sm text-white/80">{sheet.plainTranslation}</div>}
              {sheet.plainRomanization && <div className="mt-2 text-sm text-white/70">{sheet.plainRomanization}</div>}
            </div>
          ) : (
            <div className="text-foreground/70 flex h-full items-center justify-center">
              {isLoading ? "歌词加载中..." : "暂无歌词"}
            </div>
          )}
        </div>
        {showControls && cache && (
          <div className="text-foreground/80 pointer-events-none absolute right-6 bottom-6 flex flex-col items-center space-y-3 text-sm transition-opacity duration-200">
            <div className="pointer-events-auto">
              <FontSizeControl
                value={fontSize}
                onChange={v => setCache(prev => ({ ...prev, fontSize: v }))}
                onCommit={v => void commit({ type: "preferences", fontSize: v })}
              />
            </div>
            <div className="pointer-events-auto">
              <OffsetControl
                value={offset}
                onChange={v => setCache(prev => ({ ...prev, offset: v }))}
                onCommit={v => void commit({ type: "preferences", offset: v })}
              />
            </div>
            {source !== "webdav" && (
              <div className="pointer-events-auto">
                <IconButton
                  aria-label="搜索歌词"
                  title="搜索歌词"
                  onPress={() => setSearchOpen(true)}
                  className="bg-foreground/20 text-foreground hover:bg-foreground/30 min-w-0 rounded-full text-xs font-semibold"
                >
                  <RiTBoxLine size={16} />
                </IconButton>
              </div>
            )}
          </div>
        )}
      </div>
      {searchOpen && (
        <Suspense fallback={null}>
          <SearchModal
            title={title}
            onClose={() => setSearchOpen(false)}
            onAdopt={next => commit({ type: "adopt", text: next })}
          />
        </Suspense>
      )}
    </>
  );
}
