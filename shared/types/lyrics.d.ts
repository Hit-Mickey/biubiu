interface SearchSongByNeteaseParams {
  s: string;
  type: number;
  limit: number;
  offset: number;
}

interface SearchSongByNeteaseResponse {
  result?: {
    songs?: NeteaseSong[];
    hasMore?: boolean;
    songCount?: number;
  };
  code?: number;
  trp?: {
    rules?: string[];
  };
}

interface NeteaseSong {
  id?: number;
  name?: string;
  alias?: string[];
  artists?: NeteaseArtist[];
  album?: NeteaseAlbum;
  duration?: number;
  fee?: number;
  rtype?: number;
  ftype?: number;
  copyrightId?: number;
  transNames?: string[];
  mvid?: number;
  mark?: number;
  status?: number;
}

interface NeteaseAlbum {
  id?: number;
  name?: string;
  publishTime?: number;
  size?: number;
  picId?: number;
  artist?: NeteaseArtist;
  copyrightId?: number;
  alia?: string[];
  mark?: number;
  status?: number;
  transNames?: string[];
}

interface NeteaseArtist {
  id?: number;
  name?: string;
  alias?: string[];
  img1v1Url?: string;
  picId?: number;
  musicSize?: number;
  albumSize?: number;
  img1v1?: number;
}

interface GetLyricsByNeteaseParams {
  id: number;
}

interface GetLyricsByNeteaseResponse {
  sgc?: boolean;
  sfy?: boolean;
  qfy?: boolean;
  transUser?: NeteaseUser;
  lyricUser?: NeteaseUser;
  /** 歌词原文 */
  lrc?: NeteaseKlyric;
  klyric?: NeteaseKlyric;
  yrc?: NeteaseKlyric;
  ytlrc?: NeteaseKlyric;
  yromalrc?: NeteaseKlyric;
  /** 翻译歌词 */
  tlyric?: NeteaseKlyric;
  /** 歌词发音，一些日语等歌曲会有 */
  romalrc?: NeteaseKlyric;
  code?: number;
}

interface NeteaseKlyric {
  version?: number;
  lyric?: string;
}

interface NeteaseUser {
  id?: number;
  status?: number;
  demand?: number;
  userid?: number;
  nickname?: string;
  uptime?: number;
}

interface SearchSongByLrclibParams {
  q: string;
  track_name?: string;
  artist_name?: string;
  album_name?: string;
}

interface SearchSongByLrclibResponse {
  id?: number;
  name?: string;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  /** 歌词文本 */
  plainLyrics?: null | string;
  /** 歌词时间同步文本 */
  syncedLyrics?: null | string;
}

interface LyricsPreference {
  fontSize: number;
  offsetMs: number;
  showTranslation: boolean;
}

interface LyricWord {
  /** Absolute playback time in milliseconds. */
  time: number;
  end?: number;
  text: string;
}

interface LyricLine extends LyricWord {
  words?: LyricWord[];
  translation?: string;
  romanization?: string;
}

interface LyricText {
  lyrics?: string;
  tLyrics?: string;
  romaLyrics?: string;
}

/** Top-level text is the adopted source (compatible with the original cache). */
interface MusicLyrics extends LyricText {
  fontSize?: number;
  offset?: number;
  /** Read existing manual edits from older versions. */
  edited?: LyricText;
}

type TrackLyricChange =
  | { type: "adopt"; text: LyricText }
  | { type: "preferences"; offset?: number; fontSize?: number };

interface QQLyricSong {
  mid: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
}
