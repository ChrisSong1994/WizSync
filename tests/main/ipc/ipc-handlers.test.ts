import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 主进程 IPC 处理器测试（src/main/main.ts）。
 *
 * main.ts 在模块顶层有大量副作用（requestSingleInstanceLock、注册所有 ipcMain.handle、
 * app.whenReady 等），因此这里用 mock 的 electron 捕获每个 channel 的处理器，
 * 再逐个调用，覆盖安全校验（路径穿越）、备份归属校验、忽略规则、对比等边界。
 */

const mock = vi.hoisted(() => ({
  userData: "",
  handlers: new Map<string, (...args: any[]) => any>(),
  electronMock: null as any,
  appPath: "",
}));

vi.mock("electron", () => {
  const BrowserWindow = class {
    static getAllWindows() {
      return [];
    }
  };
  const electronMock = {
    app: {
      getPath: (key: string) => (key === "userData" ? mock.userData : mock.userData),
      getAppPath: () => mock.appPath,
      getVersion: () => "9.9.9-test",
      requestSingleInstanceLock: () => true,
      whenReady: () => new Promise(() => {}), // 永不 resolve：不触发启动任务
      on: vi.fn(),
      quit: vi.fn(),
      setAppUserModelId: vi.fn(),
      isPackaged: false,
    },
    ipcMain: {
      handle: (channel: string, fn: (...args: any[]) => any) => {
        mock.handlers.set(channel, fn);
      },
    },
    dialog: {
      showMessageBox: vi.fn(async () => ({ response: 1 })),
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    },
    shell: {
      openPath: vi.fn(async () => ""),
      showItemInFolder: vi.fn(),
      trashItem: vi.fn(async () => {}),
    },
    session: { defaultSession: {} },
    Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() },
    Tray: class {
      setToolTip() {}
      setIgnoreDoubleClickEvents() {}
      setTitle() {}
      setContextMenu() {}
      popUpContextMenu() {}
      on() {}
    },
    nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
    BrowserWindow,
  };
  mock.electronMock = electronMock;
  return electronMock;
});

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

// 同步引擎与磁盘/托盘相关模块：这里只测 IPC 边界，避免派生真实进程
vi.mock("../../../src/main/libs/sync-manager", () => ({
  syncManager: {
    startTask: vi.fn(),
    stopTask: vi.fn(async () => {}),
    deleteTask: vi.fn(async () => {}),
    resetTask: vi.fn(async () => {}),
    stopAllTasks: vi.fn(async () => {}),
    runSpecificPathSync: vi.fn(async () => true),
    requestIncrementalSync: vi.fn(),
    setManualSyncing: vi.fn(),
    isTaskManualSyncing: vi.fn(() => false),
    setWindow: vi.fn(),
    getLogs: vi.fn(() => "log"),
    clearLogs: vi.fn(),
  },
}));

vi.mock("../../../src/main/libs/logs", () => ({
  logManager: { write: vi.fn(), get: vi.fn(() => ""), clear: vi.fn(), getTaskDir: vi.fn(() => "/tmp") },
}));

vi.mock("../../../src/main/libs/disk", () => ({
  diskManager: {
    getDiskSpace: vi.fn(() => ({ name: "测试盘", total: 100, free: 50 })),
    init: vi.fn(),
    stopMonitoring: vi.fn(),
    getDiskSpaceSync: vi.fn(),
  },
}));

vi.mock("../../../src/main/libs/tray", () => ({
  TrayManager: class {
    setWindow() {}
    createTray() {}
  },
}));

import { syncStore } from "../../../src/main/libs/sync-store";
import { syncManager as rawSyncManager } from "../../../src/main/libs/sync-manager";
import type { SyncTask } from "../../../src/main/libs/types";

/**
 * mock 工厂里的对象不经过 vi.clearAllMocks() → 每次 beforeAll 重新包一层 spy，
 * 保证各用例之间的调用记录互不干扰。
 */
let syncManager: typeof rawSyncManager;

/** 等待模块顶层的 ipcMain.handle 注册完成 */
await import("../../../src/main/main");

let tmpDir: string;
let srcDir: string;
let tgtDir: string;

function handler<T = any>(channel: string): (...args: any[]) => T {
  const fn = mock.handlers.get(channel);
  if (!fn) throw new Error(`未注册的 IPC channel: ${channel}`);
  return fn as any;
}

