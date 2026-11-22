import { memo, useCallback, useEffect, useMemo, useRef } from "react";

import { Button, Slider } from "@heroui/react";
import {
  RiExpandDiagonalLine,
  RiPauseCircleFill,
  RiPlayCircleFill,
  RiSkipBackFill,
  RiSkipForwardFill,
} from "@remixicon/react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import clx from "classnames";
import { useShallow } from "zustand/react/shallow";

import type { NativeAudioStateSnapshot } from "@/bridge/native-audio";

import { isTauriRuntime } from "@/bridge/env";
import { getPlayModeList } from "@/common/constants/audio";
import {
  createBroadcastChannel,
  toggleMiniWindow,
  type MiniPlayerCommand,
  type MiniPlayerMessageFromMain,
  type MiniPlayerMessageFromMini,
} from "@/common/utils/mini-player-channel";
import { listenForAppShortcuts } from "@/common/utils/shortcut";
import DesktopLyricsButton from "@/components/desktop-lyrics-button";
import Image from "@/components/image";
import VolumeControl from "@/components/music-volume/control";
import { toggleDesktopLyrics, useDesktopLyrics } from "@/store/desktop-lyrics";
import { usePlayProgress } from "@/store/play-progress";

import { usePlayState } from "./play-state";
import { useStyle } from "./use-style";

const PlayModeList = getPlayModeList(16);

const CoverView = memo(() => {
  const cover = usePlayState(s => s.cover);
  if (!cover) return null;
  return (
    <div className="relative h-full w-[100px] flex-shrink-0">
      <Image
        removeWrapper
        radius="none"
        src={cover}
        width={100}
        height="100%"
        params="672w_378h_1c.avif"
        loading="eager"
        decoding="async"
        style={{ transform: "translateZ(0)", backfaceVisibility: "hidden", willChange: "transform", contain: "paint" }}
      />
      <div className="from-background pointer-events-none absolute inset-y-0 right-0 z-10 w-12 bg-gradient-to-l to-transparent" />
    </div>
  );
});

type PostCommand = (type: MiniPlayerCommand, state?: MiniPlayerMessageFromMini["data"]["state"]) => void;

const MiniVolume = memo(function MiniVolume({ post }: { post: PostCommand }) {
  const volume = usePlayState(s => s.volume);
  return (
    <VolumeControl
      compact
      volume={volume}
      onChange={volume => post("setVolume", { volume })}
      onStep={volumeDelta => post("adjustVolume", { volumeDelta })}
      onMute={() => post("toggleMute")}
    />
  );
});

