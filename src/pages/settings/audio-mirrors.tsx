import { useEffect, useRef, useState } from "react";

import { Button } from "@heroui/react";

import { getAudioUrl, getDashUrl } from "@/common/utils/audio";
import { mediaHost, sampleMirror } from "@/common/utils/audio-cdn";
import { usePlayList } from "@/store/play-list";
import { useSettings } from "@/store/settings";

export default function AudioMirrors() {
  const preferred = useSettings(s => s.preferredAudioHost);
  const [rows, setRows] = useState<{ host: string; result: string }[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const test = async () => {
    const track = usePlayList.getState().getPlayItem();
    if (
      !track ||
      track.source === "webdav" ||
      track.source === "local" ||
      (!track.sid && (!track.bvid || !track.cid))
    ) {
      setMessage("请先播放一首 B 站歌曲，再测试其可用线路。");
      return;
    }
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setMessage("");
    setRows([]);
    try {
      const stream = track.sid ? await getAudioUrl(track.sid) : await getDashUrl(track.bvid!, track.cid!);
      const nodes = new Map<string, string>();
      for (const url of stream.mirrors ?? []) {
        const host = mediaHost(url);
        if (host && !nodes.has(host) && nodes.size < 8) nodes.set(host, url);
      }
      if (!nodes.size && !controller.signal.aborted) setMessage("没有可测速的 HTTPS 音频线路");
      for (const [host, url] of nodes) {
        if (controller.signal.aborted) return;
        const result = await sampleMirror(url, controller.signal).then(
          speed => `${speed} KiB/s`,
          () => "测速失败",
        );
        if (!controller.signal.aborted) setRows(old => [...old, { host, result }]);
      }
    } catch {
      if (!controller.signal.aborted) setMessage("无法获取当前歌曲的可用线路");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <section className="space-y-2">
      <h2>播放线路</h2>
      <p className="text-foreground-500 text-sm">
        首选：{preferred || "自动"}。仅从 B 站返回的地址中选择；从下次获取播放地址起生效。测速不会切歌。
      </p>
      <div className="flex gap-2">
        <Button size="sm" isDisabled={busy} onPress={test}>
          测试当前歌曲线路
        </Button>
        {busy && (
          <Button
            size="sm"
            onPress={() => {
              active.current?.abort();
              setBusy(false);
            }}
          >
            取消
          </Button>
        )}
        {preferred && (
          <Button size="sm" onPress={() => useSettings.getState().update({ preferredAudioHost: "" })}>
            恢复自动
          </Button>
        )}
      </div>
      <p role="status">{message}</p>
      {rows.map(({ host, result }) => (
        <div key={host} className="flex items-center gap-2 text-sm">
          <span>
            {host} · {result}
          </span>
          <Button size="sm" variant="light" onPress={() => useSettings.getState().update({ preferredAudioHost: host })}>
            首选此线路
          </Button>
        </div>
      ))}
    </section>
  );
}
