import { useCallback, useEffect, useRef, useState } from "react";

import {
  addToast,
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalHeader,
  Spinner,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
  Tabs,
} from "@heroui/react";

import { formatDuration } from "@/common/utils/time";
import { useSettings } from "@/store/settings";
import { lyricSearchSources } from "@shared/settings/lyric-search-sources";

import LyricsPreviewModal from "./lyrics-preview-modal";

interface Result {
  id: string;
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;
  read: () => Promise<LyricText>;
}

async function search(source: LyricSearchSource, keyword: string): Promise<Result[]> {
  if (source === "qq") {
    return (await window.electron.searchQQLyricSongs(keyword)).map(song => ({
      ...song,
      id: song.mid,
      read: () => window.electron.getQQLyrics(song.mid),
    }));
  }
  if (source === "lrclib") {
    return ((await window.electron.searchLrclibLyrics({ q: keyword })) ?? []).map((song, i) => ({
      id: String(song.id ?? i),
      title: song.trackName || song.name,
      artist: song.artistName,
      album: song.albumName,
      duration: song.duration,
      read: async () => ({ lyrics: song.syncedLyrics?.trim() || song.plainLyrics?.trim() }),
    }));
  }
  const res = await window.electron.searchNeteaseSongs({ s: keyword, type: 1, limit: 20, offset: 0 });
  return (res?.result?.songs ?? []).flatMap(song => {
    const id = song.id;
    if (!id) return [];
    return [
      {
        id: String(id),
        title: song.name,
        artist: song.artists
          ?.map(a => a.name)
          .filter(Boolean)
          .join(" / "),
        album: song.album?.name,
        duration: song.duration ? Math.round(song.duration / 1000) : undefined,
        read: async () => {
          const data = await window.electron.getNeteaseLyrics({ id });
          const yrc = data?.yrc?.lyric;
          const timed = yrc && /^\[\d+,\d+\]\(\d+,\d+,\d+\)/m.test(yrc);
          return {
            lyrics: (timed ? yrc : undefined) || data?.lrc?.lyric?.trim() || data?.klyric?.lyric?.trim(),
            tLyrics: (timed && data?.ytlrc?.lyric) || data?.tlyric?.lyric,
            romaLyrics: (timed && data?.yromalrc?.lyric) || data?.romalrc?.lyric,
          };
        },
      },
    ];
  });
}

interface Props {
  title: string;
  onClose: () => void;
  onAdopt: (text: LyricText) => Promise<boolean>;
}

/** Mounted only while open. A track switch also discards any pending preview. */
export default function LyricsSearchModal({ title, onClose, onAdopt }: Props) {
  const [keyword, setKeyword] = useState(title);
  const [source, setSource] = useState(() => useSettings.getState().lyricSearchSource);
  const [songs, setSongs] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<{ title: string; text?: LyricText }>();
  const request = useRef<symbol | null>(null);
  const query = useRef(title);

  const submit = useCallback(async (tab: LyricSearchSource) => {
    const id = Symbol();
    request.current = id;
    const q = query.current.trim();
    setPreview(undefined);
    setSongs([]);
    setLoading(!!q);
    if (!q) return;
    try {
      const rows = await search(tab, q);
      if (request.current === id) setSongs(rows);
    } catch {
      if (request.current === id) addToast({ title: `${lyricSearchSources[tab]}搜索失败`, color: "danger" });
    } finally {
      if (request.current === id) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void submit(source);
    return () => {
      request.current = null;
    };
  }, [source, submit]);

  const select = async (song: Result) => {
    const id = Symbol();
    request.current = id;
    const name = [song.title, song.artist].filter(Boolean).join("-");
    setPreview({ title: name });
    try {
      const text = await song.read();
      if (request.current !== id) return;
      if (!text.lyrics?.trim()) {
        addToast({ title: "未找到歌词内容", color: "warning" });
        setPreview(undefined);
      } else setPreview({ title: name, text });
    } catch {
      if (request.current !== id) return;
      addToast({ title: "获取歌词失败", color: "danger" });
      setPreview(undefined);
    }
  };

  return (
    <Modal isOpen onClose={onClose} scrollBehavior="inside" size="4xl" disableAnimation>
      <ModalContent>
        <ModalHeader className="flex flex-col gap-1">搜索歌词</ModalHeader>
        <ModalBody className="pb-6">
          <div className="flex gap-2">
            <Input
              aria-label="搜索关键词"
              value={keyword}
              onValueChange={v => {
                query.current = v;
                setKeyword(v);
              }}
              placeholder="请输入歌曲或歌手名称"
              onKeyDown={e => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing && !loading) void submit(source);
              }}
            />
            <Button color="primary" isDisabled={loading || !keyword.trim()} onPress={() => void submit(source)}>
              搜索
            </Button>
          </div>
          <Tabs
            aria-label="歌词来源"
            selectedKey={source}
            onSelectionChange={key => setSource(key as LyricSearchSource)}
            classNames={{ panel: "py-0" }}
          >
            {Object.entries(lyricSearchSources).map(([key, name]) => (
              <Tab key={key} title={name} />
            ))}
          </Tabs>
          <div className="h-[340px] overflow-auto">
            {loading ? (
              <div className="flex h-full items-center justify-center">
                <Spinner color="primary" label="加载中" />
              </div>
            ) : (
              <Table
                removeWrapper
                selectionMode="single"
                aria-label={`${lyricSearchSources[source]}歌曲`}
                onRowAction={key => {
                  const song = songs.find(s => s.id === key);
                  if (song) void select(song);
                }}
              >
                <TableHeader>
                  <TableColumn width={200}>歌曲</TableColumn>
                  <TableColumn>专辑</TableColumn>
                  <TableColumn width={200}>歌手</TableColumn>
                  <TableColumn width={90}>时长</TableColumn>
                </TableHeader>
                <TableBody emptyContent="暂无数据" items={songs}>
                  {song => (
                    <TableRow key={song.id} className="cursor-pointer">
                      <TableCell>{song.title || "--"}</TableCell>
                      <TableCell>{song.album || "--"}</TableCell>
                      <TableCell>{song.artist || "--"}</TableCell>
                      <TableCell>{song.duration ? formatDuration(song.duration) : "--"}</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}
          </div>
          {preview && (
            <LyricsPreviewModal
              title={preview.title}
              text={preview.text}
              onClose={() => {
                request.current = null;
                setPreview(undefined);
              }}
              onAdopt={onAdopt}
            />
          )}
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
