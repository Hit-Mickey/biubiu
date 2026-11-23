import { webDavScheme } from "@shared/webdav";

import { isTauriRuntime } from "./env";

let mediaBase = "";
let mediaToken = "";

function readInjected() {
  if (typeof window === "undefined") return;
  const cfg = window.__BIUBIU_RUNTIME__;
  if (cfg?.base) mediaBase = cfg.base.replace(/\/+$/, "");
  if (cfg?.token) mediaToken = cfg.token;
}

readInjected();

export function setMediaServerConfig(base: string, token: string) {
  mediaBase = base.replace(/\/+$/, "");
  mediaToken = token;
}

function getMediaServerConfig() {
  if (!mediaBase) readInjected();
  return { base: mediaBase, token: mediaToken };
}

/**
 * Resolve biu-webdav:// URLs to loopback HTTP URLs when running under Tauri.
 * Standard http(s) URLs pass through unchanged.
 */
export function resolveMediaUrl(url?: string): string | undefined {
  if (!url) return url;
  if (!isTauriRuntime()) return url;

  if (
    window.__BIUBIU_RUNTIME__?.platform === "android" &&
    /^http:\/\/(?:[a-z0-9-]+\.)*(?:hdslb\.com|biliimg\.com)\//i.test(url)
  ) {
    return "https:" + url.slice(5);
  }

  const prefix = `${webDavScheme}://`;
  if (url.startsWith(prefix)) {
    const { base, token } = getMediaServerConfig();
    if (!base) return url;
    const rest = url.slice(prefix.length);
    const slashIdx = rest.indexOf("/");
    if (slashIdx <= 0) return url;
    const kind = rest.slice(0, slashIdx);
    const pathPart = rest.slice(slashIdx + 1);
    const query = token ? `?token=${encodeURIComponent(token)}` : "";
    return `${base}/webdav/${kind}/${pathPart}${query}`;
  }

  return url;
}
