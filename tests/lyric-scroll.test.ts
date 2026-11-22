import { afterEach, expect, it, vi } from "vitest";

import { observeLyricScroll } from "@/components/lyrics/scroll";

afterEach(() => vi.unstubAllGlobals());

it("animates only overflow and tracks the audio clock across pauses, seeks, speed changes and resizing", () => {
  let resize!: () => void;
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  const row = document.createElement("div");
  row.innerHTML = '<div><div class="lyric-strip">long line</div></div><div><div class="lyric-strip">short</div></div>';
  const [long, short] = Array.from(row.querySelectorAll<HTMLElement>(".lyric-strip"));
  let width = 300;
  Object.defineProperty(long.parentElement, "clientWidth", { get: () => width });
  Object.defineProperty(short.parentElement, "clientWidth", { value: 300 });
  Object.defineProperty(long, "offsetWidth", { value: 700 });
  Object.defineProperty(short, "offsetWidth", { value: 300 });
  const animation = {
    currentTime: 0,
    playbackRate: 1,
    playState: "running",
    play() {
      this.playState = "running";
    },
    pause() {
      this.playState = "paused";
    },
    cancel: vi.fn(),
  };
  const start = vi.fn().mockReturnValue(animation);
  Object.defineProperty(long, "animate", { value: start });
  const shortStart = vi.fn();
  Object.defineProperty(short, "animate", { value: shortStart });
  const scroll = observeLyricScroll(row);
  scroll.update(1000, 4000, true, 1);
  expect(start).toHaveBeenCalledWith(
    expect.arrayContaining([{ transform: "translateX(-400px)", offset: 1 }]),
    expect.objectContaining({ duration: 4000 }),
  );
  expect(shortStart).not.toHaveBeenCalled();
  scroll.update(2450, 4000, false, 1);
  expect(animation).toMatchObject({ currentTime: 2450, playState: "paused" });
  scroll.update(500, 4000, true, 2);
  expect(animation).toMatchObject({ currentTime: 500, playbackRate: 2, playState: "running" });
  expect(start).toHaveBeenCalledTimes(1);
  width = 800;
  resize();
  expect(animation.cancel).toHaveBeenCalledTimes(1);
  scroll.disconnect();
  expect(disconnect).toHaveBeenCalledOnce();
});
