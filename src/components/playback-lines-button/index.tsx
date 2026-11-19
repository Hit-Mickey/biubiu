import { RiRouteLine } from "@remixicon/react";

import { useModalStore } from "@/store/modal";

import IconButton from "../icon-button";

export default function PlaybackLinesButton({ className }: { className?: string }) {
  const open = useModalStore(s => s.openPlaybackLines);
  return (
    <IconButton aria-label="播放线路" title="播放线路" className={className} onPress={open}>
      <RiRouteLine size={16} />
    </IconButton>
  );
}
