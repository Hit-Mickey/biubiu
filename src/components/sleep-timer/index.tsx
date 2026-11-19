import { useState } from "react";

import { Button, Input, Popover, PopoverContent, PopoverTrigger } from "@heroui/react";
import { RiTimerLine } from "@remixicon/react";

import IconButton from "@/components/icon-button";
import { pauseForSleep } from "@/store/play-list";
import { cancelSleepTimer, setSleepTimer, sleepDelayMs, useSleepTimer, type SleepUnit } from "@/store/sleep-timer";

const presets = [15, 30, 45, 60, 90];

export default function SleepTimer() {
  const deadline = useSleepTimer(s => s.deadline);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("30");
  const [unit, setUnit] = useState<SleepUnit>("minutes");
  const label = deadline ? `将在 ${new Date(deadline).toLocaleString()} 暂停` : "定时暂停";
  const valid = sleepDelayMs(Number(value), unit) !== undefined;
  const start = (amount: number, selectedUnit: SleepUnit) => {
    if (setSleepTimer(amount, selectedUnit, pauseForSleep)) setOpen(false);
  };
  return (
    <Popover placement="top-end" isOpen={open} onOpenChange={setOpen}>
      <PopoverTrigger>
        <IconButton aria-label={label} title={label} color={deadline ? "primary" : "default"}>
          <RiTimerLine size={18} />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent aria-label="定时暂停" className="w-64 items-stretch p-3">
        <form
          className="space-y-3"
          onSubmit={e => {
            e.preventDefault();
            start(Number(value), unit);
          }}
        >
          <p className="text-sm font-medium">定时暂停</p>
          <div className="flex items-center gap-2">
            <Input
              size="sm"
              type="number"
              step="any"
              aria-label="暂停时长"
              placeholder="输入时长"
              value={value}
              onValueChange={setValue}
            />
            <select
              aria-label="时间单位"
              className="bg-default-100 text-foreground rounded-md px-2 py-1.5 text-sm"
              value={unit}
              onChange={e => setUnit(e.target.value as SleepUnit)}
            >
              <option value="seconds">秒</option>
              <option value="minutes">分钟</option>
              <option value="hours">小时</option>
            </select>
          </div>
          {!valid && <p className="text-danger text-xs">请输入至少 1 秒的有效时长。</p>}
          <div className="flex items-center justify-between gap-1" aria-label="快捷设置（分钟）">
            <span className="text-default-500 text-xs">分钟</span>
            {presets.map(n => (
              <Button
                key={n}
                type="button"
                size="sm"
                variant="flat"
                className="min-w-0 px-2"
                aria-label={`${n} 分钟后暂停`}
                onPress={() => {
                  setValue(String(n));
                  setUnit("minutes");
                  start(n, "minutes");
                }}
              >
                {n}
              </Button>
            ))}
          </div>
          {deadline && <p className="text-default-500 text-xs">{label}</p>}
          <div className="flex justify-end gap-2">
            {deadline && (
              <Button
                type="button"
                size="sm"
                variant="light"
                onPress={() => {
                  cancelSleepTimer();
                  setOpen(false);
                }}
              >
                取消定时
              </Button>
            )}
            <Button size="sm" color="primary" type="submit" isDisabled={!valid}>
              {deadline ? "更新定时" : "开始定时"}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
