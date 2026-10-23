#!/usr/bin/env node
/**
 * 本地构建入口：准备目标平台的 Unison 二进制，然后调用 tsc / vite / electron-builder。
 *
 * 用法：
 *   node scripts/build.mjs              # 构建当前平台（macOS 默认当前架构）
 *   node scripts/build.mjs mac          # 构建 macOS（可用 --arch=x64|arm64）
 *   node scripts/build.mjs win          # 构建 Windows x64（NSIS）
 *   node scripts/build.mjs linux        # 构建 Linux x64（AppImage + deb）
 *   node scripts/build.mjs win --skip-fetch   # 跳过 Unison 下载（二进制已就绪时）
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const TARGETS = {
  mac: { builderFlag: "--mac", unisonPlatform: "darwin", label: "macOS" },
  win: { builderFlag: "--win", unisonPlatform: "win32", label: "Windows" },
  linux: { builderFlag: "--linux", unisonPlatform: "linux", label: "Linux" },
};

const ARTIFACT_EXTENSIONS = {
  mac: [".dmg", ".zip"],
  win: [".exe"],
  linux: [".AppImage", ".deb"],
};

function hostTarget() {
  if (process.platform === "darwin") return "mac";
  if (process.platform === "win32") return "win";
  return "linux";
}

function parseArgs(argv) {
  const opts = { target: null, arch: null, noWineCheck: false, skipFetch: false };
  for (const arg of argv) {
    if (arg === "--no-wine-check") opts.noWineCheck = true;
    else if (arg === "--skip-fetch") opts.skipFetch = true;
    else if (arg.startsWith("--arch=")) opts.arch = arg.slice("--arch=".length);
    else if (!arg.startsWith("--")) opts.target = arg;
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const target = opts.target || hostTarget();
const cfg = TARGETS[target];

if (!cfg) {
  console.error(`[build] 未知目标平台 "${target}"，可选：${Object.keys(TARGETS).join(" / ")}`);
  process.exit(1);
}
if (target === "mac" && process.platform !== "darwin") {
  console.error("[build] macOS 应用只能在 macOS 上构建，请使用 macOS 机器或 GitHub Actions。");
  process.exit(1);
}

const arch =
  opts.arch ||
  (target === "mac" && process.arch === "arm64" ? "arm64" : "x64");
const allowedArchs = target === "mac" ? ["arm64", "x64"] : ["x64"];
if (!allowedArchs.includes(arch)) {
  console.error(
    `[build] ${cfg.label} 目前只支持 ${allowedArchs.join(" / ")}（官方 Unison 没有该架构的构建）。`,
  );
  process.exit(1);
}

const env = { ...process.env };
// 交叉构建时 electron-builder 还需下载 NSIS / AppImage / fpm 等工具，
// 默认走 npmmirror，避免国内直连 GitHub 超时；可用环境变量覆盖。
if (!env.ELECTRON_BUILDER_BINARIES_MIRROR) {
  env.ELECTRON_BUILDER_BINARIES_MIRROR =
    "https://npmmirror.com/mirrors/electron-builder-binaries/";
}
// 保证直接执行 node scripts/build.mjs 时也能找到 .bin 里的工具
const binDir = path.join(ROOT, "node_modules", ".bin");
env.PATH = `${binDir}${path.delimiter}${env.PATH || ""}`;

function run(cmd, args) {
  console.log(`\n[build] $ ${[cmd, ...args].join(" ")}`);
  execFileSync(cmd, args, {
    stdio: "inherit",
    env,
    cwd: ROOT,
    shell: process.platform === "win32",
  });
}

// 1. 准备目标平台的 Unison 二进制（macOS 已随仓库提供，脚本会自动跳过）
if (!opts.skipFetch) {
  run(process.execPath, [
    path.join(ROOT, "scripts/fetch-unison.mjs"),
    `--platform=${cfg.unisonPlatform}`,
    `--arch=${arch}`,
  ]);
}

// 2. Linux 主机交叉构建 Windows 需要系统 Wine；
//    macOS 上 electron-builder 会自动下载内置的 wine（Apple Silicon 需已安装 Rosetta 2）
if (target === "win" && process.platform === "linux" && !opts.noWineCheck) {
  const probe = spawnSync("wine", ["--version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) {
    console.error(`
[build] 在 Linux 上交叉构建 Windows 安装包需要 Wine。

  sudo apt install wine64
  或者使用 electronuserland/builder:wine 容器 / Windows 机器 / GitHub Actions 构建。
  跳过检查请加 --no-wine-check。
`);
    process.exit(1);
  }
}

// 3. 构建
run("tsc", []);
run("vite", ["build"]);
run("electron-builder", [cfg.builderFlag, `--${arch}`, "--publish", "never"]);

// 4. 打印本次产物
const releaseDir = path.join(ROOT, "release");
try {
  const exts = ARTIFACT_EXTENSIONS[target];
  const artifacts = fs
    .readdirSync(releaseDir)
    .filter((name) => exts.some((ext) => name.endsWith(ext)));
  if (artifacts.length > 0) {
    console.log(`\n[build] ${cfg.label} 产物（release/）：`);
    for (const name of artifacts) console.log(`  - ${name}`);
  }
} catch {
  // release 目录不存在时忽略
}
