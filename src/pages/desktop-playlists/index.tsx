import { lazy, Suspense, useEffect, useState } from "react";

import { addToast, Button, Select, SelectItem, Spinner } from "@heroui/react";
import { RiAddLine, RiDeleteBinLine, RiEditLine, RiPlayFill, RiPlayListAddLine } from "@remixicon/react";
import { useRequest } from "ahooks";

import Empty from "@/components/empty";
import IconButton from "@/components/icon-button";
import { VirtualList } from "@/components/virtual-list";
import {
  addPlaylistItems,
  deletePlaylist,
  onDesktopPlaylistsChange,
  readPlaylistPage,
  removePlaylistTrack,
  savePlaylist,
  type Playlist,
} from "@/store/desktop-playlists";
import { compactPlayData, resolvePlaylistTracks, trackKey, type PlaylistTrack } from "@/store/desktop-playlists/tracks";
import { useModalStore } from "@/store/modal";
import { usePlayList, type PlayItem } from "@/store/play-list";
import { useUser } from "@/store/user";

import PlaylistEditor from "./playlist-editor";

const ExternalImport = lazy(() => import("./external-import"));
const FavoriteSync = lazy(() => import("./favorite-sync"));
const notifyError = (e: unknown) =>
  addToast({ title: e instanceof Error ? e.message : "歌单操作失败", color: "danger" });
const queueKey = (item: PlayItem) => {
  const track = compactPlayData(item);
  return track && trackKey(track);
};