/** 调用 IPC 处理器（第一参数为模拟的 event） */
function invoke(channel: string, ...args: any[]) {
  return handler(channel)({ sender: { send: vi.fn() } }, ...args);
}

function makeTask(overrides: Partial<SyncTask> = {}): SyncTask {
  return {
    id: "t1",
    name: "任务",
    sourcePath: srcDir,
    targetPath: tgtDir,
    mode: "manual",
    direction: "bidirectional",
    status: "idle",
    backupPath: path.join(tgtDir, ".wizsync/backups"),
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wizsync-ipc-"));
  mock.userData = path.join(tmpDir, "userData");
  mock.appPath = tmpDir;
  fs.mkdirSync(mock.userData, { recursive: true });
  srcDir = path.join(tmpDir, "src");
  tgtDir = path.join(tmpDir, "tgt");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(tgtDir, { recursive: true });

  syncStore.getTasks().forEach((t) => syncStore.deleteTask(t.id));
  vi.clearAllMocks();
  syncManager = {
    ...(rawSyncManager as unknown as Record<string, unknown>),
    startTask: vi.fn(),
    stopTask: vi.fn(async () => {}),
    deleteTask: vi.fn(async () => {}),
    resetTask: vi.fn(async () => {}),
    stopAllTasks: vi.fn(async () => {}),
    runSpecificPathSync: vi.fn(async () => true),
    requestIncrementalSync: vi.fn(),
    setManualSyncing: vi.fn(),
  } as unknown as typeof rawSyncManager;
  Object.assign(rawSyncManager, syncManager);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("IPC：任务保存与路径重叠校验", () => {
  it("保存任务时自动补全备份目录并计算统计/磁盘信息", async () => {
    fs.writeFileSync(path.join(srcDir, "a.txt"), "abc");

    const tasks = await invoke("save-task", {
      id: "save-1",
      name: "新任务",
      sourcePath: srcDir,
      targetPath: tgtDir,
      mode: "manual",
      direction: "bidirectional",
      status: "idle",
    });

    expect(tasks).toHaveLength(1);
    expect(tasks[0].backupPath).toBe(path.join(tgtDir, ".wizsync", "backups"));
    expect(tasks[0].sourceStats).toEqual({ size: 3, count: 1 });
    // diskManager 在本测试里被 mock（getDiskSpace 返回固定值）
    expect(tasks[0].sourceDisk).toEqual({ name: "测试盘", total: 100, free: 50 });
  });

  it("同一目录被两个任务的源/目标复用时拒绝保存", async () => {
    await invoke("save-task", makeTask({ id: "a" }));

    await expect(invoke("save-task", makeTask({ id: "b" }))).rejects.toThrow(/路径冲突/);
  });

  it("父子嵌套目录复用被拒绝", async () => {
    await invoke("save-task", makeTask({ id: "a" }));
    const nested = path.join(srcDir, "child");
    fs.mkdirSync(nested);

    await expect(
      invoke("save-task", makeTask({ id: "b", sourcePath: nested, targetPath: path.join(tmpDir, "t2") })),
    ).rejects.toThrow(/路径冲突/);
  });

  it("编辑任务自身不触发重叠校验", async () => {
    await invoke("save-task", makeTask({ id: "a" }));
    const tasks = await invoke("save-task", makeTask({ id: "a", name: "改名后" }));
    expect(tasks).toHaveLength(1);
    expect(tasks[0].name).toBe("改名后");
  });

  it("保留用户自定义的备份目录（不被默认值覆盖）", async () => {
    const custom = path.join(tmpDir, "custom-backups");
    const tasks = await invoke("save-task", makeTask({ id: "bk-custom", backupPath: custom }));

    expect(tasks[0].backupPath).toBe(custom);
  });

  it("备份目录位于同步根目录内部时拒绝保存", async () => {
    const insideSrc = path.join(srcDir, "backups");

    await expect(
      invoke("save-task", makeTask({ id: "bk-inside", backupPath: insideSrc })),
    ).rejects.toThrow(/备份目录不能位于同步目录内部/);
  });

  it("默认备份目录（目标目录/.wizsync/backups）位于目标内但允许", async () => {
    const tasks = await invoke("save-task", makeTask({ id: "bk-default" }));
    expect(tasks[0].backupPath).toBe(path.join(tgtDir, ".wizsync", "backups"));
  });

  it("备份目录尚未创建时也能完成校验", async () => {
    const custom = path.join(tmpDir, "not-yet-created", "deep", "backups");
    const tasks = await invoke("save-task", makeTask({ id: "bk-missing", backupPath: custom }));
    expect(tasks[0].backupPath).toBe(custom);
  });

  it("delete-task 先停止引擎再移除记录", async () => {
    await invoke("save-task", makeTask({ id: "del-1" }));
    const tasks = await invoke("delete-task", "del-1");

    expect(syncManager.deleteTask).toHaveBeenCalled();
    expect(tasks).toHaveLength(0);
  });
});

describe("IPC：路径穿越防护", () => {
  it("delete-file 拒绝 ../ 越界路径", async () => {
    await invoke("save-task", makeTask({ id: "p1" }));
    const outside = path.join(tmpDir, "outside.txt");
    fs.writeFileSync(outside, "secret");

    const ok = await invoke("delete-file", "p1", "../outside.txt", "source");

    expect(ok).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it("delete-file 删除根目录内的文件（移入废纸篓）并触发增量同步", async () => {
    await invoke("save-task", makeTask({ id: "p2" }));
    fs.writeFileSync(path.join(srcDir, "victim.txt"), "x");

    const ok = await invoke("delete-file", "p2", "victim.txt", "source");

    expect(ok).toBe(true);
    expect(mock.electronMock.shell.trashItem).toHaveBeenCalledWith(path.join(srcDir, "victim.txt"));
    expect(syncManager.requestIncrementalSync).toHaveBeenCalledWith("p2", ["victim.txt"]);
  });

  it("delete-files 批量删除时任一越界即整体拒绝", async () => {
    await invoke("save-task", makeTask({ id: "p3" }));
    fs.writeFileSync(path.join(srcDir, "ok.txt"), "x");

    const ok = await invoke("delete-files", "p3", ["ok.txt", "../../etc/passwd"], "source");

    expect(ok).toBe(false);
    expect(mock.electronMock.shell.trashItem).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(srcDir, "ok.txt"))).toBe(true);
  });

  it("reveal-in-explorer 拒绝越界路径，允许根目录本身", async () => {
    await invoke("save-task", makeTask({ id: "p4" }));

    const bad = await invoke("reveal-in-explorer", "p4", "../../outside", "source");
    expect(bad).toBe(false);

    const root = await invoke("reveal-in-explorer", "p4", "", "source");
    expect(root).toBe(true);
    expect(mock.electronMock.shell.openPath).toHaveBeenCalledWith(srcDir);
  });

  it("sync-single-file 拒绝越界路径且不调用引擎", async () => {
    await invoke("save-task", makeTask({ id: "p5" }));

    const ok = await invoke("sync-single-file", "p5", "../escape.txt", "sourceToTarget");

    expect(ok).toBe(false);
    expect(syncManager.runSpecificPathSync).not.toHaveBeenCalled();
  });

  it("未知任务 ID 的 IPC 调用安全返回 false", async () => {
    expect(await invoke("sync-single-file", "nope", "a.txt", "sourceToTarget")).toBe(false);
    expect(await invoke("delete-file", "nope", "a.txt", "source")).toBe(false);
    expect(await invoke("delete-files", "nope", ["a.txt"], "source")).toBe(false);
    expect(await invoke("start-sync", "nope")).toBe(false);
  });
});

describe("IPC：备份文件管理", () => {
  it("list-backup-files 只返回保留期内的文件，并按时间倒序", async () => {
    const task = makeTask({ id: "bak", backupRetentionDays: 30 });
    await invoke("save-task", task);
    const backupDir = task.backupPath!;
    fs.mkdirSync(path.join(backupDir, "nested"), { recursive: true });

    const fresh = path.join(backupDir, "fresh.txt");
    const old = path.join(backupDir, "old.txt");
    const nested = path.join(backupDir, "nested/deep.txt");
    [fresh, old, nested].forEach((f) => fs.writeFileSync(f, "x"));
    const now = Date.now();
    fs.utimesSync(fresh, now / 1000, now / 1000);
    fs.utimesSync(nested, (now - 1000) / 1000, (now - 1000) / 1000);
    const oldTime = (now - 40 * 86400000) / 1000;
    fs.utimesSync(old, oldTime, oldTime);

    const files = await invoke("list-backup-files", "bak");

    expect(files.map((f: any) => f.name)).toEqual(["fresh.txt", "deep.txt"]);
    expect(files[1].relativePath).toBe(path.join("nested", "deep.txt"));
  });

  it("delete-backup-file 拒绝删除备份目录之外的文件", async () => {
    const task = makeTask({ id: "bak2" });
    await invoke("save-task", task);
    const outside = path.join(tmpDir, "keep.txt");
    fs.writeFileSync(outside, "keep");

    const ok = await invoke("delete-backup-file", "bak2", outside);

    expect(ok).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it("delete-backup-file 移入废纸篓而非永久删除", async () => {
    const task = makeTask({ id: "bak3" });
    await invoke("save-task", task);
    const file = path.join(task.backupPath!, "a.txt");
    fs.mkdirSync(task.backupPath!, { recursive: true });
    fs.writeFileSync(file, "old version");

    const ok = await invoke("delete-backup-file", "bak3", file);

    expect(ok).toBe(true);
    expect(mock.electronMock.shell.trashItem).toHaveBeenCalledWith(file);
  });

  it("reveal-backup-file 拒绝不属于该任务的路径", async () => {
    const task = makeTask({ id: "bak4" });
    await invoke("save-task", task);
    fs.mkdirSync(task.backupPath!, { recursive: true });
    fs.writeFileSync(path.join(task.backupPath!, "a.txt"), "x");

    expect(await invoke("reveal-backup-file", "bak4", "../../../etc/hosts")).toBe(false);
    expect(await invoke("reveal-backup-file", "bak4", "a.txt")).toBe(true);
  });

  it("open-backup-folder 在目录不存在时自动创建", async () => {
    const task = makeTask({ id: "bak5" });
    await invoke("save-task", task);
    fs.rmSync(task.backupPath!, { recursive: true, force: true });

    await invoke("open-backup-folder", "bak5");

    expect(fs.existsSync(task.backupPath!)).toBe(true);
    expect(mock.electronMock.shell.openPath).toHaveBeenCalledWith(task.backupPath);
  });
});

describe("IPC：忽略规则", () => {
  it("ignore-path 幂等，unignore-path 精确移除", async () => {
    await invoke("save-task", makeTask({ id: "ig1" }));

    await invoke("ignore-path", "ig1", "a/b.txt");
    await invoke("ignore-path", "ig1", "a/b.txt");
    let task = syncStore.getTasks().find((t) => t.id === "ig1")!;
    expect(task.ignoredPaths).toEqual(["a/b.txt"]);

    await invoke("unignore-path", "ig1", "a/b.txt");
    task = syncStore.getTasks().find((t) => t.id === "ig1")!;
    expect(task.ignoredPaths).toEqual([]);
  });

  it("ignore-paths 批量去重新增", async () => {
    await invoke("save-task", makeTask({ id: "ig2", ignoredPaths: ["keep"] }));

    await invoke("ignore-paths", "ig2", ["a", "b", "a"]);

    expect(syncStore.getTasks().find((t) => t.id === "ig2")!.ignoredPaths).toEqual([
      "keep",
      "a",
      "b",
    ]);
  });

  it("get-ignore-patterns 返回内置黑名单", async () => {
    expect(await invoke("get-ignore-patterns")).toEqual(
      expect.arrayContaining(["node_modules", "Thumbs.db", "desktop.ini"]),
    );
  });
});

describe("IPC：目录对比", () => {
  it("返回 sourceOnly / targetOnly / different / ignored 四类结果", async () => {
    await invoke("save-task", makeTask({ id: "cmp1", ignoredPaths: ["skip.txt"] }));
    fs.writeFileSync(path.join(srcDir, "only-src.txt"), "s");
    fs.writeFileSync(path.join(tgtDir, "only-tgt.txt"), "t");
    fs.writeFileSync(path.join(srcDir, "diff.txt"), "source-content");
    fs.writeFileSync(path.join(tgtDir, "diff.txt"), "target");
    fs.writeFileSync(path.join(srcDir, "same.txt"), "same");
    fs.writeFileSync(path.join(tgtDir, "same.txt"), "same");
    const now = Date.now() / 1000;
    fs.utimesSync(path.join(srcDir, "same.txt"), now, now);
    fs.utimesSync(path.join(tgtDir, "same.txt"), now, now);
    fs.writeFileSync(path.join(srcDir, "skip.txt"), "ignored");

    const diff = await invoke("compare-directories", "cmp1");

    expect(diff.sourceOnly.map((f: any) => f.path)).toEqual(["only-src.txt"]);
    expect(diff.targetOnly.map((f: any) => f.path)).toEqual(["only-tgt.txt"]);
    expect(diff.different.map((f: any) => f.path)).toEqual(["diff.txt"]);
    expect(diff.ignored.map((f: any) => f.path)).toEqual(["skip.txt"]);
  });

  it("同步进行中拒绝对比", async () => {
    await invoke("save-task", makeTask({ id: "cmp2" }));
    syncStore.updateTask("cmp2", { status: "syncing" });

    await expect(invoke("compare-directories", "cmp2")).rejects.toThrow(/currently syncing/);
  });

  it("任务不存在时抛错", async () => {
    await expect(invoke("compare-directories", "nope")).rejects.toThrow(/Task not found/);
  });

  it("cancel-compare 在中止时返回 true 并让对比抛 compare-cancelled", async () => {
    await invoke("save-task", makeTask({ id: "cmp3" }));
    for (let i = 0; i < 300; i++) {
      fs.writeFileSync(path.join(srcDir, `f${i}.txt`), "x".repeat(100));
    }

    const comparing = invoke("compare-directories", "cmp3");
    await invoke("cancel-compare");

    await expect(comparing).rejects.toThrow(/compare-cancelled/);
    expect(await invoke("cancel-compare")).toBe(false);
  });
});

describe("IPC：应用信息", () => {
  it("get-app-data-path / get-app-version 返回主进程信息", async () => {
    expect(await invoke("get-app-data-path")).toBe(mock.userData);
    expect(await invoke("get-app-version")).toBe("9.9.9-test");
  });

  it("get-default-backup-path 默认落在目标目录的 .wizsync/backups", async () => {
    await invoke("save-task", makeTask({ id: "info1" }));
    expect(await invoke("get-default-backup-path", "info1")).toBe(
      path.join(tgtDir, ".wizsync", "backups"),
    );
  });

  it("get-default-backup-path 对未知任务回退到 userData", async () => {
    expect(await invoke("get-default-backup-path", "missing")).toBe(
      path.join(mock.userData, "backups", "missing"),
    );
  });

  it("get-default-backup-path 支持新建任务时传入目标目录", async () => {
    expect(await invoke("get-default-backup-path", "brand-new", "/tmp/some-target")).toBe(
      path.join("/tmp/some-target", ".wizsync", "backups"),
    );
  });
});

describe("IPC：批量同步", () => {
  it("sync-files 越界路径整体拒绝", async () => {
    await invoke("save-task", makeTask({ id: "bs1" }));

    const result = await invoke("sync-files", "bs1", ["a.txt", "../../x"], "sourceToTarget");

    expect(result).toEqual({ ok: false });
    expect(syncManager.runSpecificPathSync).not.toHaveBeenCalled();
  });

  it("sync-files 全量协调后返回重新对比的差异", async () => {
    await invoke("save-task", makeTask({ id: "bs2" }));
    fs.writeFileSync(path.join(srcDir, "a.txt"), "a");

    const result = await invoke("sync-files", "bs2", ["a.txt"], "sourceToTarget");

    expect(syncManager.runSpecificPathSync).toHaveBeenCalledWith(
      expect.objectContaining({ id: "bs2" }),
      undefined,
      "sourceToTarget",
    );
    expect(result.ok).toBe(true);
    expect(result.diff).toBeDefined();
  });

  it("空路径列表直接成功且不启动引擎", async () => {
    await invoke("save-task", makeTask({ id: "bs3" }));
    expect(await invoke("sync-files", "bs3", [], "sourceToTarget")).toEqual({ ok: true });
    expect(syncManager.runSpecificPathSync).not.toHaveBeenCalled();
  });
});