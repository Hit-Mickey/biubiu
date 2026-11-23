import type { ReactElement, ReactNode } from "react";

import { Popover, PopoverContent, PopoverTrigger, Tooltip } from "@heroui/react";

interface Props {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  label: string;
  className: string;
  content: ReactNode;
  children: ReactElement;
}

export default function PlaybackOptions({ open, onOpenChange, label, className, content, children }: Props) {
  if (window.electron.getPlatform() === "android") {
    return (
      <Popover disableAnimation placement="top" isOpen={open} onOpenChange={onOpenChange}>
        <PopoverTrigger>{children}</PopoverTrigger>
        <PopoverContent aria-label={label} className={className}>
          {content}
        </PopoverContent>
      </Popover>
    );
  }
  return (
    <Tooltip
      disableAnimation
      triggerScaleOnOpen={false}
      radius="md"
      placement="top"
      closeDelay={500}
      showArrow={false}
      isOpen={open}
      onOpenChange={onOpenChange}
      content={content}
      classNames={{ content: className }}
    >
      {children}
    </Tooltip>
  );
}
