import { useCallback, useEffect, useRef, useState } from "react";

import { Popover, PopoverContent, Slider } from "@heroui/react";
import { RiVolumeDownLine, RiVolumeMuteLine, RiVolumeUpLine } from "@remixicon/react";

import IconButton from "../icon-button";

interface Props {
  volume: number;
  onChange: (value: number) => void;
  onStep: (delta: number) => void;
  onMute: () => void;
  portalContainer?: HTMLElement;
  compact?: boolean;
}

export default function VolumeControl({ volume, onChange, onStep, onMute, portalContainer, compact }: Props) {
  const muted = volume === 0;
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const buttonRef = useRef<HTMLButtonElement>(null!);
  const sliderRef = useRef<HTMLDivElement | null>(null);

  const cancelTimer = useCallback(() => window.clearTimeout(timer.current), []);
  const schedule = useCallback(
    (next: boolean, delay: number) => {
      cancelTimer();
      timer.current = window.setTimeout(() => setOpen(next), delay);
    },
    [cancelTimer],
  );

  const onWheel = useCallback(
    (event: WheelEvent) => {
      event.preventDefault();
      const delta = event.deltaY > 0 ? -0.05 : 0.05;
      const show = volume + delta > 0;
      onStep(delta);
      setOpen(show);
      if (show) schedule(false, 3000);
      else cancelTimer();
    },
    [cancelTimer, onStep, schedule, volume],
  );

  const setSliderRef = useCallback(
    (node: HTMLDivElement | null) => {
      sliderRef.current?.removeEventListener("wheel", onWheel);
      sliderRef.current = node;
      node?.addEventListener("wheel", onWheel, { passive: false });
    },
    [onWheel],
  );

  useEffect(() => {
    const button = buttonRef.current;
    button?.addEventListener("wheel", onWheel, { passive: false });
    return () => button?.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  useEffect(() => cancelTimer, [cancelTimer]);

  const iconSize = compact ? 16 : 18;
  return (
    <Popover
      disableAnimation
      triggerRef={buttonRef}
      portalContainer={portalContainer}
      placement={compact ? "top-end" : "top"}
      isNonModal
      shouldBlockScroll={false}
      shouldCloseOnBlur={false}
      isOpen={open}
      onOpenChange={next => {
        cancelTimer();
        setOpen(next);
      }}
    >
      <IconButton
        ref={buttonRef}
        className={compact ? "window-no-drag h-7 w-7 min-w-7" : undefined}
        aria-label={muted ? "取消静音" : "静音"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onMouseEnter={() => {
          if (open) cancelTimer();
          else schedule(true, 300);
        }}
        onMouseLeave={() => schedule(false, 400)}
        onKeyDown={event => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            cancelTimer();
            setOpen(true);
          }
        }}
        onPress={() => {
          cancelTimer();
          setOpen(false);
          onMute();
        }}
      >
        {muted ? (
          <RiVolumeMuteLine size={iconSize} />
        ) : volume > 0.5 ? (
          <RiVolumeUpLine size={iconSize} />
        ) : (
          <RiVolumeDownLine size={iconSize} />
        )}
      </IconButton>
      <PopoverContent
        aria-label="音量调节"
        className="p-0"
        onMouseEnter={cancelTimer}
        onMouseLeave={() => schedule(false, 400)}
      >
        <div
          ref={setSliderRef}
          className={compact ? "window-no-drag w-36 p-2" : "flex items-center justify-center p-3"}
        >
          <Slider
            disableAnimation
            aria-label="音量"
            color="primary"
            radius="full"
            size="sm"
            orientation={compact ? "horizontal" : "vertical"}
            value={volume}
            minValue={0}
            maxValue={1}
            step={0.01}
            onChange={value => {
              if (typeof value === "number") onChange(value);
            }}
            classNames={{
              trackWrapper: compact ? undefined : "h-40 w-[32px]",
              thumb: "after:hidden",
            }}
            endContent={
              <span className="text-foreground/60 w-8 text-center text-xs tabular-nums">
                {Math.round(volume * 100)}%
              </span>
            }
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
