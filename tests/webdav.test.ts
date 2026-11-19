// @vitest-environment node
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { webDavMediaUrl } from "@shared/webdav";

import { clearWebDavCache } from "../electron/webdav/cache";
import { normalizeWebDavUrl, WebDavClient } from "../electron/webdav/client";
import {
  deleteWebDavList,
  getWebDavLibrary,
  getWebDavLyrics,
  getWebDavTrackMetadata,
  refreshWebDavList,
  removeWebDavTracks,
  saveWebDavList,
  setWebDavPreferences,
  webDavLibraryEvents,
} from "../electron/webdav/library";
import { registerWebDavProtocol } from "../electron/webdav/protocol";

const electron = vi.hoisted(() => ({
  directory: "",
  handle: vi.fn<(scheme: string, handler: (request: Request) => Promise<Response>) => void>(),
}));
vi.mock("../electron/utils", async () => {
  electron.directory = await mkdtemp(path.join(tmpdir(), "biu-webdav-test-"));
  return { getUserDataPath: () => electron.directory };
});
vi.mock("electron", () => ({
  default: {},
  protocol: { handle: electron.handle },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (password: string) => Buffer.from(password),
    decryptString: (password: Buffer) => password.toString(),
  },
}));
vi.mock("electron-log", () => ({ default: { debug: vi.fn(), warn: vi.fn() } }));

const url = "https://webdav.test/dav/";
const trackName = "歌曲 #1 & 100%.wav";
const encodedName = encodeURIComponent(trackName);
const root = "/dav/music/";
const trackPath = `${root}${encodedName}`;
const innerTrack = `${root}album/%E6%A0%87%E9%A2%98.wav`;
const lyricPath = trackPath.replace(/\.wav$/, ".lrc");
const coverPath = trackPath.replace(/\.wav$/, ".jpg");
const lrc = "[00:00.00]远程歌词";
const config = {
  name: "WebDAV 测试",
  url,
  username: "reader",
  password: "fixture-password",
  directory: "music",
  includeSubdirectories: true,
  lazyMetadata: true,
  removeRemoteFiles: false,
};

