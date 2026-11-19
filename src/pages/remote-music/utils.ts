import type { PlayItem } from "@/store/play-list";
import type { WebDavTrack } from "@shared/webdav";

import { webDavMediaUrl } from "@shared/webdav";

export function webDavErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return "WebDAV 操作失败";
  return error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

export function webDavPlayItem(listId: string, track: WebDavTrack): PlayItem {
  return {
    id: track.id,
    source: "webdav",
    type: "audio",
    webDavListId: listId,
    title: track.title,
    ownerName: track.artist,
    duration: track.duration,
    isLossless: track.lossless,
    audioUrl: webDavMediaUrl("audio", listId, track.id),
    cover: track.hasCover ? webDavMediaUrl("cover", listId, track.id) : undefined,
  };
}
