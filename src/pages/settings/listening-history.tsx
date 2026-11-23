import { useEffect, useMemo, useState } from "react";

import { Button, Switch } from "@heroui/react";

import {
  getListeningHistory,
  historyChanged,
  historyLimit,
  listeningDate,
  listeningSummary,
  replaceListeningHistory,
  type ListeningEntry,
} from "@/store/listening-history";
import { useSettings } from "@/store/settings";

export default function ListeningHistory() {
  const enabled = useSettings(s => s.recordLocalHistory);
  const [entries, setEntries] = useState<ListeningEntry[]>([]);
  const [day, setDay] = useState(() => listeningDate(Date.now()));
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [limit, setLimit] = useState(30);
  useEffect(() => {
    let stale = false;
    const read = () => {
      void getListeningHistory().then(
        data => {
          if (!stale) setEntries(data);
        },
        () => {
          if (!stale) setError("无法读取本机听歌记录");
        },
      );
    };
    read();
    window.addEventListener(historyChanged, read);
    return () => {
      stale = true;
      window.removeEventListener(historyChanged, read);
    };
  }, []);
  const { seconds, days, top } = useMemo(() => listeningSummary(entries), [entries]);
  const daily = useMemo(() => entries.filter(entry => listeningDate(entry.at) === day).reverse(), [entries, day]);
  const today = new Date();
  const dates = Array.from({ length: 28 }, (_, i) =>
    listeningDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 27 + i).getTime()),
  );
  return (
    <section className="min-w-0 space-y-3">
      <h2>本机听歌记录</h2>
      <Switch
        size="sm"
        classNames={{ base: "max-w-full" }}
        isSelected={enabled}
        onValueChange={recordLocalHistory => useSettings.getState().update({ recordLocalHistory })}
      >
        在此设备记录播放至结尾的曲目
      </Switch>
      <p className="text-foreground-500 text-sm">
        与 B 站账号历史分开；仅保留最近 {historyLimit} 次，不自动上传。时长按曲目长度累计，不是实际在线时间。
      </p>
      <p>
        共 {entries.length} 次 · {Math.floor(seconds / 3600)} 小时 {Math.floor((seconds % 3600) / 60)} 分钟
      </p>
      <div
        aria-label="最近四周的每日播放次数"
        className="grid max-w-lg grid-cols-7 gap-1 @max-[24rem]/settings-page:grid-cols-[repeat(auto-fit,minmax(min(100%,3rem),1fr))]"
      >
        {dates.map(date => {
          const count = days.get(date) ?? 0;
          const label = `${date}：${count} 次`;
          return (
            <button
              type="button"
              key={date}
              aria-label={label}
              aria-pressed={date === day}
              title={label}
              onClick={() => {
                setDay(date);
                setLimit(30);
              }}
              className={`bg-default-100 text-foreground relative rounded px-1 py-1 text-xs @max-[24rem]/settings-page:px-0.5 ${date === day ? "ring-foreground ring-1" : ""}`}
            >
              <span
                aria-hidden="true"
                className="absolute inset-0 rounded bg-[#087e42] dark:bg-[#289e59]"
                style={{ opacity: count ? Math.min(0.5, 0.1 + Math.log2(1 + count) * 0.08) : 0 }}
              />
              <span className="relative @max-[24rem]/settings-page:whitespace-nowrap">
                {date.slice(5)}
                <br />
                {count} 次
              </span>
            </button>
          );
        })}
      </div>
      <label className="flex flex-wrap items-center gap-2 text-sm">
        查看日期
        <input
          type="date"
          className="max-w-full min-w-0"
          value={day}
          onChange={e => {
            setDay(e.target.value);
            setLimit(30);
          }}
        />
      </label>
      {daily.length ? (
        <>
          <ul className="min-w-0">
            {daily.slice(0, limit).map((entry, i) => (
              <li key={i} className="truncate text-sm @max-[36rem]/settings-page:whitespace-normal">
                {new Date(entry.at).toLocaleTimeString()} · {entry.title}{" "}
                <span className="text-foreground-500">{entry.source}</span>
              </li>
            ))}
          </ul>
          {daily.length > limit && (
            <Button size="sm" onPress={() => setLimit(n => n + 30)}>
              更多
            </Button>
          )}
        </>
      ) : (
        <p className="text-foreground-500 text-sm">当天没有播放记录</p>
      )}
      {top.length > 0 && (
        <details>
          <summary>常听曲目（前十）</summary>
          <ol className="list-inside list-decimal break-words">
            {top.map((item, i) => (
              <li key={i}>
                {item.title} · {item.count} 次
              </li>
            ))}
          </ol>
        </details>
      )}
      {entries.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="flat"
            color={confirm ? "danger" : "default"}
            onPress={async () => {
              if (!confirm) {
                setConfirm(true);
                return;
              }
              try {
                await replaceListeningHistory([]);
              } catch {
                setError("清空失败");
              }
              setConfirm(false);
            }}
          >
            {confirm ? "确认清空本机记录" : "清空本机记录"}
          </Button>
          {confirm && (
            <Button size="sm" variant="light" onPress={() => setConfirm(false)}>
              取消
            </Button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="break-words">
          {error}
        </p>
      )}
    </section>
  );
}
