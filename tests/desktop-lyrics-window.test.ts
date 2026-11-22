import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { listeners, invoke } = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  invoke: vi.fn(),
}));
vi.mock("@/bridge", () => ({}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, callback: (event: { payload: unknown }) => void) => {
    listeners.set(name, callback);
    return () => listeners.delete(name);
  },
}));

const emit = (name: string, payload: unknown) => listeners.get(name)!({ payload });
const line = () => document.getElementById("lyric-text")?.textContent;
let id = "a";
let applyState: (state: DesktopLyricsWindowState) => void;
const getTrackLyrics = vi.fn();
const getWebDavLyrics = vi.fn();

beforeEach(() => {
  vi.resetModules();
  listeners.clear();
  id = "a";
  document.body.innerHTML = '<div id="root"></div>';
  const subscribe = () => () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  window.desktopLyrics = {
    onLine: subscribe,
    onState: listener => {
      applyState = listener;
      return () => {};
    },
    onHover: subscribe,
    setLocked: vi.fn(),
    setAppearance: vi.fn().mockResolvedValue(undefined),
    setUnlockHovered: vi.fn(),
    close: vi.fn(),
  };
  window.electron = { getTrackLyrics, getWebDavLyrics } as unknown as ElectronAPI;
  invoke.mockImplementation(async (cmd: string) =>
    cmd === "audio_get_state" ? { playId: id, currentTime: 1 } : { id, source: "webdav", webDavListId: "list" },
  );
  getTrackLyrics.mockResolvedValue({});
});
afterEach(() => {
  window.dispatchEvent(new Event("unload"));
  vi.unstubAllGlobals();
});

it("reflows an inline bilingual cue in place and sends the layout preference from the floating toolbar", async () => {
  getWebDavLyrics.mockResolvedValue("[00:00]We ride all night 我们一路前行");
  await import("@/desktop-lyrics");
  await vi.waitFor(() => expect(line()).toBe("We ride all night"));
  const trans = document.getElementById("lyric-translation")!;
  expect(trans.textContent).toBe("我们一路前行");
  document.querySelector<HTMLInputElement>("#lyric-split")!.click();
  expect(window.desktopLyrics.setAppearance).toHaveBeenCalledWith({ splitBilingual: false });
  applyState({
    open: true,
    locked: false,
    inlineUnlock: true,
    appearance: { color: "#ffffff", fontSize: 26, splitBilingual: false },
  });
  expect(line()).toBe("We ride all night 我们一路前行");
  expect(trans.textContent).toBe("");
  expect(getWebDavLyrics).toHaveBeenCalledTimes(1);
});

it("waits for the selected track when the native queue is still syncing", async () => {
  let reads = 0;
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "audio_get_state") return { playId: id, currentTime: 6 };
    return ++reads === 1 ? null : { id, source: "webdav", webDavListId: "list" };
  });
  getWebDavLyrics.mockResolvedValue("[00:00]first\n[00:05]current");
  await import("@/desktop-lyrics");
  await vi.waitFor(() => expect(reads).toBe(1));
  emit("audio://state", { playId: id, currentTime: 7 });
  await vi.waitFor(() => expect(line()).toBe("current"));
  expect(getWebDavLyrics).toHaveBeenCalledTimes(1);
});

it("keeps the displayed sheet on preference changes, applies current-song edits and ignores other songs", async () => {
  getWebDavLyrics.mockResolvedValue("[00:00]first\n[00:03]second");
  await import("@/desktop-lyrics");
  await vi.waitFor(() => expect(line()).toBe("first"));
  emit("lyrics://updated", { key: "webdav-b", offset: 3500, text: { lyrics: "other" } });
  expect(line()).toBe("first");
  emit("lyrics://updated", { key: "webdav-a", offset: 3500, text: null });
  expect(line()).toBe("second");
  emit("lyrics://updated", {
    key: "webdav-a",
    offset: 0,
    text: { lyrics: "[00:00]adopted", tLyrics: "[00:00]translation" },
  });
  expect(line()).toBe("adopted");
  expect(document.getElementById("lyric-translation")?.textContent).toBe("translation");
  expect(getTrackLyrics).toHaveBeenCalledTimes(1);
  expect(getWebDavLyrics).toHaveBeenCalledTimes(1);
});

it("drops late results after a song change and retains an adoption made during a pending read", async () => {
  let finishA!: (text: string) => void;
  let finishB!: (text: string) => void;
  getWebDavLyrics
    .mockImplementationOnce(
      () =>
        new Promise<string>(resolve => {
          finishA = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<string>(resolve => {
          finishB = resolve;
        }),
    );
  await import("@/desktop-lyrics");
  await vi.waitFor(() => expect(getWebDavLyrics).toHaveBeenCalledTimes(1));
  id = "b";
  emit("audio://state", { playId: id, currentTime: 1 });
  await vi.waitFor(() => expect(getWebDavLyrics).toHaveBeenCalledTimes(2));
  emit("lyrics://updated", { key: "webdav-b", offset: 0, text: { lyrics: "adopted B" } });
  finishB("earlier B");
  finishA("earlier A");
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(line()).toBe("adopted B");
});
