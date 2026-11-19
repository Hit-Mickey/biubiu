import { maxLyricLength } from "@shared/lyrics";

const searchEndpoint = "https://u.y.qq.com/cgi-bin/musicu.fcg";
const lyricEndpoint = "https://i.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg";
const resultLimit = 12;
const byteLimit = 1024 * 1024;
let inFlight = 0;

/** Node fetch, not Electron's Bilibili session. URLs, methods and headers are owned by this module. */
async function requestJSON<T>(url: URL | string, body?: string): Promise<T> {
  if (inFlight >= 2) throw new Error("请稍后再试");
  inFlight++;
  try {
    const response = await fetch(url, {
      method: body ? "POST" : "GET",
      body,
      headers: { Referer: "https://y.qq.com/", ...(body && { "Content-Type": "application/json" }) },
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok || !response.body || Number(response.headers.get("content-length")) > byteLimit) {
      await response.body?.cancel();
      throw new Error("QQ 音乐暂不可用");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > byteLimit) {
        await reader.cancel();
        throw new Error("歌词响应过大");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as T;
  } finally {
    inFlight--;
  }
}

interface QQSong {
  mid?: string;
  name?: string;
  album?: { name?: string };
  singer?: { name?: string }[];
  interval?: number;
}
const validMid = (mid: unknown): mid is string => typeof mid === "string" && /^[a-z\d]{1,32}$/i.test(mid);

export async function searchQQ(keyword: string): Promise<QQLyricSong[]> {
  if (typeof keyword !== "string" || !keyword.trim() || keyword.length > 128) return [];
  const data = await requestJSON<{ req?: { code: number; data?: { body?: { song?: { list?: QQSong[] } } } } }>(
    searchEndpoint,
    JSON.stringify({
      comm: { ct: "19", cv: "1859", uin: "0" },
      req: {
        module: "music.search.SearchCgiService",
        method: "DoSearchForQQMusicDesktop",
        param: { query: keyword.trim(), page_num: 1, num_per_page: resultLimit, grp: 1, search_type: 0 },
      },
    }),
  );
  if (data.req?.code !== 0) throw new Error("QQ 音乐搜索失败");
  return (data.req.data?.body?.song?.list ?? []).slice(0, resultLimit).flatMap(song =>
    validMid(song.mid) && typeof song.name === "string"
      ? [
          {
            mid: song.mid,
            title: song.name,
            album: song.album?.name || "",
            artist:
              song.singer
                ?.map(s => s.name)
                .filter(Boolean)
                .join(" / ") || "",
            duration: song.interval || 0,
          },
        ]
      : [],
  );
}

export async function getQQLyrics(mid: string): Promise<LyricText> {
  if (!validMid(mid)) throw new Error("无效的 QQ 歌曲 ID");
  const url = new URL(lyricEndpoint);
  url.search = new URLSearchParams({ songmid: mid, format: "json", nobase64: "0", g_tk: "5381" }).toString();
  const data = await requestJSON<{ retcode: number; lyric?: string; trans?: string; roma?: string }>(url);
  if (data.retcode !== 0) throw new Error("QQ 音乐歌词暂不可用");
  const decode = (value?: string) =>
    typeof value === "string" && value.length <= byteLimit
      ? Buffer.from(value, "base64").toString("utf8").slice(0, maxLyricLength).trim() || undefined
      : undefined;
  return { lyrics: decode(data.lyric), tLyrics: decode(data.trans), romaLyrics: decode(data.roma) };
}
