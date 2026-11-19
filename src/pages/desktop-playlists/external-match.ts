import type { SearchVideoItem } from "@/service/web-interface-search-type";
import type { PlayItem } from "@/store/play-list";
import type { ExternalTrack } from "@shared/external-playlist";

import { getWebInterfaceWbiSearchType } from "@/service/web-interface-search-type";
import { getWebInterfaceView } from "@/service/web-interface-view";

export type VideoChoice = PlayItem & { type: "mv"; bvid: string };
export interface PreviewRow {
  track: ExternalTrack | null;
  state: "pending" | "ready" | "failed" | "unavailable";
  candidates: readonly VideoChoice[];
  selected: string;
  note?: string;
}

const noCandidates: readonly VideoChoice[] = [];
export const makePreview = (tracks: (ExternalTrack | null)[]): PreviewRow[] =>
  tracks.map(track => ({ track, state: track ? "pending" : "unavailable", candidates: noCandidates, selected: "" }));

export function selectedItems(rows: PreviewRow[]): PlayItem[] {
  const items: PlayItem[] = [];
  for (const row of rows) {
    if (!row.selected) continue;
    const item = row.candidates.find(candidate => candidate.bvid === row.selected);
    if (item) items.push(item);
  }
  return items;
}

const BV = /^BV1[A-Za-z0-9]{9}$/;
const notAutomatic = new Set([26, 29, 31, 201, 238]); // e.g. remixes, live recordings and covers
const maxChoices = 5;
const fold = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");

function plainText(value: unknown) {
  if (typeof value !== "string") return "";
  return value
    .slice(0, 1024)
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/<[^>]+>/g, "")
    .trim()
    .slice(0, 240);
}

function biliCover(pic: unknown) {
  if (typeof pic !== "string" || pic.length > 2048) return;
  const url = URL.parse(pic.startsWith("//") ? `https:${pic}` : pic);
  if (
    url &&
    /^https?:$/.test(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.port &&
    url.hostname.endsWith(".hdslb.com") &&
    url.pathname.startsWith("/bfs/")
  ) {
    return `https://${url.hostname}${url.pathname}`;
  }
}

function durationSeconds(duration: unknown) {
  if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) return duration;
  if (typeof duration !== "string" || !/^\d{1,6}(?::[0-5]?\d){0,2}$/.test(duration)) return;
  return duration.split(":").reduce((n, part) => 60 * n + Number(part), 0) || undefined;
}

type VideoHit = Pick<SearchVideoItem, "bvid" | "title" | "author" | "pic" | "mid" | "duration"> & {
  typeid?: number | string;
};

function choice(video: VideoHit): VideoChoice | undefined {
  const title = plainText(video?.title);
  if (!title || typeof video.bvid !== "string" || !BV.test(video.bvid)) return;
  return {
    type: "mv",
    source: "online",
    bvid: video.bvid,
    title,
    ownerName: plainText(video.author) || undefined,
    ownerMid: Number.isSafeInteger(video.mid) && video.mid > 0 ? video.mid : undefined,
    cover: biliCover(video.pic),
    duration: durationSeconds(video.duration),
  };
}

