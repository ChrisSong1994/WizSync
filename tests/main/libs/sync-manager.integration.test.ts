import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SyncTask } from "../../../src/main/libs/types";

/**
 * 真实 Unison 引擎集成测试。
 *
 * 与 sync-manager.test.ts（mock 掉 child_process）互补：这里不 mock 进程，
 * 直接调用仓库内置的 Unison 二进制，验证"参数组合 → 磁盘上真实结果"的端到端行为，
 * 包括双向/单向镜像、忽略规则、备份、冲突、Unicode 归一化、磁盘离线等。
 *
 * 注意：Unison 的 fastcheck 以「大小 + 整秒 mtime」判定变更，同一秒内、等长的修改
 * 会被视为未变（见文件末尾的"已知缺陷"用例）。因此除专门验证该行为的用例外，
 * 所有用例都通过 fs.utimesSync 显式设置 mtime，避免依赖真实时钟推进。
 *
 * 二进制缺失时整组跳过（CI 的 test job 在 Linux 上不下载二进制）。
 */

const mock = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", () => ({
  app: { getPath: (key: string) => (key === "userData" ? mock.userData : "") },
  BrowserWindow: class {},
}));

vi.mock("electron-store", () => {
  class MockStore {
    private data: Record<string, unknown>;
    constructor(opts: { defaults?: Record<string, unknown> }) {
      this.data = { ...(opts.defaults || {}) };
    }
    get(key: string): unknown {
      return this.data[key];
    }
    set(key: string, value: unknown): void {
      this.data[key] = value;
    }
  }
  return { default: MockStore };
});

/** 仓库内置二进制路径（直接按平台/架构拼，避免加载 main.ts 的顶层副作用） */
const UNISON_PATH = path.resolve(
  __dirname,
  "../../../src/resources/bin",
  `${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`,
  process.platform === "win32" ? "unison.exe" : "unison",
);
const hasUnison = fs.existsSync(UNISON_PATH);

vi.mock("../../../src/main/main", () => ({
  getUnisonPath: () => UNISON_PATH,
}));

vi.mock("../../../src/main/libs/logs", () => ({
  logManager: { write: vi.fn(), get: vi.fn(), clear: vi.fn() },
}));

vi.mock("../../../src/main/libs/disk", () => ({
  diskManager: { getDiskSpace: vi.fn(() => null) },
}));

import { SyncManager } from "../../../src/main/libs/sync-manager";
import { syncStore } from "../../../src/main/libs/sync-store";
import { logManager } from "../../../src/main/libs/logs";

let tmpDir: string;
let manager: SyncManager;

function makeTask(id: string, overrides: Partial<SyncTask> = {}): SyncTask {
  return {
    id,
    name: `任务 ${id}`,
    sourcePath: "",
    targetPath: "",
    mode: "manual",
    direction: "bidirectional",
    status: "idle",
    ...overrides,
  };
}

function makeDirs(): { src: string; tgt: string } {
  const src = path.join(tmpDir, "src");
  const tgt = path.join(tmpDir, "tgt");
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(tgt, { recursive: true });
  return { src, tgt };
}

/** 写入文件并把 mtime 固定到指定时刻（消除"同一秒"带来的 fastcheck 歧义） */
function writeFile(p: string, content: string, mtime?: Date) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  if (mtime) fs.utimesSync(p, mtime, mtime);
}

/** 目录树（相对路径，目录带尾部 /），不包含应用元数据目录 .wizsync */
function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        out.push(`${rel}/`);
        walk(full);
      } else {
        out.push(rel);
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out.filter((p) => !p.startsWith(".wizsync")).sort();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 每个任务上一次同步结束时记录的 lastSyncTime，用于识别"这一轮"真的结束了 */
const lastSync = new Map<string, string | undefined>();

/**
 * 等待一次同步真正收尾。
 *
 * 不能用"状态为 idle"作判据：startTask 内部先 stopTask（会把状态置 idle）再拉起
 * unison，轮询可能正好撞上这个中间态。这里要求 lastSyncTime 与本次开始前不同，
 * 或状态落到 warning/error，才算这一轮结束。
 */
async function waitForSyncEnd(id: string, timeoutMs = 30000): Promise<SyncTask> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const task = syncStore.getTasks().find((t) => t.id === id);
    const finished =
      task &&
      (task.status === "warning" ||
        task.status === "error" ||
        (task.status === "idle" && task.lastSyncTime !== lastSync.get(id)));
    if (finished) {
      // close 处理器的统计/状态落盘是异步尾巴，稍等再读快照
      await sleep(80);
      return syncStore.getTasks().find((t) => t.id === id)!;
    }
    await sleep(50);
  }
  throw new Error(
    `任务 ${id} 超时未结束，当前状态：${syncStore.getTasks().find((t) => t.id === id)?.status}`,
  );
}

