import { getContrast } from "color2k";
import { expect, it, vi } from "vitest";

import { resolvePrimaryColor, Themes } from "@/common/constants/theme";
import { defaultAppSettings } from "@shared/settings/app-settings";

it("uses the brand color in the dark theme and keeps both accents readable", () => {
  expect(resolvePrimaryColor("dark", defaultAppSettings.primaryColor)).toBe("#1088FF");
  for (const theme of ["light", "dark"] as const) {
    const accent = resolvePrimaryColor(theme, defaultAppSettings.primaryColor);
    const { background, primary } = Themes[theme].colors;
    expect(getContrast(accent, background)).toBeGreaterThan(4.5);
    expect(getContrast(accent, primary.foreground)).toBeGreaterThan(4.5);
  }
});

it("migrates both former defaults while retaining customized theme colors", async () => {
  const getStore = vi.fn();
  vi.stubGlobal("electron", { getStore });
  try {
    const { useSettings } = await import("@/store/settings");
    for (const primaryColor of ["#1ED760", "#002Fa7"]) {
      getStore.mockResolvedValue({ appSettings: { primaryColor, themeMode: "dark" } });
      await useSettings.persist.rehydrate();
      expect(useSettings.getState()).toMatchObject({ primaryColor: "#1088FF", themeMode: "dark" });
    }

    getStore.mockResolvedValue({ appSettings: { primaryColor: "#D04362", themeMode: "dark" } });
    await useSettings.persist.rehydrate();
    expect(resolvePrimaryColor("dark", useSettings.getState().primaryColor)).toBe("#D04362");
  } finally {
    vi.unstubAllGlobals();
  }
});
