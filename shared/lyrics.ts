export const maxLyricLength = 512 * 1024;

export function lyricsCacheKey(item: { source?: string; id: string; bvid?: string; cid?: string; sid?: number }) {
  if (item.source === "local" || item.source === "webdav") return `${item.source}-${item.id}`;
  if (item.bvid && item.cid) return `${item.bvid}-${item.cid}`; // existing cache keys
  if (item.sid) return `audio-${item.sid}`;
  return `track-${item.id}`;
}

export function assertLyricsKey(key: string) {
  // A single store key, never a dot path or an object prototype property.
  if (typeof key !== "string" || !/^[a-z\d_-]{1,100}-[a-z\d_-]{1,128}$/i.test(key)) {
    throw new Error("无效的歌曲标识");
  }
}

export function adoptedLyrics(record?: MusicLyrics) {
  return record?.lyrics || record?.tLyrics || record?.romaLyrics ? record : undefined;
}

/** Merge in the main process to preserve cached lyrics when a slider preference changes. */
export function applyLyricChange(record: MusicLyrics, change: TrackLyricChange): MusicLyrics {
  const next = { ...record };
  switch (change.type) {
    case "preferences":
      if (Number.isFinite(change.offset)) next.offset = Math.max(-5000, Math.min(5000, change.offset!));
      if (Number.isFinite(change.fontSize)) next.fontSize = Math.max(12, Math.min(48, change.fontSize!));
      break;
    case "adopt": {
      const text: LyricText = {};
      for (const key of ["lyrics", "tLyrics", "romaLyrics"] as const) {
        const value = change.text[key];
        if (value === undefined || value === "") continue;
        if (typeof value !== "string" || value.length > maxLyricLength) throw new Error("歌词内容过长或格式无效");
        if (value.trim()) text[key] = value.trim();
      }
      if (!text.lyrics) throw new Error("请填写歌词原文");
      delete next.edited;
      delete next.lyrics;
      delete next.tLyrics;
      delete next.romaLyrics;
      return { ...next, ...text };
    }
    default:
      throw new Error("无效的歌词操作");
  }
  return next;
}
