import { useCallback } from "react";

import { buildGradientBackground, type BlurredCover, type Rgb } from "./glassmorphism";

function CoverLayer({
  cover,
  visible,
  fallback,
  transitionMs,
}: {
  cover: BlurredCover;
  visible: boolean;
  fallback: Rgb;
  transitionMs: number;
}) {
  const attachCanvas = useCallback(
    (node: HTMLDivElement | null) => {
      node?.replaceChildren(cover.canvas);
    },
    [cover.canvas],
  );

  return (
    <div
      className={visible ? "absolute inset-0 starting:opacity-0" : "absolute inset-0 opacity-0"}
      style={{ transition: `opacity ${transitionMs}ms ease` }}
    >
      <div
        ref={attachCanvas}
        className="absolute inset-0 scale-[1.15] opacity-[0.92] [&>canvas]:size-full [&>canvas]:object-cover"
      />
      <div className="absolute inset-0" style={{ background: buildGradientBackground(cover.color ?? fallback) }} />
    </div>
  );
}

export default function GlassBackground({
  current,
  previous,
  fallback,
  transitionMs,
}: {
  current?: BlurredCover;
  previous?: BlurredCover;
  fallback: Rgb;
  transitionMs: number;
}) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      style={{ background: buildGradientBackground(fallback) }}
    >
      {[previous, current].map(
        cover =>
          cover && (
            <CoverLayer
              key={cover.src}
              cover={cover}
              visible={cover === current}
              fallback={fallback}
              transitionMs={transitionMs}
            />
          ),
      )}
    </div>
  );
}
