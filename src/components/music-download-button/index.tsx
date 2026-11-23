import React, { useState } from "react";

import { addToast, Listbox, ListboxItem } from "@heroui/react";
import { RiDownload2Fill, RiFileImageLine, RiFileMusicLine, RiFileVideoLine } from "@remixicon/react";

import { resolveMediaUrl } from "@/bridge/media-url";
import { saveBlob } from "@/common/utils/save-blob";
import AsyncButton from "@/components/async-button";
import IconButton from "@/components/icon-button";
import PlaybackOptions from "@/components/playback-options";
import { usePlayList } from "@/store/play-list";

const MusicDownloadButton = () => {
  const list = usePlayList(s => s.list);
  const playId = usePlayList(s => s.playId);
  const playItem = list.find(item => item.id === playId);
  const [isTooltipOpen, setIsTooltipOpen] = useState(false);

  const downloadAudio = async () => {
    await window.electron.addMediaDownloadTask({
      outputFileType: "audio",
      title: playItem?.pageTitle || playItem?.title || `audio-${Date.now()}`,
      cover: playItem?.pageCover || playItem?.cover,
      bvid: playItem?.bvid,
      cid: playItem?.cid,
      sid: playItem?.type === "audio" ? playItem?.sid : undefined,
    });

    addToast({
      title: "已添加下载任务",
      color: "success",
    });
  };

  const downloadVideo = async () => {
    await window.electron.addMediaDownloadTask({
      outputFileType: "video",
      title: playItem?.pageTitle || playItem?.title || `video-${Date.now()}`,
      cover: playItem?.pageCover || playItem?.cover,
      bvid: playItem?.bvid,
      cid: playItem?.cid,
    });

    addToast({
      title: "已添加下载任务",
      color: "success",
    });
  };

  const downloadCover = async () => {
    const coverUrl = resolveMediaUrl(playItem?.pageCover || playItem?.cover);

    if (!coverUrl) {
      addToast({
        title: "没有可下载的封面",
        color: "warning",
      });
      return;
    }

    try {
      const response = await fetch(coverUrl);

      if (!response.ok) {
        throw new Error(`下载失败，状态码 ${response.status}`);
      }

      const blob = await response.blob();
      const ext = blob.type?.split("/")?.[1] || "jpg";
      const name = (playItem?.pageTitle || playItem?.title || "cover").replace(/[\\/:*?"<>|]/g, "_");

      await saveBlob(blob, `${name}-cover.${ext}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      addToast({
        title: "封面下载失败",
        description: message,
        color: "danger",
      });
    }
  };

  if (playItem?.sid) {
    return (
      <AsyncButton
        aria-label="下载音频"
        isIconOnly
        size="sm"
        variant="light"
        className="hover:text-primary"
        onPress={downloadAudio}
      >
        <RiDownload2Fill size={18} />
      </AsyncButton>
    );
  }

  return (
    <PlaybackOptions
      label="下载选项"
      className="p-2"
      open={isTooltipOpen}
      onOpenChange={setIsTooltipOpen}
      content={
        <Listbox
          aria-label="下载选项"
          selectionMode="none"
          onAction={key => {
            if (key === "audio") {
              void downloadAudio();
            } else if (key === "video") {
              void downloadVideo();
            } else if (key === "cover") {
              void downloadCover();
            }
            setIsTooltipOpen(false);
          }}
        >
          <ListboxItem
            className="rounded-medium"
            key="audio"
            textValue="下载音频"
            startContent={<RiFileMusicLine size={16} />}
          >
            下载音频
          </ListboxItem>
          <ListboxItem
            className="rounded-medium"
            key="video"
            textValue="下载视频"
            startContent={<RiFileVideoLine size={16} />}
          >
            下载视频
          </ListboxItem>
          <ListboxItem
            className="rounded-medium"
            key="cover"
            textValue="下载封面"
            startContent={<RiFileImageLine size={16} />}
          >
            下载封面
          </ListboxItem>
        </Listbox>
      }
    >
      <IconButton aria-label="下载">
        <RiDownload2Fill size={18} />
      </IconButton>
    </PlaybackOptions>
  );
};

export default MusicDownloadButton;
