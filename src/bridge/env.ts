export interface InjectedRuntimeConfig {
  base?: string;
  token?: string;
  platform?: AppPlatForm;
  windowLabel?: string;
  migrationNotice?: string;
  pendingLegacyStorage?: boolean;
  portable?: boolean;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __BIUBIU_RUNTIME__?: InjectedRuntimeConfig;
  }
}

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

export function detectPlatform(): AppPlatForm {
  if (typeof window !== "undefined") {
    const injected = window.__BIUBIU_RUNTIME__?.platform;
    if (injected === "android" || injected === "windows" || injected === "macos" || injected === "linux") {
      return injected;
    }
  }
  if (typeof navigator !== "undefined") {
    const ua = navigator.userAgent || navigator.platform || "";
    if (/Android/i.test(ua)) return "android";
    if (/Mac|Darwin/i.test(ua)) return "macos";
    if (/Win/i.test(ua)) return "windows";
  }
  return "linux";
}
