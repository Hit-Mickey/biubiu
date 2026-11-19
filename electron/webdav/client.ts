import type { Element } from "@xmldom/xmldom";

const audioTypes = new Map([
  ["mp3", "audio/mpeg"],
  ["flac", "audio/flac"],
  ["wav", "audio/wav"],
  ["ogg", "audio/ogg"],
  ["oga", "audio/ogg"],
  ["opus", "audio/ogg"],
  ["m4a", "audio/mp4"],
  ["aac", "audio/aac"],
]);

const properties = ["resourcetype", "getcontentlength", "getlastmodified", "creationdate", "getetag"];
const propfind = `<propfind xmlns="DAV:"><prop>${properties.map(name => `<${name}/>`).join("")}</prop></propfind>`;

interface DavProperties {
  collection?: boolean;
  getcontentlength?: string;
  getlastmodified?: string;
  creationdate?: string;
  getetag?: string;
}

export interface DavFile {
  filename: string;
  path: string;
  collection: boolean;
  size?: number;
  createdAt?: number;
  modifiedAt?: number;
  etag?: string;
}

export class WebDavHttpError extends Error {
  constructor(readonly status: number) {
    const message =
      status === 401
        ? "WebDAV 需要有效的账号和密码"
        : status === 403
          ? "WebDAV 拒绝访问，请检查账号权限"
          : status === 404
            ? "WebDAV 目录或文件不存在"
            : `WebDAV 请求失败（HTTP ${status}）`;
    super(message);
  }
}

export function audioMimeType(format: string) {
  return audioTypes.get(format);
}

function decodeSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function encodePath(value: string) {
  return value
    .split("/")
    .filter(Boolean)
    .map(part => {
      const name = decodeSegment(part);
      if (name === "." || name === ".." || /[/\\]/.test(name) || name.includes("\0")) {
        throw new Error("WebDAV 路径包含无效的目录名");
      }
      return encodeURIComponent(name);
    })
    .join("/");
}

export function normalizeWebDavUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("请输入有效的 WebDAV 服务器地址");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("请输入 HTTP 或 HTTPS 的 WebDAV 地址，并单独填写账号和密码");
  }
  const pathname = encodePath(url.pathname);
  url.pathname = pathname ? `/${pathname}/` : "/";
  return url.href;
}

export function resolveWebDavDirectory(base: URL, directory: string) {
  const pathname = encodePath(directory.trim());
  return pathname ? `${base.pathname}${pathname}/` : base.pathname;
}

async function parseMultiStatus(xml: string) {
  const { DOMParser } = await import("@xmldom/xmldom");
  const invalid = "WebDAV 返回了无效的目录数据";
  if (/<!DOCTYPE\b/i.test(xml)) throw new Error(invalid);
  let root: Element | null;
  try {
    root = new DOMParser({
      onError: () => {
        throw new Error(invalid);
      },
    }).parseFromString(xml, "application/xml").documentElement;
  } catch {
    throw new Error(invalid);
  }
  if (root?.localName?.toLowerCase() !== "multistatus") throw new Error(invalid);

  const children = (element: Element, name: string) =>
    [...element.children].filter(child => child.localName?.toLowerCase() === name);
  const text = (element: Element, name: string) => children(element, name)[0]?.textContent?.trim();
  return children(root, "response").flatMap(response => {
    const href = text(response, "href");
    if (!href) return [];
    const props: DavProperties = {};
    for (const propstat of children(response, "propstat")) {
      if (!/^HTTP\/\S+\s+2\d{2}\b/.test(text(propstat, "status") ?? "")) continue;
      const prop = children(propstat, "prop")[0];
      if (!prop) continue;
      const resource = children(prop, "resourcetype")[0];
      if (resource) props.collection = children(resource, "collection").length > 0;
      for (const key of ["getcontentlength", "getlastmodified", "creationdate", "getetag"] as const) {
        const value = text(prop, key);
        if (value !== undefined) props[key] = value;
      }
    }
    return [{ href, props, status: text(response, "status") ?? "" }];
  });
}

function parseDate(value?: string) {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : undefined;
}

