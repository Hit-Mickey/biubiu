import { useEffect, useRef, useState } from "react";

import { Button } from "@heroui/react";

import { saveBlob } from "@/common/utils/save-blob";
import { useModalStore } from "@/store/modal";
import { maxBackupBytes, type BackupTarget } from "@shared/desktop-backup";

import type { LibraryBackup } from "./library-backup";

export default function BackupPanel() {
  const [targets, setTargets] = useState<BackupTarget[]>([]);
  const [id, setId] = useState("");
  const [names, setNames] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [pending, setPending] = useState<LibraryBackup>();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let current = true;
    window.electron.getBackupTargets().then(
      rows => {
        if (current) setTargets(rows);
      },
      () => {
        if (current) setMessage("读取 WebDAV 连接失败");
      },
    );
    return () => {
      current = false;
    };
  }, []);
  async function run(job: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await job();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "备份操作失败");
    } finally {
      setBusy(false);
    }
  }
  const list = async () => {
    const rows = await window.electron.listBackups(id);
    setNames(rows);
    setName(rows[0] ?? "");
  };
  return (
    <section className="min-w-0 space-y-3">
      <h2>曲库备份</h2>
      <p className="text-foreground-500 text-sm">
        保存桌面歌单、队列、本机听歌记录和通用外观／播放设置，不含音频、账号、密码或机器路径。恢复本地或 WebDAV
        曲目需保留原目录或连接。旧版设置 JSON 仍可在常规设置中导入。
      </p>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button
          size="sm"
          isDisabled={busy}
          onPress={() =>
            run(async () => {
              const { createBackup } = await import("./library-backup");
              const text = await createBackup();
              if (
                !(await saveBlob(
                  new Blob([text], { type: "application/json" }),
                  `biubiu-library-${new Date().toISOString().slice(0, 10)}.json`,
                ))
              )
                return;
              setMessage("已生成曲库备份");
            })
          }
        >
          导出曲库
        </Button>
        <Button
          size="sm"
          isDisabled={busy}
          onPress={() => {
            setPending(undefined);
            input.current?.click();
          }}
        >
          从文件恢复…
        </Button>
        <input
          type="file"
          hidden
          ref={input}
          accept=".json,application/json"
          onChange={e => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file)
              void run(async () => {
                if (file.size > maxBackupBytes) throw new Error("备份超过 8 MiB");
                const { parseBackup } = await import("./library-backup");
                setPending(parseBackup(await file.text()));
              });
          }}
        />
      </div>
      {targets.length ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="settings-row-control max-w-full min-w-0 @max-[36rem]/settings-page:w-full">
            <select
              aria-label="WebDAV 备份目标"
              className="bg-default-100 max-w-[min(100%,16rem)] min-w-0 rounded p-2 text-sm @max-[36rem]/settings-page:w-full @max-[36rem]/settings-page:max-w-full"
              disabled={busy}
              value={id}
              onChange={e => {
                setId(e.target.value);
                setNames([]);
                setName("");
                setPending(undefined);
                setMessage("");
              }}
            >
              <option value="">选择写入的 WebDAV 音乐目录</option>
              {targets.map(t => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <Button
            size="sm"
            isDisabled={!id || busy}
            onPress={() =>
              useModalStore.getState().onOpenConfirmModal({
                title: "备份到 WebDAV？",
                description: `将在「${targets.find(t => t.id === id)?.name}」的 BiuBiu-Backups/ 目录新建曲库备份，包括本机听歌记录。不会覆盖已有文件。`,
                type: "primary",
                confirmText: "确认上传",
                onConfirm: async () => {
                  await run(async () => {
                    const { createBackup } = await import("./library-backup");
                    const saved = await window.electron.uploadBackup(id, await createBackup());
                    setMessage(`已保存至 BiuBiu-Backups/${saved}`);
                    setNames(old => [saved, ...old]);
                    setName(saved);
                  });
                  return true;
                },
              })
            }
          >
            备份到 WebDAV
          </Button>
          <Button
            size="sm"
            isDisabled={!id || busy}
            onPress={() =>
              run(async () => {
                await list();
                setMessage("已读取云端备份列表");
              })
            }
          >
            列出云端备份
          </Button>
        </div>
      ) : (
        <p className="text-foreground-500 text-sm">先添加 WebDAV 远程列表，即可使用该目录备份。</p>
      )}
      {names.length > 0 && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="settings-row-control max-w-full min-w-0 @max-[36rem]/settings-page:w-full">
            <select
              aria-label="云端备份"
              value={name}
              disabled={busy}
              className="bg-default-100 max-w-[min(100%,20rem)] min-w-0 rounded p-2 text-sm @max-[36rem]/settings-page:w-full @max-[36rem]/settings-page:max-w-full"
              onChange={e => {
                setName(e.target.value);
                setPending(undefined);
              }}
            >
              {names.map(n => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </div>
          <Button
            size="sm"
            isDisabled={!name || busy}
            onPress={() =>
              run(async () => {
                setPending(undefined);
                const { parseBackup } = await import("./library-backup");
                setPending(parseBackup(await window.electron.downloadBackup(id, name)));
              })
            }
          >
            预览恢复…
          </Button>
        </div>
      )}
      {pending && (
        <div className="bg-default-100 min-w-0 space-y-2 rounded p-3">
          <p className="break-words">
            将替换 {pending.playlists.playlists.length} 个歌单、{pending.queue.length} 首队列曲目、
            {pending.history.length} 条听歌记录，并暂停当前播放。建议先导出现有曲库。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              color="danger"
              isDisabled={busy}
              onPress={() =>
                run(async () => {
                  const { restoreBackup } = await import("./library-backup");
                  await restoreBackup(pending);
                  setPending(undefined);
                  setMessage("曲库已恢复，点击队列中的曲目即可播放");
                })
              }
            >
              确认替换并恢复
            </Button>
            <Button size="sm" isDisabled={busy} onPress={() => setPending(undefined)}>
              取消
            </Button>
          </div>
        </div>
      )}
      <p role="status" className="text-sm break-words">
        {busy ? "处理中…" : message}
      </p>
    </section>
  );
}
