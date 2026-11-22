import "./bridge";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { adoptedLyrics, lyricsCacheKey } from "@shared/lyrics";
import { defaultDesktopLyricsAppearance, desktopLyricsFontSizes } from "@shared/settings/desktop-lyrics";

import type { NativeAudioStateSnapshot } from "./bridge/native-audio";
import type { PlayData } from "./store/play-list";

import { getNativeLyrics } from "./components/lyrics/get-lyrics";
import { displayLyricLine, firstPlainLyric, translationSuffix } from "./components/lyrics/line-layout";
import { observeLyricScroll } from "./components/lyrics/scroll";
import { activeLineAt, parseLyrics } from "./components/lyrics/timeline";

import "./desktop-lyrics.css";

declare global {
  interface Window {
    desktopLyrics: DesktopLyricsRendererAPI;
  }
}

const root = document.getElementById("root")!;
document.title = "桌面歌词";
root.innerHTML = `
  <div class="toolbar" role="toolbar" aria-label="桌面歌词设置">
    <button id="lyric-lock" type="button" title="锁定歌词后鼠标可穿透">锁定歌词</button>
    <label>颜色 <input id="lyric-color" type="color" aria-label="桌面歌词颜色" value="#ffffff"></label>
    <label>字体大小
      <select id="lyric-size" aria-label="桌面歌词字体大小">
        ${desktopLyricsFontSizes.map(size => `<option value="${size}">${size} px</option>`).join("")}
      </select>
    </label>
    <label><input id="lyric-split" type="checkbox" checked aria-label="双语歌词分行">双语分行</label>
    <button id="lyric-close" type="button" aria-label="关闭桌面歌词" title="关闭桌面歌词">×</button>
    <span id="lyric-error" role="status" hidden></span>
  </div>
  <div class="lyrics">
    <div class="lyric-viewport"><span class="lyric-strip" id="lyric-text"></span></div>
    <div class="lyric-viewport"><span class="lyric-strip" id="lyric-translation"></span></div>
    <div class="lyric-viewport"><span class="lyric-strip" id="lyric-romanization"></span></div>
  </div>
`;

const bridge = window.desktopLyrics;
const text = document.getElementById("lyric-text")!;
const translation = document.getElementById("lyric-translation")!;
const romanization = document.getElementById("lyric-romanization")!;
const lock = document.querySelector<HTMLButtonElement>("#lyric-lock")!;
const color = document.querySelector<HTMLInputElement>("#lyric-color")!;
const size = document.querySelector<HTMLSelectElement>("#lyric-size")!;
const split = document.querySelector<HTMLInputElement>("#lyric-split")!;
const status = document.getElementById("lyric-error")!;
const scroller = observeLyricScroll(root.querySelector<HTMLElement>(".lyrics")!);
let locked = false;
let inlineUnlock = false;
let splitBilingual = defaultDesktopLyricsAppearance.splitBilingual;

function update(request: Promise<void>) {
  status.hidden = true;
  void request.catch(() => {
    status.textContent = "设置保存失败";
    status.hidden = false;
  });
}

lock.addEventListener("click", () => update(bridge.setLocked(!locked)));
lock.addEventListener("mouseenter", () => {
  if (locked && inlineUnlock) bridge.setUnlockHovered(true);
});
lock.addEventListener("mouseleave", () => {
  if (locked && inlineUnlock) bridge.setUnlockHovered(false);
});
color.addEventListener("change", () => update(bridge.setAppearance({ color: color.value })));
size.addEventListener("change", () => update(bridge.setAppearance({ fontSize: Number(size.value) })));
split.addEventListener("change", () => {
  const next = split.checked;
  split.checked = splitBilingual;
  update(bridge.setAppearance({ splitBilingual: next }));
});
document.getElementById("lyric-close")?.addEventListener("click", bridge.close);

