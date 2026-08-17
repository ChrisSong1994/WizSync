import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SyncTask } from "../../../src/main/libs/types";

// 可变 holder：在每次 import 前设置 userData 临时目录
const mock = vi.hoisted(() => ({ userData: "" }));

// electron 在纯 node 环境下不可用，mock 掉 app.getPath
vi.mock("electron", () => ({
  app: {
    getPath: (key: string) => (key === "userData" ? mock.userData : ""),
  },
}));

// 让 logs.ts 引入的 sync-store（electron-store）可用
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

type LogManagerModule = typeof import("../../../src/main/libs/logs").logManager;
type SyncStoreModule = typeof import("../../../src/main/libs/sync-store").syncStore;

let userData: string;
let logManager: LogManagerModule;
let syncStore: SyncStoreModule;

beforeEach(async () => {
  vi.resetModules();
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "wizsync-logs-"));
  mock.userData = userData;
  const logs = await import("../../../src/main/libs/logs");
  const store = await import("../../../src/main/libs/sync-store");
  logManager = logs.logManager;
  syncStore = store.syncStore;
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

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

describe("LogManager", () => {
  it("write + get 往返，写入全局日志目录并按天归档", () => {
    logManager.write("task1", "hello world");

    const todayFile = path.join(userData, "logs", "task1", `${todayStr()}.log`);
    expect(fs.existsSync(todayFile)).toBe(true);
    expect(fs.readFileSync(todayFile, "utf-8")).toContain("hello world");

    const logs = logManager.get("task1");
    expect(logs).toContain("hello world");
    expect(logs).toContain(`日期: ${todayStr()}`);
  });

  it("任务存在且目标目录可用时，日志写入本地 .wizsync/logs", () => {
    const target = path.join(userData, "target-dir");
    fs.mkdirSync(target, { recursive: true });
    syncStore.saveTask(makeTask("t-local", { targetPath: target }));

    logManager.write("t-local", "local log line");

    const localFile = path.join(target, ".wizsync", "logs", `${todayStr()}.log`);
    expect(fs.existsSync(localFile)).toBe(true);

    const logs = logManager.get("t-local");
    expect(logs).toContain("local log line");
    expect(logs).toContain("本地");
  });

  it("get 只合并最近 7 天的日志文件", () => {
    const dir = path.join(userData, "logs", "t7");
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= 10; i++) {
      const day = String(i).padStart(2, "0");
      fs.writeFileSync(path.join(dir, `2026-01-${day}.log`), `content-${i}\n`);
    }

    const logs = logManager.get("t7");
    expect(logs).toContain("2026-01-10");
    expect(logs).toContain("2026-01-04");
    expect(logs).not.toContain("2026-01-03");
    expect(logs).not.toContain("2026-01-01");
  });

  it("clear 删除全局与本地日志目录", () => {
    logManager.write("t-clear", "some log");
    const globalDir = path.join(userData, "logs", "t-clear");
    expect(fs.existsSync(globalDir)).toBe(true);

    logManager.clear("t-clear");
    expect(fs.existsSync(globalDir)).toBe(false);
    expect(logManager.get("t-clear")).toBe("");
  });

  it("getTaskDir 确保目录存在并返回路径", () => {
    const dir = logManager.getTaskDir("t-dir");
    expect(fs.existsSync(dir)).toBe(true);
    expect(dir).toContain("t-dir");
  });
});
