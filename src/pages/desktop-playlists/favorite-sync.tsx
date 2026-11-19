import { useEffect, useMemo, useRef, useState } from "react";

import {
  addToast,
  Button,
  Checkbox,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
} from "@heroui/react";
import { useRequest } from "ahooks";

import type { PlaylistTrack } from "@/store/desktop-playlists/tracks";

import {
  applyFavoriteSync,
  favoriteDiff,
  readFavoriteBaseline,
  unlinkFavorite,
  type FavoriteSnapshot,
  type NormalPlaylist,
} from "@/store/desktop-playlists";
import { useUser } from "@/store/user";

import { readFavoriteFolders, readFavoriteSnapshot } from "./favorite-reader";

function Changes({ label, items }: { label: string; items: readonly { title: string }[] }) {
  const [page, setPage] = useState(0);
  if (!items.length) return null;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer">
        {label}（{items.length}）
      </summary>
      <ul className="text-default-500 my-1 list-inside list-disc">
        {items.slice(page * 10, page * 10 + 10).map((item, i) => (
          <li key={i} className="truncate" title={item.title}>
            {item.title}
          </li>
        ))}
      </ul>
      {items.length > 10 && (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="flat" isDisabled={!page} onPress={() => setPage(page - 1)}>
            上一页
          </Button>
          {page + 1} / {Math.ceil(items.length / 10)}
          <Button
            size="sm"
            variant="flat"
            isDisabled={(page + 1) * 10 >= items.length}
            onPress={() => setPage(page + 1)}
          >
            下一页
          </Button>
        </div>
      )}
    </details>
  );
}

interface Props {
  list: NormalPlaylist;
  local: PlaylistTrack[];
  mid?: number;
  onClose: () => void;
}

export default function FavoriteSync({ list, local, mid, onClose }: Props) {
  const link = list.favorite;
  const [folderId, setFolderId] = useState(link?.folderId);
  const [preview, setPreview] = useState<{
    remote: FavoriteSnapshot;
    baseline: string[];
    link: NormalPlaylist["favorite"];
  }>();
  const [removeMissing, setRemoveMissing] = useState(false);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const {
    data: folders,
    loading,
    error: folderError,
    refresh,
  } = useRequest(() => readFavoriteFolders(mid!), { ready: !!mid && !link, refreshDeps: [mid] });
  const diff = useMemo(() => preview && favoriteDiff(preview.baseline, local, preview.remote.tracks), [local, preview]);
  const allowed = Boolean(mid && (!link || link.mid === mid));

  const inspect = async () => {
    if (!mid || !folderId || !allowed || reading) return;
    const controller = new AbortController();
    abort.current = controller;
    setReading(true);
    setError("");
    setPreview(undefined);
    setRemoveMissing(false);
    try {
      const [remote, baseline] = await Promise.all([
        readFavoriteSnapshot(mid, folderId, controller.signal),
        readFavoriteBaseline(list.id),
      ]);
      if (!controller.signal.aborted) setPreview({ remote, baseline, link });
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "读取收藏夹失败");
    } finally {
      if (!controller.signal.aborted) setReading(false);
    }
  };

  const save = async (unlink = false) => {
    setError("");
    setSaving(true);
    try {
      if (unlink) await unlinkFavorite(list.id);
      else {
        if (!preview || !allowed || useUser.getState().user?.mid !== preview.remote.mid)
          throw new Error("账号已切换，请重新预览");
        await applyFavoriteSync(list.id, preview.link, preview.remote, removeMissing);
      }
      addToast({ title: unlink ? "已解除关联，歌曲已保留" : "本地歌单已同步", color: "success" });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen scrollBehavior="inside" isDismissable={!saving} isKeyboardDismissDisabled={saving} onClose={onClose}>
      <ModalContent>
        <ModalHeader>{link ? "同步 B 站收藏夹" : "关联 B 站收藏夹"}</ModalHeader>
        <ModalBody>
          <p className="text-default-500 text-sm">
            只从自己的收藏夹读取到「{list.name}」。不会修改 B 站收藏夹，也不会删除文件。
          </p>
          {link && (
            <p className="text-sm">
              {link.title} · 最近同步 {new Date(link.syncedAt).toLocaleString()}
            </p>
          )}
          {!allowed && (
            <p className="text-warning text-sm">
              {mid ? "请切换到关联收藏夹的账号后再同步。" : "请先在侧栏登录 B 站。"}
            </p>
          )}
          {!link && allowed && (
            <>
              <Select
                size="sm"
                label="我的收藏夹"
                isLoading={loading}
                isDisabled={reading || saving}
                selectedKeys={folderId ? [String(folderId)] : []}
                onChange={e => {
                  setFolderId(Number(e.target.value) || undefined);
                  setPreview(undefined);
                }}
                items={folders ?? []}
              >
                {folder => <SelectItem key={String(folder.id)}>{folder.title}</SelectItem>}
              </Select>
              {folderError && (
                <p role="alert" className="text-danger text-sm">
                  {folderError.message}{" "}
                  <Button size="sm" variant="light" onPress={refresh}>
                    重试
                  </Button>
                </p>
              )}
              {folders && !folders.length && <p className="text-default-500 text-sm">当前账号没有可关联的收藏夹。</p>}
            </>
          )}
          {allowed && (
            <Button size="sm" variant="flat" isDisabled={!folderId || saving} isLoading={reading} onPress={inspect}>
              读取并预览远端变化
            </Button>
          )}
          {preview && diff && (
            <div className="flex flex-col gap-2" aria-live="polite">
              <p className="text-sm">
                {preview.remote.title} · 可播放 {preview.remote.tracks.length} 首
                {preview.remote.skipped > 0 && `（跳过 ${preview.remote.skipped} 项失效或非音视频内容）`}
              </p>
              <Changes label="远端新增" items={diff.added} />
              <Changes label="远端移除或失效" items={diff.removed} />
              <Changes label="标题变化" items={diff.renamed} />
              {!diff.added.length && !diff.removed.length && !diff.renamed.length && (
                <p className="text-default-500 text-sm">与上次同步相比没有变化。</p>
              )}
              <p className="text-default-500 text-xs">
                只合入新增曲目和标题变化；本地独有曲目保留。本地手动移除的曲目不会在下次同步时重新加入。
              </p>
              {diff.removed.length > 0 && (
                <Checkbox size="sm" color="warning" isSelected={removeMissing} onValueChange={setRemoveMissing}>
                  也从本歌单移除上述远端已移除的曲目（默认保留）
                </Checkbox>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="text-danger text-sm">
              {error}
            </p>
          )}
        </ModalBody>
        <ModalFooter className="flex-wrap">
          {link && (
            <Button
              size="sm"
              variant="light"
              className="mr-auto"
              isDisabled={saving || reading}
              onPress={() => save(true)}
            >
              解除关联
            </Button>
          )}
          <Button size="sm" variant="flat" isDisabled={saving} onPress={onClose}>
            取消
          </Button>
          <Button
            size="sm"
            color={removeMissing ? "warning" : "primary"}
            isDisabled={!preview || !allowed || reading}
            isLoading={saving}
            onPress={() => save()}
          >
            {removeMissing ? "确认同步并移除本地曲目" : "确认同步到本地"}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
