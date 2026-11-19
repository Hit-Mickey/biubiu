<h1 align="center">BiuBiu 音乐播放器</h1>
<p align="center">
  <img src="./screenshots/logo.svg" alt="BiuBiu logo" width="120" />
</p>
<p align="center">
  支持哔哩哔哩（B 站）、本地音乐和 WebDAV 的跨平台桌面音乐播放器 🎧🎶
</p>
<p align="center">
  <a href="https://github.com/Hit-Mickey/biubiu/releases">
    <img src="https://img.shields.io/badge/version-v1.0.0-blueviolet" alt="v1.0.0" />
  </a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-orange.svg" alt="License" /></a>
</p>

<table>
  <tr>
    <td width="50%" align="center">
      <img src="./screenshots/home.png" alt="home" width="100%" />
    </td>
    <td width="50%" align="center">
      <img src="./screenshots/main.png" alt="main" width="100%" />
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <img src="./screenshots/download.png" alt="download" width="100%" />
    </td>
    <td width="50%" align="center">
      <img src="./screenshots/fullscreen.jpg" alt="fullscreen" width="100%" />
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <img src="./screenshots/playlist.png" alt="playlist" width="100%" />
    </td>
    <td width="50%" align="center">
      <p> mini 播放器</p>
      <img src="./screenshots/mini.jpg" alt="mini" width="100%" />
    </td>
  </tr>
</table>

---

## ✨ 特色功能

- 🎼 支持登录 Bilibili 并获取收藏夹、稍后再看、历史记录等信息
- 📁 扫描本地音乐目录，把歌曲加入播放队列
- ☁️ 播放 WebDAV 远程目录中的歌曲，支持递归扫描、搜索排序、列表同步、封面、歌词和歌曲缓存
- 🎧 高品质音频播放，优先拉取更高码率音频流（如无损 Flac，192K/Hi-Res）
- 🔥 支持视频文件以及提取视频中的音频下载；支持收藏夹视频批量下载
- 🧩 轻量界面，内置浅色和深色主题，同时可自定义部分主题样式，细腻的滚动与动效体验
- 💿 系统托盘与最小化隐藏，便捷控制播放
- 🍃 支持 mini 播放器模式，占用系统资源少，同时保留主窗口功能
- ♻️ 安装包支持自动检测更新，始终保持最新体验

## 下载和使用

本地打包产物位于 `dist/artifacts/`。Windows 提供 x64、ARM64 两种架构的安装版和便携版，macOS 提供 DMG 和 ZIP，Linux 提供 AppImage、DEB 和 RPM。请按系统和架构选择。

