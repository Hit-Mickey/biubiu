import { useEffect } from "react";

import { usePlayProgress } from "@/store/play-progress";

import type { TrackLyrics } from "./use-track-lyrics";

import { activeLineAt } from "./timeline";

function firstLine(value: string) {
  return value.trim().split("\n", 1)[0];
}

export default function DesktopLyricsOutput({ lyrics }: { lyrics: TrackLyrics }) {
  const { lines, plain, plainTranslation, plainRomanization } = lyrics.getSheet();
  const index = usePlayProgress(s => activeLineAt(lines, s.currentTime * 1000 + lyrics.offset));
  const line = lines[index];
  const text = line?.text || firstLine(plain) || (lyrics.isLoading ? "歌词加载中…" : lines.length ? "" : "暂无歌词");
  const translation = line?.translation ?? firstLine(plainTranslation);
  const romanization = line?.romanization ?? firstLine(plainRomanization);

  useEffect(() => {
    window.electron.showDesktopLyricLine({ text, translation, romanization });
  }, [text, translation, romanization]);

  return null;
}
