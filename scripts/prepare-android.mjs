import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const buildScript = path.join(root, "scripts", "build-ffmpeg.sh");
for (const abi of ["arm64-v8a", "x86_64"]) {
  const binary = path.join(root, "src-tauri", "gen", "android", "ffmpeg", abi, "libbiubiu_ffmpeg.so");
  if (existsSync(binary) && statSync(binary).mtimeMs >= statSync(buildScript).mtimeMs) continue;
  const shell = process.env.BASH_PATH || "bash";
  const result = spawnSync(shell, ["scripts/build-ffmpeg.sh", "android", abi], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Android FFmpeg build failed for " + abi);
}