const MiniPlayer = () => {
  const { isSingle, isPlaying, title, duration, playMode } = usePlayState(
    useShallow(state => ({
      isSingle: state.isSingle,
      isPlaying: state.isPlaying,
      title: state.title,
      duration: state.duration,
      playMode: state.playMode,
    })),
  );
  const currentTime = usePlayProgress(s => s.currentTime);
  const setCurrentTime = usePlayProgress(s => s.setCurrentTime);
  const updatePlayState = usePlayState(state => state.update);
  const bcRef = useRef<BroadcastChannel>(null);

  const postMessage = useCallback<PostCommand>((type, state) => {
    if (isTauriRuntime()) {
      void invoke("mini_player_command", { command: type, state: state ?? null }).catch(() => undefined);
      return;
    }
    if (!bcRef.current) return;
    bcRef.current.postMessage({
      from: "mini",
      data: {
        type,
        state,
      },
      ts: Date.now(),
    });
  }, []);

  useStyle();

  useEffect(() => window.electron.onDesktopLyricsState(useDesktopLyrics.setState), []);

  const playModeIcon = useMemo(() => {
    return PlayModeList.find(item => item.value === playMode)?.icon;
  }, [playMode]);

  useEffect(() => {
    const removeShortcuts = listenForAppShortcuts(command => {
      if (command === "toggleMiniMode") void toggleMiniWindow();
      else if (command === "toggleLyrics") void toggleDesktopLyrics();
      else postMessage(command);
    });

    if (isTauriRuntime()) {
      let active = true;
      const unlisteners: UnlistenFn[] = [];

      const applySnapshot = (snap: NativeAudioStateSnapshot | null | undefined) => {
        if (!active || !snap) return;
        updatePlayState({
          isSingle: Boolean(snap.isSingle),
          isPlaying: snap.isPlaying,
          title: snap.title,
          cover: snap.cover,
          duration: Number(snap.duration ?? 0),
          volume: snap.muted ? 0 : snap.volume,
          playMode: snap.playMode,
        });
        if (typeof snap.currentTime === "number") {
          setCurrentTime(snap.currentTime);
        }
      };

      void invoke<NativeAudioStateSnapshot>("mini_player_get_state")
        .then(applySnapshot)
        .catch(() => undefined);

      void listen<NativeAudioStateSnapshot>("audio://state", event => applySnapshot(event.payload)).then(fn => {
        if (active) unlisteners.push(fn);
        else fn();
      });

      void listen<{ currentTime: number; duration: number }>("audio://progress", event => {
        if (!active) return;
        const { currentTime, duration } = event.payload;
        if (typeof currentTime === "number") setCurrentTime(currentTime);
        if (typeof duration === "number" && duration > 0) {
          usePlayState.setState({ duration });
        }
      }).then(fn => {
        if (active) unlisteners.push(fn);
        else fn();
      });

      return () => {
        active = false;
        removeShortcuts();
        for (const fn of unlisteners) fn();
      };
    }

    bcRef.current = createBroadcastChannel();
    bcRef.current.onmessage = ev => {
      const { from, state } = (ev.data as MiniPlayerMessageFromMain | undefined) ?? {};
      if (from !== "main" || !state) return;

      updatePlayState(state);
      if (typeof state.currentTime === "number") {
        setCurrentTime(state.currentTime);
      }
    };
    postMessage("init");

    return () => {
      removeShortcuts();
      bcRef.current?.close();
      bcRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSeek = (v: number) => {
    postMessage("seek", { currentTime: v });
  };

  const togglePlayMode = () => {
    postMessage("togglePlayMode");
  };

  const prev = () => {
    postMessage("prev");
  };

  const togglePlay = () => {
    postMessage("togglePlay");
  };

  const next = () => {
    postMessage("next");
  };

  return (
    <div className="window-drag rounded-medium flex h-screen w-screen flex-col overflow-hidden select-none">
      <div className="flex h-full items-center">
        <CoverView />
        <div className="flex min-w-0 flex-1 flex-col space-y-1 px-2">
          <div className="flex min-w-0 flex-col">
            {title ? (
              <span className="truncate text-center text-sm font-medium">{title}</span>
            ) : (
              <span className="text-center text-sm text-zinc-500">暂无播放内容</span>
            )}
          </div>
          <div className="window-no-drag mt-1 flex items-center">
            <Slider
              aria-label="播放进度"
              minValue={0}
              maxValue={duration}
              value={currentTime}
              onChange={v => {
                handleSeek(v as number);
              }}
              isDisabled={!title}
              size="sm"
              className="flex-1"
              classNames={{
                trackWrapper: "group",
                track: "h-[4px] cursor-pointer",
                thumb: clx("w-3 h-3 after:h-2 after:bg-primary opacity-0", {
                  "group-hover:opacity-100": Boolean(title),
                }),
              }}
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center">
              <Button
                isIconOnly
                size="sm"
                variant="light"
                disableAnimation
                onPress={togglePlayMode}
                className="hover:text-primary window-no-drag h-7 w-7 min-w-7"
                aria-label="播放模式"
              >
                {playModeIcon}
              </Button>
              <DesktopLyricsButton compact className="h-7 w-7 min-w-7" />
            </div>
            <div className="flex items-center space-x-0.5">
              <Button
                isDisabled={!title || isSingle}
                isIconOnly
                size="sm"
                variant="light"
                disableAnimation
                onPress={prev}
                className="hover:text-primary window-no-drag h-7 w-7 min-w-7"
              >
                <RiSkipBackFill size={18} />
              </Button>
              <Button
                isDisabled={!title}
                isIconOnly
                size="sm"
                variant="light"
                disableAnimation
                onPress={() => {
                  togglePlay();
                }}
                className="hover:text-primary window-no-drag"
              >
                {isPlaying ? <RiPauseCircleFill size={28} /> : <RiPlayCircleFill size={28} />}
              </Button>
              <Button
                isDisabled={!title || isSingle}
                isIconOnly
                size="sm"
                variant="light"
                disableAnimation
                onPress={() => {
                  next();
                }}
                className="hover:text-primary window-no-drag h-7 w-7 min-w-7"
              >
                <RiSkipForwardFill size={18} />
              </Button>
            </div>
            <div className="flex items-center">
              <MiniVolume post={postMessage} />
              <Button
                isIconOnly
                size="sm"
                variant="light"
                disableAnimation
                onPress={() => void toggleMiniWindow()}
                className="hover:text-primary window-no-drag h-7 w-7 min-w-7"
                aria-label="切换到完整播放器"
              >
                <RiExpandDiagonalLine size={16} />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MiniPlayer;
