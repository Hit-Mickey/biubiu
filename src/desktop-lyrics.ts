import { desktopLyricsFontSizes } from "@shared/settings/desktop-lyrics";

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
    <button id="lyric-close" type="button" aria-label="关闭桌面歌词" title="关闭桌面歌词">×</button>
    <span id="lyric-error" role="status" hidden></span>
  </div>
  <div class="lyrics">
    <div id="lyric-text">暂无歌词</div>
    <div id="lyric-translation"></div>
    <div id="lyric-romanization"></div>
  </div>
`;

const bridge = window.desktopLyrics;
const text = document.getElementById("lyric-text")!;
const translation = document.getElementById("lyric-translation")!;
const romanization = document.getElementById("lyric-romanization")!;
const lock = document.querySelector<HTMLButtonElement>("#lyric-lock")!;
const color = document.querySelector<HTMLInputElement>("#lyric-color")!;
const size = document.querySelector<HTMLSelectElement>("#lyric-size")!;
const status = document.getElementById("lyric-error")!;
let locked = false;
let inlineUnlock = false;

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
document.getElementById("lyric-close")?.addEventListener("click", bridge.close);

const unsubscribeState = bridge.onState(state => {
  const justLocked = state.locked && !locked;
  locked = state.locked;
  inlineUnlock = state.inlineUnlock;
  root.toggleAttribute("data-locked", locked);
  root.toggleAttribute("data-inline-unlock", inlineUnlock);
  lock.textContent = locked ? "解锁歌词" : "锁定歌词";
  lock.title = locked ? "解锁歌词" : "锁定歌词后鼠标可穿透";
  color.value = state.appearance.color;
  size.value = String(state.appearance.fontSize);
  root.style.setProperty("--lyric-color", state.appearance.color);
  root.style.setProperty("--lyric-size", `${state.appearance.fontSize}px`);
  if (justLocked && inlineUnlock && lock.matches(":hover")) bridge.setUnlockHovered(true);
});
const unsubscribeHover = bridge.onHover(hovered => {
  root.setAttribute("data-native-hover", "");
  root.toggleAttribute("data-hovered", hovered);
  if (!hovered && locked && inlineUnlock) bridge.setUnlockHovered(false);
});
const unsubscribeLine = bridge.onLine(line => {
  text.textContent = line.text;
  translation.textContent = line.translation ?? "";
  romanization.textContent = line.romanization ?? "";
});
window.addEventListener(
  "unload",
  () => {
    unsubscribeState();
    unsubscribeHover();
    unsubscribeLine();
  },
  { once: true },
);
