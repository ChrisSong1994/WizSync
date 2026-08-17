import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SyncTask } from "../../../src/main/libs/types";

// electron-store 依赖 electron.app，无法在纯 node 环境加载，
// 用内存实现整体 mock。
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

import { syncStore } from "../../../src/main/libs/sync-store";

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

beforeEach(() => {
  syncStore.getTasks().forEach((t) => syncStore.deleteTask(t.id));
});

describe("syncStore", () => {
  it("初始为空任务列表", () => {
    expect(syncStore.getTasks()).toEqual([]);
  });

  it("saveTask 新增任务并返回完整列表", () => {
    const tasks = syncStore.saveTask(makeTask("t1"));
    expect(tasks).toHaveLength(1);
    expect(syncStore.getTasks()[0].id).toBe("t1");
  });

  it("saveTask 按 id 覆盖已有任务而不重复", () => {
    syncStore.saveTask(makeTask("t1"));
    const tasks = syncStore.saveTask(makeTask("t1", { name: "改名" }));
    expect(tasks).toHaveLength(1);
    expect(syncStore.getTasks()[0].name).toBe("改名");
  });

  it("deleteTask 按 id 删除任务", () => {
    syncStore.saveTask(makeTask("t1"));
    syncStore.saveTask(makeTask("t2"));
    const tasks = syncStore.deleteTask("t1");
    expect(tasks.map((t) => t.id)).toEqual(["t2"]);
  });

  it("updateTask 只合并指定属性", () => {
    syncStore.saveTask(makeTask("t1"));
    const updated = syncStore.updateTask("t1", { status: "error", lastSyncTime: "now" });
    expect(updated).toEqual(
      expect.objectContaining({ id: "t1", status: "error", lastSyncTime: "now", name: "任务 t1" })
    );
  });

  it("updateTask 对不存在的 id 返回 undefined 且不报错", () => {
    expect(syncStore.updateTask("nope", { status: "error" })).toBeUndefined();
    expect(syncStore.getTasks()).toEqual([]);
  });
});
