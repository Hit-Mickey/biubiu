export type ExternalPlaylistSource = "netease" | "qq";
export interface ExternalPlaylistRef {
  source: ExternalPlaylistSource;
  id: string;
}

export interface ExternalTrack {
  title: string;
  artists: string[];
  /** Seconds, if public metadata includes a duration. */
  duration?: number;
}

export interface ExternalPlaylist {
  title: string;
  /** Source count; may exceed the number of positions the source exposes anonymously. */
  total: number;
  /** All exposed positions in source order, including duplicates and unavailable (null) tracks. */
  tracks: (ExternalTrack | null)[];
}

const isPlaylistId = (id: unknown): id is string => typeof id === "string" && /^[1-9]\d{0,15}$/.test(id);

/** Interpret the pasted link locally. Never visit it (including share/redirect links). */
export function parseExternalPlaylist(input: string): ExternalPlaylistRef | null {
  const text = input.trim();
  const scoped = /^(netease|qq):([1-9]\d{0,15})$/.exec(text);
  if (scoped) return { source: scoped[1] === "qq" ? "qq" : "netease", id: scoped[2] };
  if (text.length > 2048 || !/^https?:\/\//i.test(text) || /[\s\\]/.test(text)) return null;

  const url = URL.parse(text);
  if (!url || url.username || url.password || url.port) return null;
  const withId = (source: ExternalPlaylistSource, id?: string | null) => (isPlaylistId(id) ? { source, id } : null);
  const queryId = (params: URLSearchParams) => (params.getAll("id").length === 1 ? params.get("id") : null);

  if (["music.163.com", "y.music.163.com", "m.music.163.com"].includes(url.hostname)) {
    if (url.pathname === "/" && /^#\/(?:m\/)?playlist\?/.test(url.hash)) {
      return withId("netease", queryId(new URLSearchParams(url.hash.slice(url.hash.indexOf("?") + 1))));
    }
    if (/^\/(?:m\/)?playlist\/?$/.test(url.pathname)) return withId("netease", queryId(url.searchParams));
    return withId("netease", /^\/(?:m\/)?playlist\/(\d+)\/?$/.exec(url.pathname)?.[1]);
  }
  if (["y.qq.com", "i.y.qq.com"].includes(url.hostname)) {
    if (
      ["/n2/m/share/details/taoge.html", "/n/m/detail/taoge/index.html", "/portal/playlist.html"].includes(url.pathname)
    ) {
      return withId("qq", queryId(url.searchParams));
    }
    return withId("qq", /^\/n\/(?:ryqq(?:_v2)?|yqq)\/playlist\/(\d+)(?:\.html)?\/?$/.exec(url.pathname)?.[1]);
  }
  return null;
}
