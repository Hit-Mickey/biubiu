import { create } from "zustand";

const unitMs = { seconds: 1000, minutes: 60_000, hours: 3_600_000 };
export type SleepUnit = keyof typeof unitMs;
export const useSleepTimer = create<{ deadline: number | null }>(() => ({ deadline: null }));
let timer: ReturnType<typeof setTimeout> | undefined;

export function sleepDelayMs(amount: number, unit: SleepUnit) {
  const ms = amount * unitMs[unit];
  if (ms >= 1000 && Number.isFinite(new Date(Date.now() + ms).getTime())) return Math.round(ms);
}

export function cancelSleepTimer() {
  clearTimeout(timer);
  timer = undefined;
  useSleepTimer.setState({ deadline: null });
}

export function setSleepTimer(amount: number, unit: SleepUnit, pause: () => void) {
  const delay = sleepDelayMs(amount, unit);
  if (delay === undefined) return false; // An invalid replacement must not cancel the running timer.
  clearTimeout(timer);
  const deadline = Date.now() + delay;
  useSleepTimer.setState({ deadline });
  const arm = () => {
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      // Browser timeouts take a signed 32-bit delay. Keep one timer even for multi-day input.
      timer = setTimeout(arm, Math.min(remaining, 0x7fffffff));
    } else {
      timer = undefined;
      useSleepTimer.setState({ deadline: null });
      pause();
    }
  };
  arm();
  return true;
}
