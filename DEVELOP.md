# WizSync 技术架构与核心设计方案

本文档旨在为开发者提供 WizSync 的深度技术概览，涵盖架构设计、核心逻辑以及关键技术方案。

---

## 1. 总体架构 (Architecture Overview)

WizSync 采用 **Electron** 框架构建，遵循典型的 **主进程 (Main Process)** 与 **渲染进程 (Renderer Process)** 分离架构。

### 1.1 模块职责划分

- **Main Process (`src/main/`)**:
  - **App Lifecycle**: 负责应用的启动、退出、窗口管理及系统托盘 (Tray) 交互。
  - **SyncManager**: 核心调度引擎，负责子进程管理、定时同步和异常处理。
  - **SyncStore**: 基于 `electron-store` 的持久化层，保存用户配置的任务。
  - **Binary Management**: 动态计算并调用内置的 Unison 二进制文件。
- **Renderer Process (`src/render/`)**:
  - **UI 层**: 使用 React + TailwindCSS 构建的现代化界面。
  - **状态管理**: 实时反映同步状态、任务进度和日志输出。
- **IPC Bridge (`src/main/preload.ts`)**:
  - 定义了安全的通信接口，允许渲染进程安全地调用主进程功能。

---

## 2. 核心同步方案 (Core Sync Logic)

WizSync 的同步能力并非从零开发，而是构建在成熟的开源同步引擎 **Unison** 之上。

### 2.1 同步引擎：Unison
- **原理**: 使用类似 rsync 的算法，但支持更强大的双向同步。它通过维护一个“状态库 (Archive)”来跟踪文件变更。
- **优势**: 能够识别双向修改并处理冲突，确保跨设备数据的一致性。

### 2.2 稳定性与大数据量支持
针对大数据量同步，WizSync 做了以下优化：
- **原子性操作**: Unison 默认采用“先同步到临时文件再移动”的策略，确保同步中断不会损坏原始文件。
- **多线程加速**: 对于包含大量小文件的目录，支持开启 `-maxthreads` 多线程并发同步。
- **差异对比 (Fastcheck)**: 默认开启快速检查模式，通过文件大小和修改时间快速识别变更，极大地提升了大数据量下的扫描速度。
- **断线重连**: 自动识别网络驱动器挂载或磁盘掉线，并在恢复后自动重新初始化同步任务。

---

## 3. 关键技术细节

### 3.1 内置二进制分发
为了实现“开箱即用”，WizSync 将对应平台的 Unison 二进制文件内置在 `src/resources/bin` 目录下：
- **macOS**: `darwin-x64` / `darwin-arm64`（随仓库提供）。
- **Windows**: `win32-x64`（`unison.exe`，由 `pnpm fetch:unison` 下载官方 Release）。
- **Linux**: `linux-x64`（Ubuntu 22.04 静态构建，由 `pnpm fetch:unison` 下载官方 Release）。
- **路径定位**: 主进程按 `process.platform` + `process.arch` 计算目录，动态判断 `app.isPackaged`，在开发和生产环境下准确找到二进制路径。

> Linux/Windows 开发或本地打包前，先执行 `pnpm fetch:unison` 下载当前平台二进制（脚本幂等，已存在则跳过；CI 中会自动执行）。

### 3.2 托盘交互 (Tray Experience)
托盘图标不仅仅是一个快捷方式，它是主窗口的补充：
- **实时反馈**: 图标旁显示的数字代表正在同步的任务数。
- **任务管理**: 点击托盘可直接看到简化版的任务列表，并能快速启停。

### 3.3 性能优化
- **日志缓冲**: Unison 的输出先进入缓冲区，达到一定长度后再通过 IPC 发送到 UI，避免高频渲染导致界面卡顿。
- **异步统计**: 目录大小统计属于重型 IO 操作，完全异步化执行，不阻塞核心同步流程。

---

## 4. 开发建议

- **新增功能**: 建议遵循 `main.ts` 保持轻量、逻辑下沉到 `libs/` 的原则。
- **二进制更新**: 如果需要更新 Unison 版本，请确保替换 `src/resources/bin` 下的所有架构文件并保持执行权限。
- **调试**: 主进程日志可通过控制台查看，Unison 详细日志可在应用的“查看日志”模态框中实时追踪。

---

## 5. 发布流程 (Release)

发布由 GitHub Actions（`.github/workflows/release.yml`）自动完成，**推送 `v*` 标签即触发**：

```bash
git tag v1.0.7
git push origin v1.0.7
```

