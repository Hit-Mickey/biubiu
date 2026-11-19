import { usePlayList } from "@/store/play-list";

let previousVolume = 0.5;

export function setPlaybackVolume(value: number) {
  if (!Number.isFinite(value)) return;
  const next = Math.max(0, Math.min(1, value));
  const { volume, isMuted, setVolume, toggleMute } = usePlayList.getState();
  if (next === 0 && volume > 0) previousVolume = volume;
  if (volume !== next) setVolume(next);
  if (isMuted !== (next === 0)) toggleMute();
}

export function togglePlaybackMute() {
  const { volume, isMuted } = usePlayList.getState();
  setPlaybackVolume(isMuted || volume === 0 ? volume || previousVolume : 0);
}

export function stepPlaybackVolume(delta: number) {
  const { volume, isMuted } = usePlayList.getState();
  const next = Math.round(((isMuted ? 0 : volume) + delta) * 100) / 100;
  setPlaybackVolume(next);
}