- 版本发布与更新 [BiuBiu GitHub Releases](https://github.com/Hit-Mickey/biubiu/releases)
- 快速选择：
  - 优先选安装包 `win-setup`；需要免安装/无管理员权限选 `win-portable`
  - 优先选 `dmg`；需要脚本/自动化分发可选 `zip`
  - 优先选 `AppImage`；偏好包管理器可选 `deb`/`rpm`
- 常见产物对比如下（`<version>` 为版本号，`<arch>` 常见为 `x64`/`arm64`）：

<table>
  <thead>
    <tr>
      <th align="left">系统</th>
      <th align="left">推荐下载</th>
      <th align="left">优点</th>
      <th align="left">限制</th>
      <th align="left">文件名示例</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>
        <img alt="Windows" src="https://img.shields.io/badge/Windows-10%2F11-0078D6?logo=windows&logoColor=white" />
        <br />
        <code>x64</code>/<code>arm64</code>
      </td>
      <td>
        安装包（NSIS）
        <br />
        <code>win-setup</code>
      </td>
      <td>
        一键安装/卸载、开始菜单/桌面快捷方式<br />
        通常兼容性最好、适合长期使用<br />
        自动更新支持更完整
      </td>
      <td>
        需要安装到磁盘（非免安装）<br />
        可能触发系统权限/安全提示
      </td>
      <td>
        <code>BiuBiu-&lt;version&gt;-win-setup-x64.exe</code><br />
        <code>BiuBiu-&lt;version&gt;-win-setup-arm64.exe</code>
      </td>
    </tr>
    <tr>
      <td>
        <img alt="Windows" src="https://img.shields.io/badge/Windows-10%2F11-0078D6?logo=windows&logoColor=white" />
        <br />
        <code>x64</code>/<code>arm64</code>
      </td>
      <td>
        免安装版（Portable）
        <br />
        <code>win-portable</code>
      </td>
      <td>
        解压/下载即用，不改系统配置<br />
        适合U盘/临时环境/无管理员权限
      </td>
      <td>
        应用内自动更新受限，通常需要手动下载替换
      </td>
      <td>
        <code>BiuBiu-&lt;version&gt;-win-portable-x64.exe</code><br />
        <code>BiuBiu-&lt;version&gt;-win-portable-arm64.exe</code>
      </td>
    </tr>
    <tr>
      <td>
        <img alt="macOS" src="https://img.shields.io/badge/macOS-12%2B-000000?logo=apple&logoColor=white" />
        <br />
        <code>x64</code>/<code>arm64</code>
      </td>
      <td>
        DMG（推荐）
        <br />
        <code>.dmg</code>
      </td>
      <td>
        拖拽安装体验好、适合大多数用户<br />
        分发与回收方便
      </td>
      <td>
        首次打开可能需要在系统设置中允许来源<br />
        不同系统安全策略提示不同
      </td>
      <td>
        <code>BiuBiu-&lt;version&gt;-mac-x64.dmg</code><br />
        <code>BiuBiu-&lt;version&gt;-mac-arm64.dmg</code>
      </td>
    </tr>
    <tr>
      <td>
        <img alt="macOS" src="https://img.shields.io/badge/macOS-12%2B-000000?logo=apple&logoColor=white" />
        <br />
        <code>x64</code>/<code>arm64</code>
      </td>
      <td>
        ZIP
        <br />
        <code>.zip</code>
      </td>
      <td>
        体积通常更小、适合脚本/CI 分发<br />
        解压即用
      </td>
      <td>
        安装体验不如 DMG 直观（需要手动放入应用目录）
      </td>
      <td>
        <code>BiuBiu-&lt;version&gt;-mac-x64.zip</code><br />
        <code>BiuBiu-&lt;version&gt;-mac-arm64.zip</code>
      </td>
    </tr>
    <tr>
      <td>
        <img alt="Linux" src="https://img.shields.io/badge/Linux-x64%2Farm64-FCC624?logo=linux&logoColor=000000" />
      </td>
      <td>
        AppImage（最通用）
        <br />
        <code>.AppImage</code>
      </td>
      <td>
        发行版通用、下载即运行<br />
        不依赖包管理器，适合多发行版
      </td>
      <td>
        需手动赋予可执行权限（例如 <code>chmod +x</code>）<br />
        桌面集成需要额外操作
      </td>
      <td>
        <code>BiuBiu-&lt;version&gt;-linux-x64.AppImage</code><br />
        <code>BiuBiu-&lt;version&gt;-linux-arm64.AppImage</code>
      </td>
    </tr>
    <tr>
      <td>
        <img alt="Linux" src="https://img.shields.io/badge/Linux-x64%2Farm64-FCC624?logo=linux&logoColor=000000" />
      </td>
      <td>
        DEB / RPM
        <br />
        <code>.deb</code> / <code>.rpm</code>
      </td>
      <td>
        更符合系统习惯，桌面/菜单集成更好<br />
        方便用系统包管理器安装/卸载
      </td>
      <td>
        与发行版/依赖关系更强（Debian/Ubuntu 用 <code>.deb</code>，Fedora/RHEL 用 <code>.rpm</code>）
      </td>
      <td>
        <code>BiuBiu-&lt;version&gt;-linux-x64.deb</code> / <code>.rpm</code><br />
        <code>BiuBiu-&lt;version&gt;-linux-arm64.deb</code> / <code>.rpm</code>
      </td>
    </tr>
  </tbody>
</table>

- 系统要求（建议）
  - Windows 10 / 11（`x64` / `arm64`）
  - macOS 12+（`x64` / `arm64`）
  - 主流 Linux 发行版（`x64` / `arm64`）
- 架构怎么选
  - Windows：设置 → 系统 → 关于 → “系统类型”（ARM 设备选 `arm64`，其余多为 `x64`）
  - macOS：Apple 芯片选 `arm64`，Intel 芯片选 `x64`
  - Linux：执行 `uname -m`，常见 `x86_64` 对应 `x64`，`aarch64` 对应 `arm64`
- 自动更新说明
  - 应用会定期检查本仓库的 GitHub Releases。设置页也可手动检查。
  - Windows 免安装版（portable）在应用内下载更新受限，建议前往 Releases 手动下载替换。
- `*.yml`、`*.blockmap` 为自动更新辅助文件，手动下载时无需关注。

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
- **定时暂停**：点击底部播放栏的时钟，输入时长并选择秒、分钟或小时（如 `90 秒`、`1.5 小时`），点击「开始定时」。也可使用快捷分钟按钮，或在到点前随时更新、取消；到点只暂停，不退出应用。
- **设置 → 曲库与备份**：听歌统计默认关闭；开启后仅在本机保存最近 2,000 次播放至结尾的记录。数据备份支持文件，以及已有 WebDAV 列表目录下的 `BiuBiu-Backups/`。恢复前可预览，确认后替换桌面歌单、队列、听歌记录和通用设置，不会自动播放。备份不包含音频、目录凭据或代理密码，本地路径和 WebDAV 连接需另行配置。常规设置中的旧版配置导入／导出保留。
- **播放线路**：播放 B 站歌曲时，可在上述设置中手动测试当前音质的可用节点并设为首选。未手动测速时不产生测速流量；节点不可用时仍按接口返回的默认地址选取。

## 本地开发与打包

使用 Node.js `22.17.1` 及以上的 22.x，或 `24.20.0` 及以上的 24.x，并使用 pnpm `10.24.0`。在项目根目录执行以下命令。

```bash
pnpm install --frozen-lockfile
pnpm dev
```

如果 Windows PowerShell 中的中文日志出现乱码，在运行 `pnpm dev` 前切换终端编码。

```powershell
chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
```

运行 `pnpm test --run` 执行测试。运行 `pnpm build` 构建当前系统的 x64 和 ARM64 安装包。Electron 主进程和预加载脚本生成在 `.electron/`，界面生成在 `dist/web/`，打包产物生成在 `dist/artifacts/`。Linux 打包需要 `rpm` 工具。

推送 `v*` 标签时，GitHub Actions 的 **Release** 工作流会构建 Windows、macOS 和 Linux 安装包。各平台构建成功后，安装包会发布到 GitHub Releases。也可以在工作流页面选择已有的版本标签手动运行。 [Release 工作流](https://github.com/Hit-Mickey/biubiu/actions/workflows/release.yml)

设置页显示版本 `v1.0.0`。打包和更新使用 SemVer `1.0.0`，对应的发布标签为 `v1.0.0`。

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