export default function DesktopPlaylistsPage() {
  const [id, setId] = useState<string>();
  const { data, error, refresh } = useRequest(() => readPlaylistPage(id), { refreshDeps: [id] });
  useEffect(() => onDesktopPlaylistsChange(refresh), [refresh]);
  const list = data?.selected;
  const [editor, setEditor] = useState<{ kind: Playlist["kind"]; list?: Playlist }>();
  const [sync, setSync] = useState(false);
  const [external, setExternal] = useState(false);
  const [resolving, setResolving] = useState(false);
  const openConfirm = useModalStore(s => s.onOpenConfirmModal);
  const queueSize = usePlayList(s => s.list.length);
  const mid = useUser(s => (s.user?.isLogin ? s.user.mid : undefined));

  const addQueue = async (all: boolean) => {
    if (!list) return;
    const player = usePlayList.getState();
    const current = player.getPlayItem();
    const items = all ? player.list : current ? [current] : [];
    if (!items.length) return;
    try {
      const { added, skipped } = await addPlaylistItems(list.id, items);
      addToast({
        title: `已加入 ${added} 首${skipped ? `，跳过 ${skipped} 首不可识别曲目` : added === 0 ? "（曲目已在歌单中）" : ""}`,
        color: added ? "success" : "default",
      });
    } catch (e) {
      notifyError(e);
    }
  };

  const send = async (tracks: PlaylistTrack[], action: "queue" | "play-all" | "play-one") => {
    if (resolving || !tracks.length) return;
    setResolving(true);
    try {
      const items = await resolvePlaylistTracks(tracks);
      const missing = tracks.length - items.length;
      if (missing) addToast({ title: `有 ${missing} 首本地歌曲未在已配置目录中找到，已跳过`, color: "warning" });
      if (!items.length) return;
      const player = usePlayList.getState();
      if (action === "play-all") await player.playList(items);
      else {
        const before = player.list.length;
        player.addList(items, queueKey);
        const next = usePlayList.getState();
        if (action === "queue") addToast({ title: `已加入播放队列 ${next.list.length - before} 首`, color: "success" });
        else {
          const key = trackKey(tracks[0]);
          const row = next.list.find(t => queueKey(t) === key);
          if (row && row.id !== next.playId) await next.playListItem(row.id);
          else if (row && row.id === player.playId && player.getAudio().paused) player.togglePlay();
        }
      }
    } catch (e) {
      notifyError(e);
    } finally {
      setResolving(false);
    }
  };

  const removeList = () => {
    if (!list) return;
    openConfirm({
      title: `删除歌单「${list.name}」？`,
      description: "只移除本地歌单及对它的引用，不会删除文件或修改 B 站收藏夹。",
      type: "warning",
      confirmText: "删除歌单",
      onConfirm: async () => {
        try {
          await deletePlaylist(list.id);
          setId(undefined);
          return true;
        } catch (e) {
          notifyError(e);
          return false;
        }
      },
    });
  };

  const importItems = async (title: string, items: PlayItem[]) => {
    const newId = await savePlaylist({ name: title.trim().slice(0, 80) || "导入的歌单", items });
    setId(newId);
    setExternal(false);
    addToast({ title: "已导入为本地歌单", color: "success" });
  };

  return (
    <section aria-label="我的歌单" className="flex h-full min-h-0 flex-col px-4">
      <header className="flex min-h-10 shrink-0 flex-wrap items-center justify-between gap-2">
        <h1 className="font-medium">我的歌单</h1>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="flat"
            startContent={<RiAddLine size={16} />}
            isDisabled={!data}
            onPress={() => setEditor({ kind: "normal" })}
          >
            新建歌单
          </Button>
          <Button size="sm" variant="flat" isDisabled={!data} onPress={() => setEditor({ kind: "dynamic" })}>
            新建动态歌单
          </Button>
          <Button size="sm" variant="flat" isDisabled={!data} onPress={() => setExternal(true)}>
            导入外部歌单
          </Button>
        </div>
      </header>
      {error ? (
        <div className="m-auto text-center" role="alert">
          <p className="mb-2 text-sm">歌单读取失败：{error.message}</p>
          <Button size="sm" variant="flat" onPress={refresh}>
            重试
          </Button>
        </div>
      ) : !data ? (
        <Spinner className="m-auto" label="读取歌单" />
      ) : !list ? (
        <Empty title="还没有本地歌单。新建一个歌单，从播放队列添加歌曲。" />
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-2 pt-3 pb-2">
            <Select
              size="sm"
              className="w-52"
              aria-label="选择歌单"
              disallowEmptySelection
              selectedKeys={[list.id]}
              onChange={e => e.target.value && setId(e.target.value)}
              items={data.catalog}
            >
              {p => (
                <SelectItem key={p.id} textValue={p.name}>
                  {p.name}
                  {p.kind === "dynamic" && " · 动态"}
                </SelectItem>
              )}
            </Select>
            <IconButton
              tooltip="编辑歌单"
              aria-label="编辑歌单"
              variant="flat"
              onPress={() => setEditor({ kind: list.kind, list })}
            >
              <RiEditLine size={17} />
            </IconButton>
            <IconButton tooltip="删除歌单" aria-label="删除歌单" variant="flat" onPress={removeList}>
              <RiDeleteBinLine size={17} />
            </IconButton>
            <span className="text-default-500 text-xs">
              {list.kind === "normal" ? "普通歌单" : `动态歌单 · ${list.sourceIds.length} 个来源`} ·{" "}
              {data.tracks.length} 首
            </span>
            {list.kind === "normal" && (
              <Button size="sm" variant="light" onPress={() => setSync(true)}>
                {list.favorite ? `同步收藏夹：${list.favorite.title}` : "关联 B 站收藏夹"}
              </Button>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2 py-2">
            <Button
              size="sm"
              color="primary"
              className="dark:text-black"
              startContent={<RiPlayFill size={17} />}
              isDisabled={!data.tracks.length || resolving}
              onPress={() => send(data.tracks, "play-all")}
            >
              播放全部
            </Button>
            <IconButton
              aria-label="全部加入播放队列"
              tooltip="全部加入播放队列"
              variant="flat"
              isDisabled={!data.tracks.length || resolving}
              onPress={() => send(data.tracks, "queue")}
            >
              <RiPlayListAddLine size={17} />
            </IconButton>
            {list.kind === "normal" ? (
              <>
                <Button size="sm" variant="flat" isDisabled={!queueSize} onPress={() => addQueue(false)}>
                  加入当前曲目
                </Button>
                <Button size="sm" variant="flat" isDisabled={!queueSize} onPress={() => addQueue(true)}>
                  从播放队列加曲（{queueSize}）
                </Button>
              </>
            ) : (
              <span className="text-default-500 text-xs">按来源顺序实时合并；请在来源歌单中增减曲目。</span>
            )}
          </div>
          <VirtualList
            key={list.id}
            className="min-h-0 flex-1"
            itemHeight={44}
            data={data.tracks}
            empty={
              <Empty
                title={
                  list.kind === "normal"
                    ? "歌单为空，可从播放队列或收藏夹添加曲目。"
                    : "暂无歌曲，编辑歌单可选择普通歌单作为来源。"
                }
              />
            }
            renderItem={(track, row) => (
              <div className="hover:bg-content2 flex h-11 items-center gap-3 rounded-md px-2 text-sm">
                <span className="text-default-400 w-7 text-right text-xs">{row.index + 1}</span>
                <span className="min-w-0 flex-1 truncate" title={track.title}>
                  {track.type === "mv" && track.pageTitle ? `${track.title} · ${track.pageTitle}` : track.title}
                </span>
                <span className="text-default-500 text-xs">
                  {track.source === "local" ? "本地" : track.source === "webdav" ? "WebDAV" : "B 站"}
                </span>
                <IconButton
                  aria-label={`播放 ${track.title}`}
                  tooltip="播放"
                  isDisabled={resolving}
                  onPress={() => send([track], "play-one")}
                >
                  <RiPlayFill size={16} />
                </IconButton>
                <IconButton
                  aria-label={`入队 ${track.title}`}
                  tooltip="加入播放队列"
                  isDisabled={resolving}
                  onPress={() => send([track], "queue")}
                >
                  <RiPlayListAddLine size={16} />
                </IconButton>
                {list.kind === "normal" && (
                  <IconButton
                    aria-label={`移除 ${track.title}`}
                    tooltip="仅从本歌单移除"
                    onPress={() => removePlaylistTrack(list.id, trackKey(track)).catch(notifyError)}
                  >
                    <RiDeleteBinLine size={16} />
                  </IconButton>
                )}
              </div>
            )}
          />
        </>
      )}
      {editor && data && (
        <PlaylistEditor
          {...editor}
          catalog={data.catalog}
          onClose={() => setEditor(undefined)}
          onSaved={newId => {
            setId(newId);
            setEditor(undefined);
          }}
        />
      )}
      {sync && list?.kind === "normal" && data && (
        <Suspense fallback={<Spinner label="打开收藏夹" />}>
          <FavoriteSync
            key={`${list.id}:${mid}`}
            list={list}
            local={data.tracks}
            mid={mid}
            onClose={() => setSync(false)}
          />
        </Suspense>
      )}
      {external && (
        <Suspense fallback={<Spinner label="打开外部歌单导入" />}>
          <ExternalImport onClose={() => setExternal(false)} onImport={importItems} />
        </Suspense>
      )}
    </section>
  );
}
