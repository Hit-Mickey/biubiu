import { useEffect, useState } from "react";

import { usePlayList } from "@/store/play-list";

import { lastStarted } from "./timeline";

/** Only the active line owns spans and a boundary timer. Use the existing media clock
 * (not elapsed wall time) so pause, rate changes, buffering and seeking stay in sync. */
export default function ActiveWords({ words, offset }: { words: LyricWord[]; offset: number }) {
  const [cursor, setCursor] = useState(-2);
  useEffect(() => {
    const media = usePlayList.getState().getAudio();
    let timer: number | undefined;
    const sync = () => {
      window.clearTimeout(timer);
      if (document.hidden) return;
      const ms = media.currentTime * 1000 + offset;
      const i = lastStarted(words, ms);
      const end = words[i]?.end ?? Infinity;
      const finished = ms >= end;
      setCursor(i * 2 + Number(finished));
      const next = Math.min(words[i + 1]?.time ?? Infinity, finished ? Infinity : end);
      if (!media.paused && !media.seeking && media.playbackRate > 0 && Number.isFinite(next)) {
        timer = window.setTimeout(sync, Math.max(16, Math.ceil((next - ms) / media.playbackRate)));
      }
    };
    const events = ["timeupdate", "playing", "pause", "seeked", "ratechange"];
    events.forEach(event => media.addEventListener(event, sync));
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      window.clearTimeout(timer);
      events.forEach(event => media.removeEventListener(event, sync));
      document.removeEventListener("visibilitychange", sync);
    };
  }, [offset, words]);

  return words.map((word, i) => (
    <span
      key={`${word.time}-${i}`}
      className={
        i * 2 > cursor ? "opacity-45" : i * 2 === cursor ? "underline decoration-1 underline-offset-4" : undefined
      }
    >
      {word.text}
    </span>
  ));
}
