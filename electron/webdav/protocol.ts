import { protocol } from "electron";
import log from "electron-log";

import { webDavScheme } from "@shared/webdav";

import { cacheAudioStream, cachedAudioResponse } from "./cache";
import { audioMimeType } from "./client";
import { findWebDavTrack, getWebDavCover, getWebDavPreferences, openWebDavTrack, trackVersion } from "./library";

export function registerWebDavScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: webDavScheme,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
  ]);
}

export function registerWebDavProtocol() {
  protocol.handle(webDavScheme, async request => {
    const origin = request.headers.get("origin");
    if (origin && origin !== "null" && origin !== "file://") return new Response(null, { status: 403 });
    const headers = new Headers({
      "access-control-allow-origin": origin || "null",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers });

    const url = new URL(request.url);
    const [, listId, trackId, extra] = url.pathname.split("/");
    if (extra !== undefined || !findWebDavTrack(listId, trackId)) return new Response(null, { status: 404, headers });
    try {
      if (url.hostname === "cover") {
        const cover = await getWebDavCover(listId, trackId);
        if (!cover) return new Response(null, { status: 404, headers });
        headers.set("content-type", cover.mime);
        headers.set("content-length", String(cover.bytes.byteLength));
        return new Response(request.method === "HEAD" ? null : Buffer.from(cover.bytes), { headers });
      }
      if (url.hostname !== "audio") return new Response(null, { status: 404, headers });

      const { client, track } = openWebDavTrack(listId, trackId);
      const preferences = getWebDavPreferences();
      headers.set("content-type", audioMimeType(track.format) ?? "application/octet-stream");
      const version = trackVersion(track);
      if (preferences.cacheAudio) {
        const cached = await cachedAudioResponse(version, request, headers);
        if (cached) return cached;
      }

      const upstreamHeaders = new Headers({ "accept-encoding": "identity" });
      const range = request.headers.get("range");
      if (range) upstreamHeaders.set("range", range);
      const upstream = await client.request(
        track.path,
        { method: request.method, headers: upstreamHeaders, signal: request.signal },
        true,
      );
      const encoding = upstream.headers.get("content-encoding");
      const contentType = upstream.headers.get("content-type");
      const encoded = Boolean(encoding && encoding !== "identity");
      const invalidMedia = contentType?.includes("text/html") || contentType?.includes("xml");
      if (!upstream.ok || invalidMedia || (encoded && upstream.status === 206)) {
        await upstream.body?.cancel();
        const contentRange = upstream.headers.get("content-range");
        if (contentRange) headers.set("content-range", contentRange);
        return new Response(null, { status: upstream.ok ? 502 : upstream.status, headers });
      }
      for (const name of ["content-length", "content-range", "accept-ranges"]) {
        const value = upstream.headers.get(name);
        if (value && !encoded) headers.set(name, value);
      }
      const body =
        preferences.cacheAudio && !encoded ? await cacheAudioStream(upstream, version, track.size) : upstream.body;
      return new Response(body, { status: upstream.status, headers });
    } catch (error) {
      if (getWebDavPreferences().debugLog) log.debug("[WebDAV] 媒体请求失败", error instanceof Error && error.message);
      return new Response(null, { status: 502, headers });
    }
  });
}
