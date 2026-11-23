import React, { useState } from "react";

import { Button } from "@heroui/react";

import { PlayRate } from "@/common/constants/audio";
import PlaybackOptions from "@/components/playback-options";
import { usePlayList } from "@/store/play-list";

import IconButton from "../icon-button";

const MusicRate = () => {
  const rate = usePlayList(s => s.rate);
  const setRate = usePlayList(s => s.setRate);
  const [isTooltipOpen, setIsTooltipOpen] = useState(false);

  return (
    <PlaybackOptions
      label="播放速率"
      className="w-[60px] min-w-[60px] px-2 py-3"
      open={isTooltipOpen}
      onOpenChange={setIsTooltipOpen}
      content={
        <div className="flex flex-col items-center gap-1">
          {PlayRate.map(v => (
            <Button
              key={v}
              isIconOnly
              radius="md"
              size="sm"
              color={v === rate ? "primary" : "default"}
              variant={v === rate ? "solid" : "light"}
              className="min-w-[40px]"
              aria-label={`${v}倍速`}
              onPress={() => setRate(v)}
            >
              {v}x
            </Button>
          ))}
        </div>
      }
    >
      <IconButton className="min-w-fit text-[16px]" aria-label="播放速率">
        {rate}x
      </IconButton>
    </PlaybackOptions>
  );
};

export default MusicRate;
