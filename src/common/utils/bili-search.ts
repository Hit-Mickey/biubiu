export type BiliSearchTarget =
  | { kind: "video"; id: string; page?: number }
  | { kind: "audio"; sid: number }
  | { kind: "short"; code: string }
  | { kind: "unsupported" };

function videoId(text: string) {
  if (/^bv[a-z0-9]{10}$/i.test(text)) return "BV" + text.slice(2);
  if (/^av[1-9]\d*$/i.test(text) && Number.isSafeInteger(Number(text.slice(2)))) return text.toLowerCase();
}

function audioTarget(text: string): BiliSearchTarget | undefined {
  const match = /^au([1-9]\d*)$/i.exec(text);
  if (match && Number.isSafeInteger(Number(match[1]))) return { kind: "audio", sid: Number(match[1]) };
}

export function parseBiliSearch(input: string): BiliSearchTarget | undefined {
  const text = input.trim();
  const id = videoId(text);
  if (id) return { kind: "video", id };
  const audio = audioTarget(text);
  if (audio) return audio;

  // Mobile shares include a title before the URL. Only recognise a complete official host.
  const link = text
    .match(/(?:^|[\s【】（(])((?:(?:https?:)?\/\/)?(?:(?:[\w-]+\.)*bilibili\.com|b23\.tv)\/[^\s<>【】]+)/i)?.[1]
    ?.replace(/[。），,).]+$/, "");
  if (!link) return;
  let url: URL;
  try {
    url = new URL(/^https?:/i.test(link) ? link : "https://" + link.replace(/^\/\//, ""));
  } catch {
    return { kind: "unsupported" };
  }
  const path = url.pathname;
  if (url.hostname === "b23.tv") {
    const code = /^\/([a-zA-Z0-9]{1,64})\/?$/.exec(path)?.[1];
    return code ? { kind: "short", code } : { kind: "unsupported" };
  }
  const video = videoId(/^\/video\/([^/]+)\/?$/i.exec(path)?.[1] ?? "");
  if (video) {
    const page = Number(url.searchParams.get("p"));
    return { kind: "video", id: video, ...(Number.isSafeInteger(page) && page > 0 && { page }) };
  }
  return audioTarget(/^\/audio\/([^/]+)\/?$/i.exec(path)?.[1] ?? "") ?? { kind: "unsupported" };
}

export function biliSearchTerm(target: Exclude<BiliSearchTarget, { kind: "unsupported" }>) {
  if (target.kind === "short") return `https://b23.tv/${target.code}`;
  if (target.kind === "audio") return `au${target.sid}`;
  return target.page ? `https://www.bilibili.com/video/${target.id}?p=${target.page}` : target.id;
}
