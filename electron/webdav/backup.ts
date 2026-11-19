import { randomUUID } from "node:crypto";

import { isDesktopBackup, backupNamePattern, maxBackupBytes } from "@shared/desktop-backup";

import { readDavBytes, requireDavSuccess, WebDavHttpError } from "./client";
import { getBackupConnection } from "./library";

export async function listBackups(target: string) {
  const { client, directory } = getBackupConnection(target);
  try {
    const entries = await client.list(directory);
    return entries
      .filter(f => !f.collection && backupNamePattern.test(f.filename))
      .map(f => f.filename)
      .sort()
      .reverse();
  } catch (error) {
    if (error instanceof WebDavHttpError && error.status === 404) return [];
    throw error;
  }
}

export async function uploadBackup(target: string, text: string) {
  if (typeof text !== "string" || Buffer.byteLength(text) > maxBackupBytes || !isDesktopBackup(JSON.parse(text)))
    throw new Error("备份格式错误或超过 8 MiB");
  const { client, directory } = getBackupConnection(target);
  const mk = await client.request(directory, { method: "MKCOL" });
  if (mk.status !== 405) await requireDavSuccess(mk);
  await mk.body?.cancel();
  const name = `biubiu-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.json`;
  const saved = await client.request(directory + name, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "If-None-Match": "*" },
    body: text,
  });
  await requireDavSuccess(saved);
  await saved.body?.cancel();
  return name;
}

export async function downloadBackup(target: string, name: string) {
  if (!backupNamePattern.test(name)) throw new Error("无效的备份文件名");
  const { client, directory } = getBackupConnection(target);
  const response = await client.request(directory + name);
  await requireDavSuccess(response);
  return (await readDavBytes(response, maxBackupBytes)).toString("utf8");
}
