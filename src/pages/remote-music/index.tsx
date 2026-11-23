import { useEffect, useMemo, useRef, useState } from "react";

import { addToast, Button, Input, Select, SelectItem, Spinner } from "@heroui/react";
import {
  RiAddLine,
  RiArrowDownLine,
  RiArrowUpLine,
  RiDeleteBinLine,
  RiEditLine,
  RiPlayFill,
  RiPlayListAddLine,
  RiRefreshLine,
  RiSearchLine,
  RiSettings3Line,
} from "@remixicon/react";
import { useLocalStorageState, useRequest } from "ahooks";

import type { WebDavList, WebDavTrack } from "@shared/webdav";

import { PlayMode } from "@/common/constants/audio";
import Empty from "@/components/empty";
import IconButton from "@/components/icon-button";
import LocatePlayingButton from "@/components/locate-playing-button";
import { type ScrollRefObject } from "@/components/scroll-container";
import { VirtualList } from "@/components/virtual-list";
import { useModalStore } from "@/store/modal";
import { usePlayList } from "@/store/play-list";

import WebDavListEditor from "./list-editor";
import WebDavPreferencesModal from "./preferences";
import { RemoteTrackRow, RemoteTracksHeader } from "./tracks";
import { webDavErrorMessage, webDavPlayItem } from "./utils";

const sortFields = [
  { key: "default", name: "默认顺序" },
  { key: "filename", name: "文件名" },
  { key: "title", name: "标题" },
  { key: "artist", name: "歌手" },
  { key: "album", name: "专辑" },
  { key: "createdAt", name: "文件创建时间" },
  { key: "modifiedAt", name: "文件更新时间" },
  { key: "size", name: "文件大小" },
  { key: "duration", name: "时长" },
] as const;

type SortKey = (typeof sortFields)[number]["key"];
interface SortOrder {
  key: SortKey;
  descending: boolean;
}
const defaultSort: SortOrder = { key: "default", descending: false };
const RowHeight = 44;
const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

function sortTracks(tracks: WebDavTrack[], { key, descending }: SortOrder) {
  if (key === "default") return tracks;
  return tracks.toSorted((first, second) => {
    const a = first[key];
    const b = second[key];
    if (a == null || b == null) return Number(a == null) - Number(b == null);
    const order = typeof a === "number" && typeof b === "number" ? a - b : collator.compare(String(a), String(b));
    return descending ? -order : order;
  });
}

function notifyError(error: unknown) {
  addToast({ title: webDavErrorMessage(error), color: "danger" });
}

