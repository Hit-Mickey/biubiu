import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { productName, version } = JSON.parse(await readFile("package.json", "utf8"));
const prefix = productName + "_" + version + "_";

function releaseFiles(platform, arch) {
  if (!["x64", "arm64"].includes(arch)) throw new Error("Unsupported architecture: " + arch);
  switch (platform) {
    case "win32":
      return { setup: prefix + arch + "-setup.exe", portable: prefix + "windows-" + arch + "-portable.zip" };
    case "darwin":
      return { dmg: prefix + arch + ".dmg", zip: prefix + "macos-" + arch + ".zip" };
    case "linux":
      return {
        appimage: prefix + (arch === "x64" ? "amd64" : "aarch64") + ".AppImage",
        deb: prefix + (arch === "x64" ? "amd64" : "arm64") + ".deb",
        rpm: productName + "-" + version + "-1." + (arch === "x64" ? "x86_64" : "aarch64") + ".rpm",
      };
    default:
      throw new Error("Unsupported release platform: " + platform);
  }
}

async function verifyFiles(dir, files) {
  for (const file of files) {
    const info = await stat(path.join(dir, file));
    if (!info.isFile() || info.size === 0) throw new Error("Invalid or empty release asset: " + file);
  }
}

async function portableZip(release, zip) {
  const stage = await mkdtemp(path.join(os.tmpdir(), "biubiu-portable-"));
  try {
    const files = [
      "biubiu.exe",
      "resources/ffmpeg/ffmpeg.exe",
      "resources/ffmpeg/COPYING.LGPLv2.1",
      ...["logo.png", "tray.ico", "prev.png", "next.png", "play.png", "pause.png"].map(f => "icons/" + f),
    ];
    if (existsSync(path.join(release, "WebView2Loader.dll"))) files.push("WebView2Loader.dll");
    for (const file of files) {
      await mkdir(path.dirname(path.join(stage, file)), { recursive: true });
      await copyFile(path.join(release, file), path.join(stage, file));
    }
    await writeFile(path.join(stage, "portable.flag"), "");
    execFileSync("tar.exe", ["-a", "-cf", zip, "-C", stage, "."], { stdio: "inherit", windowsHide: true });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function collect(target) {
  const arch = target ? { x86_64: "x64", aarch64: "arm64" }[target.split("-")[0]] : process.arch;
  const files = releaseFiles(process.platform, arch);
  const release = path.resolve("src-tauri/target", target ?? "", "release");
  const bundle = path.join(release, "bundle");
  const out = path.resolve("dist/release");
  await mkdir(out, { recursive: true });
  if (process.platform === "win32") {
    await copyFile(path.join(bundle, "nsis", files.setup), path.join(out, files.setup));
    await portableZip(release, path.join(out, files.portable));
  } else if (process.platform === "darwin") {
    const dmgArch = arch === "arm64" ? "aarch64" : "x64";
    await copyFile(path.join(bundle, "dmg", prefix + dmgArch + ".dmg"), path.join(out, files.dmg));
    const app = path.join(bundle, "macos", productName + ".app");
    execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, path.join(out, files.zip)], {
      stdio: "inherit",
    });
  } else {
    for (const [dir, file] of Object.entries(files)) {
      await copyFile(path.join(bundle, dir, file), path.join(out, file));
    }
  }
  const names = Object.values(files);
  await verifyFiles(out, names);
  if (process.env.GITHUB_OUTPUT) {
    const paths = names.map(file => "dist/release/" + file);
    await appendFile(process.env.GITHUB_OUTPUT, ["files<<BIUBIU_FILES", ...paths, "BIUBIU_FILES", ""].join("\n"));
  }
}

async function verifyRelease(dir) {
  const expected = ["win32", "darwin", "linux"].flatMap(platform =>
    ["x64", "arm64"].flatMap(arch => Object.values(releaseFiles(platform, arch))),
  );
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !expected.includes(entry.name)) throw new Error("Unexpected release asset: " + entry.name);
  }
  await verifyFiles(dir, expected);
  console.log(`Verified all ${expected.length} release assets for v${version}.`);
}

if (process.argv[2] === "--verify") {
  await verifyRelease(process.argv[3]);
} else {
  await collect(process.argv[2]);
}