/** 保存任务并执行一次完整同步，返回结束后的任务快照 */
async function syncOnce(task: SyncTask): Promise<SyncTask> {
  syncStore.saveTask(task);
  lastSync.set(task.id, syncStore.getTasks().find((t) => t.id === task.id)?.lastSyncTime);
  await manager.startTask(task);
  return waitForSyncEnd(task.id);
}

/**
 * 只对指定路径做增量同步（对应对比页的单文件/批量操作）。
 *
 * runSpecificPathSync 返回的 Promise 在进程 close 处理器里 resolve —— 但它在
 * updateStatus 之前，所以这里 resolve 后再做一次终态轮询。
 */
async function syncPaths(
  task: SyncTask,
  paths: string[],
  direction?: "sourceToTarget" | "targetToSource",
): Promise<SyncTask> {
  await manager.runSpecificPathSync(task, paths, direction);
  // close 处理器在 onDone(true) 之后还有统计落盘等异步尾巴
  await sleep(300);
  return syncStore.getTasks().find((t) => t.id === task.id)!;
}

/** 最近一次同步写入的日志文本（用于断言"无变动"等结论） */
function logs(): string {
  return vi.mocked(logManager.write).mock.calls.map((c) => String(c[1])).join("\n");
}

const T1 = new Date("2026-01-01T10:00:00Z");
const T2 = new Date("2026-01-01T11:00:00Z");
const T3 = new Date("2026-01-01T12:00:00Z");

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wizsync-int-"));
  mock.userData = path.join(tmpDir, "userData");
  fs.mkdirSync(mock.userData, { recursive: true });
  manager = new SyncManager();
  syncStore.getTasks().forEach((t) => syncStore.deleteTask(t.id));
  vi.mocked(logManager.write).mockClear();
});

