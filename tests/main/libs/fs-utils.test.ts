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
  filesContentEqual,
  computeDirDiff,
  resolveExistingRelativePath,
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

  it("单个文件无法读取（断链 symlink）不再截断整个目录扫描", async () => {
    writeFile("sub/a_keep.txt", "real1");
    writeFile("sub/z_keep.txt", "real2");
    // 非隐藏断链 symlink 排序在最前：stat 跟随后抛 ENOENT。
    // 修复前会让整个 sub/ 目录从结果里消失，把真实文件误报为"仅在另一侧"。
    const broken = path.join(tmpDir, "sub", "0_aaaa_broken");
    fs.symlinkSync("/nonexistent/target", broken);

    const files = await getAllFiles(tmpDir);
    expect([...files.keys()].sort()).toEqual(["sub/a_keep.txt", "sub/z_keep.txt"]);
  });

  it("跳过可解析的 symlink（unison 默认忽略链接，避免同步后对比仍残留差异）", async () => {
    writeFile("real.txt", "real");
    writeFile("dir/inner.txt", "inner");
    fs.symlinkSync("real.txt", path.join(tmpDir, "link-file")); // 相对 symlink → 文件
    fs.symlinkSync("dir", path.join(tmpDir, "link-dir")); // 相对 symlink → 目录

    const files = await getAllFiles(tmpDir);
    // 只保留真实文件，symlink 一律不进入对比清单
    expect([...files.keys()].sort()).toEqual(["dir/inner.txt", "real.txt"]);
  });
});

describe("IGNORE_PATTERNS", () => {
  it("包含约定的黑名单", () => {
    expect(IGNORE_PATTERNS).toEqual(["node_modules", "Thumbs.db", "desktop.ini"]);
  });
});

