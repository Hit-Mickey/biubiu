type Stream = { baseUrl?: string; base_url?: string; backupUrl?: string[]; backup_url?: string[] };

export function streamCandidates(stream?: Stream) {
  return [
    ...new Set(
      [stream?.baseUrl || stream?.base_url, ...(stream?.backupUrl ?? stream?.backup_url ?? [])].filter(
        (url): url is string => Boolean(url),
      ),
    ),
  ];
}

// Choose only among this representation's original signed URLs. Never rewrite a host or mix qualities.
export function selectMirror(candidates: string[], host?: string) {
  return (host && candidates.find(url => mediaHost(url) === host)) || candidates[0] || "";
}

export function mediaHost(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.hostname : "";
  } catch {
    return "";
  }
}

// A streaming sample: even a server ignoring Range cannot load the full song into memory.
export async function sampleMirror(url: string, parent: AbortSignal) {
  const size = 128 * 1024;
  const start = performance.now();
  const response = await fetch(url, {
    headers: { Range: `bytes=0-${size - 1}` },
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.any([parent, AbortSignal.timeout(6000)]),
  });
  const reader = response.body?.getReader();
  try {
    if (!response.ok || !reader || /text|json/i.test(response.headers.get("Content-Type") ?? ""))
      throw new Error("节点不可用");
    let bytes = 0;
    while (bytes < size) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
    }
    if (!bytes) throw new Error("节点未返回音频");
    return Math.round(Math.min(bytes, size) / 1024 / Math.max(0.001, (performance.now() - start) / 1000));
  } finally {
    await reader?.cancel().catch(() => undefined);
  }
}