async function getDirectoryFiles(xml: string, base: URL, directory: string, responseUrl: string) {
  const found = new Map<string, DavFile>();
  const location = new URL(responseUrl || directory, base);
  const canonicalLocation = `/${encodePath(location.pathname)}`.replace(/\/?$/, "/");
  // A reverse proxy may strip the WebDAV mount path from absolute hrefs.
  const prefixes = [canonicalLocation, directory, `/${directory.slice(base.pathname.length)}`];
  for (const { href, props, status } of await parseMultiStatus(xml)) {
    let pathname: string;
    let trailingSlash: boolean;
    try {
      const itemUrl = new URL(href, `${location.origin}${canonicalLocation}`);
      if (itemUrl.host !== location.host || !/^https?:$/.test(itemUrl.protocol)) continue;
      trailingSlash = itemUrl.pathname.endsWith("/");
      pathname = `/${encodePath(itemUrl.pathname)}`;
    } catch {
      continue;
    }
    const code = Number(/^HTTP\/\S+\s+(\d{3})\b/.exec(status)?.[1]);
    if (prefixes.some(prefix => pathname === (prefix.replace(/\/$/, "") || "/"))) {
      if (code >= 400) throw new WebDavHttpError(code);
      if (!trailingSlash && props.collection === false) throw new Error("WebDAV 路径指向文件，请填写目录路径");
      continue;
    }
    if (code >= 400) continue;
    const segment = prefixes
      .filter(prefix => pathname.startsWith(prefix))
      .map(prefix => pathname.slice(prefix.length))
      .find(part => part && !part.includes("/"));
    if (!segment) continue;
    const collection = Boolean(props.collection || trailingSlash);
    const path = `${directory}${segment}${collection ? "/" : ""}`;
    const size = props.getcontentlength ? Number(props.getcontentlength) : undefined;
    const modifiedAt = parseDate(props.getlastmodified);
    found.set(path, {
      filename: decodeSegment(segment),
      path,
      collection,
      size: size !== undefined && Number.isSafeInteger(size) && size >= 0 ? size : undefined,
      modifiedAt,
      createdAt: parseDate(props.creationdate) ?? modifiedAt,
      etag: props.getetag,
    });
  }
  return [...found.values()];
}

export async function readDavBytes(response: Response, limit: number, truncate = false) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = limit - length;
      if (value.byteLength > remaining && !truncate) throw new Error("WebDAV 返回的数据过大");
      const chunk = value.subarray(0, remaining);
      chunks.push(chunk);
      length += chunk.byteLength;
      if (truncate && length === limit) break;
    }
    return Buffer.concat(chunks, length);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function requireDavSuccess(response: Response) {
  if (response.ok) return;
  await response.body?.cancel();
  throw new WebDavHttpError(response.status);
}

export class WebDavClient {
  readonly base: URL;
  private readonly authorization?: string;

  constructor(
    url: string,
    username: string,
    password: string,
    private readonly log?: (message: string) => void,
  ) {
    this.base = new URL(url);
    if (username) this.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  }

  async request(path: string, init: RequestInit = {}, streaming = false) {
    const url = new URL(this.base);
    url.pathname = path;
    if (!url.pathname.startsWith(this.base.pathname)) throw new Error("WebDAV 路径超出服务器目录");
    let current = url;
    const headers = new Headers(init.headers);
    if (this.authorization) headers.set("Authorization", this.authorization);
    const method = init.method ?? "GET";
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 30_000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout.signal]) : timeout.signal;
    try {
      for (let redirects = 0; redirects <= 5; redirects++) {
        const response = await fetch(current, { ...init, method, headers, signal, redirect: "manual" });
        this.log?.(`${method} ${response.status}`);
        const location = response.headers.get("location");
        if (![301, 302, 303, 307, 308].includes(response.status) || !location) return response;
        await response.body?.cancel();
        const next = new URL(location, current);
        if (!/^https?:$/.test(next.protocol) || next.username || next.password) break;
        const secureUpgrade = current.protocol === "http:" && next.protocol === "https:" && current.host === next.host;
        if (next.origin !== current.origin && !secureUpgrade) {
          if (method !== "GET" && method !== "HEAD") break;
          headers.delete("Authorization");
        }
        // Never send a write (or its backup payload) to a different resource on redirect.
        if ((method === "DELETE" || method === "PUT" || method === "MKCOL") && next.pathname !== current.pathname)
          break;
        current = next;
      }
      throw new Error("无法跟随 WebDAV 服务器重定向");
    } catch (error) {
      if (timeout.signal.aborted) throw new Error("连接 WebDAV 超时，请检查服务器地址及网络");
      if (error instanceof TypeError) throw new Error("无法连接 WebDAV 服务器，请检查地址及网络");
      throw error;
    } finally {
      // Keep the deadline for small reads and directory responses, and allow long media streams.
      if (streaming) clearTimeout(timer);
      else timer.unref();
    }
  }

  async list(directory: string) {
    const response = await this.request(directory, {
      method: "PROPFIND",
      headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
      body: propfind,
    });
    await requireDavSuccess(response);
    const bytes = await readDavBytes(response, 32 * 1024 * 1024);
    const encoding =
      bytes[0] === 0xff && bytes[1] === 0xfe
        ? "utf-16le"
        : bytes[0] === 0xfe && bytes[1] === 0xff
          ? "utf-16be"
          : "utf-8";
    const xml = new TextDecoder(encoding).decode(bytes);
    return getDirectoryFiles(xml, this.base, directory, response.url);
  }

  async remove(path: string) {
    const response = await this.request(path, { method: "DELETE" });
    if (response.status === 404) {
      await response.body?.cancel();
      return;
    }
    await requireDavSuccess(response);
    if (response.status === 207) {
      await response.body?.cancel();
      throw new Error("WebDAV 返回了部分删除结果，请更新列表确认文件状态");
    }
    await response.body?.cancel();
  }
}