describe("computeDirDiff", () => {
  /** 设置文件 mtime（毫秒），用于构造确定性的 mtime 差异 */
  function setMtime(rel: string, ms: number) {
    const full = path.join(tmpDir, rel);
    fs.utimesSync(full, ms / 1000, ms / 1000);
  }

  /** 对 tmpDir/src 与 tmpDir/tgt 跑一遍对比 */
  async function diffFor(foldCase: boolean, ignoredPaths: string[] = []) {
    const [sourceFiles, targetFiles] = await Promise.all([
      getAllFiles(path.join(tmpDir, "src")),
      getAllFiles(path.join(tmpDir, "tgt")),
    ]);
    return computeDirDiff(sourceFiles, targetFiles, {
      sourceRoot: path.join(tmpDir, "src"),
      targetRoot: path.join(tmpDir, "tgt"),
      ignoredPaths,
      foldCase,
    });
  }

  it("foldCase=true: 大小写不同的同内容文件折叠为同一文件（in-sync）", async () => {
    // unison -fat 下源端 photos/img.jpg 与目标端 Photos/IMG.jpg 被视为同一文件；
    // Node 对比若不折叠会同时报"仅在源/仅在目标"——这正是"同步后对比仍残留差异"的根因。
    writeFile("src/photos/img.jpg", "case-content");
    writeFile("tgt/Photos/IMG.jpg", "case-content");
    setMtime("src/photos/img.jpg", 1_700_000_000_000);
    setMtime("tgt/Photos/IMG.jpg", 1_700_000_000_000);

    const d = await diffFor(true);
    expect(d.sourceOnly).toEqual([]);
    expect(d.targetOnly).toEqual([]);
    expect(d.different).toEqual([]);
  });

  it("foldCase=true: 大小写不同但内容不同时报为 different（不是仅在某一侧）", async () => {
    writeFile("src/photos/img.jpg", "AAAA");
    writeFile("tgt/Photos/IMG.jpg", "BBBB");
    setMtime("src/photos/img.jpg", 1_000_000_000_000);
    setMtime("tgt/Photos/IMG.jpg", 2_000_000_000_000); // mtime 差异 > 2000ms → 走内容比对

    const d = await diffFor(true);
    expect(d.sourceOnly).toEqual([]);
    expect(d.targetOnly).toEqual([]);
    expect(d.different).toHaveLength(1);
    expect(d.different[0].path).toBe("photos/img.jpg"); // 展示源端实际路径
    expect(d.different[0].sourceSize).toBe(4);
    expect(d.different[0].targetSize).toBe(4);
  });

  it("foldCase=false: 保持大小写敏感，大小写不同的文件报为仅在某一侧", async () => {
    writeFile("src/photos/img.jpg", "case-content");
    writeFile("tgt/Photos/IMG.jpg", "case-content");
    setMtime("src/photos/img.jpg", 1_700_000_000_000);
    setMtime("tgt/Photos/IMG.jpg", 1_700_000_000_000);

    const d = await diffFor(false);
    expect(d.sourceOnly.map(x => x.path)).toEqual(["photos/img.jpg"]);
    expect(d.targetOnly.map(x => x.path)).toEqual(["Photos/IMG.jpg"]);
    expect(d.different).toEqual([]);
  });

  it("大小相同、mtime 差异大但内容一致 → in-sync（内容比对）", async () => {
    writeFile("src/a.txt", "hello world");
    writeFile("tgt/a.txt", "hello world");
    setMtime("src/a.txt", 1_000_000_000_000);
    setMtime("tgt/a.txt", 2_000_000_000_000);

    const d = await diffFor(true);
    expect(d.different).toEqual([]);
  });

  it("大小相同、mtime 差异大且内容不同 → different", async () => {
    writeFile("src/a.txt", "hello!");
    writeFile("tgt/a.txt", "world!");
    setMtime("src/a.txt", 1_000_000_000_000);
    setMtime("tgt/a.txt", 2_000_000_000_000);

    const d = await diffFor(true);
    expect(d.different).toHaveLength(1);
    expect(d.different[0].path).toBe("a.txt");
  });

  it("大小不同 → different（无需内容比对）", async () => {
    writeFile("src/a.txt", "short");
    writeFile("tgt/a.txt", "a much longer content");
    const d = await diffFor(true);
    expect(d.different).toHaveLength(1);
    expect(d.different[0].path).toBe("a.txt");
  });

  it("仅在某一侧的文件 → sourceOnly / targetOnly", async () => {
    writeFile("src/only_src.txt", "s");
    writeFile("tgt/only_tgt.txt", "t");
    const d = await diffFor(true);
    expect(d.sourceOnly.map(x => x.path)).toEqual(["only_src.txt"]);
    expect(d.targetOnly.map(x => x.path)).toEqual(["only_tgt.txt"]);
    expect(d.different).toEqual([]);
  });

  it("ignoredPaths 命中的路径不进 sourceOnly/targetOnly，进入 ignored", async () => {
    writeFile("src/skip_me.txt", "s");
    writeFile("tgt/skip_me.txt", "t");
    writeFile("src/keep.txt", "k");
    const d = await diffFor(true, ["skip_me.txt"]);
    // skip_me.txt 两侧都在但被忽略 → 不进差异分组，进 ignored
    expect(d.sourceOnly.map(x => x.path)).toEqual(["keep.txt"]);
    expect(d.targetOnly).toEqual([]);
    expect(d.ignored.some(i => i.path === "skip_me.txt")).toBe(true);
  });

  // unison 默认 unicode=true：它会把 NFD 名字在目标端写成 NFC。
  // 对比层必须同样按 NFC 折叠，否则同步完成后仍会残留"仅在源/仅在目标"的幽灵差异。
  const NFD_CAFE = "cafe\u0301.txt"; // e + combining acute
  const NFC_CAFE = "caf\u00e9.txt";  // é

  it("NFC/NFD 归一化：源端 NFD、目标端 NFC 视为同一文件（in-sync）", async () => {
    const T = 1_700_000_000_000;
    writeFile(`src/${NFD_CAFE}`, "same-content");
    writeFile(`tgt/${NFC_CAFE}`, "same-content");
    setMtime(`src/${NFD_CAFE}`, T);
    setMtime(`tgt/${NFC_CAFE}`, T);

    // foldCase 开关不应影响 Unicode 归一化（unison 与 -fat 无关地做归一化）
    for (const foldCase of [true, false]) {
      const d = await diffFor(foldCase);
      expect(d.sourceOnly).toEqual([]);
      expect(d.targetOnly).toEqual([]);
      expect(d.different).toEqual([]);
    }
  });

  it("NFC/NFD 归一化不会掩盖真实内容差异（仍报 different）", async () => {
    writeFile(`src/${NFD_CAFE}`, "aaaa");
    writeFile(`tgt/${NFC_CAFE}`, "bb");
    const d = await diffFor(true);
    expect(d.sourceOnly).toEqual([]);
    expect(d.targetOnly).toEqual([]);
    expect(d.different).toHaveLength(1);
    expect(d.different[0].sourceSize).toBe(4);
    expect(d.different[0].targetSize).toBe(2);
  });

  it("ignoredPaths 用另一种归一化形式书写也能命中", async () => {
    writeFile(`src/${NFD_CAFE}`, "x");
    const d = await diffFor(true, [NFC_CAFE]);
    expect(d.sourceOnly).toEqual([]);
    expect(d.targetOnly).toEqual([]);
    expect(d.ignored.map(i => i.path)).toEqual([NFD_CAFE]);
  });
});

