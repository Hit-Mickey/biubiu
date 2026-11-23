<h1 align="center">BiuBiu 音乐播放器</h1>
<p align="center">
  <img src="./src-tauri/icons/128x128@2x.png" alt="BiuBiu logo" width="120" />
</p>
<p align="center">
  支持哔哩哔哩（B 站）、本地音乐和 WebDAV 的跨平台音乐播放器 🎧🎶
</p>
<p align="center">
  <a href="https://github.com/Hit-Mickey/biubiu/releases">
    <img src="https://img.shields.io/badge/version-v2.1.0-blueviolet" alt="v2.1.0" />
  </a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-orange.svg" alt="License" /></a>
</p>

---

## 相较[wood3n/biu](https://github.com/wood3n/biu)的新增与改进

- **桌面端使用 Tauri v2 和 Rust进行重构，大幅降低内存占用**。
- **新增 Android 版**，对Android界面进行优化。
- **搜索支持 BV 号和 B 站视频链接**。Android 和桌面端都可直接输入 BV 号、完整视频链接或 `b23.tv` 短链接查找对应曲目，也可按关键词搜索。
- **推荐页支持手动刷新**。
- **新增定位当前播放**。「我的歌单」「远程列表」和「本地音乐」可一键滚动到正在播放的歌曲。
- **新增「我的歌单」和外部歌单导入**。可创建普通及动态歌单、关联 B 站收藏夹，并将网易云音乐和 QQ 音乐公开歌单的曲目匹配到 B 站。
- **新增桌面歌词与歌词设置**。桌面歌词支持悬停工具栏、锁定、调色和调整字号。全屏歌词增加本地歌词读取和逐字高亮，歌词搜索可选 QQ 音乐、网易云或 LRCLIB，并可设置默认源。
- **改进歌词显示与控制**。全屏和桌面歌词支持双语分行，桌面歌词长行可滚动。迷你播放器可直接开关桌面歌词。Windows 和 Linux 默认使用 `Ctrl+G` 在应用内开关歌词，使用 `Ctrl+Alt+G` 全局开关，macOS 对应 `⌘+G` 和 `⌘+⌥+G`。
- **新增听歌统计及曲库备份**。可将播放记录保存在本机，并将配置和曲库备份到本地文件或 WebDAV。
- **新增 WebDAV 远程目录中的歌曲播放**，支持递归扫描、搜索排序、列表同步、封面、歌词和歌曲缓存。

## ✨原版功能

- 🎼 支持登录 Bilibili 并获取收藏夹、稍后再看、历史记录等信息
- 🎧 高品质音频播放，优先拉取更高码率音频流（如无损 Flac，192K/Hi-Res）
- 🔥 支持视频文件以及提取视频中的音频下载；支持收藏夹视频批量下载
- 🧩 轻量界面，内置浅色和深色主题，同时可自定义部分主题样式，细腻的滚动与动效体验
- 💿 系统托盘与最小化隐藏，便捷控制播放
- 🍃 支持 mini 播放器模式，占用系统资源少，同时保留主窗口功能
- ♻️ 安装包支持自动检测更新，始终保持最新体验

## 下载和使用

