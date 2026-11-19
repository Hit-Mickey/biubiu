import { lazy, Suspense } from "react";

import DesktopLyricsButton from "@/components/desktop-lyrics-button";
import MusicPlayMode from "@/components/music-play-mode";
import MusicRate from "@/components/music-rate";
import MusicVolume from "@/components/music-volume";
import OpenPlaylistDrawerButton from "@/components/open-playlist-drawer-button";
import PlaybackLinesButton from "@/components/playback-lines-button";
import SleepTimer from "@/components/sleep-timer";
import { isBilibiliSource, usePlayList } from "@/store/play-list";

const MusicDownloadButton = lazy(() => import("@/components/music-download-button"));

const RightControl = () => {
  const playId = usePlayList(s => s.playId);
  const getPlayItem = usePlayList(s => s.getPlayItem);

  return (
    <div className="flex h-full items-center justify-end space-x-2">
      <DesktopLyricsButton />
      <PlaybackLinesButton />
      <SleepTimer />
      <MusicPlayMode />
      {Boolean(playId) && isBilibiliSource(getPlayItem()?.source) && (
        <Suspense fallback={null}>
          <MusicDownloadButton />
        </Suspense>
      )}
      <OpenPlaylistDrawerButton />
      <MusicVolume />
      <MusicRate />
    </div>
  );
};

export default RightControl;