describe("resolveExistingRelativePath", () => {
  it("精确匹配时原样返回", () => {
    writeFile("tgt/sub/a.txt", "x");
    expect(resolveExistingRelativePath(path.join(tmpDir, "tgt"), path.join("sub", "a.txt")))
      .toBe(path.join("sub", "a.txt"));
  });

  it("Unicode 归一化 / 大小写不一致时仍能解析到磁盘上的真实条目", () => {
    // 对比层按 NFC 折叠，可能给出与磁盘字节不同的名字（源端 NFD、目标端 NFC）
    writeFile("tgt/caf\u00e9.txt", "x"); // NFC 名字落盘
    const queried = ["cafe\u0301.txt", "CAF\u00c9.TXT"]; // NFD / 全大写

    for (const q of queried) {
      const rel = resolveExistingRelativePath(path.join(tmpDir, "tgt"), q);
      expect(rel).not.toBeNull();
      // 返回的名字必须真实存在，且指向同一个文件
      expect(fs.existsSync(path.join(tmpDir, "tgt", rel!))).toBe(true);
      expect(fs.readFileSync(path.join(tmpDir, "tgt", rel!), "utf-8")).toBe("x");
      expect(rel!.normalize("NFC").toLowerCase()).toBe("caf\u00e9.txt");
    }
  });

  it("路径不存在时返回 null，且不会越出根目录", () => {
    writeFile("tgt/a.txt", "x");
    const root = path.join(tmpDir, "tgt");
    expect(resolveExistingRelativePath(root, "nope.txt")).toBeNull();
    expect(resolveExistingRelativePath(root, path.join("..", "a.txt"))).toBeNull();
  });
});

describe("filesContentEqual", () => {
  it("内容一致时返回 true", async () => {
    const a = path.join(tmpDir, "a.txt");
    const b = path.join(tmpDir, "b.txt");
    fs.writeFileSync(a, "hello world");
    fs.writeFileSync(b, "hello world");
    expect(await filesContentEqual(a, b)).toBe(true);
  });

  it("内容不同但长度相同返回 false", async () => {
    const a = path.join(tmpDir, "a.txt");
    const b = path.join(tmpDir, "b.txt");
    fs.writeFileSync(a, "hello!");
    fs.writeFileSync(b, "world!");
    expect(await filesContentEqual(a, b)).toBe(false);
  });

  it("内容不同且长度不同返回 false", async () => {
    const a = path.join(tmpDir, "a.txt");
    const b = path.join(tmpDir, "b.txt");
    fs.writeFileSync(a, "short");
    fs.writeFileSync(b, "a much longer content");
    expect(await filesContentEqual(a, b)).toBe(false);
  });

  it("超过单块(64KB)的大文件内容一致返回 true", async () => {
    const big = "x".repeat(70 * 1024); // 跨块
    const a = path.join(tmpDir, "big-a.bin");
    const b = path.join(tmpDir, "big-b.bin");
    fs.writeFileSync(a, big);
    fs.writeFileSync(b, big);
    expect(await filesContentEqual(a, b)).toBe(true);
  });

  it("超过单块的大文件在块边界处不同返回 false", async () => {
    const a = path.join(tmpDir, "big-a.bin");
    const b = path.join(tmpDir, "big-b.bin");
    fs.writeFileSync(a, "x".repeat(64 * 1024) + "A");
    fs.writeFileSync(b, "x".repeat(64 * 1024) + "B");
    expect(await filesContentEqual(a, b)).toBe(false);
  });

  it("任一侧文件缺失返回 false", async () => {
    const a = path.join(tmpDir, "exists.txt");
    const b = path.join(tmpDir, "missing.txt");
    fs.writeFileSync(a, "x");
    expect(await filesContentEqual(a, b)).toBe(false);
  });
});