function makeWave() {
  const buffer = Buffer.alloc(44 + 8000 * 2 * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(buffer.length - 44, 40);
  return buffer;
}

function davEntry(href: string, size: number, collection = false) {
  return `<d:response><d:href>${href.replaceAll("&", "&amp;")}</d:href>
    <d:propstat><d:prop><d:getcontentlength/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
    <d:propstat><d:prop><d:resourcetype>${collection ? "<d:collection/>" : ""}</d:resourcetype>
    <d:getcontentlength>${size}</d:getcontentlength><d:creationdate>2025-01-02T03:04:05Z</d:creationdate>
    <d:getetag>"version"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
    </d:response>`;
}

function davResponse(entries: string[]) {
  return new Response(`<d:multistatus xmlns:d="DAV:">${entries.join("")}</d:multistatus>`, { status: 207 });
}

const wave = makeWave();
const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
let files: Map<string, Buffer>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  files = new Map([
    [trackPath, wave],
    [innerTrack, wave],
    [coverPath, image],
    [lyricPath, Buffer.from(lrc)],
  ]);
  const authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
  fetchMock = vi.fn<typeof fetch>(async (input, options) => {
    const { pathname } = new URL(String(input));
    const headers = new Headers(options?.headers);
    if (headers.get("authorization") !== authorization) return new Response(null, { status: 401 });
    if (options?.method === "PROPFIND") {
      expect(headers.get("depth")).toBe("1");
      if (pathname !== root && pathname !== `${root}album/`) return new Response(null, { status: 404 });
      const entries = [...files].flatMap(([filePath, bytes]) => {
        const relative = filePath.slice(pathname.length);
        return filePath.startsWith(pathname) && !relative.includes("/")
          ? [davEntry(filePath.slice(4), bytes.length)]
          : [];
      });
      if (pathname === root) entries.push(davEntry("/music/album/", 0, true));
      return davResponse(entries);
    }
    const bytes = files.get(pathname);
    if (!bytes) return new Response(null, { status: 404 });
    if (options?.method === "DELETE") {
      files.delete(pathname);
      return new Response(null, { status: 204 });
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(headers.get("range") ?? "");
    const start = Number(range?.[1] ?? 0);
    const end = Math.min(Number(range?.[2] || bytes.length - 1), bytes.length - 1);
    const responseHeaders = new Headers({ "content-length": String(end - start + 1), "accept-ranges": "bytes" });
    if (range) responseHeaders.set("content-range", `bytes ${start}-${end}/${bytes.length}`);
    return new Response(Uint8Array.from(bytes.subarray(start, end + 1)), {
      status: range ? 206 : 200,
      headers: responseHeaders,
    });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());
afterAll(() => rm(electron.directory, { recursive: true, force: true }));

describe("WebDAV library", () => {
  test("lists encoded paths, reads tags and serves authenticated seekable audio from its optional cache", async () => {
    const { id } = await saveWebDavList(config);
    const initial = getWebDavLibrary().lists.find(list => list.id === id)!;
    expect(initial.tracks.map(track => track.filename)).toEqual([trackName, "标题.wav"]);
    expect(initial.tracks[1].folder).toBe("album");
    expect(initial).not.toHaveProperty("password");
    expect(initial.hasPassword).toBe(true);
    expect(await readFile(path.join(electron.directory, "webdav.json"), "utf8")).not.toContain(config.password);
    expect(fetchMock.mock.calls.map(call => call[1]?.method)).toEqual(["PROPFIND", "PROPFIND"]);

    const track = initial.tracks[0];
    expect(await getWebDavTrackMetadata(id, track.id)).toMatchObject({ duration: 2, hasCover: true });
    expect(await getWebDavLyrics(id, track.id)).toBe(lrc);
    registerWebDavProtocol();
    const handle = electron.handle.mock.calls[0][1];
    const media = webDavMediaUrl("audio", id, track.id);
    const range = await handle(new Request(media, { headers: { Range: "bytes=4-31" } }));
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe(`bytes 4-31/${wave.length}`);
    expect(Buffer.from(await range.arrayBuffer())).toEqual(wave.subarray(4, 32));
    const cover = await handle(new Request(webDavMediaUrl("cover", id, track.id)));
    expect(cover.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await cover.arrayBuffer())).toEqual(image);

    setWebDavPreferences({ cacheAudio: true, debugLog: false });
    const full = await handle(new Request(media, { headers: { Range: "bytes=0-" } }));
    expect(Buffer.from(await full.arrayBuffer())).toEqual(wave);
    await expect
      .poll(() => readdir(path.join(electron.directory, "webdav-cache")))
      .toEqual([expect.stringMatching(/\.audio$/)]);
    const count = fetchMock.mock.calls.length;
    const cached = await handle(new Request(media, { headers: { Range: "bytes=-10" } }));
    expect(cached.status).toBe(206);
    expect(Buffer.from(await cached.arrayBuffer())).toEqual(wave.subarray(-10));
    expect(fetchMock.mock.calls.length).toBe(count);
    await clearWebDavCache();
    await deleteWebDavList(id);
  });

  test("keeps track IDs stable on refresh and deletes only explicitly selected remote files", async () => {
    await expect(saveWebDavList({ ...config, password: "incorrect" })).rejects.toThrow("账号和密码");
    const { id } = await saveWebDavList(config);
    const original = getWebDavLibrary().lists.find(list => list.id === id)!.tracks[0];
    await removeWebDavTracks(id, [original.id], false);
    expect(files.has(trackPath)).toBe(true);
    expect(getWebDavLibrary().lists.find(list => list.id === id)?.tracks).toHaveLength(1);
    await refreshWebDavList(id);
    expect(getWebDavLibrary().lists.find(list => list.id === id)?.tracks[0].id).toBe(original.id);
    fetchMock.mockResolvedValueOnce(
      davResponse([`<d:response><d:href>${root}</d:href><d:status>HTTP/1.1 403 Forbidden</d:status></d:response>`]),
    );
    await expect(refreshWebDavList(id)).rejects.toThrow("拒绝访问");
    expect(getWebDavLibrary().lists.find(list => list.id === id)?.tracks).toHaveLength(2);

    await saveWebDavList({ ...config, id, password: undefined, removeRemoteFiles: true });
    const change = vi.fn();
    webDavLibraryEvents.once("change", change);
    const result = await removeWebDavTracks(id, [original.id], true);
    expect(result.removed).toEqual([original.id]);
    expect(change).toHaveBeenCalledWith([original.id]);
    expect(files.has(trackPath)).toBe(false);
    expect(files.has(innerTrack)).toBe(true);
    await deleteWebDavList(id);
    expect(files.has(innerTrack)).toBe(true);
  });

  test("does not forward credentials to a redirected media host", async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "https://cdn.test/track.wav" } }),
    );
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const client = new WebDavClient(normalizeWebDavUrl(url), config.username, config.password);
    await client.request(trackPath, { headers: { Range: "bytes=0-31" } });
    const redirected = fetchMock.mock.calls[1];
    expect(String(redirected[0])).toBe("https://cdn.test/track.wav");
    const headers = new Headers(redirected[1]?.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.get("range")).toBe("bytes=0-31");
  });
});
