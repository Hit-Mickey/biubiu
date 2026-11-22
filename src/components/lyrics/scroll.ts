import "./scroll.css";

/** Only the displayed cue owns animations. The media clock also drives pause, seek and rate changes. */
export function observeLyricScroll(row: HTMLElement) {
  const strips = Array.from(row.querySelectorAll<HTMLElement>(".lyric-strip"), element => ({
    element,
    viewport: element.parentElement!,
    overflow: 0,
    animation: undefined as Animation | undefined,
    duration: 0,
  }));
  let elapsed: number | undefined;
  let available: number | undefined;
  let playing = false;
  let rate = 1;

  function sync() {
    if (elapsed === undefined) return;
    for (const strip of strips) {
      if (!strip.overflow) continue;
      const natural = 1200 + (strip.overflow / 55) * 1000;
      const duration = available === undefined ? natural : Math.max(1, Math.min(available, natural));
      const hold = Math.min(600 / duration, 0.18);
      const position = Math.max(0, available === undefined ? elapsed % duration : Math.min(elapsed, duration));
      if (strip.duration !== duration) {
        strip.animation?.cancel();
        strip.duration = duration;
        const end = "translateX(-" + strip.overflow + "px)";
        strip.animation = strip.element.animate?.(
          [
            { transform: "translateX(0)", offset: 0 },
            { transform: "translateX(0)", offset: hold },
            { transform: end, offset: 1 - hold },
            { transform: end, offset: 1 },
          ],
          { duration, fill: "both" },
        );
      }
      const animation = strip.animation;
      if (!animation) {
        const fraction = Math.max(0, Math.min(1, (position / duration - hold) / (1 - 2 * hold)));
        strip.viewport.scrollLeft = strip.overflow * fraction;
        continue;
      }
      const run = playing && elapsed >= 0 && position < duration;
      if (animation.playbackRate !== rate) animation.playbackRate = rate;
      if (!run && animation.playState !== "paused") animation.pause();
      if (!run || animation.playState !== "running" || Math.abs(Number(animation.currentTime) - position) > 100)
        animation.currentTime = position;
      if (run && animation.playState !== "running") animation.play();
    }
  }

  function measure() {
    for (const strip of strips) {
      const overflow = Math.max(0, strip.element.offsetWidth - strip.viewport.clientWidth);
      if (strip.overflow === overflow) continue;
      strip.animation?.cancel();
      strip.animation = undefined;
      strip.duration = 0;
      strip.overflow = overflow;
      strip.viewport.scrollLeft = 0;
    }
    sync();
  }

  const observer = new ResizeObserver(measure);
  for (const strip of strips) {
    observer.observe(strip.viewport);
    observer.observe(strip.element);
  }
  measure();
  return {
    update(timeInLine: number, lineDuration: number | undefined, isPlaying: boolean, playbackRate: number) {
      elapsed = timeInLine;
      available = lineDuration;
      playing = isPlaying;
      rate = playbackRate;
      sync();
    },
    disconnect() {
      observer.disconnect();
      for (const strip of strips) {
        strip.animation?.cancel();
        strip.viewport.scrollLeft = 0;
      }
    },
  };
}
