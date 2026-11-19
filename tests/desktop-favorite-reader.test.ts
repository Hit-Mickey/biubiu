import { beforeEach, expect, it, vi } from "vitest";

import { readFavoriteFolders, readFavoriteSnapshot } from "@/pages/desktop-playlists/favorite-reader";

const api = vi.hoisted(() => ({ login: vi.fn(), folders: vi.fn(), page: vi.fn() }));
vi.mock("@/service/user-info", () => ({ getUserInfo: api.login }));
vi.mock("@/service/fav-folder-created-list-all", () => ({ getFavFolderCreatedListAll: api.folders }));
vi.mock("@/service/fav-resource", () => ({ getFavResourceList: api.page }));

const mid = 7;
const id = 107;
const signal = () => new AbortController().signal;
const info = { id, mid, media_count: 3, title: "收藏夹", cover: "unused" };
const video = { type: 2, id: 22, bvid: "BV17x411w7KC", title: "视频", attr: 0, cover: "secret" };
const song = { type: 12, id: 3, title: "音频", attr: 0 };
const page = (medias: unknown, more: boolean, params = info) => ({
  code: 0,
  data: { info: params, medias, has_more: more },
});

beforeEach(() => {
  api.login.mockResolvedValue({ code: 0, data: { mid, isLogin: true } });
});

it("uses the active login, only offers owned folders, projects each page to minimal playable references", async () => {
  api.folders.mockResolvedValue({ code: 0, data: { list: [info, { ...info, id: 99, mid: 17 }] } });
  expect(await readFavoriteFolders(mid)).toEqual([{ id, title: "收藏夹" }]);
  expect(api.folders).toHaveBeenCalledWith({ up_mid: mid });
  api.page.mockResolvedValueOnce(page([video, { ...song, attr: 9 }], true)).mockResolvedValueOnce(page([song], false));
  const result = await readFavoriteSnapshot(mid, id, signal());
  expect(result).toMatchObject({
    skipped: 1,
    tracks: [
      { type: "mv", bvid: video.bvid, aid: "22", title: video.title },
      { type: "audio", sid: 3, title: song.title },
    ],
  });
  expect(JSON.stringify(result)).not.toContain("secret");
  expect(api.page.mock.calls.map(call => call[0].pn)).toEqual([1, 2]);
});

it("denies a stale/different login before reading resources and rejects a mismatched folder owner", async () => {
  await expect(readFavoriteSnapshot(8, id, signal())).rejects.toThrow("账号");
  expect(api.page).not.toHaveBeenCalled();
  api.page.mockResolvedValueOnce(page([video], false, { ...info, mid: 9 }));
  await expect(readFavoriteSnapshot(mid, id, signal())).rejects.toThrow("不属于");
});

it("does not turn a failed page, a truncated result or a repeated page into remote removals", async () => {
  api.page.mockResolvedValueOnce(page([video], true)).mockResolvedValueOnce({ code: -403, message: "权限不足" });
  await expect(readFavoriteSnapshot(mid, id, signal())).rejects.toThrow("权限不足");
  api.page.mockResolvedValueOnce(page(null, false));
  await expect(readFavoriteSnapshot(mid, id, signal())).rejects.toThrow();
  api.page.mockResolvedValueOnce(page([video], false));
  await expect(readFavoriteSnapshot(mid, id, signal())).rejects.toThrow();
  api.page.mockResolvedValueOnce(page([video], true)).mockResolvedValueOnce(page([video, song], false));
  await expect(readFavoriteSnapshot(mid, id, signal())).rejects.toThrow();
  api.page.mockResolvedValueOnce(page(null, false, { ...info, media_count: 0 }));
  expect((await readFavoriteSnapshot(mid, id, signal())).tracks).toEqual([]);
});

it("stops paging when the dialog is closed", async () => {
  const controller = new AbortController();
  api.page.mockImplementationOnce(() => {
    controller.abort();
    return page([video], true);
  });
  await expect(readFavoriteSnapshot(mid, id, controller.signal)).rejects.toThrow();
  expect(api.page).toHaveBeenCalledTimes(1);
});
