import log from "@/common/utils/logger";
import { getAudioWebStreamUrl } from "@/service/audio-web-url";
import { getPlayerPlayurl, type DashAudio } from "@/service/player-playurl";
import { useSettings } from "@/store/settings";
import { useUser } from "@/store/user";

import { audioQualitySort } from "../constants/audio";
import { VideoFnval } from "../constants/video";
import { selectMirror, streamCandidates } from "./audio-cdn";
import { getUrlParams } from "./url";

function sortAudio(audio: DashAudio[]) {
  return audio.toSorted((a, b) => {
    if (a.bandwidth !== b.bandwidth) {
      return b.bandwidth - a.bandwidth;
    }

    const indexA = audioQualitySort.indexOf(a.id);
    const indexB = audioQualitySort.indexOf(b.id);
    if (indexA === -1) return 1;
    if (indexB === -1) return -1;
    return indexB - indexA;
  });
}

function selectAudioByQuality(audioList: DashAudio[], quality: AudioQuality): DashAudio | undefined {
  if (!audioList.length) return undefined;

  const sortedList = sortAudio(audioList);

  switch (quality) {
    case "high":
      return sortedList[0];
    case "medium": {
      const midIndex = Math.floor((sortedList.length - 1) / 2);
      return sortedList[midIndex];
    }
    case "low":
      return sortedList[sortedList.length - 1];
    default:
      return sortedList[0];
  }
}

export async function getDashUrl(bvid: string, cid: string | number, audioQuality: AudioQuality = "auto") {
  try {
    const getUrlInfoRes = await getPlayerPlayurl({
      bvid,
      cid,
      fnval: VideoFnval.AllDash,
    });

    const bestVideoInfo = getUrlInfoRes?.data?.dash?.video?.[0];
    const videoResolution = `${bestVideoInfo?.width}x${bestVideoInfo?.height}`;
    const videoUrl = bestVideoInfo?.baseUrl || bestVideoInfo?.backupUrl?.[0];
    const flacAudio = getUrlInfoRes?.data?.dash?.flac?.audio;
    const dolbyAudio = getUrlInfoRes?.data?.dash?.dolby?.audio?.[0];

    const premium = audioQuality === "auto" || audioQuality === "lossless";
    const selectedAudio =
      (premium && (flacAudio || dolbyAudio)) ||
      selectAudioByQuality(getUrlInfoRes?.data?.dash?.audio ?? [], audioQuality);
    const mirrors = streamCandidates(selectedAudio);
    return {
      isLossless: Boolean(selectedAudio && selectedAudio === flacAudio),
      isDolby: Boolean(selectedAudio && selectedAudio === dolbyAudio),
      audioCodecs: selectedAudio?.codecs?.toLowerCase() || "",
      audioBandwidth: selectedAudio?.bandwidth,
      mirrors,
      audioUrl: selectMirror(mirrors, useSettings.getState().preferredAudioHost),
      videoUrl,
      videoResolution,
    };
  } catch (error) {
    log.error("[Get video play url error]", error);
    return {
      isLossless: false,
    };
  }
}

/**
 * 登录情况下获取音乐播放链接
 */
export const getAudioUrl = async (sid: number | string) => {
  const res = await getAudioWebStreamUrl({
    songid: sid,
    quality: useUser.getState().user?.vipStatus ? 3 : 2,
    privilege: 2,
    mid: useUser.getState().user?.mid || 0,
    platform: "web",
  });

  const isFlac = res?.data?.type === 3;

  return {
    audioUrl: selectMirror(res?.data?.cdns ?? [], useSettings.getState().preferredAudioHost),
    mirrors: res?.data?.cdns ?? [],
    audioCodecs: isFlac ? "flac" : "",
    isLossless: isFlac,
  };
};

/** URL是否有效 */
export const isUrlValid = (url?: string): url is string => {
  if (!url) return false;
  const expires = Number(getUrlParams(url).deadline) * 1000;
  return Number.isFinite(expires) && Date.now() < expires;
};
