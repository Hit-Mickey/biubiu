import log from "electron-log";
import ffmpeg from "fluent-ffmpeg";
import fs from "node:fs";
import path from "node:path";

import { appSettingsStore } from "../../store";
import { IconBase } from "../../utils";

function fixFfmpegPath() {
  try {
    const configured = appSettingsStore.get("appSettings")?.ffmpegPath;
    if (configured && fs.existsSync(configured)) {
      log.info(`Found user configured ffmpeg at ${configured}`);
      ffmpeg.setFfmpegPath(configured);
      return;
    }
  } catch (error) {
    log.error("Error reading ffmpeg path from settings:", error);
  }

  const { platform, arch } = process;
  if (platform === "darwin" || platform === "linux") {
    const installed = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg", "/snap/bin/ffmpeg"].find(
      file => fs.existsSync(file),
    );
    if (installed) {
      log.info(`Found ffmpeg at ${installed}`);
      ffmpeg.setFfmpegPath(installed);
      return;
    }
  }

  const binaries: Partial<Record<NodeJS.Platform, string>> = {
    win32: "ffmpeg.exe",
    darwin: `ffmpeg-mac-${arch === "arm64" ? arch : "x64"}`,
    linux: "ffmpeg-linux",
  };
  const bundled = path.join(IconBase, "electron", "ffmpeg", binaries[platform] ?? "ffmpeg");
  if (fs.existsSync(bundled)) {
    if (platform !== "win32") {
      try {
        fs.chmodSync(bundled, "755");
      } catch (error) {
        log.error(`Failed to chmod ffmpeg at ${bundled}`, error);
      }
    }
    ffmpeg.setFfmpegPath(bundled);
  }
}

interface ConvertOptions {
  outputFileType: MediaDownloadOutputFileType;
  /** 有些视频可能没有音频 */
  audioTempPath?: string;
  videoTempPath?: string;
  outputPath: string;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

const getAvailableOutputPath = (outputPath: string) => {
  if (!fs.existsSync(outputPath)) return outputPath;

  const parsed = path.parse(outputPath);
  const name = parsed.ext ? parsed.name : parsed.base;
  const ext = parsed.ext;

  for (let i = 1; i < 10000; i += 1) {
    const next = path.join(parsed.dir, `${name} (${i})${ext}`);
    if (!fs.existsSync(next)) return next;
  }

  throw new Error("Cannot find available output path");
};

export const convert = async ({
  audioTempPath,
  videoTempPath,
  outputPath,
  outputFileType,
  onProgress,
  signal,
}: ConvertOptions): Promise<string> => {
  fixFfmpegPath();
  const finalOutputPath = getAvailableOutputPath(outputPath);
  return new Promise((resolve, reject) => {
    const command = ffmpeg();

    if (signal?.aborted) {
      return reject(new Error("Aborted"));
    }

    signal?.addEventListener("abort", () => {
      command.kill("SIGKILL");
      reject(new Error("Aborted"));
    });

    if (outputFileType === "video") {
      if (!videoTempPath) {
        return reject(new Error("Video conversion requires video temp path"));
      }

      command.input(videoTempPath);

      if (audioTempPath) {
        // ffmpeg -i video -i audio -c:v copy -c:a copy -shortest output
        command.input(audioTempPath);
        command.outputOptions(["-c:v copy", "-c:a copy", "-shortest"]);
      } else {
        // ffmpeg -i video -c:v copy output
        command.outputOptions(["-c:v copy"]);
      }
    } else {
      if (!audioTempPath) {
        return reject(new Error("Audio conversion requires audio temp path"));
      }
      // ffmpeg -i audio -c:a copy output
      command.input(audioTempPath);
      command.outputOptions(["-c:a copy"]);
    }

    command.on("progress", progress => {
      if (onProgress && progress.percent) {
        onProgress(Math.round(progress.percent));
      }
    });

    command.on("error", err => {
      reject(err);
    });

    command.on("end", () => {
      resolve(finalOutputPath);
    });

    // Save to output path
    command.save(finalOutputPath);
  });
};
