import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Entries } from "@/store/desktop-playlists/database";

import {
  addPlaylistItems,
  applyFavoriteSync,
  deletePlaylist,
  exportDesktopPlaylists,
  favoriteDiff,
  importDesktopPlaylists,
  parseDesktopPlaylistsBackup,
  readFavoriteBaseline,
  readPlaylistPage,
  removePlaylistTrack,
  savePlaylist,
  unlinkFavorite,
  type NormalPlaylist,
} from "@/store/desktop-playlists";
import {
  compactPlayData,
  resolvePlaylistTracks,
  restorePlayData,
  trackKey,
  type PlaylistTrack,
} from "@/store/desktop-playlists/tracks";

// jsdom has no IndexedDB. Exercise the repository over isolated structured-cloned entries, recording its read scope.
const { records, reads } = vi.hoisted(() => ({ records: new Map<string, unknown>(), reads: [] as string[] }));
vi.mock("@/store/desktop-playlists/database", () => ({
  onDesktopPlaylistsChange: vi.fn(),
  transaction: async (_mode: string, run: (db: Entries) => Promise<unknown>) => {
    const stage = new Map(records);
    const value = await run({
      async get<T>(key: string) {
        reads.push(key);
        return structuredClone(stage.get(key)) as T | undefined;
      },
      put: (key, value) => stage.set(key, structuredClone(value)),
      delete: key => stage.delete(key),
      clear: () => stage.clear(),
    });
    records.clear();
    for (const [k, v] of stage) records.set(k, v);
    return value;
  },
}));

const au = (sid: number, title = `音频 ${sid}`): PlaylistTrack => ({ type: "audio", sid, title });
const snapshot = (tracks: PlaylistTrack[]) => ({ mid: 8, folderId: 108, title: "收藏", tracks, skipped: 0 });
const link = async (id: string) => ((await readPlaylistPage(id)).selected as NormalPlaylist).favorite;
const bv = "BV17x411w7KC";

beforeEach(() => {
  records.clear();
  reads.length = 0;
});

describe("desktop playlist repository", () => {
  it("keeps only ordered normal IDs in dynamic lists; changing, renaming and deleting a source is reflected immediately", async () => {
    const a = await savePlaylist({ name: "甲", items: [au(1, "首选"), au(2)] });
    const b = await savePlaylist({ name: "乙", items: [au(1, "重复"), au(3)] });
    const c = await savePlaylist({ name: "无关", items: [au(8)] });
    const d = await savePlaylist({ name: "动态", sourceIds: [b, a, b] });
    reads.length = 0;
    const first = await readPlaylistPage(d);
    expect(first.tracks).toEqual([au(1, "重复"), au(3), au(2)]);
    expect(reads).toEqual(["catalog", `tracks:${b}`, `tracks:${a}`]);
    expect(records.has(`tracks:${d}`)).toBe(false);
    expect(first.selected).toEqual({ id: d, kind: "dynamic", name: "动态", sourceIds: [b, a] });
    await savePlaylist({ id: a, name: "已改名" });
    await expect(addPlaylistItems(a, [au(4), au(2), { type: "audio", audioUrl: "file:///bad" }])).resolves.toEqual({
      added: 1,
      skipped: 1,
    });
    await removePlaylistTrack(b, "au:1");
    expect((await readPlaylistPage(d)).tracks).toEqual([au(3), au(1, "首选"), au(2), au(4)]);
    await savePlaylist({ id: d, name: "动态", sourceIds: [a, b] });
    expect((await readPlaylistPage(d)).tracks.map(trackKey)).toEqual(["au:1", "au:2", "au:4", "au:3"]);
    await expect(savePlaylist({ id: d, name: "坏", sourceIds: [d] })).rejects.toThrow();
    await expect(addPlaylistItems(d, [au(9)])).rejects.toThrow();
    await deletePlaylist(a);
    expect((await readPlaylistPage(d)).selected).toMatchObject({ sourceIds: [b] });
    expect((await readPlaylistPage(c)).tracks).toEqual([au(8)]);
  });

  it("round-trips a versioned, whitelisted backup; invalid references/version/track never replace current data", async () => {
    const id = await savePlaylist({
      name: "歌单",
      items: [{ ...au(1), audioUrl: "secret", cover: "bad", cookie: "token" }],
    });
    await savePlaylist({ name: "聚合", sourceIds: [id] });
    await applyFavoriteSync(id, undefined, snapshot([au(7)]), false);
    const saved = await exportDesktopPlaylists();
    expect(JSON.stringify(saved)).not.toMatch(/secret|audioUrl|cookie|cover/);
    await importDesktopPlaylists({ version: 1, playlists: [] });
    expect((await readPlaylistPage()).tracks).toEqual([]);
    await importDesktopPlaylists(saved);
    expect(await exportDesktopPlaylists()).toEqual(saved);
    const bad = {
      ...saved,
      playlists: [...saved.playlists, { id: "extra", name: "orphan", kind: "dynamic", sourceIds: ["gone"] }],
    };
    await expect(importDesktopPlaylists(bad)).rejects.toThrow();
    expect(() => parseDesktopPlaylistsBackup({ version: 2, playlists: [] })).toThrow();
    expect(() =>
      parseDesktopPlaylistsBackup({
        version: 1,
        playlists: [{ id, name: "x", kind: "normal", tracks: [{ type: "audio", sid: -1 }] }],
      }),
    ).toThrow();
    expect(await exportDesktopPlaylists()).toEqual(saved);
  });

  it("compares remote baselines, preserves local entries and opt-outs, removes only explicitly confirmed remote losses", async () => {
    const id = await savePlaylist({ name: "我的", items: [au(5)] });
    await applyFavoriteSync(id, undefined, snapshot([au(1), au(2), au(3)]), false);
    const oldLink = await link(id);
    await removePlaylistTrack(id, "au:2");
    const next = snapshot([au(2), au(3, "新标题"), au(4)]);
    const diff = favoriteDiff(await readFavoriteBaseline(id), (await readPlaylistPage(id)).tracks, next.tracks);
    expect(diff).toEqual({ added: [au(4)], removed: [{ key: "au:1", title: "音频 1" }], renamed: [au(3, "新标题")] });
    await applyFavoriteSync(id, oldLink, next, false);
    expect((await readPlaylistPage(id)).tracks).toEqual([au(5), au(1), au(3, "新标题"), au(4)]);
    await expect(applyFavoriteSync(id, oldLink, snapshot([]), true)).rejects.toThrow("重新预览");
    await applyFavoriteSync(id, await link(id), snapshot([au(3, "新标题")]), true);
    expect((await readPlaylistPage(id)).tracks).toEqual([au(5), au(1), au(3, "新标题")]);
    await unlinkFavorite(id);
    expect(await readFavoriteBaseline(id)).toEqual([]);
    expect(await link(id)).toBeUndefined();
    expect((await readPlaylistPage(id)).tracks).toHaveLength(3);
  });
});

