import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Windows ships the reproducible binary. Build for the host architecture on Unix.
if (process.platform !== "win32") {
  const name = process.platform === "darwin" ? "ffmpeg-mac" : "ffmpeg-linux";
  const file = fileURLToPath(new URL("../src-tauri/resources/ffmpeg/" + name, import.meta.url));
  const decoders = spawnSync(file, ["-hide_banner", "-decoders"], { encoding: "utf8" });
  const muxers = spawnSync(file, ["-hide_banner", "-muxers"], { encoding: "utf8" });
  if (
    decoders.status !== 0 ||
    !/\bwmav2\b/.test(decoders.stdout) ||
    muxers.status !== 0 ||
    !/\bf32le\b/.test(muxers.stdout)
  ) {
    const build = spawnSync("bash", ["scripts/build-ffmpeg.sh"], { stdio: "inherit" });
    process.exitCode = build.status ?? 1;
  }
}
