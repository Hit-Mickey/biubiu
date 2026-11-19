import { addToast } from "@heroui/react";

import type { PlayMode } from "@/common/constants/audio";

export type MiniPlayerCommand =
  | "init"
  | "seek"
  | "togglePlayMode"
  | "next"
  | "prev"
  | "togglePlay"
  | "volumeUp"
  | "volumeDown";

export interface MiniPlayerMessageFromMini {
  from: "mini";
  data: { type: MiniPlayerCommand; state?: { currentTime?: number } };
  ts: number;
}

export interface MiniPlayerState {
  isSingle: boolean;
  isPlaying: boolean;
  title?: string;
  cover?: string;
  currentTime: number;
  duration: number;
  playMode?: PlayMode;
  playId?: string;
}

export interface MiniPlayerMessageFromMain {
  from: "main";
  state: MiniPlayerState;
  ts: number;
}

export function createBroadcastChannel() {
  return new BroadcastChannel("play-list-store-sync-channel");
}

export async function toggleMiniWindow() {
  try {
    await window.electron.toggleMiniPlayer();
    return true;
  } catch {
    addToast({ title: "切换出错", color: "danger" });
    return false;
  }
}