在 GitHub Releases 中选择与你的系统和处理器对应的文件。Windows 的「设置 → 系统 → 系统信息」会显示处理器架构，Mac 的「关于本机」会显示芯片型号。Linux 可运行 `uname -m` 查看。 [下载 BiuBiu](https://github.com/Hit-Mickey/biubiu/releases)

| 系统               | 架构                           | 安装或运行                                                                                                      |
| -------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Windows 10 / 11    | x64、ARM64                     | 双击对应架构的 `-setup.exe` 安装。便携版请将 `-portable.zip` 完整解压后运行 `biubiu.exe`。                      |
| macOS 12 及以上    | Intel x64、Apple Silicon ARM64 | 打开 DMG，将 BiuBiu 拖至「应用程序」，也可解压对应架构的 ZIP。                                                  |
| Linux              | x86_64、aarch64                | AppImage 需要执行权限，可运行 `chmod +x BiuBiu_*.AppImage`。Debian / Ubuntu 可用 DEB，Fedora 系发行版可用 RPM。 |
| Android 8.0 及以上 | ARM64、x86_64                  | 在含有 Android 安装包的发布中选择 `BiuBiu_版本号_android.apk`，打开后按系统提示安装。                           |

应用启动后和运行期间会检查本仓库的最新正式版。「设置 → 关于应用」也可手动检查。点击「下载更新」会下载对应系统和架构的发布附件，并校验 GitHub 提供的 SHA-256。校验通过后，Windows 安装版可点击「退出并安装更新」，macOS 会打开 DMG，Linux 会打开系统安装工具或替换当前 AppImage。Windows 便携版可打开下载目录，退出程序后解压新 ZIP。

## Android 操作

安卓版直接使用桌面端的页面组件、主题和 Rust 播放引擎。播放、入队、编辑歌单、搜索歌词及设置使用同一套操作逻辑。侧栏默认显示图标和文字，点 BiuBiu 名称上方的按钮可收起或展开文字，按钮始终靠左。在歌曲条目上连续轻点两下即可播放，点右侧省略号可打开 UP 主主页。B 站歌曲列表同时展示播放量和时长。底栏显示歌曲信息和播放控制，可直接选择线路、定时暂停、切换播放顺序、调整音量和倍速。点封面进入播放页查看歌词，点队列图标查看播放列表。锁屏、耳机和通知栏也能控制当前队列。

在「本地音乐」中添加系统文件选择器授权的音乐目录。「远程列表」可直接使用 WebDAV，连接密码通过 Android Keystore 加密。Android 10 及以上的默认下载目录为 `Download/BiuBiu`，也可在设置中选择其他目录。

## 从 Electron 版升级

建议先在旧版「设置 → 曲库与备份」导出一份备份，然后退出旧版，启动新版。新版首次启动会从同一用户的旧版配置目录读取通用设置、快捷键、WebDAV 列表、歌词和下载记录。已有的新版配置优先。旧版目录保留，可继续使用原版导出备份。

旧版的桌面歌单、听歌记录和播放队列保存在 Chromium 数据库。迁移时会临时使用已安装的 Edge、Chrome 或 Chromium 读取 BiuBiu 数据库的副本，导入歌单、记录、队列和播放位置，完成后关闭临时浏览器。缺少可用浏览器或读库失败时，下次启动会重试。也可在新版「设置 → 曲库与备份」导入旧版导出的曲库文件。导入已有文件时，界面会预览将替换的内容。

新版需要在 B 站重新登录，并在需要认证的 WebDAV 列表中重新填写密码。WebDAV 音频缓存可在下次播放时重新生成。Windows 正式版配置在 `%APPDATA%\BiuBiu-Tauri`，macOS 在 `~/Library/Application Support/BiuBiu-Tauri`，Linux 在 `${XDG_CONFIG_HOME:-~/.config}/BiuBiu-Tauri`。开发版使用带 `-dev` 的独立目录。

## WebDAV 远程列表

1. 在侧栏打开 **远程列表 → 新建 WebDAV 列表**，填写列表名称和服务器地址，例如 `https://nas.example.com/dav/`。需要认证时，填写账号和密码。
2. 填写相对于服务器地址的**文件目录**，例如 `/音乐`。留空时扫描服务器地址对应的根目录。勾选 **包含子目录** 可继续扫描最多 5 层。
3. 点击 **测试连接**，然后 **保存**。双击歌曲可播放，也可搜索、排序、多选后批量播放或加入队列。

列表会在应用启动时及运行期间每天本地时间 11:00 自动同步，也可点击 **更新远程列表** 手动刷新。支持 MP3、FLAC、WAV、OGG、OGA、Opus、M4A 和 AAC，并读取内嵌封面、歌词及同目录的同名封面和 `.lrc` 文件。

编辑列表时可启用 **播放时读取歌曲标签**，扫描时先显示文件名。在 **WebDAV 设置** 中可启用或清空歌曲缓存，也可开启调试日志。

启用 **移除歌曲时同时删除远程文件** 后，在列表中确认移除歌曲会删除 WebDAV 服务器上的对应音频文件。

## 桌面曲库

- **我的歌单**：将当前曲目或队列保存到普通歌单，也可以把多个普通歌单组合为自动去重的动态歌单。关联自己的 B 站收藏夹后，可预览新增、改名和移除，再同步到本地；默认保留远端已移除的曲目，不写回收藏夹。
- **导入外部歌单**：在「我的歌单」中粘贴网易云／QQ 音乐公开歌单的完整链接，或输入 `netease:数字`、`qq:数字`。不限制歌单总首数；先读取平台公开的曲目信息，再按需匹配 B 站视频。可以停止匹配、改选候选、指定 BV 号或跳过。确认后才存为本地歌单，不读取外站音频。
- **全屏歌词**：本地音乐优先读取同名 `.spl` / `.lrc`，没有侧车文件时读取内嵌歌词；B 站字幕与 WebDAV 歌词仍可使用。支持带时间戳的逐字高亮、译文和罗马音；在歌词区可搜索并采用网易云、QQ 音乐或 LRCLIB 的歌词，不修改原文件。
- **桌面歌词**：点击播放栏或全屏歌词区的按钮直接显示，再次点击打开设置。鼠标移入歌词窗口时，工具栏在歌词上方居中显示，可锁定、调整颜色和字号或关闭。颜色和字号会保存，锁定后鼠标可穿透歌词区域。
- **歌词搜索默认源**：在「设置 → 常规设置 → 播放」中选择。初始为 QQ 音乐，可改用网易云或 LRCLIB。
- **定时暂停**：点击底部播放栏的时钟，输入时长并选择秒、分钟或小时（如 `90 秒`、`1.5 小时`），点击「开始定时」。也可使用快捷分钟按钮，或在到点前随时更新、取消；到点只暂停，不退出应用。
- **设置 → 曲库与备份**：听歌统计默认关闭；开启后仅在本机保存最近 2,000 次播放至结尾的记录。数据备份支持文件，以及已有 WebDAV 列表目录下的 `BiuBiu-Backups/`。恢复前可预览，确认后替换桌面歌单、队列、听歌记录和通用设置，不会自动播放。备份不包含音频、目录凭据或代理密码，本地路径和 WebDAV 连接需另行配置。常规设置中的旧版配置导入／导出保留。
- **播放线路**：点击播放栏定时暂停左侧，或全屏播放页搜索歌词下方的「播放线路」，可测试当前 B 站歌曲的节点并保存首选线路。

## 本地开发与打包

桌面外壳使用 Tauri v2，主窗口、迷你播放器和桌面歌词使用系统 WebView。Rust 负责播放队列、音频解码、输出、下载、WebDAV、SQLite 和系统媒体控制。切换到迷你播放器或关闭到托盘时会释放主窗口，后台播放、定时暂停和播放进度由 Rust 继续维护。退出后再次打开，可以从保存的位置继续播放。

准备 Node.js（22.17.1 及以上的 22.x，或 24.20.0 及以上的 24.x）、pnpm 10.24.0 和稳定版 Rust。Windows 推荐安装 Visual Studio C++ 桌面开发工具和 WebView2，macOS 需要 Xcode 命令行工具。Ubuntu 22.04 所需系统开发包见发布工作流的「Linux build libraries」。 [Tauri 开发环境](https://v2.tauri.app/start/prerequisites/) · [发布工作流](.github/workflows/release.yml)

```bash
pnpm install --frozen-lockfile
pnpm dev
```

```bash
pnpm exec tsc --noEmit
pnpm exec vitest run
cargo test --manifest-path src-tauri/Cargo.toml
pnpm build
node scripts/collect-release.mjs
```

`pnpm build:web` 构建网页资源，输出到 `dist/web/`。`pnpm build` 构建当前平台的程序和安装包。Windows 可直接运行 `src-tauri/target/release/biubiu.exe` 测试，安装包位于 `src-tauri/target/release/bundle/nsis/`。最后一条命令将本平台发布附件整理到 `dist/release/`，包括 Windows 便携 ZIP 或 macOS 应用 ZIP。

Windows x64 仓库附带精简版 FFmpeg。Linux 和 macOS 首次开发或打包时会从 FFmpeg 官方下载源码、验证摘要并为本机架构编译，需要 Bash、C 编译器和 GNU Make。Windows ARM64 的发布任务使用 CLANGARM64 编译原生 FFmpeg。构建选项和所用源码版本见 [FFmpeg 构建脚本](scripts/build-ffmpeg.sh)，随包分发的许可见 [LGPL 2.1](src-tauri/resources/ffmpeg/COPYING.LGPLv2.1)。

### 构建 Android APK

安装 JDK 21、Android SDK（Platform 37.0、Build Tools 36.0.0）、NDK 27.2.12479018 和 CMake 3.22.1。设置 `JAVA_HOME`、`ANDROID_HOME`、`NDK_HOME`，将 SDK 中的 CMake、Ninja 和 platform-tools 加入 PATH。FFmpeg 使用 Bash、GNU Make 和宿主 C 编译器构建，Windows 可通过 `BASH_PATH` 指定 Git Bash，通过 `MAKE` 指定 GNU Make。

```sh
rustup target add aarch64-linux-android x86_64-linux-android
pnpm install --frozen-lockfile
pnpm dev:android
# 构建可直接安装的开发签名包
pnpm build:android --debug
```

APK 位于 `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`。发布时运行 `pnpm build:android`，Gradle 从 `BIUBIU_ANDROID_KEYSTORE`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD` 读取长期签名。后续版本使用同一密钥才能覆盖安装。

在 GitHub 仓库的 Actions secrets 中配置 `ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS` 和 `ANDROID_KEY_PASSWORD`。其中 `ANDROID_KEYSTORE_BASE64` 是签名文件的 Base64 内容。标签发布需要完整签名配置。手动从分支运行测试构建时，签名配置不完整会生成开发签名的 APK，可从运行记录的 `Android-test` Artifacts 下载。

## 发布新版本

1. 将 `package.json`、`src-tauri/Cargo.toml` 和 `src-tauri/tauri.conf.json` 的版本改为相同的 SemVer 值，运行一次 Cargo 更新 `src-tauri/Cargo.lock`，并提交版本改动。
2. 在目标提交上打标签并推送。例如，软件版本 `2.1.0` 对应标签 `v2.1.0`。
3. GitHub Actions 的 **Release** 工作流会为 Windows、macOS 和 Linux 各构建 x64、ARM64 两种架构，并构建同时支持 ARM64 和 x86_64 的 Android APK。14 个桌面附件和 1 个正式签名 APK 全部通过校验后，工作流才会公开 GitHub Release。正式版和预发布版分别标记。
4. 网页补发可在 **Actions → Release → Run workflow** 填入已有标签。手工选择分支且标签留空，只会生成该分支的测试构建，可在运行页面下载 Artifacts。已经公开的同名 Release 会保留。

## 📄 许可证

本项目以 PolyForm Noncommercial License 1.0.0（非商业许可）发布，禁止任何商业用途。详情参见 [`LICENSE`](LICENSE)（SPDX：`PolyForm-Noncommercial-1.0.0`）。

---

如果你喜欢这个项目，欢迎 ⭐️ Star 支持！也欢迎提出 Issue 交流与反馈 🙌

## 🙏 鸣谢

- 本项目基于 [wood3n/biu](https://github.com/wood3n/biu)。
- WebDAV 远程列表参考了 [any-listen](https://github.com/any-listen/any-listen)。
- 特别感谢 [SocialSisterYi/bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect) 对哔哩哔哩 API 的长期收集与整理，为本项目相关接口的使用提供了重要参考。
- `bilibili-API-collect` 的相关资料按其 `CC-BY-NC 4.0` 许可条款用于学习与研究。

---

## 🤝 贡献指南

非常欢迎社区贡献！你可以按以下流程参与：

1. Fork 本仓库并创建分支：`feature/your-feature` / `fix/your-fix`
2. 开发并通过本地构建与基本自测（如：`pnpm dev`、`pnpm build`）
3. 提交 PR，详述改动点与影响范围
4. 审查通过后合入主分支

建议：

- 使用 ESLint/Prettier 保持代码风格一致（ESLint/Prettier 已配置）
- 提交信息简洁规范（推荐使用 `feat: ...`、`fix: ...` 等约定式格式）
- PR 中附上必要的截图或说明

## ⚖️ 法律声明与使用限制

- 本项目仅供学习与研究使用，禁止任何形式的商业用途（包括但不限于销售、收费服务、广告变现、商业集成等）。
- 本项目与 Bilibili 无任何官方关联或背书，不使用其商标与标识；涉及的名称与商标归其权利人所有。
- 音乐来源包括 B 站公开接口、用户账号授权的数据、本地文件和用户配置的 WebDAV 目录。使用 B 站功能时需遵守其《用户协议》《社区规则》及相关法律法规。部分音频清晰度与解析可能需要登录或大会员权限。
- 禁止绕过登录/会员权限、DRM/加密措施，或进行批量爬取、恶意抓取等违反平台规则的行为。
- 如需商业授权或调整许可，请联系作者；如涉及权利或合规问题，请通过 Issues 反馈以便及时处理。
