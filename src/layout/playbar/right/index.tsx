import { lazy, Suspense } from "react";

import MusicPlayMode from "@/components/music-play-mode";
import MusicRate from "@/components/music-rate";
import MusicVolume from "@/components/music-volume";
import OpenPlaylistDrawerButton from "@/components/open-playlist-drawer-button";
import { isBilibiliSource, usePlayList } from "@/store/play-list";

const MusicDownloadButton = lazy(() => import("@/components/music-download-button"));

const RightControl = () => {
  const playId = usePlayList(s => s.playId);
  const getPlayItem = usePlayList(s => s.getPlayItem);

  return (
    <div className="flex h-full items-center justify-end space-x-2">
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
