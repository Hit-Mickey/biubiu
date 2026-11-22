import { invoke } from "@tauri-apps/api/core";
import axios, {
  AxiosError,
  AxiosHeaders,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";

import { isTauriRuntime } from "./env";

interface RustHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

interface RustHttpPayload {
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyKind: "none" | "raw" | "multipart";
  body?: string;
  multipartFields?: [string, string][];
  timeoutMs?: number;
}

function buildRequestUrl(config: InternalAxiosRequestConfig): string {
  const base = config.baseURL ?? "";
  const rel = config.url ?? "";
  let fullUrl: string;
  if (/^https?:\/\//i.test(rel)) {
    fullUrl = rel;
  } else if (base) {
    fullUrl = `${base.replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`;
  } else {
    fullUrl = rel;
  }

  const params = config.params;
  if (params && typeof params === "object") {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item !== undefined && item !== null) search.append(key, String(item));
        }
      } else {
        search.append(key, String(value));
      }
    }
    const qs = search.toString();
    if (qs) {
      fullUrl += (fullUrl.includes("?") ? "&" : "?") + qs;
    }
  }

  return fullUrl;
}

function serializeHeaders(headers: InternalAxiosRequestConfig["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const raw = typeof (headers as AxiosHeaders).toJSON === "function" ? (headers as AxiosHeaders).toJSON() : headers;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    const lower = key.toLowerCase();
    if (lower === "content-length") continue;
    out[key] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

async function serializeBody(
  data: unknown,
  headers: Record<string, string>,
): Promise<Pick<RustHttpPayload, "bodyKind" | "body" | "multipartFields">> {
  if (data === undefined || data === null) {
    return { bodyKind: "none" };
  }

  if (typeof FormData !== "undefined" && data instanceof FormData) {
    const fields: [string, string][] = [];
    data.forEach((value, key) => {
      fields.push([key, typeof value === "string" ? value : String(value)]);
    });
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "content-type") delete headers[key];
    }
    return { bodyKind: "multipart", multipartFields: fields };
  }

  if (typeof URLSearchParams !== "undefined" && data instanceof URLSearchParams) {
    if (!Object.keys(headers).some(k => k.toLowerCase() === "content-type")) {
      headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";
    }
    return { bodyKind: "raw", body: data.toString() };
  }

  if (typeof data === "string") {
    return { bodyKind: "raw", body: data };
  }

  if (!Object.keys(headers).some(k => k.toLowerCase() === "content-type")) {
    headers["Content-Type"] = "application/json;charset=UTF-8";
  }
  return { bodyKind: "raw", body: JSON.stringify(data) };
}

const tauriHttpAdapter: AxiosAdapter = async config => {
  const signal = config.signal as AbortSignal | undefined;
  if (signal?.aborted) {
    throw new axios.CanceledError("canceled", AxiosError.ERR_CANCELED, config);
  }

  const url = buildRequestUrl(config);
  const method = (config.method || "GET").toUpperCase();
  const headers = serializeHeaders(config.headers);
  const bodySpec = await serializeBody(config.data, headers);

  const payload: RustHttpPayload = {
    url,
    method,
    headers,
    ...bodySpec,
    timeoutMs: config.timeout && config.timeout > 0 ? config.timeout : 10000,
  };

  let abortReject: ((err: unknown) => void) | undefined;
  const onAbort = () => {
    abortReject?.(new axios.CanceledError("canceled", AxiosError.ERR_CANCELED, config));
  };

  let resp: RustHttpResponse;
  try {
    const invokePromise = invoke<RustHttpResponse>("bili_http_request", { req: payload });
    if (signal) {
      resp = await new Promise<RustHttpResponse>((resolve, reject) => {
        abortReject = reject;
        signal.addEventListener("abort", onAbort, { once: true });
        invokePromise.then(resolve, reject);
      });
    } else {
      resp = await invokePromise;
    }
  } catch (err) {
    if (axios.isCancel(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new AxiosError(message, AxiosError.ERR_NETWORK, config);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }

  let parsedData: unknown = resp.body;
  if (config.responseType !== "text" && resp.body) {
    try {
      parsedData = JSON.parse(resp.body);
    } catch {
      parsedData = resp.body;
    }
  }

  const axiosResponse: AxiosResponse = {
    data: parsedData,
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
    config,
  };

  const validateStatus = config.validateStatus ?? (status => status >= 200 && status < 300);
  if (!validateStatus(resp.status)) {
    throw new AxiosError(
      `Request failed with status code ${resp.status}`,
      resp.status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
      config,
      null,
      axiosResponse,
    );
  }

  return axiosResponse;
};

export function getPlatformAxiosAdapter(): AxiosAdapter | undefined {
  return isTauriRuntime() ? tauriHttpAdapter : undefined;
}

export async function loadBilibiliCookiesViaBridge(): Promise<void> {
  await invoke("load_bilibili_cookies");
}

export async function sampleAudioMirrorViaBridge(url: string): Promise<number> {
  return invoke<number>("sample_audio_mirror", { url });
}