工作流会依次执行：

1. 在 `ubuntu-latest` 上执行类型检查（`tsc`）与单元测试（`vitest`）；
2. 按平台并行构建：macOS `arm64` / `x64`、Windows `x64`、Linux `x64`；
3. Windows / Linux 构建前自动执行 `node scripts/fetch-unison.mjs` 拉取官方 Unison 二进制；
4. 用 `electron-builder` 生成安装包，产物名形如 `WizSync-1.0.7-arm64.dmg`、`WizSync-1.0.7-x64.exe`、`WizSync-1.0.7-x64.AppImage`、`WizSync-1.0.7-x64.deb`；
5. 将全部产物上传到同名 GitHub Release，并自动生成 Release Notes。

补充说明：

- 构建时会把 `package.json` 的 `version` 同步为标签去掉 `v` 后的值，因此无需手动改版本号；
- `package.json` 的 `build.electronDownload.mirror` 指向 npmmirror，避免国内网络直连 GitHub 下载 Electron 超时；如 CI/本地网络可直连官方源，可删除该配置；
- 标签含 `-`（如 `v1.0.7-beta.1`）会发布为 **Pre-release**；
- 手动触发（Actions → Release → Run workflow）只构建并上传 Actions 产物，不会创建 Release；
- 当前工作流未配置代码签名与公证（macOS）/ 证书签名（Windows），产物属于未签名版本：macOS 用户首次打开需在“系统设置 → 隐私与安全性”中放行，Windows 可能触发 SmartScreen 提示；如需正式分发，可补充 `CSC_LINK` / `CSC_KEY_PASSWORD` 及 Apple 公证相关 Secrets；
- Linux 提供 AppImage（免安装）与 deb（Debian/Ubuntu）两种包；
- Windows 的孤儿 Unison 进程清理依赖 `ps`，目前仅在 macOS/Linux 生效。

### 5.1 本地构建

本地构建统一走 `scripts/build.mjs`，它会先准备好目标平台的 Unison 二进制，再依次执行 `tsc`、`vite build`、`electron-builder`：

```bash
pnpm build          # 构建当前平台（macOS 按当前架构：Apple Silicon 为 arm64）
pnpm build:mac      # macOS，可加 --arch=x64 构建 Intel 版
pnpm build:win      # Windows x64（NSIS 安装包）
pnpm build:linux    # Linux x64（AppImage + deb）
```

产物统一输出到 `release/`，例如 `WizSync-1.0.7-arm64.dmg`、`WizSync-1.0.7-x64.exe`、`WizSync-1.0.7-x86_64.AppImage`、`WizSync-1.0.7-amd64.deb`。

脚本常用参数：

```bash
node scripts/build.mjs win --arch=x64     # 显式指定架构
node scripts/build.mjs win --skip-fetch   # 跳过 Unison 下载（二进制已就绪）
node scripts/build.mjs win --no-wine-check
```

平台与前置条件：

- **macOS**：只能在 macOS 主机上构建（`electron-builder` 限制），需要 Xcode Command Line Tools；
- **Windows**：在 macOS 上可直接交叉构建，`electron-builder` 会自动下载内置的 `wine-4.0.1-mac` 生成 NSIS 安装包（Apple Silicon 需已安装 Rosetta 2）；在 Linux 主机上交叉构建则需要系统预装 Wine（`sudo apt install wine64`），否则脚本会提示并可加 `--no-wine-check` 跳过检查；在 Windows 上构建则原生完成；
- **Linux**：在任意平台上交叉构建均可，需要 `fpm` 等工具（脚本已默认从 npmmirror 下载 `electron-builder-binaries`）。

Unison 二进制下载说明：

- `scripts/fetch-unison.mjs` 固定下载 Unison 2.54.0 的官方 Release（Linux 为 Ubuntu 22.04 静态构建），下载后按 GitHub API 提供的 **sha256** 校验，校验失败视为不可信并尝试下一个来源；
- 下载顺序：`UNISON_PROXY`（自定义镜像前缀）→ GitHub 直连 → `ghfast.top` / `gh-proxy.com` 公共代理；
- GitHub 完全不可达时，可手动下载官方归档后本地导入：
  ```bash
  node scripts/fetch-unison.mjs --platform=win32 --arch=x64 --file=~/Downloads/unison-2.54.0-windows-x86_64.zip
  ```
- 已下载的二进制位于 `src/resources/bin/<platform>-<arch>/`，不会提交到仓库（见 `.gitignore`）；`--force` 可强制重新下载。
