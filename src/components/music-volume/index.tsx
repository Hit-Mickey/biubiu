import { setPlaybackVolume, stepPlaybackVolume, togglePlaybackMute } from "@/common/utils/playback-volume";
import { usePlayList } from "@/store/play-list";

import VolumeControl from "./control";

export default function MusicVolume({ portalContainer }: { portalContainer?: HTMLElement }) {
  const volume = usePlayList(s => (s.isMuted ? 0 : s.volume));
  return (
    <VolumeControl
      volume={volume}
      onChange={setPlaybackVolume}
      onStep={stepPlaybackVolume}
      onMute={togglePlaybackMute}
      portalContainer={portalContainer}
    />
  );
}
