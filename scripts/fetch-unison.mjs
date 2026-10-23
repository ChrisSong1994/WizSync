#!/usr/bin/env node
/**
 * 下载官方 Unison 二进制到 src/resources/bin/<platform>-<arch>/。
 *
 * macOS 的二进制已随仓库提供；Linux / Windows 由于体积与架构差异，在开发环境
 * 和 CI 中按需下载（固定版本，保证可复现）。
 *
 * 用法：
 *   node scripts/fetch-unison.mjs                    # 下载当前平台的二进制
 *   node scripts/fetch-unison.mjs --force            # 强制重新下载
 *   node scripts/fetch-unison.mjs --platform=win32 --arch=x64   # 交叉准备（打包 Windows 时）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const UNISON_VERSION = "2.54.0";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEST_ROOT = path.join(ROOT, "src/resources/bin");

// GitHub 被墙/连不上时依次尝试的公共镜像（仅做 HTTPS 转发，下载后仍校验官方 sha256）
const PROXY_BASES = ["https://ghfast.top/", "https://gh-proxy.com/"];

// 资产名与官方 Release 一致：https://github.com/bcpierce00/unison/releases
// sha256 取自 GitHub API 的 assets[].digest，用于校验镜像/代理来源的完整性。
const ASSETS = {
  "linux-x64": {
    url: `https://github.com/bcpierce00/unison/releases/download/v${UNISON_VERSION}/unison-${UNISON_VERSION}-ubuntu-22.04-x86_64-static.tar.gz`,
    sha256: "d279dff18682c909d3ddb0b280ab151229b4798b9399b1d227084da424337d24",
    kind: "tar.gz",
    binName: "unison",
  },
  "win32-x64": {
    url: `https://github.com/bcpierce00/unison/releases/download/v${UNISON_VERSION}/unison-${UNISON_VERSION}-windows-x86_64.zip`,
    sha256: "8e0c9070824dc7e3f207d54c8afdec1af55ac26af2740d0d5d7b6e00c44d5fab",
    kind: "zip",
    binName: "unison.exe",
  },
};

function parseArgs(argv) {
  const opts = {
    platform: process.platform,
    arch: process.arch === "arm64" ? "arm64" : "x64",
    force: false,
    file: null,
  };
  for (const arg of argv) {
    if (arg === "--force") opts.force = true;
    else if (arg.startsWith("--platform=")) opts.platform = arg.slice("--platform=".length);
    else if (arg.startsWith("--arch=")) opts.arch = arg.slice("--arch=".length);
    else if (arg.startsWith("--file=")) opts.file = arg.slice("--file=".length);
  }
  return opts;
}

function verifySha256(buf, expected, source) {
  const actual = crypto.createHash("sha256").update(buf).digest("hex");
  if (actual !== expected) {
    throw new Error(`校验失败（${source}）：期望 ${expected}，实际 ${actual}`);
  }
}

async function fetchOne(url, expectedSha, sourceLabel) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}（${sourceLabel}）`);
  const buf = Buffer.from(await res.arrayBuffer());
  // 防止把 HTML 错误页当成二进制
  if (buf.length < 1024 * 1024) {
    throw new Error(`内容异常（${buf.length} 字节），可能不是有效归档（${sourceLabel}）`);
  }
  verifySha256(buf, expectedSha, sourceLabel);
  return buf;
}

/**
 * 下载官方资产：优先直连 GitHub，失败后依次尝试代理镜像；所有来源都做 sha256 校验。
 * UNISON_PROXY 环境变量可指定自建/其他镜像前缀，例如 UNISON_PROXY=https://ghfast.top/
 */
async function download(url, expectedSha) {
  const sources = [];
  const customProxy = process.env.UNISON_PROXY;
  if (customProxy) sources.push({ label: `自定义镜像 ${customProxy}`, url: customProxy + url });
  sources.push({ label: "GitHub", url });
  for (const base of PROXY_BASES) {
    sources.push({ label: `镜像 ${base}`, url: base + url });
  }

  let lastErr;
  for (const source of sources) {
    try {
      const buf = await fetchOne(source.url, expectedSha, source.label);
      if (source.label !== "GitHub") {
        console.warn(`[fetch-unison] GitHub 不可用，已通过${source.label}下载（sha256 校验通过）`);
      }
      return buf;
    } catch (err) {
      lastErr = err;
      // 校验失败说明内容不可信，但仍可尝试下一个来源
      console.warn(`[fetch-unison] 下载失败（${source.label}）：${err.message}`);
    }
  }
  throw new Error(
    `所有下载来源均失败。可手动下载官方归档后通过 --file=<本地路径> 指定，或设置 UNISON_PROXY 镜像前缀。最后错误：${lastErr?.message}`,
  );
}

function extract(archive, kind, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  if (kind === "tar.gz") {
    execFileSync("tar", ["-xzf", archive, "-C", outDir], { stdio: "inherit" });
    return;
  }
  // zip：Windows 10+/macOS 自带的 bsdtar 即可解压；若失败再退回 unzip
  try {
    execFileSync("tar", ["-xf", archive, "-C", outDir], { stdio: "inherit" });
  } catch {
    execFileSync("unzip", ["-oq", archive, "-d", outDir], { stdio: "inherit" });
  }
}

function findBinary(dir, binName) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findBinary(full, binName);
      if (hit) return hit;
    } else if (entry.name.toLowerCase() === binName.toLowerCase()) {
      return full;
    }
  }
  return null;
}

async function main() {
  const { platform, arch, force, file } = parseArgs(process.argv.slice(2));
  const key = `${platform}-${arch}`;
  const asset = ASSETS[key];

  if (!asset) {
    console.log(`[fetch-unison] ${key} 无需/暂无官方二进制，跳过（macOS 二进制随仓库提供）。`);
    return;
  }

  const destDir = path.join(DEST_ROOT, key);
  const destBin = path.join(destDir, asset.binName);

  if (fs.existsSync(destBin) && !force) {
    console.log(`[fetch-unison] 已存在：${path.relative(ROOT, destBin)}（--force 可重新下载）`);
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wizsync-unison-"));
  try {
    const archive = path.join(tmp, asset.kind === "zip" ? "unison.zip" : "unison.tar.gz");
    if (file) {
      console.log(`[fetch-unison] 使用本地归档：${file}`);
      const buf = fs.readFileSync(path.resolve(file));
      verifySha256(buf, asset.sha256, file);
      fs.writeFileSync(archive, buf);
    } else {
      console.log(`[fetch-unison] 下载 Unison ${UNISON_VERSION}（${key}）…`);
      fs.writeFileSync(archive, await download(asset.url, asset.sha256));
    }

    const extractDir = path.join(tmp, "extract");
    extract(archive, asset.kind, extractDir);

    const bin = findBinary(extractDir, asset.binName);
    if (!bin) throw new Error(`解压后未找到 ${asset.binName}`);

    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(bin, destBin);
    if (platform !== "win32") fs.chmodSync(destBin, 0o755);
    console.log(`[fetch-unison] 完成：${path.relative(ROOT, destBin)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`[fetch-unison] ${err.message}`);
  process.exit(1);
});
