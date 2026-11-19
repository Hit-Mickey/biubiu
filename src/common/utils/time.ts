const pad = (value: number) => String(value).padStart(2, "0");
const firstUnit = (value: number) => pad(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds)) return "00:00";
  const rounded = Math.round(Math.abs(seconds));
  const minutes = Math.floor(rounded / 60);
  const remainder = pad(rounded % 60);
  if (seconds >= 3600) {
    return `${firstUnit(Math.floor(minutes / 60))}:${pad(minutes % 60)}:${remainder}`;
  }
  return `${seconds < 0 ? "-" : ""}${firstUnit(minutes)}:${remainder}`;
}

export function formatMillisecond(value?: number) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "无效日期";
  const year = String(date.getFullYear()).padStart(4, "0");
  return `${year}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export const formatSecondsToDate = (value?: number) => (value ? formatMillisecond(value * 1000) : "");

export const unixTime = () => Math.floor(Date.now() / 1000);
