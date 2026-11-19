import { create } from "zustand";

import type { MiniPlayerState } from "@/common/utils/mini-player-channel";

type State = Omit<MiniPlayerState, "currentTime" | "playId">;

interface Action {
  update: (state: State) => void;
}

export const usePlayState = create<State & Action>(set => ({
  isPlaying: false,
  isSingle: false,
  duration: 0,
  volume: 0.5,
  update: state => set(state),
}));
