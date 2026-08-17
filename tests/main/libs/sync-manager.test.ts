import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SyncTask } from "../../../src/main/libs/types";

// 可变 holder：在 import 前设置 userData 临时目录
const mock = vi.hoisted(() => ({ userData: "" }));

// 最小 EventEmitter 实现，避免在 hoisted 工厂里依赖 import
const fakeProc = vi.hoisted(() => {
  type Handler = (...args: any[]) => void;
  class Emitter {
    private handlers: Record<string, Handler[]> = {};
    on(event: string, cb: Handler) {
      (this.handlers[event] ||= []).push(cb);
      return this;
    }
    emit(event: string, ...args: any[]) {
      (this.handlers[event] || []).slice().forEach((cb) => cb(...args));
      return this;
    }
  }
  class FakeProc extends Emitter {
    pid = 4242;
    stdout = new Emitter();
    stderr = new Emitter();
    kill = () => {};
  }
  return { FakeProc };
});

vi.mock("electron", () => ({
  app: {
    getPath: (key: string) => (key === "userData" ? mock.userData : ""),
  },
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

// main.ts 有大量顶层副作用，整体 mock 掉 getUnisonPath
vi.mock("../../../src/main/main", () => ({
  getUnisonPath: () => "/usr/bin/fake-unison",
}));

vi.mock("../../../src/main/libs/logs", () => ({
  logManager: { write: vi.fn(), get: vi.fn(), clear: vi.fn() },
}));

vi.mock("../../../src/main/libs/disk", () => ({
  diskManager: { getDiskSpace: vi.fn(() => null) },
}));

vi.mock("../../../src/main/libs/fs-utils", () => ({
  getDirStats: vi.fn(async () => ({ size: 0, count: 0 })),
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => new fakeProc.FakeProc()),
}));

import { SyncManager } from "../../../src/main/libs/sync-manager";
import { syncStore } from "../../../src/main/libs/sync-store";
import { logManager } from "../../../src/main/libs/logs";
import { spawn } from "node:child_process";

const updateTaskSpy = vi.spyOn(syncStore, "updateTask");
const mockedSpawn = vi.mocked(spawn);
// 冲突/离线场景会主动 console.error，抑制掉以保持测试输出干净
vi.spyOn(console, "error").mockImplementation(() => {});

let tmpDir: string;
let manager: SyncManager;

function makeTask(id: string, overrides: Partial<SyncTask> = {}): SyncTask {
  return {
    id,
    name: `任务 ${id}`,
    sourcePath: "/src",
    targetPath: "/tgt",
    mode: "manual",
    direction: "bidirectional",
    status: "idle",
    ...overrides,
  };
}

/** 创建一对真实存在的源/目标目录 */
function makeDirs(): { src: string; tgt: string } {
  const src = path.join(tmpDir, "src");
  const tgt = path.join(tmpDir, "tgt");
  fs.mkdirSync(src);
  fs.mkdirSync(tgt);
  return { src, tgt };
}

/** 取出最近一次 spawn 调用的参数列表 */
function lastArgs(): string[] {
  const call = mockedSpawn.mock.calls[mockedSpawn.mock.calls.length - 1];
  return call[1]! as string[];
}

/** 让最近一次 spawn 的进程以 code=0 收尾，避免进程表残留 */
function finishLastProc() {
  const proc = mockedSpawn.mock.results[mockedSpawn.mock.results.length - 1].value;
  (proc as any).emit("close", 0);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wizsync-mgr-"));
  mock.userData = path.join(tmpDir, "userData");
  fs.mkdirSync(mock.userData, { recursive: true });

  manager = new SyncManager();
  syncStore.getTasks().forEach((t) => syncStore.deleteTask(t.id));
  updateTaskSpy.mockClear();
  mockedSpawn.mockClear();
  vi.mocked(logManager.write).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("SyncManager 手动同步标记", () => {
  it("setManualSyncing / isTaskManualSyncing 往返", () => {
    expect(manager.isTaskManualSyncing("t1")).toBe(false);
    manager.setManualSyncing("t1", true);
    expect(manager.isTaskManualSyncing("t1")).toBe(true);
    manager.setManualSyncing("t1", false);
    expect(manager.isTaskManualSyncing("t1")).toBe(false);
  });
});

describe("SyncManager.startTask 校验逻辑", () => {
  it("源目录不存在时标记 error 且不启动进程", async () => {
    const task = makeTask("t-offline", {
      sourcePath: path.join(tmpDir, "no-src"),
      targetPath: path.join(tmpDir, "tgt"),
    });

    await manager.startTask(task);

    expect(updateTaskSpy).toHaveBeenLastCalledWith("t-offline", { status: "error" });
    expect(spawn).not.toHaveBeenCalled();
    expect(logManager.write).toHaveBeenCalledWith(
      "t-offline",
      expect.stringContaining("已离线")
    );
  });

  it("源与目标解析为同一真实路径时拒绝同步", async () => {
    const task = makeTask("t-same", { sourcePath: tmpDir, targetPath: tmpDir });

    await manager.startTask(task);

    expect(updateTaskSpy).toHaveBeenLastCalledWith("t-same", { status: "error" });
    expect(spawn).not.toHaveBeenCalled();
    expect(logManager.write).toHaveBeenCalledWith(
      "t-same",
      expect.stringContaining("同一真实路径")
    );
  });

  it("源与目标存在嵌套关系时拒绝同步", async () => {
    const src = path.join(tmpDir, "src");
    const tgt = path.join(src, "sub");
    fs.mkdirSync(tgt, { recursive: true });

    await manager.startTask(makeTask("t-nested", { sourcePath: src, targetPath: tgt }));

    expect(updateTaskSpy).toHaveBeenLastCalledWith("t-nested", { status: "error" });
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("SyncManager Unison 参数构建", () => {
  it("双向同步：基础参数、prefer newer、忽略规则与根目录", async () => {
    const { src, tgt } = makeDirs();
    await manager.startTask(makeTask("t-bi", { sourcePath: src, targetPath: tgt }));

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(mockedSpawn.mock.calls[0][0]).toBe("/usr/bin/fake-unison");

    const args = lastArgs();
    expect(args).toContain("-batch");
    expect(args).toContain("-terse");
    expect(args).toContain("-prefer");
    expect(args).toContain("newer");
    expect(args).toContain("-ignore");
    expect(args).toContain("Name node_modules");
    expect(args).toContain("-ignore");
    expect(args).toContain("Path .wizsync");
    // 末尾依次为源、目标根目录
    expect(args[args.length - 2]).toBe(src);
    expect(args[args.length - 1]).toBe(tgt);

    finishLastProc();
  });

  it("sourceToTarget 单向同步：-force 指向源目录并传播时间戳（不含 -prefer）", async () => {
    const { src, tgt } = makeDirs();
    await manager.startTask(
      makeTask("t-s2t", { sourcePath: src, targetPath: tgt, direction: "sourceToTarget" })
    );

    const args = lastArgs();
    expect(args).toContain("-force");
    expect(args[args.indexOf("-force") + 1]).toBe(src);
    // -force 已覆盖 -prefer，单向同步不再重复传 -prefer
    expect(args).not.toContain("-prefer");
    expect(args).toContain("-times");

    finishLastProc();
  });

  it("配置备份目录时添加 -backup 相关参数", async () => {
    const { src, tgt } = makeDirs();
    const bak = path.join(tmpDir, "backups");
    await manager.startTask(makeTask("t-bak", { sourcePath: src, targetPath: tgt, backupPath: bak }));

    const args = lastArgs();
    expect(args).toContain("-backup");
    expect(args).toContain("-backupdir");
    expect(args[args.indexOf("-backupdir") + 1]).toBe(bak);
    // unison 2.53.8 不支持 -backupdel，且命中备份模式的文件删除时本就默认进备份
    expect(args).not.toContain("-backupdel");

    finishLastProc();
  });

  it("自定义忽略路径转换为 -ignore Path 参数", async () => {
    const { src, tgt } = makeDirs();
    await manager.startTask(
      makeTask("t-ig", { sourcePath: src, targetPath: tgt, ignoredPaths: ["a/b", "c.txt"] })
    );

    const args = lastArgs();
    for (const p of ["a/b", "c.txt"]) {
      const idx = args.indexOf(`Path ${p}`);
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx - 1]).toBe("-ignore");
    }

    finishLastProc();
  });

  it("启用多线程时添加 -maxthreads 10", async () => {
    const { src, tgt } = makeDirs();
    await manager.startTask(
      makeTask("t-par", { sourcePath: src, targetPath: tgt, useParallel: true })
    );

    const args = lastArgs();
    expect(args).toContain("-maxthreads");
    expect(args[args.indexOf("-maxthreads") + 1]).toBe("10");

    finishLastProc();
  });

  it("FAT 兼容默认开启，useFat=false 时移除 -fat", async () => {
    const { src, tgt } = makeDirs();

    await manager.startTask(makeTask("t-fat-on", { sourcePath: src, targetPath: tgt }));
    expect(lastArgs()).toContain("-fat");

    finishLastProc();

    await manager.startTask(makeTask("t-fat-off", { sourcePath: src, targetPath: tgt, useFat: false }));
    expect(lastArgs()).not.toContain("-fat");

    finishLastProc();
  });

  it("runSpecificPathSync 为每个路径添加 -path 参数", async () => {
    const { src, tgt } = makeDirs();
    const task = makeTask("t-path", { sourcePath: src, targetPath: tgt });

    // runSpecificPathSync 返回的 Promise 在进程结束时才 resolve，先断言再收尾
    const pending = manager.runSpecificPathSync(task, ["sub/a.txt", "b.txt"]);

    const args = lastArgs();
    expect(args.filter((a) => a === "-path")).toHaveLength(2);
    expect(args).toContain("sub/a.txt");
    expect(args).toContain("b.txt");

    finishLastProc();
    await pending;
  });
});

describe("SyncManager 调度逻辑", () => {
  it("requestIncrementalSync 防抖：1500ms 内多次调用只触发一次", () => {
    vi.useFakeTimers();
    const { src, tgt } = makeDirs();
    const task = makeTask("t-deb", { sourcePath: src, targetPath: tgt });
    syncStore.saveTask(task);

    const startSpy = vi.spyOn(manager, "startTask").mockImplementation(async () => {});

    manager.requestIncrementalSync("t-deb");
    manager.requestIncrementalSync("t-deb");
    manager.requestIncrementalSync("t-deb");

    vi.advanceTimersByTime(1499);
    expect(startSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledWith(task);
  });

  it("stopTask 清理 pid 并置状态为 idle", async () => {
    const task = makeTask("t-stop", { sourcePath: tmpDir, targetPath: tmpDir, pid: 12345 });
    syncStore.saveTask(task);

    await manager.stopTask("t-stop");

    expect(updateTaskSpy).toHaveBeenCalledWith("t-stop", { pid: undefined });
    expect(updateTaskSpy).toHaveBeenLastCalledWith("t-stop", { status: "idle" });
  });
});
