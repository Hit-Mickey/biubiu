import { isTauriRuntime } from "@/bridge/env";

function formatArgs(args: unknown[]): string {
  return args
    .map(arg => {
      if (arg instanceof Error) return arg.stack || arg.message;
      if (typeof arg === "string") return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

function forwardToBackend(level: "info" | "warn" | "error" | "debug", args: unknown[]) {
  if (!isTauriRuntime()) return;
  void import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke("app_log", { level, message: formatArgs(args) }))
    .catch(() => undefined);
}

const log = {
  error: (...args: unknown[]) => {
    console.error(...args);
    forwardToBackend("error", args);
  },
  warn: (...args: unknown[]) => {
    console.warn(...args);
    forwardToBackend("warn", args);
  },
  info: (...args: unknown[]) => {
    console.info(...args);
    forwardToBackend("info", args);
  },
  debug: (...args: unknown[]) => {
    console.debug(...args);
  },
  verbose: (...args: unknown[]) => {
    console.debug(...args);
  },
  log: (...args: unknown[]) => {
    console.log(...args);
  },
};

export default log;
