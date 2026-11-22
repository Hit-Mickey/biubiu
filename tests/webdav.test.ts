import { afterEach, describe, expect, test } from "vitest";

import { resolveMediaUrl, setMediaServerConfig } from "@/bridge/media-url";
import { backupFormat, backupNamePattern, isDesktopBackup, maxBackupBytes } from "@shared/desktop-backup";
import { webDavMediaUrl } from "@shared/webdav";

describe("WebDAV shared helpers and media URL rewriting", () => {
  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
    delete window.__BIUBIU_RUNTIME__;
    setMediaServerConfig("", "");
  });

  test("formats biu-webdav media URLs and preserves non-Tauri passthrough", () => {
    const audioUrl = webDavMediaUrl("audio", "list-1", "track-2");
    const coverUrl = webDavMediaUrl("cover", "list-1", "track-2");
    expect(audioUrl).toBe("biu-webdav://audio/list-1/track-2");
    expect(coverUrl).toBe("biu-webdav://cover/list-1/track-2");
    expect(resolveMediaUrl(audioUrl)).toBe(audioUrl);
    expect(resolveMediaUrl("https://example.com/cover.jpg")).toBe("https://example.com/cover.jpg");
  });

  test("rewrites biu-webdav URLs to loopback HTTP endpoints under Tauri runtime", () => {
    window.__TAURI_INTERNALS__ = {};
    setMediaServerConfig("http://127.0.0.1:45678/", "secret+token");
    expect(resolveMediaUrl(webDavMediaUrl("cover", "list-1", "track-2"))).toBe(
      "http://127.0.0.1:45678/webdav/cover/list-1/track-2?token=secret%2Btoken",
    );
    expect(resolveMediaUrl(webDavMediaUrl("audio", "list-1", "track-2"))).toBe(
      "http://127.0.0.1:45678/webdav/audio/list-1/track-2?token=secret%2Btoken",
    );
    expect(resolveMediaUrl("https://i0.hdslb.com/pic.jpg")).toBe("https://i0.hdslb.com/pic.jpg");
  });

  test("validates desktop backup schema and filename pattern", () => {
    expect(maxBackupBytes).toBe(8 * 1024 * 1024);
    expect(backupNamePattern.test("biubiu-2026-11-21T15-00-00-123Z-a1b2c3d4.json")).toBe(true);
    expect(backupNamePattern.test("../other.json")).toBe(false);
    expect(isDesktopBackup({ format: backupFormat, version: 1 })).toBe(true);
    expect(isDesktopBackup({ format: backupFormat, version: 2 })).toBe(false);
    expect(isDesktopBackup(null)).toBe(false);
  });
});
