import { lazy, Suspense, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";

import { RiTBoxLine } from "@remixicon/react";
import clsx from "classnames";

import type { PlayData } from "@/store/play-list";

import { usePlayList } from "@/store/play-list";
import { usePlayProgress } from "@/store/play-progress";

import type { DisplayLyricLine } from "./line-layout";
import type { TrackLyrics } from "./use-track-lyrics";

import IconButton from "../icon-button";
import ActiveWords from "./active-words";
import { useSplitBilingual } from "./bilingual-preference";
import FontSizeControl from "./font-size-control";
import { displayLyricLine, plainLyricText, translationSuffix } from "./line-layout";
import OffsetControl from "./offset-control";
import { observeLyricScroll } from "./scroll";
import { activeLineAt } from "./timeline";

const SearchModal = lazy(() => import("../lyrics-search-modal"));
const emptySheet = { lines: [], plain: "", plainTranslation: "", plainRomanization: "" };
const mask =
  "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.15) 6%, rgba(0,0,0,0.5) 12%, black 24%, black 76%, rgba(0,0,0,0.5) 88%, rgba(0,0,0,0.15) 94%, transparent 100%)";

interface Props {
  item: PlayData;
  lyrics: TrackLyrics;
  color?: string;
  centered?: boolean;
  showControls?: boolean;
  deferRendering?: boolean;
  extraControls?: ReactNode;
}

function LyricRow({ active, children, className, ...props }: ComponentProps<"div"> & { active: boolean }) {
  return (
    <div
      {...props}
      className={clsx("leading-snug break-words whitespace-pre-wrap", active && "lyric-viewport", className)}
    >
      {active ? <div className="lyric-strip">{children}</div> : children}
    </div>
  );
}

/** FullScreenPlayer keys this component by song and unmounts it when lyrics are hidden. */
export default function Lyrics({ item, lyrics, color, centered, showControls, deferRendering, extraControls }: Props) {
  const { hasCache, getSheet, offset, fontSize, isLoading } = lyrics;
  const [searchOpen, setSearchOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const sheet = deferRendering ? emptySheet : getSheet();
  const split = useSplitBilingual();
  const lines = useMemo<DisplayLyricLine[]>(
    () => (split ? sheet.lines.map(line => displayLyricLine(line, true)) : sheet.lines),
    [sheet.lines, split],
  );
  const plain = useMemo(() => {
    if (!sheet.plainTranslation) return plainLyricText(sheet.plain, split);
    const originals = sheet.plain.split("\n");
    const translations = sheet.plainTranslation.split("\n");
    if (originals.length !== translations.length)
      return (
        <>
          {sheet.plain}
          <div className="mt-2 text-white/80">{sheet.plainTranslation}</div>
        </>
      );
    return originals.map((text, i) => (
      <div key={i} className="min-h-[1lh]">
        {text}
        {translations[i] && (
          <span className={clsx("text-white/80", split && "block")}>
            {split ? translations[i] : translationSuffix(text, translations[i])}
          </span>
        )}
      </div>
    ));
  }, [sheet.plain, sheet.plainTranslation, split]);
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
    observer.observe(row);
    return () => observer.disconnect();
  }, [activeIndex, lines, fontSize]);

  useLayoutEffect(() => {
    const row = rowsRef.current?.children[activeIndex] as HTMLElement | undefined;
    const line = lines[activeIndex];
    if (!row || !line) return;
    const scroller = observeLyricScroll(row);
    const media = usePlayList.getState().getAudio();
    const end = line.end ?? lines[activeIndex + 1]?.time;
    const sync = () =>
      scroller.update(
        media.currentTime * 1000 + offset - line.time,
        end === undefined ? undefined : end - line.time,
        !media.paused && !media.seeking,
        media.playbackRate,
      );
    const events = ["timeupdate", "playing", "pause", "seeked", "ratechange"];
    events.forEach(event => media.addEventListener(event, sync));
    sync();
    return () => {
      events.forEach(event => media.removeEventListener(event, sync));
      scroller.disconnect();
    };
  }, [activeIndex, lines, offset]);

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
              {lines.map((line, index) => {
                const active = index === activeIndex;
                return (
                  <div
                    key={`${line.time}-${index}`}
                    className={clsx(
                      "w-full transform-none py-2 transition-all duration-300 ease-out",
                      centered ? "text-center" : "text-left",
                      active ? "font-extrabold opacity-100" : "font-normal opacity-60",
                    )}
                    style={{ fontSize: active ? fontSize * 1.5 : fontSize, transform: "none" }}
                  >
                    <LyricRow
                      active={active}
                      className={active ? "text-white drop-shadow-[0_4px_24px_rgba(0,0,0,0.35)]" : undefined}
                      style={{ color: color || undefined }}
                    >
                      {active && line.words?.length ? <ActiveWords words={line.words} offset={offset} /> : line.text}
                      {!split && translationSuffix(line.text, line.translation)}
                    </LyricRow>
                    {split && line.translation && (
                      <LyricRow active={active} className="mt-1 text-white/80">
                        {active && line.translationWords?.length ? (
                          <ActiveWords words={line.translationWords} offset={offset} />
                        ) : (
                          line.translation
                        )}
                      </LyricRow>
                    )}
                    {line.romanization && (
                      <LyricRow active={active} className="mt-1 text-white/70">
                        {line.romanization}
                      </LyricRow>
                    )}
                  </div>
                );
              })}
            </div>
          ) : sheet.plain ? (
            <div className="py-20 leading-relaxed break-words whitespace-pre-wrap" style={{ color, fontSize }}>
              {plain}
              {sheet.plainRomanization && <div className="mt-2 text-white/70">{sheet.plainRomanization}</div>}
            </div>
          ) : (
            <div className="text-foreground/70 flex h-full items-center justify-center">
              {isLoading ? "歌词加载中..." : "暂无歌词"}
            </div>
          )}
        </div>
        {showControls && (
          <div className="text-foreground/80 pointer-events-none absolute right-6 bottom-6 flex flex-col items-center space-y-3 text-sm transition-opacity duration-200">
            {hasCache && (
              <>
                <div className="pointer-events-auto">
                  <FontSizeControl
                    value={fontSize}
                    onChange={v => lyrics.preview({ fontSize: v })}
                    onCommit={v => void lyrics.commit({ type: "preferences", fontSize: v })}
                  />
                </div>
                <div className="pointer-events-auto">
                  <OffsetControl
                    value={offset}
                    onChange={v => lyrics.preview({ offset: v })}
                    onCommit={v => void lyrics.commit({ type: "preferences", offset: v })}
                  />
                </div>
                {item.source !== "webdav" && (
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
              </>
            )}
            {extraControls}
          </div>
        )}
      </div>
      {searchOpen && (
        <Suspense fallback={null}>
          <SearchModal
            title={title}
            onClose={() => setSearchOpen(false)}
            onAdopt={async next => {
              const adopted = await lyrics.commit({ type: "adopt", text: next });
              if (adopted) setSearchOpen(false);
              return adopted;
            }}
          />
        </Suspense>
      )}
    </>
  );
}
