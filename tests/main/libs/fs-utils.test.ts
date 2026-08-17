import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  IGNORE_PATTERNS,
  getDirStats,
  isPathInside,
  resolveInside,
  getAllFiles,
} from "../../../src/main/libs/fs-utils";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wizsync-fs-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 在 tmpDir 下写入一个文件（自动创建父目录） */
function writeFile(rel: string, content: string = "x") {
  const full = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function byteLen(s: string) {
  return Buffer.byteLength(s, "utf8");
}

describe("getDirStats", () => {
  it("空目录返回 0 个文件、0 字节", async () => {
    expect(await getDirStats(tmpDir)).toEqual({ size: 0, count: 0 });
  });

  it("统计根目录下普通文件的数量与总大小", async () => {
    writeFile("a.txt", "abc");
    writeFile("b.txt", "hello world");
    expect(await getDirStats(tmpDir)).toEqual({
      size: byteLen("abc") + byteLen("hello world"),
      count: 2,
    });
  });

  it("递归统计子目录内的文件", async () => {
    writeFile("a.txt", "12345");
    writeFile("sub/b.txt", "abc");
    writeFile("sub/deep/c.txt", "xy");
    expect(await getDirStats(tmpDir)).toEqual({
      size: 5 + 3 + 2,
      count: 3,
    });
  });

  it("跳过隐藏文件与黑名单目录/文件", async () => {
    writeFile(".hidden", "hidden");
    writeFile(".git/config", "git");
    writeFile("node_modules/pkg/index.js", "pkg");
    writeFile("Thumbs.db", "thumbs");
    writeFile("desktop.ini", "ini");
    writeFile("keep.txt", "keep");

    const stats = await getDirStats(tmpDir);
    expect(stats.count).toBe(1);
    expect(stats.size).toBe(byteLen("keep"));
  });

  it("目录不存在时返回空统计且不抛异常", async () => {
    expect(await getDirStats(path.join(tmpDir, "nope"))).toEqual({
      size: 0,
      count: 0,
    });
  });

  it("文件数超过信号量并发上限时仍正确（覆盖等待队列路径）", async () => {
    // 故意超过 STAT_CONCURRENCY(64)，让 acquire/release 走满等待队列与惰性压缩分支
    const N = 400;
    for (let i = 0; i < N; i++) {
      writeFile(`batch/f${i}.txt`, "x");
    }
    expect(await getDirStats(tmpDir)).toEqual({ size: N, count: N });
  });
});

describe("isPathInside", () => {
  it("目标等于基准目录时返回 true", () => {
    expect(isPathInside("/a/b", "/a/b")).toBe(true);
  });

  it("目标是基准目录的子路径时返回 true", () => {
    expect(isPathInside("/a/b", "/a/b/c/d")).toBe(true);
  });

  it("兄弟路径（共享字符串前缀）返回 false，避免前缀误判", () => {
    expect(isPathInside("/a/b", "/a/bc")).toBe(false);
  });

  it("父目录不包含子目录（反向）返回 false", () => {
    expect(isPathInside("/a/b/c", "/a/b")).toBe(false);
  });

  it("带 .. 穿越的路径解析后越界返回 false", () => {
    expect(isPathInside("/a/b", "/a/b/../evil")).toBe(false);
  });

  it("包含路径分隔符的同名前缀不会被误判", () => {
    expect(isPathInside("/a/b", "/a/b/c")).toBe(true);
    expect(isPathInside("/a/b", "/a/b-other")).toBe(false);
  });
});

describe("resolveInside", () => {
  it("合法相对路径解析为基准目录内的绝对路径", () => {
    const result = resolveInside(tmpDir, "sub/file.txt");
    expect(result).toBe(path.join(tmpDir, "sub/file.txt"));
    expect(result).not.toBeNull();
  });

  it("空字符串（根目录本身）合法", () => {
    expect(resolveInside(tmpDir, "")).toBe(path.resolve(tmpDir));
  });

  it("越界相对路径返回 null", () => {
    expect(resolveInside(tmpDir, "../escape")).toBeNull();
    expect(resolveInside(tmpDir, "sub/../../escape")).toBeNull();
  });

  it("绝对路径形式的目标越界时返回 null", () => {
    expect(resolveInside(tmpDir, path.join(tmpDir, "..", "escape"))).toBeNull();
  });
});

describe("getAllFiles", () => {
  it("返回相对路径 -> 文件信息的映射", async () => {
    writeFile("a.txt", "12345");
    writeFile("sub/b.txt", "abc");

    const files = await getAllFiles(tmpDir);
    expect([...files.keys()].sort()).toEqual(["a.txt", "sub/b.txt"]);

    const a = files.get("a.txt")!;
    expect(a.size).toBe(5);
    expect(typeof a.mtime).toBe("number");
  });

  it("跳过隐藏文件与黑名单路径", async () => {
    writeFile(".hidden", "h");
    writeFile("node_modules/pkg.js", "p");
    writeFile("Thumbs.db", "t");
    writeFile("ok.txt", "o");

    const files = await getAllFiles(tmpDir);
    expect([...files.keys()]).toEqual(["ok.txt"]);
  });

  it("累计 state.count 并回调进度", async () => {
    for (let i = 0; i < 201; i++) {
      writeFile(`f${i}.txt`, "x");
    }
    const state = { count: 0 };
    const onProgress = vi.fn();

    await getAllFiles(tmpDir, tmpDir, state, onProgress);

    expect(state.count).toBe(201);
    // 进度回调在 count 达到 200 时触发一次
    expect(onProgress).toHaveBeenCalledWith(200);
  });

  it("目录不存在时返回空 Map 且不抛异常", async () => {
    const files = await getAllFiles(path.join(tmpDir, "nope"));
    expect(files.size).toBe(0);
  });
});

describe("IGNORE_PATTERNS", () => {
  it("包含约定的黑名单", () => {
    expect(IGNORE_PATTERNS).toEqual(["node_modules", "Thumbs.db", "desktop.ini"]);
  });
});