afterEach(async () => {
  await manager.stopAllTasks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe.skipIf(!hasUnison)("真实 Unison：双向同步", () => {
  it("首次同步把源端文件与目录（含空目录）复制到目标端，状态回到 idle", async () => {
    const { src, tgt } = makeDirs();
    writeFile(path.join(src, "a.txt"), "hello\n");
    writeFile(path.join(src, "sub/b.txt"), "nested\n");
    fs.mkdirSync(path.join(src, "empty-dir"));

    const done = await syncOnce(makeTask("bi-1", { sourcePath: src, targetPath: tgt }));

    expect(done.status).toBe("idle");
    expect(done.lastSyncTime).toBeTruthy();
    expect(tree(tgt)).toEqual(["a.txt", "empty-dir/", "sub/", "sub/b.txt"]);
    expect(done.sourceStats).toEqual({ size: 13, count: 2 });
    expect(done.targetStats).toEqual(done.sourceStats);
    expect(done.skippedCount).toBe(0);
    expect(logs()).toContain("同步结束 (代码: 0) [有变动]");
  });

  it("两端各自新增文件后，双向同步收敛到一致", async () => {
    const { src, tgt } = makeDirs();
    const task = makeTask("bi-2", { sourcePath: src, targetPath: tgt });
    await syncOnce(task);

    writeFile(path.join(src, "from-src.txt"), "s", T2);
    writeFile(path.join(tgt, "from-tgt.txt"), "t", T2);

    const done = await syncOnce(task);
    expect(done.status).toBe("idle");
    expect(tree(src)).toEqual(["from-src.txt", "from-tgt.txt"]);
    expect(tree(tgt)).toEqual(["from-src.txt", "from-tgt.txt"]);
  });

  it("仅一端修改的文件按 mtime 较新者传播（-prefer newer）", async () => {
    const { src, tgt } = makeDirs();
    const task = makeTask("bi-3", { sourcePath: src, targetPath: tgt });
    writeFile(path.join(src, "x.txt"), "v1\n", T1);
    await syncOnce(task);

    // 目标端更新：应回传到源端
    writeFile(path.join(tgt, "x.txt"), "v2-from-target\n", T2);
    await syncOnce(task);
    expect(fs.readFileSync(path.join(src, "x.txt"), "utf-8")).toBe("v2-from-target\n");

    // 源端再更新：应传播回目标端
    writeFile(path.join(src, "x.txt"), "v3-from-source\n", T3);
    const done = await syncOnce(task);
    expect(done.status).toBe("idle");
    expect(fs.readFileSync(path.join(tgt, "x.txt"), "utf-8")).toBe("v3-from-source\n");
  });

  it("仅一端删除的文件会同步删除另一端，并以 -time 无关的删除传播完成", async () => {
    const { src, tgt } = makeDirs();
    const task = makeTask("bi-del", { sourcePath: src, targetPath: tgt });
    writeFile(path.join(src, "a.txt"), "a", T1);
    writeFile(path.join(src, "b.txt"), "b", T1);
    await syncOnce(task);

    fs.unlinkSync(path.join(src, "a.txt"));
    const done = await syncOnce(task);

    expect(done.status).toBe("idle");
    expect(tree(tgt)).toEqual(["b.txt"]);
    expect(tree(src)).toEqual(["b.txt"]);
  });

  it("两端都改且时间戳相同 → warning，冲突文件保留两端原样并随状态上报", async () => {
    const { src, tgt } = makeDirs();
    const task = makeTask("bi-conflict", { sourcePath: src, targetPath: tgt });
    writeFile(path.join(src, "c.txt"), "base\n", T1);
    await syncOnce(task);

    writeFile(path.join(src, "c.txt"), "source-version\n", T2);
    writeFile(path.join(tgt, "c.txt"), "target-version\n", T2);

    const done = await syncOnce(task);

    expect(done.status).toBe("warning");
    expect(done.lastSyncTime).toBeTruthy();
    expect(fs.readFileSync(path.join(src, "c.txt"), "utf-8")).toBe("source-version\n");
    expect(fs.readFileSync(path.join(tgt, "c.txt"), "utf-8")).toBe("target-version\n");
    expect(done.conflicts).toEqual([{ path: "c.txt", kind: "content" }]);
    expect(done.skippedCount).toBe(1);
    expect(done.skippedFiles?.[0]).toMatchObject({ path: "c.txt" });
    expect(logs()).toContain("同步结束 (代码: 1)");
    expect(logs()).toContain("[冲突] 1 个文件两边都被修改且无法自动收敛");
  });

  it("冲突可通过「使用源端版本」定向解决（-force 单路径），随后冲突被清空", async () => {
    const { src, tgt } = makeDirs();
    const task = makeTask("bi-resolve", { sourcePath: src, targetPath: tgt });
    writeFile(path.join(src, "c.txt"), "base\n", T1);
    await syncOnce(task);

    writeFile(path.join(src, "c.txt"), "keep-source\n", T2);
    writeFile(path.join(tgt, "c.txt"), "drop-target\n", T2);
    const conflicted = await syncOnce(task);
    expect(conflicted.status).toBe("warning");

    const resolved = await syncPaths(task, ["c.txt"], "sourceToTarget");

    expect(fs.readFileSync(path.join(tgt, "c.txt"), "utf-8")).toBe("keep-source\n");
    expect(resolved.conflicts).toEqual([]);
    expect(resolved.status).toBe("idle");
  });

  it("局部冲突不污染其他未涉及路径的冲突记录", async () => {
    const { src, tgt } = makeDirs();
    const task = makeTask("bi-scope", { sourcePath: src, targetPath: tgt });
    writeFile(path.join(src, "a.txt"), "a0\n", T1);
    writeFile(path.join(src, "b.txt"), "b0\n", T1);
    await syncOnce(task);

    writeFile(path.join(src, "a.txt"), "a-src\n", T2);
    writeFile(path.join(tgt, "a.txt"), "a-tgt\n", T2);
    writeFile(path.join(src, "b.txt"), "b-src\n", T2);
    writeFile(path.join(tgt, "b.txt"), "b-tgt\n", T2);
    const conflicted = await syncOnce(task);
    expect(conflicted.conflicts?.map((c) => c.path).sort()).toEqual(["a.txt", "b.txt"]);

    const after = await syncPaths(task, ["a.txt"], "sourceToTarget");

    // 只解决 a.txt，b.txt 的冲突必须保留在卡片上
    expect(after.conflicts?.map((c) => c.path)).toEqual(["b.txt"]);
  });
});

describe.skipIf(!hasUnison)("真实 Unison：单向镜像", () => {
  it("sourceToTarget：源端删除会镜像到目标端", async () => {
    const { src, tgt } = makeDirs();
    const task = makeTask("one-s2t", { sourcePath: src, targetPath: tgt, direction: "sourceToTarget" });
    writeFile(path.join(src, "keep.txt"), "s", T1);
    writeFile(path.join(src, "drop.txt"), "d", T1);
    await syncOnce(task);
    expect(tree(tgt)).toEqual(["drop.txt", "keep.txt"]);

    fs.unlinkSync(path.join(src, "drop.txt"));
    const done = await syncOnce(task);

    expect(done.status).toBe("idle");
    expect(tree(tgt)).toEqual(["keep.txt"]);
  });

  it("targetToSource：目标端删除会镜像到源端", async () => {
    const { src, tgt } = makeDirs();
    const task = makeTask("one-t2s", { sourcePath: src, targetPath: tgt, direction: "targetToSource" });
    writeFile(path.join(tgt, "keep.txt"), "t", T1);
    writeFile(path.join(tgt, "drop.txt"), "d", T1);
    await syncOnce(task);
    expect(tree(src)).toEqual(["drop.txt", "keep.txt"]);

    fs.unlinkSync(path.join(tgt, "drop.txt"));
    const done = await syncOnce(task);

    expect(done.status).toBe("idle");
    expect(tree(src)).toEqual(["keep.txt"]);
  });

  it("单向同步后再次执行不产生变动（-times 传播时间戳，不反复全量比对）", async () => {
    const { src, tgt } = makeDirs();
    writeFile(path.join(src, "a.txt"), "data", T1);
    const task = makeTask("one-idem", { sourcePath: src, targetPath: tgt, direction: "sourceToTarget" });
    await syncOnce(task);
    const mtimeAfterFirst = fs.statSync(path.join(tgt, "a.txt")).mtimeMs;

    vi.mocked(logManager.write).mockClear();
    await syncOnce(task);

    expect(fs.statSync(path.join(tgt, "a.txt")).mtimeMs).toBe(mtimeAfterFirst);
    expect(logs()).toContain("[无变动]");
  });

  it("源端更新覆盖目标端改动（单向以源端为权威）", async () => {
    const { src, tgt } = makeDirs();
    const task = makeTask("one-authority", {
      sourcePath: src,
      targetPath: tgt,
      direction: "sourceToTarget",
      backupPath: path.join(tgt, ".wizsync", "backups"),
    });
    writeFile(path.join(src, "a.txt"), "from-source-v1\n", T1);
    await syncOnce(task);

    writeFile(path.join(tgt, "a.txt"), "someone-edited-target\n", T2);
    writeFile(path.join(src, "a.txt"), "from-source-v2\n", T3);
    const done = await syncOnce(task);

    expect(done.status).toBe("idle");
    expect(fs.readFileSync(path.join(tgt, "a.txt"), "utf-8")).toBe("from-source-v2\n");
  });
});

describe.skipIf(!hasUnison)("真实 Unison：忽略规则", () => {
  it("默认规则跳过隐藏文件、node_modules、Thumbs.db", async () => {
    const { src, tgt } = makeDirs();
    writeFile(path.join(src, "visible.txt"), "v");
    writeFile(path.join(src, ".hidden/secret"), "h");
    writeFile(path.join(src, ".dotfile"), "d");
    writeFile(path.join(src, "node_modules/pkg/index.js"), "n");
    writeFile(path.join(src, "Thumbs.db"), "t");
    writeFile(path.join(src, "desktop.ini"), "i");

    const done = await syncOnce(makeTask("ig-default", { sourcePath: src, targetPath: tgt }));

    expect(done.status).toBe("idle");
    expect(tree(tgt)).toEqual(["visible.txt"]);
  });

  it("任务级 ignoredPaths 生效，且不影响其他路径", async () => {
    const { src, tgt } = makeDirs();
    writeFile(path.join(src, "keep.txt"), "k");
    writeFile(path.join(src, "custom/z.txt"), "z");

    await syncOnce(
      makeTask("ig-custom", { sourcePath: src, targetPath: tgt, ignoredPaths: ["custom"] }),
    );

    expect(tree(tgt)).toEqual(["keep.txt"]);
  });

  it("自定义元数据目录 .wizsync 不会被同步到另一端", async () => {
    const { src, tgt } = makeDirs();
    const task = makeTask("ig-meta", { sourcePath: src, targetPath: tgt });
    writeFile(path.join(src, "a.txt"), "a", T1);
    await syncOnce(task);
    // 日志/备份都写在 target/.wizsync 下，应被视为本地元数据
    writeFile(path.join(tgt, ".wizsync/logs/2026-01-01.log"), "log line", T2);
    const done = await syncOnce(task);

    expect(done.status).toBe("idle");
    expect(tree(src)).toEqual(["a.txt"]);
  });
});

describe.skipIf(!hasUnison)("真实 Unison：备份", () => {
  it("覆盖前把旧版本写入备份目录，删除文件时也备份，备份目录不回灌源端", async () => {
    const { src, tgt } = makeDirs();
    const backupDir = path.join(tgt, ".wizsync", "backups");
    const task = makeTask("bak-1", { sourcePath: src, targetPath: tgt, backupPath: backupDir });
    writeFile(path.join(src, "a.txt"), "v1\n", T1);
    writeFile(path.join(src, "keep.txt"), "k\n", T1);
    await syncOnce(task);

    writeFile(path.join(src, "a.txt"), "v2\n", T2);
    await syncOnce(task);

    const backupsAfterUpdate = fs.readdirSync(backupDir);
    expect(backupsAfterUpdate).toHaveLength(1);
    expect(fs.readFileSync(path.join(backupDir, backupsAfterUpdate[0]), "utf-8")).toBe("v1\n");

    fs.unlinkSync(path.join(src, "a.txt"));
    const done = await syncOnce(task);

    expect(done.status).toBe("idle");
    expect(fs.existsSync(path.join(tgt, "a.txt"))).toBe(false);
    expect(fs.readdirSync(backupDir).length).toBeGreaterThanOrEqual(2);
    // 备份目录位于目标根目录内，但不得反向同步到源端
    expect(tree(src)).toEqual(["keep.txt"]);
  });

  it("备份文件的 mtime 为备份产生时间（不沿用被覆盖版本的旧时间戳）", async () => {
    const { src, tgt } = makeDirs();
    const backupDir = path.join(tgt, ".wizsync", "backups");
    const task = makeTask("bak-2", {
      sourcePath: src,
      targetPath: tgt,
      backupPath: backupDir,
      backupRetentionDays: 30,
    });
    // 刻意用一个很早、且必然超过 30 天保留期的时间戳
    writeFile(path.join(src, "a.txt"), "v1\n", T1);
    await syncOnce(task);
    writeFile(path.join(src, "a.txt"), "v2\n", T2);
    await syncOnce(task);

    const [backupName] = fs.readdirSync(backupDir);
    const backupPath = path.join(backupDir, backupName);
    expect(fs.readFileSync(backupPath, "utf-8")).toBe("v1\n");
    // 备份保留期按 mtime 计算，因此这里的 mtime 必须是"刚才"，而不是 T1（2026-01-01）
    const ageMs = Date.now() - fs.statSync(backupPath).mtimeMs;
    expect(ageMs).toBeLessThan(5 * 60 * 1000);
    expect(fs.statSync(backupPath).mtimeMs).toBeGreaterThan(T2.getTime());
  });

  it("旧文件今天被覆盖，备份不会被保留期清理误删", async () => {
    const { src, tgt } = makeDirs();
    const backupDir = path.join(tgt, ".wizsync", "backups");
    const task = makeTask("bak-retention", {
      sourcePath: src,
      targetPath: tgt,
      backupPath: backupDir,
      backupRetentionDays: 30,
    });
    // 一个 60 天前最后修改过的文件，今天被覆盖
    const oldMtime = new Date(Date.now() - 60 * 86400000);
    writeFile(path.join(src, "old.txt"), "v1\n", oldMtime);
    await syncOnce(task);
    writeFile(path.join(src, "old.txt"), "v2\n", new Date());
    await syncOnce(task);

    const [backupPath] = fs.readdirSync(backupDir).map((n) => path.join(backupDir, n));
    const ageDays = (Date.now() - fs.statSync(backupPath).mtimeMs) / 86400000;
    expect(ageDays).toBeLessThan(30);
  });

  it("未开启备份时不创建备份文件", async () => {
    const { src, tgt } = makeDirs();
    const task = makeTask("bak-off", { sourcePath: src, targetPath: tgt });
    writeFile(path.join(src, "a.txt"), "v1\n", T1);
    await syncOnce(task);
    writeFile(path.join(src, "a.txt"), "v2\n", T2);
    await syncOnce(task);

    expect(fs.existsSync(path.join(tgt, ".wizsync/backups"))).toBe(false);
    expect(fs.readFileSync(path.join(tgt, "a.txt"), "utf-8")).toBe("v2\n");
  });
});

describe.skipIf(!hasUnison)("真实 Unison：局部路径同步", () => {
  it("-path 只同步指定路径，其余差异保持不动", async () => {
    const { src, tgt } = makeDirs();
    const task = makeTask("path-1", { sourcePath: src, targetPath: tgt });
    writeFile(path.join(src, "one.txt"), "1", T1);
    writeFile(path.join(src, "two.txt"), "2", T1);
    syncStore.saveTask(task);

    const done = await syncPaths(task, ["one.txt"], "sourceToTarget");

    expect(done.status).toBe("idle");
    expect(tree(tgt)).toEqual(["one.txt"]);
  });

  it("批量路径同步（对应对比页「全部同步到目标端」）一次处理多个文件", async () => {
    const { src, tgt } = makeDirs();
    const task = makeTask("path-2", { sourcePath: src, targetPath: tgt });
    const names = ["a/1.txt", "a/2.txt", "b/3.txt"];
    names.forEach((n, i) => writeFile(path.join(src, n), `content-${i}`, T1));
    writeFile(path.join(src, "untouched.txt"), "u", T1);
    syncStore.saveTask(task);

    const done = await syncPaths(task, names, "sourceToTarget");

    expect(done.status).toBe("idle");
    expect(tree(tgt)).toEqual(["a/", "a/1.txt", "a/2.txt", "b/", "b/3.txt"]);
  });
});

describe.skipIf(!hasUnison)("真实 Unison：Unicode 与大小写", () => {
  it("源端 NFD 文件名同步到目标端后归一化为 NFC，再次同步无变动", async () => {
    const { src, tgt } = makeDirs();
    const task = makeTask("uni-1", { sourcePath: src, targetPath: tgt });
    const nfdName = "café.txt";
    writeFile(path.join(src, nfdName), "u", T1);

    await syncOnce(task);

    expect(fs.readdirSync(tgt)).toEqual(["café.txt"]);
    // 源端保持 NFD 原样
    expect(fs.readdirSync(src)).toEqual([nfdName]);

    vi.mocked(logManager.write).mockClear();
    await syncOnce(task);
    expect(logs()).toContain("[无变动]");
  });

  it("含中文/日文/韩文的文件名与深路径可正常同步", async () => {
    const { src, tgt } = makeDirs();
    const names = ["中文目录/报告 2026.txt", "日本語/がっこう.txt", "한국어/파일.txt", "emoji-📁/🚀.txt"];
    names.forEach((n, i) => writeFile(path.join(src, n), `payload-${i}`, T1));

    const done = await syncOnce(makeTask("uni-2", { sourcePath: src, targetPath: tgt }));

    expect(done.status).toBe("idle");
    expect(tree(tgt)).toEqual(
      [
        "emoji-📁/",
        "emoji-📁/🚀.txt",
        "中文目录/",
        "中文目录/报告 2026.txt",
        "日本語/",
        "日本語/がっこう.txt",
        "한국어/",
        "한국어/파일.txt",
      ].sort(),
    );
  });

  it("大小写不敏感(-fat)：仅大小写重命名不会被当作新文件重复复制", async () => {
    const { src, tgt } = makeDirs();
    const task = makeTask("case-1", { sourcePath: src, targetPath: tgt });
    writeFile(path.join(src, "Case.txt"), "c", T1);
    await syncOnce(task);

    fs.renameSync(path.join(src, "Case.txt"), path.join(src, "case.txt"));
    await syncOnce(task);

    // unison 的 -fat 语义：视为同一文件，目标端保留原大小写，不产生第二份
    expect(tree(tgt)).toEqual(["Case.txt"]);
    expect(tree(src)).toEqual(["case.txt"]);
  });
});

describe.skipIf(!hasUnison)("真实 Unison：异常与生命周期", () => {
  it("目标目录被移除后标记 error，恢复后再次同步可正常完成", async () => {
    const { src, tgt } = makeDirs();
    const task = makeTask("life-1", { sourcePath: src, targetPath: tgt });
    writeFile(path.join(src, "a.txt"), "a", T1);
    await syncOnce(task);

    fs.rmSync(tgt, { recursive: true, force: true });
    const offline = await syncOnce(task);
    expect(offline.status).toBe("error");
    expect(logs()).toContain("启动失败：目标目录 已离线");

    // 目标端恢复为"存在但为空"（模拟挂载点复用）：必须被整体清空保护拦截，
    // 而不是把源端文件当作已删除传播过去
    fs.mkdirSync(tgt, { recursive: true });
    const restored = await syncOnce(task);
    expect(restored.status).toBe("error");
    expect(restored.sourcePath && tree(src)).toEqual(["a.txt"]);
    expect(logs()).toContain("检测到目标目录为空");
  });

  it("源端被整体清空时同样拦截（双向）", async () => {
    const { src, tgt } = makeDirs();
    const task = makeTask("life-2", { sourcePath: src, targetPath: tgt });
    writeFile(path.join(src, "a.txt"), "a", T1);
    writeFile(path.join(src, "b.txt"), "b", T1);
    await syncOnce(task);

    fs.rmSync(src, { recursive: true, force: true });
    fs.mkdirSync(src, { recursive: true });

    const done = await syncOnce(task);
    expect(done.status).toBe("error");
    expect(tree(tgt)).toEqual(["a.txt", "b.txt"]);
    expect(logs()).toContain("检测到源目录为空");
  });

  it("首次同步（无归档）一侧为空是正常情况，不拦截", async () => {
    const { src, tgt } = makeDirs();
    writeFile(path.join(tgt, "only-target.txt"), "t", T1);

    const done = await syncOnce(makeTask("life-first", { sourcePath: src, targetPath: tgt }));

    expect(done.status).toBe("idle");
    expect(tree(src)).toEqual(["only-target.txt"]);
  });

  it("单向镜像下清空一侧是用户明确意图，不拦截", async () => {
    const { src, tgt } = makeDirs();
    const task = makeTask("life-mirror", {
      sourcePath: src,
      targetPath: tgt,
      direction: "sourceToTarget",
    });
    writeFile(path.join(src, "a.txt"), "a", T1);
    await syncOnce(task);

    fs.rmSync(src, { recursive: true, force: true });
    fs.mkdirSync(src, { recursive: true });

    const done = await syncOnce(task);

    expect(done.status).toBe("idle");
    expect(tree(tgt)).toEqual([]);
  });

  it("-path 局部同步不受整体清空保护影响", async () => {
    const { src, tgt } = makeDirs();
    const task = makeTask("life-path", { sourcePath: src, targetPath: tgt });
    writeFile(path.join(src, "a.txt"), "a", T1);
    writeFile(path.join(src, "b.txt"), "b", T1);
    await syncOnce(task);

    // 只删掉 a.txt，对 a.txt 做定向同步：不应因"根目录非空但此路径缺失"被拦截
    fs.unlinkSync(path.join(src, "a.txt"));
    syncStore.saveTask(task);
    const done = await syncPaths(task, ["a.txt"], "sourceToTarget");

    expect(done.status).toBe("idle");
    expect(tree(tgt)).toEqual(["b.txt"]);
  });

  it("同步进行中调用 stopTask 会终止进程且不留同步中状态", async () => {
    const { src, tgt } = makeDirs();
    for (let i = 0; i < 400; i++) {
      writeFile(path.join(src, `d${i % 20}/f${i}.txt`), `payload-${i}`.repeat(200), T1);
    }
    const task = makeTask("stop-1", { sourcePath: src, targetPath: tgt, useParallel: true });
    syncStore.saveTask(task);
    await manager.startTask(task);

    await manager.stopTask(task.id);

    const after = syncStore.getTasks().find((t) => t.id === task.id)!;
    expect(after.status).toBe("idle");
    expect(after.pid).toBeUndefined();
    expect(manager.isTaskManualSyncing(task.id)).toBe(false);
  });

  it("多线程(-maxthreads 10)同步大量小文件后两端一致", async () => {
    const { src, tgt } = makeDirs();
    const N = 300;
    for (let i = 0; i < N; i++) {
      writeFile(path.join(src, `g${i % 10}/file-${i}.txt`), `content-${i}`, T1);
    }
    const done = await syncOnce(
      makeTask("many-1", { sourcePath: src, targetPath: tgt, useParallel: true }),
    );

    expect(done.status).toBe("idle");
    expect(done.targetStats).toEqual({ size: done.sourceStats!.size, count: N });
    expect(tree(tgt).length).toBe(N + 10);
  });

  it("大文件（>8MB，超过 unison 单块传输）内容一致", async () => {
    const { src, tgt } = makeDirs();
    const big = Buffer.alloc(9 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4096) big[i] = i % 251;
    fs.writeFileSync(path.join(src, "big.bin"), big);
    fs.utimesSync(path.join(src, "big.bin"), T1, T1);

    const done = await syncOnce(makeTask("big-1", { sourcePath: src, targetPath: tgt }));

    expect(done.status).toBe("idle");
    expect(fs.readFileSync(path.join(tgt, "big.bin")).equals(big)).toBe(true);
  });

  it("空目录同步后两端保持一致", async () => {
    const { src, tgt } = makeDirs();
    fs.mkdirSync(path.join(src, "empty-a"));
    fs.mkdirSync(path.join(src, "nested/empty-b"), { recursive: true });

    const done = await syncOnce(makeTask("empty-1", { sourcePath: src, targetPath: tgt }));

    expect(done.status).toBe("idle");
    expect(tree(tgt)).toEqual(["empty-a/", "nested/", "nested/empty-b/"]);
  });

  it("归档（同步状态）被删除后重新初始化，两端相同文件不会误报冲突", async () => {
    const { src, tgt } = makeDirs();
    const task = makeTask("archive-1", { sourcePath: src, targetPath: tgt });
    writeFile(path.join(src, "same.txt"), "identical", T1);
    await syncOnce(task);

    fs.rmSync(path.join(mock.userData, "task-data", task.id, "unison"), {
      recursive: true,
      force: true,
    });
    const done = await syncOnce(task);

    expect(done.status).toBe("idle");
    expect(done.conflicts ?? []).toEqual([]);
    expect(tree(src)).toEqual(tree(tgt));
  });
});

// ---------------------------------------------------------------------------
// 已知缺陷（用 it.fails 固化：这些用例当前"应当失败"，即缺陷仍存在）。
// 缺陷修复后 Vitest 会提示 "expected test to fail but it passed"，
// 届时把 it.fails 改回 it 即可作为回归用例。
// ---------------------------------------------------------------------------

describe.skipIf(!hasUnison)("回归：单向镜像不产生 (conflict_on_...) 副本", () => {
  it("单一向源→目标：目标端独有文件被直接删除，不留副本", async () => {
    const { src, tgt } = makeDirs();
    const task = makeTask("bug-mirror", {
      sourcePath: src,
      targetPath: tgt,
      direction: "sourceToTarget",
    });
    writeFile(path.join(src, "a.txt"), "a", T1);
    await syncOnce(task);

    writeFile(path.join(tgt, "only-target.txt"), "t", T2);
    await syncOnce(task);

    expect(tree(tgt)).toEqual(["a.txt"]);
  });

  it("目标端被改写的文件以源端为准，且不产生副本", async () => {
    const { src, tgt } = makeDirs();
    const task = makeTask("mirror-overwrite", {
      sourcePath: src,
      targetPath: tgt,
      direction: "sourceToTarget",
    });
    writeFile(path.join(src, "keep.txt"), "source-version", T1);
    await syncOnce(task);
    writeFile(path.join(tgt, "keep.txt"), "target-edited-version", T2);

    await syncOnce(task);

    expect(tree(tgt)).toEqual(["keep.txt"]);
    expect(fs.readFileSync(path.join(tgt, "keep.txt"), "utf-8")).toBe("source-version");
  });

  it("连续多次同步不会累积副本", async () => {
    const { src, tgt } = makeDirs();
    const task = makeTask("bug-mirror-grow", {
      sourcePath: src,
      targetPath: tgt,
      direction: "sourceToTarget",
    });
    writeFile(path.join(src, "a.txt"), "a", T1);
    await syncOnce(task);
    writeFile(path.join(tgt, "only-target.txt"), "t", T2);

    await syncOnce(task);
    await syncOnce(task);
    await syncOnce(task);

    expect(fs.readdirSync(tgt).filter((n) => n.includes("conflict_on"))).toHaveLength(0);
    expect(tree(tgt)).toEqual(["a.txt"]);
  });

  it("对比页「使用源端版本」（-force 单路径）同样不留副本", async () => {
    const { src, tgt } = makeDirs();
    const task = makeTask("mirror-path-force", { sourcePath: src, targetPath: tgt });
    writeFile(path.join(src, "c.txt"), "base", T1);
    writeFile(path.join(src, "other.txt"), "o", T1);
    await syncOnce(task);
    writeFile(path.join(tgt, "c.txt"), "target-edit-longer", T2);

    await syncPaths(task, ["c.txt"], "sourceToTarget");

    expect(tree(tgt)).toEqual(["c.txt", "other.txt"]);
    expect(fs.readFileSync(path.join(tgt, "c.txt"), "utf-8")).toBe("base");
  });
});

describe.skipIf(!hasUnison)("回归：目标端被清空后中止同步，不清空源端", () => {
  it("目标根目录被重挂载成空目录时识别为整体丢失并中止", async () => {
    const { src, tgt } = makeDirs();
    const task = makeTask("bug-wipe", {
      sourcePath: src,
      targetPath: tgt,
      backupPath: path.join(tmpDir, "backups"),
    });
    for (let i = 1; i <= 3; i++) writeFile(path.join(src, `f${i}.txt`), `data${i}`, T1);
    await syncOnce(task);
    expect(tree(tgt)).toHaveLength(3);

    // 模拟 SD 卡重挂载：目录存在但内容为空（卷被重新格式化/挂载点复用）
    fs.rmSync(tgt, { recursive: true, force: true });
    fs.mkdirSync(tgt, { recursive: true });

    const done = await syncOnce(task);

    expect(done.status).toBe("error");
    expect(tree(src)).toHaveLength(3);
    expect(logs()).toContain("检测到目标目录为空");
  });

  it("拦截后源端文件可完整恢复到目标端（重置缓存后）", async () => {
    const { src, tgt } = makeDirs();
    const task = makeTask("wipe-recover", { sourcePath: src, targetPath: tgt });
    for (let i = 1; i <= 3; i++) writeFile(path.join(src, `f${i}.txt`), `data${i}`, T1);
    await syncOnce(task);

    fs.rmSync(tgt, { recursive: true, force: true });
    fs.mkdirSync(tgt, { recursive: true });
    expect((await syncOnce(task)).status).toBe("error");

    // 用户在确认磁盘正常后执行「强制重置」：清理归档并以源端重建基线
    await manager.resetTask(task);
    for (let i = 0; i < 40; i++) {
      const now = syncStore.getTasks().find((t) => t.id === task.id)!;
      if (now.lastSyncTime && now.status === "idle") break;
      await sleep(100);
    }

    expect(tree(tgt)).toEqual(["f1.txt", "f2.txt", "f3.txt"]);
  });
});

describe.skipIf(!hasUnison)("快速检查开关", () => {
  it.fails("默认 fastcheck：同一秒内等长修改会漏检（已知限制，可用关闭快速检查规避）", async () => {
    const { src, tgt } = makeDirs();
    const task = makeTask("bug-fastcheck", { sourcePath: src, targetPath: tgt });
    // 两个内容长度相同，且显式设置为同一毫秒级时间戳
    writeFile(path.join(src, "x.txt"), "AAAAAAAAAA\n", T1);
    await syncOnce(task);

    writeFile(path.join(src, "x.txt"), "BBBBBBBBBB\n", T1);
    await syncOnce(task);

    // 实际：Nothing to do，目标端仍是 AAAAAAAAAA
    expect(fs.readFileSync(path.join(tgt, "x.txt"), "utf-8")).toBe("BBBBBBBBBB\n");
  });

  it("关闭快速检查后，同一秒内等长修改能被识别并同步", async () => {
    const { src, tgt } = makeDirs();
    const task = makeTask("fc-off", {
      sourcePath: src,
      targetPath: tgt,
      useFastcheck: false,
    });
    writeFile(path.join(src, "x.txt"), "AAAAAAAAAA\n", T1);
    await syncOnce(task);

    writeFile(path.join(src, "x.txt"), "BBBBBBBBBB\n", T1);
    const done = await syncOnce(task);

    expect(done.status).toBe("idle");
    expect(fs.readFileSync(path.join(tgt, "x.txt"), "utf-8")).toBe("BBBBBBBBBB\n");
  });

  it("关闭快速检查后常规变更同样正常同步", async () => {
    const { src, tgt } = makeDirs();
    const task = makeTask("fc-off-2", {
      sourcePath: src,
      targetPath: tgt,
      useFastcheck: false,
    });
    writeFile(path.join(src, "a.txt"), "v1", T1);
    await syncOnce(task);
    writeFile(path.join(src, "a.txt"), "v2-longer", T2);
    const done = await syncOnce(task);

    expect(done.status).toBe("idle");
    expect(fs.readFileSync(path.join(tgt, "a.txt"), "utf-8")).toBe("v2-longer");
  });
});