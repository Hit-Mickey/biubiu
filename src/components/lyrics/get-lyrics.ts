import type { WebPlayerParams } from "@/service/web-player";
import type { PlayData } from "@/store/play-list";

async function getLyricsByBili(params: WebPlayerParams) {
  const { getWebPlayerInfo } = await import("@/service/web-player");
  const res = await getWebPlayerInfo(params);
  const subTitleUrl =
    res?.data?.subtitle?.subtitles?.[0]?.subtitle_url || res?.data?.subtitle?.subtitles?.[0]?.subtitle_url_v2;

  if (subTitleUrl) {
    const { getLyric } = await import("@/service/ai-lyrics");
    const getLyricsRes = await getLyric(subTitleUrl.startsWith("//") ? "https:" + subTitleUrl : subTitleUrl);
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
  if (source === "local") return { lyrics: audioUrl ? await window.electron.readLocalLyrics(audioUrl, id) : undefined };
  if (source === "webdav")
    return { lyrics: webDavListId ? await window.electron.getWebDavLyrics(webDavListId, id) : undefined };
  if (!cid || !Number.isFinite(+cid)) return {};
  const params = { cid: +cid, ...(bvid && { bvid }), ...(aid && Number.isFinite(+aid) && { aid: +aid }) };
  const sourceKey = JSON.stringify(params);
  const read = async () => {
    const [revision, cached] = await window.electron.getPlaybackSubtitles(id, sourceKey);
    if (cached) return cached;
    const lines = (await getLyricsByBili(params)) ?? [];
    if (lines.length) await window.electron.savePlaybackSubtitles(revision, lines);
    return lines;
  };
  // Both WebViews use the same origin. Keep interactive Bilibili authentication in the requesting window.
  const subtitles = navigator.locks
    ? await navigator.locks.request(`biubiu-subtitles:${id}:${sourceKey}`, read)
    : await read();
  return { subtitles };
}
