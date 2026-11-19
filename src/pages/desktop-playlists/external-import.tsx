import { useEffect, useRef, useState } from "react";

import { Button, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";

import type { PlayItem } from "@/store/play-list";

import { formatDuration } from "@/common/utils/time";
import { parseExternalPlaylist } from "@shared/external-playlist";

import {
  makePreview,
  matchRows,
  type PreviewRow,
  resolveVideo,
  selectedItems,
  withVideoChoice,
} from "./external-match";

export interface ExternalImportProps {
  onClose: () => void;
  onImport: (title: string, items: PlayItem[]) => void | Promise<void>;
}

type Operation = "读取" | "匹配" | "验证" | "保存";
const pageSize = 8;
const maxPlaylistName = 80;

/** The playlist page mounts this dialog on demand; nothing is fetched on mount or while typing. */
export default function ExternalImport({ onClose, onImport }: ExternalImportProps) {
  const [input, setInput] = useState("");
  const [title, setTitle] = useState("");
  const [total, setTotal] = useState<number>();
  // Keep one working list. Each match updates just its slot, the counters and (if visible) one small page.
  const allRows = useRef<PreviewRow[]>([]);
  const [preview, setPreview] = useState({
    visible: [] as PreviewRow[],
    page: 0,
    length: 0,
    pending: 0,
    unavailable: 0,
    failed: 0,
    chosen: 0,
  });
  const { visible, page, length, pending, unavailable, failed, chosen } = preview;
  const [editing, setEditing] = useState<number>();
  const [bv, setBv] = useState("");
  const [notice, setNotice] = useState("");
  const [operation, setOperation] = useState<Operation>();
  const job = useRef<AbortController | null>(null);
  const busy = Boolean(operation);
  const saving = operation === "保存";

  useEffect(
    () => () => {
      job.current?.abort();
      job.current = null;
    },
    [],
  );

  const perform = async (kind: Operation, action: (signal: AbortSignal) => Promise<void>) => {
    if (job.current) return;
    const controller = new AbortController();
    job.current = controller;
    setOperation(kind);
    setNotice("");
    try {
      await action(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) {
        const message =
          error instanceof Error
            ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
            : "请稍后重试";
        setNotice(`${kind}失败：${message}`);
      }
    } finally {
      if (job.current === controller) {
        job.current = null;
        setOperation(undefined);
      }
    }
  };

  const stop = () => {
    job.current?.abort();
    job.current = null;
    setOperation(undefined);
    setNotice(operation === "匹配" ? "匹配已停止。已完成的结果保留，可以继续匹配或只保存已选项。" : "本次请求已取消");
  };

  const close = () => {
    if (saving) return;
    job.current?.abort();
    job.current = null;
    onClose();
  };

  const read = () =>
    perform("读取", async signal => {
      const ref = parseExternalPlaylist(input);
      if (!ref) throw new Error("请输入网易云或 QQ音乐的完整歌单链接，或 netease:数字 / qq:数字；不支持短链和单曲链接");
      const api = window.electron.externalPlaylist;
      const id = crypto.randomUUID();
      const abort = () => api.cancel(id);
      signal.addEventListener("abort", abort, { once: true });
      try {
        const playlist = await api.read(ref, id);
        signal.throwIfAborted();
        setTitle(playlist.title.slice(0, maxPlaylistName));
        setTotal(playlist.total);
        const rows = makePreview(playlist.tracks);
        allRows.current = rows;
        const available = rows.reduce((n, row) => n + Number(Boolean(row.track)), 0);
        setPreview({
          visible: rows.slice(0, pageSize),
          page: 0,
          length: rows.length,
          pending: available,
          unavailable: rows.length - available,
          failed: 0,
          chosen: 0,
        });
        setInput("");
        if (!playlist.tracks.length) setNotice(playlist.total ? "平台没有返回可用的曲目信息" : "这是一个空歌单");
      } finally {
        signal.removeEventListener("abort", abort);
      }
    });

  const showPage = (next: number) => {
    const visible = allRows.current.slice(next * pageSize, (next + 1) * pageSize);
    setPreview(prev => ({ ...prev, page: next, visible }));
  };

  const changeRow = (index: number, update: (previous: PreviewRow) => PreviewRow) => {
    const old = allRows.current[index];
    const row = update(old);
    allRows.current[index] = row;
    setPreview(prev => {
      const i = index - prev.page * pageSize;
      return {
        ...prev,
        visible: i >= 0 && i < prev.visible.length ? prev.visible.with(i, row) : prev.visible,
        pending: prev.pending + Number(row.state === "pending") - Number(old.state === "pending"),
        failed: prev.failed + Number(row.state === "failed") - Number(old.state === "failed"),
        chosen: prev.chosen + Number(Boolean(row.selected)) - Number(Boolean(old.selected)),
      };
    });
  };

  const startMatch = (state: "pending" | "failed") =>
    perform("匹配", async signal => {
      setEditing(undefined);
      await matchRows(allRows.current, state, signal, (index, row) => changeRow(index, () => row));
    });

  const correct = (index: number) =>
    perform("验证", async signal => {
      const video = await resolveVideo(bv, signal);
      signal.throwIfAborted();
      changeRow(index, row => withVideoChoice(row, video));
      setEditing(undefined);
    });

  const save = () =>
    perform("保存", async signal => {
      const items = selectedItems(allRows.current);
      if (!title.trim() || !items.length) throw new Error("请填写歌单名称并至少选择一首歌");
      await onImport(title.trim(), items);
      if (!signal.aborted) onClose();
    });

  const pages = Math.ceil(length / pageSize);

  return (
    <Modal
      isOpen
      onClose={close}
      isDismissable={!saving}
      isKeyboardDismissDisabled={saving}
      hideCloseButton={saving}
      size="3xl"
      radius="md"
      scrollBehavior="inside"
      disableAnimation
    >
      <ModalContent>
        <ModalHeader>从网易云 / QQ音乐导入歌单</ModalHeader>
        <ModalBody>
          {total === undefined ? (
            <form
              className="flex flex-col gap-3"
              onSubmit={e => {
                e.preventDefault();
                void read();
              }}
            >
              <Input
                label="公开歌单链接或带平台的 ID"
                placeholder="https://music.163.com/playlist?id=…"
                value={input}
                onValueChange={setInput}
                maxLength={2048}
                isDisabled={busy}
              />
              <p className="text-small text-default-500">
                支持带数字 ID 的官方歌单长链接，也可以输入 netease:123 或
                qq:123。短链接请先在平台打开，再复制完整歌单地址。
              </p>
              <p className="text-small text-default-500">
                按来源顺序分批读取公开的曲名、歌手和时长，不设歌曲总数上限，可随时停止。点击「开始匹配」后才逐首搜索
                B站，不导入外站音频。
              </p>
              <Button type="submit" size="sm" color="primary" className="self-start" isDisabled={busy || !input.trim()}>
                {operation === "读取" ? "正在分批读取…" : "读取歌单"}
              </Button>
            </form>
          ) : (
            <>
              <Input
                label="保存为歌单"
                value={title}
                onValueChange={setTitle}
                maxLength={maxPlaylistName}
                isDisabled={saving}
              />
              <div className="text-small text-default-500">
                来源共 {total} 首，已读取 {length - unavailable} 首曲目信息。按来源顺序保存已选的 B站视频；同一 BV
                在本地歌单中仅保留首次选中的位置。
                {unavailable > 0 && <p>{unavailable} 首缺少公开曲目信息，已保留原位置。</p>}
                {total > length && <p>平台未返回其余 {total - length} 首的位置，未纳入预览。</p>}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {pending > 0 && (
                  <Button
                    size="sm"
                    color="primary"
                    variant="flat"
                    isDisabled={busy}
                    onPress={() => startMatch("pending")}
                  >
                    {pending + unavailable === length ? "开始匹配" : "继续匹配"}（{pending}）
                  </Button>
                )}
                {failed > 0 && (
                  <Button size="sm" variant="flat" isDisabled={busy} onPress={() => startMatch("failed")}>
                    重试失败项（{failed}）
                  </Button>
                )}
                <span role="status" className="text-small text-default-500">
                  {operation === "匹配" ? "正在逐首匹配，" : ""}待匹配 {pending} · 失败 {failed} · 已选 {chosen}
                  {unavailable > 0 && ` · 来源缺失 ${unavailable}`}
                </span>
              </div>
              <ol start={page * pageSize + 1} className="divide-divider divide-y">
                {visible.map((row, offset) => {
                  const index = page * pageSize + offset;
                  return (
                    <li key={index} className="space-y-1 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-small font-medium break-words">
                            {index + 1}. {row.track?.title || "平台未公开曲目信息"}
                          </p>
                          <p className="text-tiny text-default-500">
                            {[
                              row.track?.artists.join(" / "),
                              row.track?.duration ? formatDuration(row.track.duration) : "",
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        </div>
                        {row.track && (
                          <Button
                            size="sm"
                            variant="light"
                            isDisabled={busy}
                            aria-label={`为第 ${index + 1} 首指定 BV 号`}
                            onPress={() => {
                              setEditing(editing === index ? undefined : index);
                              setBv("");
                              setNotice("");
                            }}
                          >
                            指定 BV
                          </Button>
                        )}
                      </div>
                      {row.candidates.length > 0 && (
                        <select
                          className="bg-default-100 text-foreground text-small w-full rounded-md p-2"
                          aria-label={`第 ${index + 1} 首的 B站匹配`}
                          value={row.selected}
                          disabled={busy}
                          onChange={e => {
                            const selected = e.currentTarget.value;
                            changeRow(index, prev => ({ ...prev, selected, note: undefined }));
                          }}
                        >
                          <option value="">跳过，不导入</option>
                          {row.candidates.map(v => (
                            <option key={v.bvid} value={v.bvid}>
                              {v.title} · {v.ownerName || "未知 UP"}
                              {v.duration ? ` · ${formatDuration(v.duration)}` : ""} · {v.bvid}
                            </option>
                          ))}
                        </select>
                      )}
                      <p className="text-tiny text-default-500">
                        {row.note ||
                          (row.state === "pending" ? "等待匹配" : row.selected ? "已选中，可改选或跳过" : "已跳过")}
                      </p>
                      {editing === index && (
                        <form
                          className="flex items-center gap-2"
                          onSubmit={e => {
                            e.preventDefault();
                            void correct(index);
                          }}
                        >
                          <Input
                            size="sm"
                            aria-label="B站视频 BV 号"
                            placeholder="输入完整 BV 号"
                            value={bv}
                            maxLength={64}
                            onValueChange={setBv}
                            isDisabled={busy}
                          />
                          <Button size="sm" type="submit" variant="flat" isDisabled={busy || !bv.trim()}>
                            验证并选用
                          </Button>
                        </form>
                      )}
                    </li>
                  );
                })}
              </ol>
              {pages > 1 && (
                <div className="flex items-center justify-center gap-3">
                  <Button variant="light" size="sm" isDisabled={!page} onPress={() => showPage(page - 1)}>
                    上一页
                  </Button>
                  <span className="text-small">
                    {page + 1} / {pages}
                  </span>
                  <Button variant="light" size="sm" isDisabled={page + 1 >= pages} onPress={() => showPage(page + 1)}>
                    下一页
                  </Button>
                </div>
              )}
            </>
          )}
          {notice && (
            <p role="alert" className="text-small text-warning-700">
              {notice}
            </p>
          )}
        </ModalBody>
        <ModalFooter className="flex-wrap items-center">
          {busy && !saving && (
            <Button size="sm" variant="flat" onPress={stop}>
              停止{operation}
            </Button>
          )}
          <Button size="sm" variant="light" isDisabled={saving} onPress={close}>
            关闭
          </Button>
          {total !== undefined && (
            <Button size="sm" color="primary" isDisabled={busy || !chosen || !title.trim()} onPress={save}>
              {saving ? "正在保存…" : `保存已选 ${chosen} 首`}
            </Button>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
