import type { ConfigThemes } from "@heroui/react";

import { defaultAppSettings } from "../../../shared/settings/app-settings";
import { isHex } from "../utils/color";

const brandColor = defaultAppSettings.primaryColor;
const lightAccent = "#0069CE";

export const Themes = {
  dark: {
    extend: "dark",
    colors: {
      background: "#17181a",
      primary: { DEFAULT: brandColor, foreground: "#000000" },
      focus: brandColor,
    },
  },
  light: {
    extend: "light",
    colors: {
      background: "#ffffff",
      primary: { DEFAULT: lightAccent, foreground: "#ffffff" },
      focus: lightAccent,
    },
  },
} satisfies ConfigThemes;

export function resolvePrimaryColor(theme: keyof typeof Themes, preference?: string) {
  const custom =
    typeof preference === "string" && isHex(preference) && preference.toLowerCase() !== brandColor.toLowerCase();
  return custom ? preference : Themes[theme].colors.primary.DEFAULT;
}