function match(track: ExternalTrack, hits: VideoHit[]): PreviewRow {
  const targetTitle = fold(track.title);
  const artists = track.artists.map(fold).filter(Boolean);
  const seen = new Set<string>();
  const ranked = hits
    .slice(0, 20)
    .flatMap(hit => {
      const item = choice(hit);
      if (!item || seen.has(item.bvid)) return [];
      seen.add(item.bvid);
      const title = fold(item.title);
      const titleMatches = Boolean(targetTitle) && title.includes(targetTitle);
      const artistMatches = artists.some(name => title.includes(name) || fold(item.ownerName || "").includes(name));
      const delta = track.duration && item.duration ? Math.abs(track.duration - item.duration) : undefined;
      // Duration alone is not an identity. If duration is unknown, require an artist match.
      const automatic =
        titleMatches && (delta === undefined ? artistMatches : delta <= 20) && !notAutomatic.has(Number(hit.typeid));
      const score =
        Number(automatic) * 10 +
        Number(titleMatches) * 3 +
        Number(artistMatches) * 2 +
        (delta === undefined ? 0 : 1 / (1 + delta));
      return [{ item, automatic, score }];
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxChoices);
  const selected = ranked[0]?.automatic ? ranked[0].item.bvid : "";
  return {
    track,
    state: "ready",
    candidates: ranked.map(hit => hit.item),
    selected,
    note: selected
      ? undefined
      : ranked.length
        ? "没有足够接近的匹配，请选择候选或跳过"
        : "没有找到 B站候选，可指定 BV 号或跳过",
  };
}

class BiliRestricted extends Error {
  constructor() {
    super("B站限制了本次查询，请稍后再试");
  }
}

function checkResponse(response: { code: number; data: unknown }, message: string) {
  if (
    [-101, -352, -403, -412, -509, 429].includes(response.code) ||
    (response.data && typeof response.data === "object" && "v_voucher" in response.data && response.data.v_voucher)
  )
    throw new BiliRestricted();
  if (response.code !== 0) throw new Error(`${message}（代码 ${response.code}）`);
}

function asLookupError(error: unknown, fallback: string) {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  if (status && [401, 403, 412, 429].includes(status)) return new BiliRestricted();
  return error instanceof Error && !status ? error : new Error(fallback);
}

function waitBetweenSearches(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 1200);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Process in playlist order and keep completed rows if stopped. A platform restriction stops the whole batch. */
export async function matchRows(
  rows: PreviewRow[],
  state: "pending" | "failed",
  signal: AbortSignal,
  onRow: (index: number, row: PreviewRow) => void,
) {
  let first = true;
  let failures = 0;
  for (const [index, row] of rows.entries()) {
    signal.throwIfAborted();
    if (row.state !== state || !row.track) continue;
    if (!first) {
      await waitBetweenSearches(signal);
      signal.throwIfAborted();
    }
    first = false;
    const track = row.track;
    try {
      const keyword = [track.title, ...track.artists].join(" ").slice(0, 180);
      const res = await getWebInterfaceWbiSearchType<VideoHit>(
        { search_type: "video", keyword, page: 1 },
        { passive: true, signal },
      );
      signal.throwIfAborted();
      checkResponse(res, "B站搜索失败");
      if (!Array.isArray(res.data?.result) && res.data?.numResults !== 0) throw new Error("B站返回的搜索结果无效");
      onRow(index, match(track, res.data.result ?? []));
      failures = 0;
    } catch (error) {
      signal.throwIfAborted();
      const reason = asLookupError(error, "B站搜索失败，请稍后重试");
      onRow(index, { ...row, state: "failed", note: reason.message });
      if (reason instanceof BiliRestricted) throw reason;
      if (++failures >= 3) throw new Error("连续三次搜索失败，已暂停匹配");
    }
  }
}

/** Only a validated BV identifier reaches the existing video metadata service. */
export async function resolveVideo(input: string, signal: AbortSignal): Promise<VideoChoice> {
  const bvid = input.trim();
  if (!BV.test(bvid)) throw new Error("请输入完整的 12 位 BV 号，例如 BV1xx411c7mD");
  signal.throwIfAborted();
  try {
    const res = await getWebInterfaceView({ bvid }, { passive: true, signal });
    signal.throwIfAborted();
    checkResponse(res, "该 B站视频不可用");
    const v = res.data;
    const video =
      v?.bvid === bvid &&
      choice({ bvid, title: v.title, author: v.owner?.name, mid: v.owner?.mid, pic: v.pic, duration: v.duration });
    if (!video) throw new Error("未能确认该 BV 号的视频信息");
    return video;
  } catch (error) {
    signal.throwIfAborted();
    throw asLookupError(error, "未能读取 B站视频信息");
  }
}

export function withVideoChoice(row: PreviewRow, video: VideoChoice): PreviewRow {
  return {
    ...row,
    state: "ready",
    selected: video.bvid,
    note: undefined,
    candidates: [video, ...row.candidates.filter(item => item.bvid !== video.bvid)].slice(0, maxChoices),
  };
}
