import { maxLyricLength } from "@shared/lyrics";

const clock = String.raw`(\d{1,4}):([0-5]?\d)(?:[.:](\d{1,6}))?`;
const lineTag = new RegExp(`\\[${clock}\\]`, "y");
const wordTag = new RegExp(`\\[${clock}\\]|<${clock}>`, "g");
const metadata = /^\[[a-z][\w-]*:[^\]]*\]$/i;
const maxLines = 5000;

function timestamp(match: RegExpExecArray, offset: number, group = 1) {
  return Math.max(
    0,
    +match[group] * 60_000 + +match[group + 1] * 1000 + Number(((match[group + 2] ?? "") + "000").slice(0, 3)) - offset,
  );
}

function splitWords(body: string, time: number, offset: number): LyricLine {
  let start = time;
  let pos = 0;
  const words: LyricWord[] = [];
  let end: number | undefined;
  for (const mark of body.matchAll(wordTag)) {
    const next = timestamp(mark, offset, mark[1] === undefined ? 4 : 1);
    const text = body.slice(pos, mark.index);
    if (words.length >= 512) return { time, text: body.replace(wordTag, "").trim() };
    if (text) words.push({ time: start, end: Math.max(start, next), text });
    start = Math.max(start, next);
    pos = mark.index + mark[0].length;
    if (pos === body.length) end = start;
  }
  if (!pos) return { time, text: body.trim() };
  if (pos < body.length) words.push({ time: start, text: body.slice(pos) });
  return { time, end, text: words.map(w => w.text).join(""), words };
}

/** NetEase YRC uses absolute millisecond starts and explicit durations. */
function yrcLine(line: string, offset: number): LyricLine | undefined {
  const row = /^\[(\d{1,9}),(\d{1,9})\]/.exec(line);
  if (!row) return;
  const time = Math.max(0, +row[1] - offset);
  const words: LyricWord[] = [];
  let previous: RegExpExecArray | undefined;
  const pushWord = (to: number) => {
    if (!previous) return;
    const text = line.slice(previous.index + previous[0].length, to);
    const start = Math.max(0, +previous[1] - offset);
    if (text && start >= (words.at(-1)?.time ?? time)) words.push({ time: start, end: start + +previous[2], text });
  };
  const marker = /\((\d{1,9}),(\d{1,9}),\d+\)/g;
  for (const mark of line.matchAll(marker)) {
    if (words.length >= 512) return { time, end: time + +row[2], text: line.slice(row[0].length).replace(marker, "") };
    pushWord(mark.index);
    previous = mark;
  }
  pushWord(line.length);
  if (words.length) return { time, end: time + +row[2], text: words.map(w => w.text).join(""), words };
}

function addCompanion(line: LyricLine, text: string) {
  if (!text || text === line.text || text === line.translation) return;
  if (!line.translation) line.translation = text;
  else if (!line.romanization) line.romanization = text;
}

function parseTrack(raw = "") {
  raw = raw.slice(0, maxLyricLength).trim();
  const offset = Number(/^\s*\[offset:\s*([+-]?\d{1,8})\s*\]\s*$/im.exec(raw)?.[1] ?? 0);
  const byTime = new Map<number, LyricLine>();
  let previous: LyricLine[] = [];
  const add = (row: LyricLine) => {
    const existing = byTime.get(row.time);
    if (existing?.text) {
      addCompanion(existing, row.text);
      return existing;
    }
    byTime.set(row.time, row);
    return row;
  };
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || metadata.test(line) || /^\{\s*"t"\s*:/.test(line)) continue;
    if (byTime.size >= maxLines) break;
    const starts: number[] = [];
    let pos = 0;
    lineTag.lastIndex = 0;
    let tag: RegExpExecArray | null;
    while ((tag = lineTag.exec(line))) {
      if (starts.length < maxLines - byTime.size) starts.push(timestamp(tag, offset));
      pos = lineTag.lastIndex;
    }
    if (starts.length) {
      const first = splitWords(line.slice(pos), starts[0], offset);
      previous = starts.map((time, i) => add(i ? { time, text: first.text } : first));
    } else {
      const row = yrcLine(line, offset);
      if (row) previous = [add(row)];
      else if (previous.length) previous.forEach(original => addCompanion(original, line));
    }
  }
  const sorted = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
  for (let i = 0; i + 1 < sorted.length; i++) sorted[i].end = Math.min(sorted[i].end ?? Infinity, sorted[i + 1].time);
  const plain = sorted.length ? "" : raw.replace(/^[ \t]*\[[a-z][\w-]*:[^\]\r\n]*\][ \t]*(?:\r?\n|$)/gim, "").trim();
  return { lines: sorted.filter(row => row.text.trim()), plain };
}

export function parseLyrics({ lyrics, tLyrics, romaLyrics }: LyricText) {
  const original = parseTrack(lyrics || tLyrics || romaLyrics);
  let plainTranslation = "";
  let plainRomanization = "";
  for (const [field, text] of [
    ["translation", tLyrics],
    ["romanization", romaLyrics],
  ] as const) {
    if (!text || text === (lyrics || tLyrics || romaLyrics)) continue;
    const side = parseTrack(text);
    if (original.lines.length) {
      if (side.lines.length) {
        const byTime = new Map(side.lines.map(row => [row.time, row.text]));
        original.lines.forEach(row => {
          row[field] = byTime.get(row.time) || row[field];
        });
      } else {
        const texts = side.plain.split("\n");
        if (texts.length === original.lines.length)
          original.lines.forEach((row, i) => {
            row[field] = texts[i];
          });
      }
    } else {
      const value = side.plain || side.lines.map(row => row.text).join("\n");
      if (field === "translation") plainTranslation = value;
      else plainRomanization = value;
    }
  }
  return { ...original, plainTranslation, plainRomanization };
}

/** Binary search works for backward seeks as well as forward play. */
export function lastStarted(rows: readonly { time: number }[], ms: number) {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (rows[mid].time <= ms) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

export function activeLineAt(rows: LyricLine[], ms: number) {
  const index = lastStarted(rows, ms);
  if (index < 0) return rows.length ? 0 : -1; // keep the first line centered during the intro
  return ms < (rows[index].end ?? Infinity) ? index : -1;
}