describe("compact playable references", () => {
  it("preserves exact expanded parts for playback, without transient URLs, queue IDs or cookies", () => {
    const item = {
      type: "mv",
      source: "online",
      bvid: bv,
      title: "视频",
      cid: "22",
      aid: "11",
      totalPage: 3,
      pageIndex: 2,
      hasMultiPart: true,
      pageTitle: "第二首",
      id: "queue-row",
      audioUrl: "signed",
      pageCover: "https://cdn.test/?secret",
      cookie: "token",
    };
    const part = compactPlayData(item)!;
    expect(trackKey(part)).toBe(`${bv}:22`);
    expect(JSON.stringify(part)).not.toMatch(/queue-row|Url|token|Cover|cdn.test/);
    expect(restorePlayData(part)).toMatchObject({
      bvid: bv,
      cid: "22",
      aid: "11",
      pageTitle: "第二首",
      pageIndex: 2,
      totalPage: 3,
    });
    expect(restorePlayData(part)?.id).not.toBe(restorePlayData(part)?.id);
    expect(trackKey(compactPlayData({ ...item, cid: "11", totalPage: 1 })!)).toBe(
      trackKey(compactPlayData({ type: "mv", bvid: bv })!),
    );
    for (const value of [
      { ...item, bvid: "https://evil" },
      { ...item, cid: "NaN" },
      { type: "audio", sid: 0 },
      { source: "local", type: "audio", id: "file:///private" },
      { source: "webdav", type: "audio", id: "ok", webDavListId: "../secret" },
    ])
      expect(compactPlayData(value)).toBeUndefined();
  });

  it("resolves trusted local IDs only on demand, skips missing files and regenerates internal WebDAV URLs", async () => {
    const local = compactPlayData({
      type: "audio",
      source: "local",
      id: "file-id",
      title: "local",
      audioUrl: "file:///other",
    })!;
    const dav = compactPlayData({
      type: "audio",
      source: "webdav",
      id: "dav-id",
      webDavListId: "list-id",
      title: "file:///private",
      audioUrl: "https://user:password@example.test/",
    })!;
    expect(restorePlayData(local)).toBeUndefined();
    expect(restorePlayData(local, "https://external/file")).toBeUndefined();
    const scan = vi.fn().mockResolvedValue([{ id: "file-id", path: "C:\\音乐\\a# 1.mp3" }]);
    const original = window.electron;
    try {
      window.electron = { resolveLocalMusic: scan } as unknown as typeof original;
      const davOnly = await resolvePlaylistTracks([dav]);
      expect(scan).not.toHaveBeenCalled();
      expect(davOnly[0]).toMatchObject({
        id: "dav-id",
        title: "WebDAV 歌曲",
        audioUrl: "biu-webdav://audio/list-id/dav-id",
      });
      const items = await resolvePlaylistTracks([
        local,
        dav,
        local,
        { ...local, source: "local", type: "audio", id: "gone" },
      ]);
      expect(scan).toHaveBeenCalledExactlyOnceWith(["file-id", "gone"]);
      expect(items.map(i => i.id)).toEqual(["file-id", "dav-id", "file-id"]);
      expect(items[0].audioUrl).toBe("file:///C:/%E9%9F%B3%E4%B9%90/a%23%201.mp3");
    } finally {
      window.electron = original;
    }
  });
});
