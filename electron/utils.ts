import { app } from "electron";
import isDev from "electron-is-dev";
import { existsSync } from "node:fs";
import path from "node:path";

import { appName } from "@shared/app";
import { ELECTRON_ICON_BASE_PATH } from "@shared/path";
import { StoreNameMap } from "@shared/store";

export const IconBase = isDev ? process.cwd() : process.resourcesPath;

let userDataPath: string | undefined;

export const getUserDataPath = () => {
  if (userDataPath) return userDataPath;

  const appData = app.getPath("appData");
  const defaultPath = app.getPath("userData");
  const preferredPath = isDev ? path.join(appData, `${appName}-dev`) : defaultPath;
  const legacyNames = isDev ? ["biu-dev"] : ["Biu", "biu"];
  const hasSettings = (dir: string) => existsSync(path.join(dir, `${StoreNameMap.AppSettings}.json`));

  // Keep existing settings, browser storage and encrypted credentials together after renaming.
  userDataPath = hasSettings(preferredPath)
    ? preferredPath
    : (legacyNames.map(name => path.join(appData, name)).find(hasSettings) ?? preferredPath);

  if (userDataPath !== defaultPath) {
    app.setPath("userData", userDataPath);
    app.setPath("sessionData", userDataPath);
  }
  return userDataPath;
};

export const getWindowIcon = () =>
  process.platform === "darwin"
    ? undefined
    : path.resolve(
        IconBase,
        ELECTRON_ICON_BASE_PATH,
        process.platform === "win32" ? (isDev ? "dev.ico" : "logo.ico") : "logo.png",
      );

const entities = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
  nbsp: " ",
};

/**
 * 将包含 HTML 和特殊字符的字符串转换为合法的文件名
 */
export function sanitizeFilename(input?: string, replacement = "_") {
  if (!input) return "";

  const decoded = input.replace(/&([a-z0-9]+|#[0-9]{1,6}|#x[0-9a-f]{1,6});/gi, (match, entity) => {
    return entities[entity.toLowerCase()] || match;
  });

  const noHtml = decoded.replace(/<[^>]+>/g, "");

  // 替换 Windows/Linux 文件名非法字符
  // 非法集：\ / : * ? " < > | 以及控制字符
  // eslint-disable-next-line no-control-regex
  const illegalRe = /[\\/:*?"<>|\x00-\x1f\x80-\x9f]/g;
  const sanitized = noHtml.replace(illegalRe, replacement);

  return sanitized.replace(/\s+/g, " ").trim().replace(/\.$/, "").slice(0, 255); // 截断长度，防止文件名过长
}
