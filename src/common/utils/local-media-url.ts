/** File URLs must escape literal #, %, and ? in names, not just spaces. */
export function localMediaUrl(file: string) {
  if (file.startsWith("content://") && !file.includes("\0")) return file;
  if (!/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(file) || file.includes("\0")) return;
  const path = file.startsWith("/") ? file : file.replaceAll("\\", "/");
  const escaped = path
    .split("/")
    .map((part, i) => (i === 0 && /^[a-z]:$/i.test(part) ? part : encodeURIComponent(part)))
    .join("/");
  return `file:${path.startsWith("//") ? "" : path.startsWith("/") ? "//" : "///"}${escaped}`;
}
