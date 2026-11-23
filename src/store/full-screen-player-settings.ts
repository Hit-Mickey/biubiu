import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface FullScreenPlayerSettingsState {
  showLyrics: boolean;
  splitBilingual?: boolean;
  showSpectrum: boolean;
  showCover: boolean;
  showBlurredBackground: boolean;
  backgroundColor?: string;
  spectrumColor?: string;
  lyricsColor?: string;
}

interface Actions {
  update: (patch: Partial<FullScreenPlayerSettingsState>) => void;
  reset: () => void;
}

const defaultSettings: FullScreenPlayerSettingsState = {
  showLyrics: true,
  showSpectrum: false,
  showCover: true,
  showBlurredBackground: true,
  backgroundColor: undefined,
  spectrumColor: "currentColor",
  lyricsColor: "#ffffff",
};

export const useFullScreenPlayerSettings = create<FullScreenPlayerSettingsState & Actions>()(
  persist(
    set => ({
      ...defaultSettings,
      update: patch => set(patch),
      reset: () => set({ ...defaultSettings, splitBilingual: true }),
    }),
    {
      name: "full-screen-player-settings",
      partialize: state => ({
        showLyrics: state.showLyrics,
        splitBilingual: state.splitBilingual,
        showSpectrum: state.showSpectrum,
        showCover: state.showCover,
        showBlurredBackground: state.showBlurredBackground,
        backgroundColor: state.backgroundColor,
        spectrumColor: state.spectrumColor,
        lyricsColor: state.lyricsColor,
      }),
    },
  ),
);
