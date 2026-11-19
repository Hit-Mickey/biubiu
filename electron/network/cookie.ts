import { session, type CookiesSetDetails } from "electron";
import log from "electron-log";

import { getBiliTicket } from "./web-bili-ticket";
import { getWebBuvid } from "./web-buvid";

const setCookie = async (details: Partial<CookiesSetDetails>) => {
  await session.defaultSession.cookies.set({
    ...details,
    url: "https://bilibili.com/",
    domain: ".bilibili.com",
    path: "/",
    secure: true,
    sameSite: "no_restriction",
    httpOnly: false,
  });
};

/**
 * 过期时间：259260 秒，3天零1分钟
 */
async function injectBiliTicketCookie() {
  const ticket = await getBiliTicket();

  const expirationDate = Math.floor(Date.now() / 1000 + 259260);

  await setCookie({
    name: "bili_ticket",
    value: ticket,
    expirationDate,
  });

  await setCookie({
    name: "bili_ticket_expires",
    value: String(expirationDate),
    expirationDate,
  });
  await session.defaultSession.cookies.flushStore();
}

/**
 * buvid4: 过期时间：30天
 */
async function injectBuvidCookie() {
  const buvid = await getWebBuvid();

  await setCookie({
    name: "buvid4",
    value: buvid.b_4,
    expirationDate: Math.floor(Date.now() / 1000 + 30 * 24 * 3600),
  });
  await session.defaultSession.cookies.flushStore();
}

const refreshes = new Map<"ticket" | "buvid", Promise<void>>();

function refreshCookie(kind: "ticket" | "buvid") {
  const pending = refreshes.get(kind);
  if (pending) return pending;
  const task = (kind === "ticket" ? injectBiliTicketCookie() : injectBuvidCookie()).finally(() =>
    refreshes.delete(kind),
  );
  refreshes.set(kind, task);
  return task;
}

function setupCookieAutoRefresh() {
  session.defaultSession.cookies.on("changed", async (_event, cookie, cause, removed) => {
    if (!removed) return;
    const name = cookie.name;
    const expired = cause === "expired" || cause === "expired-overwrite";
    if (!expired) return;
    if (name === "buvid4") {
      try {
        await refreshCookie("buvid");
      } catch (err) {
        log.warn("[cookies] auto refresh buvid4 failed", err);
      }
      return;
    }

    if (name === "bili_ticket" || name === "bili_ticket_expires") {
      try {
        await refreshCookie("ticket");
      } catch (err) {
        log.warn("[cookies] auto refresh bili_ticket failed", err);
      }
    }
  });
}

export async function injectAuthCookie() {
  setupCookieAutoRefresh();
  const cookies = await session.defaultSession.cookies.get({ url: "https://bilibili.com/" }).catch(() => []);
  const now = Date.now() / 1000;
  const valid = (name: string) =>
    cookies.some(cookie => cookie.name === name && cookie.value && (cookie.expirationDate ?? 0) > now);
  const tasks: Promise<void>[] = [];
  if (!valid("bili_ticket") || !valid("bili_ticket_expires")) tasks.push(refreshCookie("ticket"));
  if (!valid("buvid4")) tasks.push(refreshCookie("buvid"));
  const results = await Promise.allSettled(tasks);
  const failures = results.filter(r => r.status === "rejected");
  if (failures.length) {
    failures.forEach(f => log.warn("[cookies] inject failed:", f.reason));
  }
}

export const getCookieString = async () => {
  const cookies = await session.defaultSession.cookies.get({ url: "https://bilibili.com" });
  return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
};
