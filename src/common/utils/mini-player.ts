import { shallow } from "zustand/shallow";

import { usePlayList } from "@/store/play-list";
import { usePlayProgress } from "@/store/play-progress";

import {
  createBroadcastChannel,
  toggleMiniWindow,
  type MiniPlayerMessageFromMain,
  type MiniPlayerMessageFromMini,
  type MiniPlayerState,
} from "./mini-player-channel";
import { setPlaybackVolume, stepPlaybackVolume, togglePlaybackMute } from "./playback-volume";

let bc: BroadcastChannel | null = null;
let unsubscribePlayList: VoidFunction | null = null;
let unsubscribePlayProgress: VoidFunction | null = null;
let isBroadcasting = false;

function getMainStateSnapshot(): MiniPlayerState {
  const { list, isPlaying, playMode, duration, playId, volume, isMuted, getPlayItem } = usePlayList.getState();
  const currentTime = usePlayProgress.getState().currentTime;
  const playItem = getPlayItem();

  return {
    isSingle: list.length === 1,
    title: playItem?.pageTitle || playItem?.title,
    cover: playItem?.pageCover || playItem?.cover,
    playId,
    isPlaying,
    currentTime: Number(currentTime ?? 0),
    playMode,
    duration: Number(duration ?? 0),
    volume: isMuted ? 0 : volume,
  };
}

function postMainState(channel: BroadcastChannel) {
  const message: MiniPlayerMessageFromMain = {
    from: "main",
    state: getMainStateSnapshot(),
    ts: Date.now(),
  };
  channel.postMessage(message);
}

function handleMessageFromMini(message: MiniPlayerMessageFromMini, channel: BroadcastChannel) {
  const data = message.data;
  if (!data) return;

  const type = data.type;
  switch (type) {
    case "init": {
      postMainState(channel);
      break;
    }
    case "seek": {
      const t = data.state?.currentTime;
      if (typeof t === "number" && Number.isFinite(t)) {
        usePlayList.getState().seek(t);
      }
      break;
    }
    case "togglePlayMode": {
      usePlayList.getState().togglePlayMode();
      break;
    }
    case "next": {
      void usePlayList.getState().next();
      break;
    }
    case "prev": {
      void usePlayList.getState().prev();
      break;
    }
    case "togglePlay": {
      usePlayList.getState().togglePlay();
      break;
    }
    case "setVolume": {
      const value = data.state?.volume;
      if (typeof value === "number") setPlaybackVolume(value);
      break;
    }
    case "adjustVolume": {
      const delta = data.state?.volumeDelta;
      if (delta === 0.05 || delta === -0.05) stepPlaybackVolume(delta);
      break;
    }
    case "toggleMute": {
      togglePlaybackMute();
      break;
    }
    case "volumeUp":
    case "volumeDown": {
      const { setVolume, volume } = usePlayList.getState();
      setVolume(type === "volumeUp" ? Math.min(1, volume + 0.05) : Math.max(0, volume - 0.05));
      break;
    }
    default: {
      break;
    }
  }
}

/**
 * 启动主窗口 -> mini 播放器的状态同步通道。
 *
 * - 只会启动一次；重复调用会直接返回。
 * - 收到 mini 端的播放控制命令后，会转发到主播放状态。
 * - 主播放状态发生变化会推送给 mini 端更新 UI。
 */
function startMiniPlayerMainSync() {
  if (isBroadcasting) return;

  bc = createBroadcastChannel();

  isBroadcasting = true;

  bc.onmessage = ev => {
    const data = ev.data as MiniPlayerMessageFromMini;
    if (data?.from !== "mini") return;
    handleMessageFromMini(data, bc as BroadcastChannel);
  };

  unsubscribePlayList = usePlayList.subscribe((state, prevState) => {
    if (
      !shallow(
        {
          playId: state.playId,
          isPlaying: state.isPlaying,
          playMode: state.playMode,
          duration: state.duration,
          volume: state.isMuted ? 0 : state.volume,
          item: state.getPlayItem(),
        },
        {
          playId: prevState.playId,
          isPlaying: prevState.isPlaying,
          playMode: prevState.playMode,
          duration: prevState.duration,
          volume: prevState.isMuted ? 0 : prevState.volume,
          item: prevState.list.find(item => item.id === prevState.playId),
        },
      )
    ) {
      postMainState(bc as BroadcastChannel);
    }
  });

  unsubscribePlayProgress = usePlayProgress.subscribe((state, prevState) => {
    if (state.currentTime !== prevState.currentTime) {
      postMainState(bc as BroadcastChannel);
    }
  });
}

/**
 * 停止主窗口 -> mini 播放器的状态同步通道。
 */
export function stopMiniPlayerMainSync() {
  if (!isBroadcasting) return;

  unsubscribePlayList?.();
  unsubscribePlayList = null;
  unsubscribePlayProgress?.();
  unsubscribePlayProgress = null;
  bc?.close();
  bc = null;
  isBroadcasting = false;
}

/**
 * 切换mini/完整播放模式
 */
export async function toggleMiniMode() {
  startMiniPlayerMainSync();
  if (!(await toggleMiniWindow())) stopMiniPlayerMainSync();
}
