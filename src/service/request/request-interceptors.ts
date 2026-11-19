import { type InternalAxiosRequestConfig } from "axios";

import { nextCookieRefreshTime, refreshCookie } from "@/common/utils/cookie";
import { unixTime } from "@/common/utils/time";
import { useToken } from "@/store/token";

import { encodeParamsWbi } from "./wbi-sign";

let refreshCookiePromise: Promise<boolean> | undefined;

export const requestInterceptors = async (config: InternalAxiosRequestConfig) => {
  const now = unixTime();
  if (!config.skipRefreshCheck && (useToken.getState().nextCheckRefreshTime || 0) < now) {
    if (!refreshCookiePromise) {
      useToken.setState({ nextCheckRefreshTime: now + 30 });
      refreshCookiePromise = refreshCookie().finally(() => {
        refreshCookiePromise = undefined;
      });
    }
    try {
      await refreshCookiePromise;
    } finally {
      useToken.setState({ nextCheckRefreshTime: nextCookieRefreshTime() });
    }
  }

  if (config.useCSRF) {
    const csrfToken = await window.electron.getCookie("bili_jct");
    if (csrfToken) {
      if (config.method === "post") {
        config.data ??= {};
        config.data.csrf = csrfToken;
      } else {
        config.params ??= {};
        config.params.csrf = csrfToken;
      }
    }
  }

  if (config.useWbi) {
    config.params ??= {};
    config.params = await encodeParamsWbi(config.params);
  }

  if (config.useFormData) {
    const formData = new FormData();
    for (const key in config.data) {
      formData.append(key, config.data[key]);
    }
    config.data = formData;
  }

  return config;
};
