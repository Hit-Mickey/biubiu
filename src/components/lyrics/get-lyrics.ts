import type { PlayData } from "@/store/play-list";

import { getLyric } from "@/service/ai-lyrics";
import { getWebPlayerInfo, type WebPlayerParams } from "@/service/web-player";

export async function getLyricsByBili(params: WebPlayerParams) {
  const res = await getWebPlayerInfo(params);
  const subTitleUrl =
    res?.data?.subtitle?.subtitles?.[0]?.subtitle_url || res?.data?.subtitle?.subtitles?.[0]?.subtitle_url_v2;

  if (subTitleUrl) {
    const getLyricsRes = await getLyric(subTitleUrl);
    return (
      getLyricsRes?.body
        ?.map(item => {
          const raw = item.content ?? "";
          const cleaned = raw.replace(/^[♪♫]+|[♪♫]+$/g, "").trim();
          return {
            time: Math.max(0, Math.round((item.from ?? 0) * 1000)),
            text: cleaned,
          };
        })
        .filter(item => item.text)
        .toSorted((a, b) => a.time - b.time) ?? []
    );
  }

  return null;
}

export interface NativeLyrics extends LyricText {
  subtitles?: LyricLine[];
}

export async function getNativeLyrics({
  source,
  webDavListId,
  id,
  audioUrl,
  cid,
  bvid,
  aid,
}: Pick<PlayData, "source" | "webDavListId" | "id" | "audioUrl" | "cid" | "bvid" | "aid">): Promise<NativeLyrics> {
  if (source === "local") return { lyrics: audioUrl ? await window.electron.readLocalLyrics(audioUrl) : undefined };
  if (source === "webdav")
    return { lyrics: webDavListId ? await window.electron.getWebDavLyrics(webDavListId, id) : undefined };
  if (!cid || !Number.isFinite(+cid)) return {};
  const lines = await getLyricsByBili({
    cid: +cid,
    ...(bvid && { bvid }),
    ...(aid && Number.isFinite(+aid) && { aid: +aid }),
  });
  return { subtitles: lines ?? [] };
}
