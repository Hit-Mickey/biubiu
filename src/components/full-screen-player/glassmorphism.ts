import { useEffect, useMemo, useState } from "react";

export type Rgb = { r: number; g: number; b: number };

export interface BlurredCover {
  src: string;
  canvas: HTMLCanvasElement;
  color?: Rgb;
}

interface Covers {
  current?: BlurredCover;
  previous?: BlurredCover;
}

const maxCoverSize = 480;
const fallbackColor = { r: 30, g: 215, b: 96 };
const emptyCovers: Covers = {};

function getRelativeLuminance({ r, g, b }: Rgb) {
  const linear = (component: number) => {
    const v = component / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function normalizeGlowColor(rgb: Rgb): Rgb {
  const l = getRelativeLuminance(rgb);
  const strength = l < 0.22 ? ((0.22 - l) / 0.22) * 0.55 : l > 0.88 ? ((l - 0.88) / 0.12) * 0.45 : 0;
  if (!strength) return rgb;
  const target = l < 0.22 ? 255 : 0;
  const mix = (v: number) => Math.round(v + (target - v) * strength);
  return { r: mix(rgb.r), g: mix(rgb.g), b: mix(rgb.b) };
}

function hexToRgb(hex: string): Rgb | undefined {
  const match = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(hex.trim());
  if (!match) return;
  let value = match[1];
  if (value.length === 3) value = value.replace(/./g, digit => digit + digit);
  const rgb = parseInt(value, 16);
  return { r: rgb >> 16, g: (rgb >> 8) & 255, b: rgb & 255 };
}

function coverColor(image: HTMLImageElement): Rgb | undefined {
  const ctx = new OffscreenCanvas(32, 32).getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  ctx.drawImage(image, 0, 0, 32, 32);
  const { data } = ctx.getImageData(0, 0, 32, 32);
  const average = (skipExtremes: boolean) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 180) continue;
      const lum = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
      if (skipExtremes && (lum < 0.06 || lum > 0.96)) continue;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      count++;
    }
    if (count)
      return normalizeGlowColor({ r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) });
  };
  return average(true) ?? average(false);
}

async function prepareCover(src: string, blurPx: number, signal: AbortSignal): Promise<BlurredCover | undefined> {
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  const cancel = () => image.removeAttribute("src");
  signal.addEventListener("abort", cancel, { once: true });
  try {
    image.src = src;
    let color: Rgb | undefined;
    try {
      await image.decode();
      color = coverColor(image);
    } catch {
      signal.throwIfAborted();
      // Covers without CORS headers can still be displayed without sampling their color.
      image.removeAttribute("crossorigin");
      image.src = src;
      await image.decode();
    }
    signal.throwIfAborted();
    const { naturalWidth, naturalHeight } = image;
    const scale = Math.min(1, maxCoverSize / Math.max(naturalWidth, naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(naturalHeight * scale));
    const surface = new OffscreenCanvas(canvas.width, canvas.height);
    const ctx = surface.getContext("2d", { willReadFrequently: true });
    const target = canvas.getContext("bitmaprenderer");
    if (!ctx || !target) return;
    // Rasterize the blur once at a bounded size. CSS only scales the resulting bitmap.
    const fittedScale = Math.max(window.innerWidth / canvas.width, window.innerHeight / canvas.height);
    ctx.filter = `blur(${blurPx / fittedScale}px)`;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    target.transferFromImageBitmap(surface.transferToImageBitmap());
    return { src, canvas, color };
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function getEffectsProfile() {
  const memory = navigator.deviceMemory ?? 0;
  const cores = navigator.hardwareConcurrency;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const lowEnd = (memory > 0 && memory <= 4) || (cores > 0 && cores <= 4);
  return { blurPx: lowEnd || reduceMotion ? 8 : 12, transitionMs: reduceMotion ? 0 : 700 };
}

export function buildGradientBackground(rgb: Rgb) {
  const color = `${rgb.r} ${rgb.g} ${rgb.b}`;
  const overlayAlpha = getRelativeLuminance(rgb) > 0.7 ? 0.62 : 0.72;
  return `radial-gradient(1100px circle at 50% 18%, rgb(${color} / 0.42), transparent 62%),
radial-gradient(900px circle at 14% 86%, rgb(${color} / 0.22), transparent 58%),
radial-gradient(900px circle at 86% 92%, rgb(${color} / 0.16), transparent 60%),
rgb(0 0 0 / ${overlayAlpha})`;
}

export function useGlassmorphism(coverSrc: string | undefined, fallbackHex: string, enabled: boolean) {
  const [covers, setCovers] = useState<Covers>(emptyCovers);
  const { blurPx, transitionMs } = useMemo(getEffectsProfile, []);
  const fallback = useMemo(() => normalizeGlowColor(hexToRgb(fallbackHex) ?? fallbackColor), [fallbackHex]);

  useEffect(() => {
    if (!enabled) {
      setCovers(emptyCovers);
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;
    const showCover = (current?: BlurredCover) => {
      if (signal.aborted) return;
      setCovers(covers => {
        if (covers.current?.src === current?.src) return covers;
        return { current, previous: transitionMs ? covers.current : undefined };
      });
    };
    if (!coverSrc) {
      showCover();
      return;
    }
    void prepareCover(coverSrc, blurPx, signal).then(showCover, () => showCover());
    return () => controller.abort();
  }, [coverSrc, blurPx, enabled, transitionMs]);

  useEffect(() => {
    const previous = covers.previous;
    if (!previous) return;
    const timeout = window.setTimeout(() => {
      setCovers(covers => (covers.previous === previous ? { current: covers.current } : covers));
    }, transitionMs);
    return () => window.clearTimeout(timeout);
  }, [covers.previous, transitionMs]);

  return { covers, fallback, transitionMs, glow: covers.current?.color ?? fallback };
}
