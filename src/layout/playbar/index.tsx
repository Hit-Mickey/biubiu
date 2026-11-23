import { lazy, Suspense, useEffect } from "react";

import { Card } from "@heroui/react";

import MusicPlayControl from "@/components/music-play-control";
import MusicPlayMode from "@/components/music-play-mode";
import MusicPlayProgress from "@/components/music-play-progress";
import MusicRate from "@/components/music-rate";
import MusicVolume from "@/components/music-volume";
import OpenPlaylistDrawerButton from "@/components/open-playlist-drawer-button";
import PlaybackLinesButton from "@/components/playback-lines-button";
import SleepTimer from "@/components/sleep-timer";
import { usePlayList } from "@/store/play-list";

import Center from "./center";
import Right, { CurrentDownload } from "./right";

const Left = lazy(() => import("./left"));

/**
 * 播放任务栏
 */
function PlayBar() {
  const empty = usePlayList(s => s.list.length === 0);
  const playId = usePlayList(s => s.playId);
  const init = usePlayList(s => s.init);

  useEffect(() => {
    init();
  }, [init]);

  const song = playId ? (
    <Suspense fallback={null}>
      <Left />
    </Suspense>
  ) : null;
  if (window.electron.getPlatform() === "android") {
    return (
      <Card radius="none" shadow="sm" className="phone-playbar bg-background h-full">
        {song && (
          <div className="phone-song">
            <div className="min-w-0 flex-1">{song}</div>
            <CurrentDownload />
          </div>
        )}
        <div className="phone-controls">
          <div className="phone-tools">
            <PlaybackLinesButton />
            <SleepTimer />
            <MusicPlayMode />
          </div>
          <MusicPlayControl />
          <div className="phone-tools">
            <OpenPlaylistDrawerButton />
            <MusicVolume />
            <MusicRate />
          </div>
        </div>
        <MusicPlayProgress className="phone-progress" isDisabled={empty} />
      </Card>
    );
  }
  return (
    <Card
      radius="none"
      shadow="sm"
      className="bg-background grid h-full grid-cols-[minmax(0,1fr)_minmax(0,3fr)_minmax(max-content,1fr)] px-4"
    >
      <div className="h-full">{song}</div>
      <Center />
      <Right />
    </Card>
  );
}

export default PlayBar;