const RemoteMusicPage = () => {
  const scrollRef = useRef<ScrollRefObject | null>(null);
  const { data, error, refresh } = useRequest(() => window.electron.getWebDavLibrary());
  const [listId, setListId] = useState<string>();
  const [editor, setEditor] = useState<{ list?: WebDavList }>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [sortOrders, setSortOrders] = useLocalStorageState<Record<string, SortOrder>>("webdav-list-sort", {
    defaultValue: {},
  });
  const openConfirm = useModalStore(state => state.onOpenConfirmModal);
  const currentPlayItem = usePlayList(state => state.getPlayItem());

  useEffect(() => window.electron.onWebDavChange(refresh), [refresh]);

  const list = data?.lists.find(item => item.id === listId) ?? data?.lists[0];
  const listSort = (list && sortOrders?.[list.id]) || defaultSort;
  const filtered = useMemo(() => {
    if (!list) return [];
    const needle = keyword.trim().toLowerCase();
    const tracks = needle
      ? list.tracks.filter(track =>
          [track.title, track.artist, track.album, track.filename, track.folder].some(value =>
            value?.toLowerCase().includes(needle),
          ),
        )
      : list.tracks;
    return sortTracks(tracks, listSort);
  }, [keyword, list, listSort]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedTracks = useMemo(() => filtered.filter(track => selected.has(track.id)), [filtered, selected]);
  const targets = selectedTracks.length ? selectedTracks : filtered;

  const activeTrackIndex = useMemo(() => {
    if (!currentPlayItem) return;
    if (
      currentPlayItem.source !== "webdav" ||
      (currentPlayItem.webDavListId && currentPlayItem.webDavListId !== list?.id)
    )
      return -1;
    return filtered.findIndex(track => track.id === currentPlayItem.id);
  }, [currentPlayItem, filtered, list?.id]);

  const chooseList = (id: string | undefined) => {
    setListId(id);
    setKeyword("");
    setSelectedIds([]);
    setSelecting(false);
  };

  const setSort = (sort: SortOrder) => {
    if (list) setSortOrders(previous => ({ ...previous, [list.id]: sort }));
  };

  const playAll = () => {
    if (list)
      void usePlayList.getState().playList(
        targets.map(track => webDavPlayItem(list.id, track)),
        PlayMode.Loop,
      );
  };

  const addToQueue = (tracks: WebDavTrack[]) => {
    if (!list || !tracks.length) return;
    usePlayList.getState().addList(tracks.map(track => webDavPlayItem(list.id, track)));
    addToast({ title: "已添加到播放列表", color: "success" });
  };

  const update = async () => {
    if (!list) return;
    try {
      await window.electron.refreshWebDavList(list.id);
      setSelectedIds([]);
      addToast({ title: "远程列表已更新", color: "success" });
    } catch (error) {
      notifyError(error);
    }
  };

  const deleteList = () => {
    if (!list) return;
    openConfirm({
      title: `移除列表「${list.name}」`,
      confirmText: "移除",
      type: "warning",
      onConfirm: async () => {
        try {
          await window.electron.deleteWebDavList(list.id);
          setSortOrders(previous =>
            Object.fromEntries(Object.entries(previous ?? {}).filter(([id]) => id !== list.id)),
          );
          chooseList(undefined);
          return true;
        } catch (error) {
          notifyError(error);
          return false;
        }
      },
    });
  };

  const removeTracks = (tracks: WebDavTrack[]) => {
    if (!list || !tracks.length) return;
    const deleteFiles = list.removeRemoteFiles;
    openConfirm({
      title: deleteFiles ? "删除 WebDAV 文件" : "从列表移除歌曲",
      description: deleteFiles
        ? `确认删除「${list.name}」中的 ${tracks.length} 个远程音频文件？此操作无法撤销。`
        : `将从「${list.name}」移除 ${tracks.length} 首歌曲。更新列表时将重新读取目录。`,
      confirmText: deleteFiles ? "删除文件" : "移除",
      type: deleteFiles ? "danger" : "warning",
      onConfirm: async () => {
        try {
          const result = await window.electron.removeWebDavTracks(
            list.id,
            tracks.map(track => track.id),
            deleteFiles,
          );
          const removed = new Set(result.removed);
          setSelectedIds(previous => previous.filter(id => !removed.has(id)));
          if (result.error) {
            addToast({ title: `已移除 ${removed.size} 首。${result.error}`, color: "danger" });
            return removed.size > 0;
          }
          return true;
        } catch (error) {
          notifyError(error);
          return false;
        }
      },
    });
  };

  const trackAction = (track: WebDavTrack, action: string) => {
    if (!list) return;
    const item = webDavPlayItem(list.id, track);
    const player = usePlayList.getState();
    switch (action) {
      case "play":
        void player.play(item);
        break;
      case "next":
        player.addToNext(item);
        break;
      case "queue":
        addToQueue([track]);
        break;
      case "copy":
        void navigator.clipboard
          .writeText([track.artist, track.title].filter(Boolean).join(" - "))
          .then(() => addToast({ title: "已复制歌曲名", color: "success" }))
          .catch(notifyError);
        break;
      case "remove":
        removeTracks([track]);
        break;
      default:
        break;
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-col px-4" aria-label="WebDAV 远程列表">
      <div className="library-actions flex min-h-10 shrink-0 items-center justify-between gap-3">
        <h1 className="font-medium">远程列表</h1>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="flat" startContent={<RiAddLine size={18} />} onPress={() => setEditor({})}>
            新建 WebDAV 列表
          </Button>
          <IconButton
            aria-label="WebDAV 设置"
            tooltip="WebDAV 设置"
            variant="flat"
            isDisabled={!data}
            onPress={() => setSettingsOpen(true)}
          >
            <RiSettings3Line size={18} />
          </IconButton>
        </div>
      </div>
      {!data ? (
        <div className="flex flex-1 items-center justify-center">
          {error ? (
            <Button variant="flat" onPress={refresh}>
              重新加载远程列表
            </Button>
          ) : (
            <Spinner label="读取远程列表" />
          )}
        </div>
      ) : !list ? (
        <Empty title="添加 WebDAV 服务器上的音乐目录，即可播放其中的歌曲。" />
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-2 pt-3 pb-2">
            <Select
              aria-label="选择远程列表"
              size="sm"
              className="w-52"
              disallowEmptySelection
              selectedKeys={[list.id]}
              onChange={event => {
                if (event.target.value) chooseList(event.target.value);
              }}
              items={data.lists}
            >
              {item => <SelectItem key={item.id}>{item.name}</SelectItem>}
            </Select>
            <IconButton
              aria-label="更新远程列表"
              tooltip={`最近更新 ${new Date(list.syncedAt).toLocaleString("zh-CN", { hour12: false })}`}
              variant="flat"
              isLoading={list.isSyncing}
              onPress={update}
            >
              <RiRefreshLine size={18} />
            </IconButton>
            <IconButton
              aria-label="编辑远程列表"
              tooltip="编辑远程列表"
              variant="flat"
              onPress={() => setEditor({ list })}
            >
              <RiEditLine size={18} />
            </IconButton>
            <IconButton aria-label="移除远程列表" tooltip="移除远程列表" variant="flat" onPress={deleteList}>
              <RiDeleteBinLine size={18} />
            </IconButton>
            <span className="text-default-500 ml-2 text-xs">{list.tracks.length} 首歌曲</span>
            <span
              className="text-default-500 min-w-0 flex-1 truncate text-xs"
              title={`${list.url} · ${list.directory || "/"}`}
            >
              {new URL(list.url).host} · {list.directory || "/"}
            </span>
          </div>
          {list.error && (
            <p className="text-danger bg-danger-50 mb-2 shrink-0 rounded-md px-3 py-2 text-sm" role="status">
              {list.error}
            </p>
          )}
          <div className="library-actions flex shrink-0 flex-wrap items-center justify-between gap-2 py-2">
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                color="primary"
                className="dark:text-black"
                startContent={<RiPlayFill size={18} />}
                isDisabled={!targets.length}
                onPress={playAll}
              >
                {selectedTracks.length ? "播放选中" : "播放全部"}
              </Button>
              <IconButton
                aria-label="添加到播放列表"
                tooltip="添加到播放列表"
                variant="flat"
                isDisabled={!targets.length}
                onPress={() => addToQueue(targets)}
              >
                <RiPlayListAddLine size={18} />
              </IconButton>
              <LocatePlayingButton
                currentIndex={activeTrackIndex}
                missingMessage={
                  keyword.trim() ? "当前筛选结果中未找到正在播放的歌曲" : "未在当前列表中找到正在播放的歌曲"
                }
                scrollRef={scrollRef}
                rowHeight={RowHeight}
              />
              <Button
                size="sm"
                variant="flat"
                isDisabled={!list.tracks.length}
                onPress={() => {
                  setSelecting(!selecting);
                  setSelectedIds([]);
                }}
              >
                {selecting ? "结束多选" : "多选"}
              </Button>
              {selectedTracks.length > 0 && (
                <Button size="sm" variant="flat" color="danger" onPress={() => removeTracks(selectedTracks)}>
                  移除 {selectedTracks.length} 首
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Input
                aria-label="搜索远程歌曲"
                placeholder="搜索歌曲"
                size="sm"
                className="w-44"
                isClearable
                startContent={<RiSearchLine size={16} />}
                value={keyword}
                onValueChange={value => {
                  setKeyword(value);
                  setSelectedIds([]);
                }}
              />
              <Select
                aria-label="歌曲排序"
                size="sm"
                className="w-36"
                disallowEmptySelection
                selectedKeys={[listSort.key]}
                onChange={event => {
                  const field = sortFields.find(field => field.key === event.target.value);
                  if (field) setSort({ ...listSort, key: field.key });
                }}
              >
                {sortFields.map(field => (
                  <SelectItem key={field.key}>{field.name}</SelectItem>
                ))}
              </Select>
              <IconButton
                aria-label={listSort.descending ? "改为升序" : "改为降序"}
                tooltip={listSort.descending ? "改为升序" : "改为降序"}
                variant="flat"
                isDisabled={listSort.key === "default"}
                onPress={() => setSort({ ...listSort, descending: !listSort.descending })}
              >
                {listSort.descending ? <RiArrowDownLine size={16} /> : <RiArrowUpLine size={16} />}
              </IconButton>
            </div>
          </div>
          <RemoteTracksHeader
            selecting={selecting}
            someSelected={selectedTracks.length > 0}
            allSelected={filtered.length > 0 && selectedTracks.length === filtered.length}
            onSelectAll={value => setSelectedIds(value ? filtered.map(track => track.id) : [])}
          />
          <VirtualList
            key={list.id}
            scrollRef={scrollRef}
            className="min-h-0 flex-1"
            data={filtered}
            itemHeight={RowHeight}
            empty={<Empty title={keyword.trim() ? "没有匹配的歌曲" : "当前目录没有歌曲"} />}
            renderItem={(track, row) => (
              <RemoteTrackRow
                key={track.id}
                track={track}
                number={row.index + 1}
                active={row.index === activeTrackIndex}
                selecting={selecting}
                selected={selected.has(track.id)}
                onSelect={value =>
                  setSelectedIds(previous => (value ? [...previous, track.id] : previous.filter(id => id !== track.id)))
                }
                onAction={key => trackAction(track, key)}
              />
            )}
          />
        </>
      )}
      {editor && (
        <WebDavListEditor
          list={editor.list}
          onClose={() => setEditor(undefined)}
          onSaved={id => {
            chooseList(id);
            setEditor(undefined);
            refresh();
          }}
        />
      )}
      {settingsOpen && data && (
        <WebDavPreferencesModal preferences={data.preferences} onClose={() => setSettingsOpen(false)} />
      )}
    </section>
  );
};

export default RemoteMusicPage;
