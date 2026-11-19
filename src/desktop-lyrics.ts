import "./desktop-lyrics.css";

declare global {
  interface Window {
    desktopLyrics: DesktopLyricsRendererAPI;
  }
}

const root = document.getElementById("root")!;
document.title = "桌面歌词";
root.innerHTML = `
  <button type="button" aria-label="关闭桌面歌词" title="关闭桌面歌词">×</button>
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

root.querySelector("button")?.addEventListener("click", bridge.close);
const unsubscribe = bridge.onLine(line => {
  text.textContent = line.text;
  translation.textContent = line.translation ?? "";
  romanization.textContent = line.romanization ?? "";
});
window.addEventListener("unload", unsubscribe, { once: true });
