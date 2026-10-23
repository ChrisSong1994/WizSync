import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SyncTask } from "../../../src/main/libs/types";

// electron 在纯 node 环境下不可用，BrowserWindow 仅在类型位置使用
vi.mock("electron", () => ({
  BrowserWindow: class {},
}));

// 让 disk.ts 引入的 sync-store（electron-store）可用
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

import { diskManager } from "../../../src/main/libs/disk";
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

afterEach(() => {
  vi.restoreAllMocks();
  diskManager.stopMonitoring();
});

describe("DiskManager.getDiskSpace", () => {
  it("真实存在的目录返回磁盘空间信息，名称为本地磁盘", () => {
    const info = diskManager.getDiskSpace(os.tmpdir());
    expect(info).not.toBeNull();
    expect(info!.name).toBe("本地磁盘");
    expect(info!.total).toBeGreaterThan(0);
    expect(info!.free).toBeGreaterThan(0);
  });

  it("目录不存在时返回 null", () => {
    expect(
      diskManager.getDiskSpace(path.join(os.tmpdir(), "wizsync-no-such-dir-xyz"))
    ).toBeNull();
  });

  it("外置磁盘 /Volumes/xxx 以卷名作为磁盘名", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "statfsSync").mockReturnValue({
      bsize: 4096,
      blocks: 1000,
      bfree: 500,
    } as any);

    expect(diskManager.getDiskSpace("/Volumes/SDCARD")?.name).toBe("SDCARD");
    // 卷名为空时使用兜底文案
    expect(diskManager.getDiskSpace("/Volumes/")?.name).toBe("外置磁盘");
  });

  it("非卷、非用户目录的磁盘使用默认名称", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "statfsSync").mockReturnValue({
      bsize: 4096,
      blocks: 1000,
      bfree: 500,
    } as any);

    expect(diskManager.getDiskSpace("/etc")?.name).toBe("本地磁盘");
  });

  it.skipIf(process.platform !== "darwin")("darwin 下系统盘命名为 Macintosh HD", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "statfsSync").mockReturnValue({
      bsize: 4096,
      blocks: 1000,
      bfree: 500,
    } as any);

    expect(diskManager.getDiskSpace("/")?.name).toBe("Macintosh HD");
    expect(diskManager.getDiskSpace("/Users/foo")?.name).toBe("Macintosh HD");
  });
});

describe("DiskManager 磁盘重连检测", () => {
  it("之前离线的任务在磁盘恢复后触发 onDiskReconnect", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "statfsSync").mockReturnValue({
      bsize: 4096,
      blocks: 1000,
      bfree: 500,
    } as any);

    // 之前磁盘缺失（无 sourceDisk/targetDisk）的任务
    syncStore.saveTask(
      makeTask("t1", {
        sourcePath: "/Volumes/A",
        targetPath: "/Volumes/B",
        status: "error",
        sourceDisk: undefined,
        targetDisk: undefined,
      })
    );

    const win = { webContents: { send: vi.fn() } } as any;
    const onStatusChange = vi.fn();
    const onReconnect = vi.fn();

    // init 会立即执行一次 checkAllDisks
    diskManager.init(win, onStatusChange, onReconnect);
    await new Promise((r) => setImmediate(r));

    expect(onReconnect).toHaveBeenCalledWith("t1");
  });

  it("一直离线的任务不会触发重连回调", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    syncStore.saveTask(
      makeTask("t2", {
        sourcePath: "/Volumes/A",
        targetPath: "/Volumes/B",
        status: "error",
      })
    );

    const onReconnect = vi.fn();
    diskManager.init({ webContents: { send: vi.fn() } } as any, vi.fn(), onReconnect);
    await new Promise((r) => setImmediate(r));

    expect(onReconnect).not.toHaveBeenCalled();
  });
});