function onWindowState(state: DesktopLyricsWindowState) {
  const justLocked = state.locked && !locked;
  locked = state.locked;
  inlineUnlock = state.inlineUnlock;
  root.toggleAttribute("data-locked", locked);
  root.toggleAttribute("data-inline-unlock", inlineUnlock);
  lock.textContent = locked ? "解锁歌词" : "锁定歌词";
  lock.title = locked ? "解锁歌词" : "锁定歌词后鼠标可穿透";
  color.value = state.appearance.color;
  size.value = String(state.appearance.fontSize);
  split.checked = splitBilingual = state.appearance.splitBilingual;
  root.style.setProperty("--lyric-color", state.appearance.color);
  root.style.setProperty("--lyric-size", `${state.appearance.fontSize}px`);
  if (justLocked && inlineUnlock && lock.matches(":hover")) bridge.setUnlockHovered(true);
  paint();
}
const unsubscribeHover = bridge.onHover(hovered => {
  root.setAttribute("data-native-hover", "");
  root.toggleAttribute("data-hovered", hovered);
  if (!hovered && locked && inlineUnlock) bridge.setUnlockHovered(false);
});
let wantedId: string | undefined;
let trackKey: string | undefined;
let reading = false;
let receivedState = false;
let revision = 0;
let currentTime = 0;
let playing = false;
let rate = 1;
let offset: number | undefined;
const emptySheet = parseLyrics({});
let sheet: typeof emptySheet | undefined;
let shown: { sheet: typeof sheet; index: number; split: boolean; placeholder: string } | undefined;

function paint() {
  if (!receivedState) return;
  const { lines, plain, plainTranslation, plainRomanization } = sheet ?? emptySheet;
  const ms = currentTime * 1000 + (offset ?? 0);
  const index = activeLineAt(lines, ms);
  const row = lines[index];
  const placeholder = lines.length || (wantedId && !sheet) ? "" : "暂无歌词";
  if (
    !shown ||
    shown.sheet !== sheet ||
    shown.index !== index ||
    shown.split !== splitBilingual ||
    shown.placeholder !== placeholder
  ) {
    shown = { sheet, index, split: splitBilingual, placeholder };
    const line = displayLyricLine(
      row ?? firstPlainLyric(plain || placeholder, plainTranslation, plainRomanization),
      splitBilingual,
    );
    text.textContent = splitBilingual ? line.text : line.text + translationSuffix(line.text, line.translation);
    translation.textContent = splitBilingual ? (line.translation ?? "") : "";
    romanization.textContent = line.romanization ?? "";
  }
  const end = row?.end ?? lines[index + 1]?.time;
  scroller.update(ms - (row?.time ?? 0), row && end !== undefined ? end - row.time : undefined, playing, rate);
}

async function loadTrack(id: string) {
  const current = ++revision;
  reading = true;
  try {
    const track = await invoke<PlayData | null>("audio_current_track");
    if (track?.id !== id || current !== revision) return;
    trackKey = lyricsCacheKey(track);
    const saved = await window.electron.getTrackLyrics(trackKey);
    if (current !== revision) return;
    offset ??= saved?.offset ?? 0;
    const adopted = saved?.edited ?? adoptedLyrics(saved);
    const native = adopted ? undefined : await getNativeLyrics(track);
    if (current !== revision) return;
    sheet = native?.subtitles ? { ...emptySheet, lines: native.subtitles } : parseLyrics(adopted ?? native ?? {});
  } catch {
    if (current === revision) sheet = emptySheet;
  } finally {
    if (current === revision) {
      reading = false;
      paint();
    }
  }
}

function onPlayback(snap: NativeAudioStateSnapshot) {
  receivedState = true;
  currentTime = snap.currentTime;
  playing = snap.isPlaying;
  rate = snap.rate;
  if (wantedId !== snap.playId) {
    ++revision;
    wantedId = snap.playId;
    trackKey = undefined;
    offset = undefined;
    sheet = undefined;
    reading = false;
  }
  if (wantedId && !trackKey && !reading) void loadTrack(wantedId);
  paint();
}

const unsubscribeState = bridge.onState(onWindowState);
const subscriptions = Promise.all([
  listen<NativeAudioStateSnapshot>("audio://state", ev => onPlayback(ev.payload)),
  listen<{ currentTime: number }>("audio://progress", ev => {
    currentTime = ev.payload.currentTime;
    paint();
  }),
  listen<{ key: string; offset: number; text: LyricText | null }>("lyrics://updated", ({ payload }) => {
    if (payload.key !== trackKey) return;
    offset = payload.offset;
    if (payload.text) {
      ++revision;
      reading = false;
      sheet = parseLyrics(payload.text);
    }
    paint();
  }),
]);
void subscriptions.then(async () => {
  const snap = await invoke<NativeAudioStateSnapshot>("audio_get_state");
  if (!receivedState) onPlayback(snap);
});
window.addEventListener(
  "unload",
  () => {
    scroller.disconnect();
    unsubscribeState();
    unsubscribeHover();
    void subscriptions.then(unsubscribers => unsubscribers.forEach(off => off()));
  },
  { once: true },
);
