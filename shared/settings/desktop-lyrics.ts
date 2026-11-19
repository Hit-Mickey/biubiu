export const desktopLyricsFontSizes = [16, 20, 23, 26, 30, 36, 42];

export const defaultDesktopLyricsAppearance: DesktopLyricsAppearance = {
  color: "#ffffff",
  fontSize: 26,
};

export function normalizeDesktopLyricsAppearance(
  patch?: Partial<DesktopLyricsAppearance>,
  fallback = defaultDesktopLyricsAppearance,
): DesktopLyricsAppearance {
  const color = patch?.color;
  const fontSize = patch?.fontSize;
  return {
    color: typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : fallback.color,
    fontSize: typeof fontSize === "number" && desktopLyricsFontSizes.includes(fontSize) ? fontSize : fallback.fontSize,
  };
}
