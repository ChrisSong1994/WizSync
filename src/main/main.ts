import { app, BrowserWindow, ipcMain, dialog, shell, session } from "electron";
import path from "node:path";
import fs from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { syncStore } from "./libs/sync-store";
import { syncManager } from "./libs/sync-manager";
import { logManager } from "./libs/logs";
import { TrayManager } from "./libs/tray";
import { getDirStats, getAllFiles, computeDirDiff, IGNORE_PATTERNS, resolveInside, resolveExistingRelativePath } from "./libs/fs-utils";
import { diskManager } from "./libs/disk";
import { SyncTask, DiffResult } from "./libs/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(__dirname, "..");

// 修复 macOS 生产环境下的 PATH 变量
if (process.platform === "darwin") {
  process.env.PATH = `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin:/opt/local/bin`;
}

process.env.APP_ROOT = APP_ROOT;

/**
 * 获取 Unison 二进制文件的路径
 */
export function getUnisonPath(): string {
  const arch = process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";

  // 使用 app.getAppPath() 获取应用根目录
  let resourcePath = path.join(
    app.getAppPath(),
    "src/resources/bin",
    arch,
    "unison",
  );

  // 处理 ASAR unpack 后的路径
  if (resourcePath.includes("app.asar")) {
    resourcePath = resourcePath.replace("app.asar", "app.asar.unpacked");
  }

  // 确保二进制文件具有可执行权限
  try {
    if (fs.existsSync(resourcePath)) {
      const stats = fs.statSync(resourcePath);
      // 如果没有执行权限 (0o111)，则添加权限
      if (!(stats.mode & 0o111)) {
        fs.chmodSync(resourcePath, 0o755);
      }
    }
  } catch (err) {
    console.error("修复二进制权限失败:", err);
  }

  return resourcePath;
}

export const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
export const MAIN_DIST = path.join(APP_ROOT, "dist-electron");
export const RENDERER_DIST = path.join(APP_ROOT, "dist");

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(APP_ROOT, "public")
  : RENDERER_DIST;

let win: BrowserWindow | null = null;
let isQuitting = false;
const trayManager = new TrayManager(APP_ROOT);

// 单实例锁：防止两个实例同时运行，避免同一批同步根目录被并发写入
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

/**
 * 创建主窗口
 */
function createWindow() {
  win = new BrowserWindow({
    icon: path.join(process.env.VITE_PUBLIC || "", "assets/logo.png"),
    width: 1000,
    height: 750,
    minHeight: 600,
    minWidth: 850,
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      // 显式声明安全项，防止未来默认值变化带来回归
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
    titleBarStyle: "hiddenInset",
  });

  syncManager.setWindow(win);
  trayManager.setWindow(win);

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(RENDERER_DIST, "index.html"));
  }

  win.on("close", (e) => {
    if (isQuitting) {
      win = null;
    } else {
      // 拦截关闭事件，隐藏窗口而不是退出
      e.preventDefault();
      win?.hide();
    }
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
    win = null;
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else {
    win?.show();
  }
});

app.on("before-quit", async (e) => {
  if (isQuitting) return;
  
  // 拦截第一次退出事件以执行异步清理
  e.preventDefault();
  isQuitting = true;
  
  console.log("正在执行退出前清理...");
  await syncManager.stopAllTasks();
  
  // 清理完成后再次触发退出
  app.quit();
});

app.whenReady().then(() => {
  // 非主实例（被单实例锁拒绝）直接退出，不再初始化
  if (!gotSingleInstanceLock) return;

  // 生产环境注入 CSP：仅在打包模式下生效，避免影响 vite dev（HMR 需要内联脚本与 ws 连接）
  if (app.isPackaged) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'",
          ],
        },
      });
    });
  }

  createWindow();
  trayManager.createTray(createWindow);

  // 应用启动后自动执行所有非手动任务
  setTimeout(() => {
    // 清理上次异常退出残留的 Unison 孤儿进程，避免其与本次启动的同步进程并发写入同一批根目录
    cleanupOrphanedUnison();

    const tasks = syncStore.getTasks();

    // 清理超过保留期的备份文件（递归，跳过隐藏文件；保留期默认 30 天，任务可配置）
    const now = Date.now();
    const cleanOldBackups = (dir: string, retentionMs: number) => {
      try {
        fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            cleanOldBackups(fullPath, retentionMs);
          } else if (entry.isFile()) {
            const mtime = fs.statSync(fullPath).mtimeMs;
            if (now - mtime > retentionMs) fs.unlinkSync(fullPath);
          }
        });
      } catch {}
    };
    tasks.forEach((task) => {
      if (!task.backupPath || !fs.existsSync(task.backupPath)) return;
      cleanOldBackups(task.backupPath, getRetentionMs(task));
    });

    tasks.forEach((task) => {
      if (task.mode === "scheduled") {
        syncManager.startTask(task);
      }
    });
  }, 1500); // 延迟 1.5 秒启动，确保 UI 和系统资源已就绪
});

// IPC 处理器绑定

/**
 * 校验渲染进程传来的相对路径不越出同步根目录。
 * 返回解析后的完整路径；越界返回 null（调用方应拒绝并记日志）。
 * 空字符串合法，表示根目录本身（用于 reveal 根目录）。
 */
function resolveInRoot(root: string, relPath: string): string | null {
  const full = resolveInside(root, relPath);
  if (!full) {
    console.warn(`[安全] 已拒绝越界路径: "${relPath}" (根目录: ${root})`);
  }
  return full;
}

/**
 * 越界校验 + 修正为磁盘上真实存在的相对路径。
 *
 * 对比层按 NFC / 大小写折叠匹配（与 unison 一致），因此给出的相对路径可能与某一端
 * 磁盘上的字节不一致（典型：源端是 NFD，unison 把目标端写成 NFC）。删除 / 定位 /
 * 单文件同步必须作用在真实存在的名字上，否则在 exFAT 这类「大小写不敏感但 Unicode
 * 归一化敏感」的卷上会 ENOENT（操作静默失败）。
 *
 * 先做越界校验（安全），再逐段按「精确 → NFC + 小写」解析；都找不到返回 null。
 */
function resolveExistingInRoot(root: string, relPath: string): string | null {
  const full = resolveInRoot(root, relPath);
  if (!full) return null;
  if (fs.existsSync(full)) return relPath;
  return resolveExistingRelativePath(root, relPath);
}

/** 备份保留天数默认值 */
const DEFAULT_BACKUP_RETENTION_DAYS = 30;

/** 根据任务配置计算备份保留期（毫秒），未配置时取默认值 */
function getRetentionMs(task: SyncTask): number {
  const days = task.backupRetentionDays && task.backupRetentionDays > 0
    ? task.backupRetentionDays
    : DEFAULT_BACKUP_RETENTION_DAYS;
  return days * 24 * 60 * 60 * 1000;
}

/**
 * 清理上次异常退出残留的 Unison 孤儿进程。
 * 通过匹配进程环境变量 UNISON=<userData>/task-data/<taskId>/unison 识别（由 sync-manager 注入）。
 * 仅在应用启动时（尚未派生任何同步进程）调用，因此命中的必然不是本实例的子进程。
 */
function cleanupOrphanedUnison() {
  const marker = path.join(app.getPath("userData"), "task-data");
  try {
    const out = execSync("ps eww -axo pid=,command=", {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
    let killed = 0;
    for (const line of out.split("\n")) {
      if (!line.includes("unison")) continue;
      if (!line.includes(marker)) continue;
      const pid = Number(line.trim().split(/\s+/)[0]);
      if (!Number.isInteger(pid) || pid <= 1) continue;
      try {
        process.kill(pid, "SIGKILL");
        killed++;
      } catch {}
    }
    if (killed > 0) console.log(`[清理] 已终止 ${killed} 个残留 Unison 进程`);
  } catch (err) {
    console.error("[清理] 孤儿进程扫描失败:", err);
  }
}

/** 将路径解析为可用于重叠比较的规范形式（realpath 优先，失败回退到绝对路径） */
function canonicalRoot(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/** 判断两个根目录是否重叠（相等或存在父子嵌套关系，含 symlink 解析） */
function rootsOverlap(a: string, b: string): boolean {
  const ca = canonicalRoot(a);
  const cb = canonicalRoot(b);
  if (ca === cb) return true;
  const aWithSep = ca.endsWith(path.sep) ? ca : ca + path.sep;
  const bWithSep = cb.endsWith(path.sep) ? cb : cb + path.sep;
  return aWithSep.startsWith(bWithSep) || bWithSep.startsWith(aWithSep);
}

/** 检查新任务与现有任务是否存在根目录重叠，返回错误信息或 null */
function findRootConflict(task: SyncTask): string | null {
  const tasks = syncStore.getTasks();
  for (const existing of tasks) {
    if (existing.id === task.id) continue; // 编辑自身时跳过
    for (const np of [task.sourcePath, task.targetPath]) {
      for (const ep of [existing.sourcePath, existing.targetPath]) {
        if (rootsOverlap(np, ep)) {
          return `路径冲突：目录 "${np}" 与任务 "${existing.name}" 的 "${ep}" 存在重叠（含 symlink 解析）。为避免两个任务并发写入同一目录，已拒绝保存。`;
        }
      }
    }
  }
  return null;
}

/** 当前 compare 扫描的取消控制器（一次只允许一个对比进行） */
let compareController: AbortController | null = null;

ipcMain.handle("cancel-compare", () => {
  if (compareController) {
    compareController.abort();
    return true;
  }
  return false;
});

ipcMain.handle("get-tasks", () => syncStore.getTasks());

ipcMain.handle("show-confirm", async (_event, message: string) => {
  const result = await dialog.showMessageBox(win!, {
    type: "question",
    buttons: ["取消", "确定"],
    defaultId: 1,
    cancelId: 0,
    message,
  });
  return result.response === 1;
});

ipcMain.handle("get-default-backup-path", (_event, taskId: string) => {
  const tasks = syncStore.getTasks();
  const task = tasks.find(t => t.id === taskId);
  if (task?.targetPath) {
    return path.join(task.targetPath, ".wizsync", "backups");
  }
  return path.join(app.getPath("userData"), "backups", taskId);
});

ipcMain.handle("save-task", async (_event, task: SyncTask) => {
  // 跨任务根目录重叠校验（realpath 解析，防 symlink 别名/父子嵌套导致的并发写入）
  const rootConflict = findRootConflict(task);
  if (rootConflict) throw new Error(rootConflict);

  if (!task.backupPath && task.targetPath) {
    task.backupPath = path.join(task.targetPath, ".wizsync", "backups");
  }
  task.sourceStats = await getDirStats(task.sourcePath);
  task.targetStats = await getDirStats(task.targetPath);
  task.sourceDisk = diskManager.getDiskSpace(task.sourcePath) || undefined;
  task.targetDisk = diskManager.getDiskSpace(task.targetPath) || undefined;
  return syncStore.saveTask(task);
});

ipcMain.handle("delete-task", async (_event, id: string) => {
  const tasks = syncStore.getTasks();
  const task = tasks.find((t) => t.id === id);
  if (task) {
    await syncManager.deleteTask(task);
  } else {
    syncManager.stopTask(id);
  }
  return syncStore.deleteTask(id);
});

ipcMain.handle("select-directory", async () => {
  const result = await dialog.showOpenDialog(win!, {
    properties: ["openDirectory"],
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle("start-sync", (_event, id: string) => {
  const tasks = syncStore.getTasks();
  const task = tasks.find((t) => t.id === id);
  if (!task) return false;
  syncManager.startTask(task);
  return true;
});

ipcMain.handle("stop-sync", (_event, id: string) => {
  syncManager.stopTask(id);
  return true;
});

ipcMain.handle("reset-sync", async (_event, id: string) => {
  const tasks = syncStore.getTasks();
  const task = tasks.find((t) => t.id === id);
  if (!task) return false;
  await syncManager.resetTask(task);
  return true;
});

ipcMain.handle("get-persistent-logs", (_event, id: string) => {
  return syncManager.getLogs(id);
});

ipcMain.handle("clear-persistent-logs", (_event, id: string) => {
  syncManager.clearLogs(id);
  return true;
});

ipcMain.handle("get-ignore-patterns", () => {
  return IGNORE_PATTERNS;
});

ipcMain.handle(
  "sync-single-file",
  async (
    _event,
    taskId: string,
    filePath: string,
    direction: "sourceToTarget" | "targetToSource",
  ) => {
    const tasks = syncStore.getTasks();
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return false;

    // 越界校验：filePath 必须是同步根目录内的相对路径；
    // 同时修正为所选端磁盘上真实存在的名字（NFC/大小写可能与对比结果不同）
    const base = direction === "sourceToTarget" ? task.sourcePath : task.targetPath;
    const relPath = resolveExistingInRoot(base, filePath);
    if (!relPath) return false;

    // 标记正在手动同步，防止触发 Unison 冲突
    syncManager.setManualSyncing(taskId, true);

    try {
      // 交给 Unison 引擎处理单文件同步
      logManager.write(
        taskId,
        `[手动同步] 正在通过引擎同步特定文件: ${relPath} (${direction === "sourceToTarget" ? "源→目标" : "目标→源"})`,
      );

      syncManager.runSpecificPathSync(task, [relPath], direction);
      return true;
    } catch (err: any) {
      console.error("单文件同步启动失败:", err);
      logManager.write(taskId, `[错误] 单文件同步启动失败: ${err.message}`);
      return false;
    } finally {
      // 释放手动同步标记，无需 requestIncrementalSync，因为引擎会自动更新状态
      syncManager.setManualSyncing(taskId, false);
    }
  },
);

ipcMain.handle(
  "reveal-in-explorer",
  async (
    _event,
    taskId: string,
    filePath: string,
    side: "source" | "target",
  ) => {
    const tasks = syncStore.getTasks();
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return false;

    const basePath = side === "source" ? task.sourcePath : task.targetPath;
    // 越界校验，防止揭示同步根目录之外的文件；并修正为真实存在的名字
    const relPath = resolveExistingInRoot(basePath, filePath);
    if (!relPath) return false;
    const fullPath = path.join(basePath, relPath);

    if (fs.existsSync(fullPath)) {
      shell.showItemInFolder(fullPath);
      return true;
    }
    return false;
  },
);

ipcMain.handle("reveal-backup-file", (_event, taskId: string, filePath: string) => {
  // 只允许揭示属于该任务的备份目录内的文件
  const task = syncStore.getTasks().find((t) => t.id === taskId);
  if (!task?.backupPath || !resolveInRoot(task.backupPath, filePath)) return false;
  if (fs.existsSync(filePath)) {
    shell.showItemInFolder(filePath);
    return true;
  }
  return false;
});

ipcMain.handle("open-log-folder", (_event, id: string) => {
  const dir = logManager.getTaskDir(id);
  shell.openPath(dir);
  return true;
});

ipcMain.handle("get-app-data-path", () => app.getPath("userData"));

/**
 * 当前应用版本号，取自 package.json 的 version 字段（由 electron-builder 打包时写入）。
 */
ipcMain.handle("get-app-version", () => app.getVersion());

ipcMain.handle("open-app-data-folder", async () => {
  const dir = app.getPath("userData");
  // 目录可能尚未创建，先确保存在再打开
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  await shell.openPath(dir);
  return true;
});

/**
 * 退出应用（渲染进程"退出"按钮触发）。
 * 直接走 app.quit()，由 before-quit 的统一流程负责停止所有同步进程、
 * 取消定时器与待重试后再真正退出，保证与 Cmd+Q 走同一条清理路径。
 */
ipcMain.handle("quit-app", () => {
  app.quit();
  return true;
});

ipcMain.handle("open-backup-folder", (_event, id: string) => {
  const tasks = syncStore.getTasks();
  const task = tasks.find((t) => t.id === id);
  let backupPath = task?.backupPath;
  if (!backupPath && task?.targetPath) {
    backupPath = path.join(task.targetPath, ".wizsync", "backups");
  } else if (!backupPath) {
    backupPath = path.join(app.getPath("userData"), "backups", id);
  }
  if (!fs.existsSync(backupPath)) {
    fs.mkdirSync(backupPath, { recursive: true });
  }
  shell.openPath(backupPath);
  return true;
});

ipcMain.handle("list-backup-files", async (_event, id: string) => {
  const tasks = syncStore.getTasks();
  const task = tasks.find((t) => t.id === id);
  if (!task?.backupPath || !fs.existsSync(task.backupPath)) return [];

  const retentionMs = getRetentionMs(task);
  const now = Date.now();
  const results: { name: string; path: string; relativePath: string; size: number; mtime: number }[] = [];

  const scan = (dir: string) => {
    try {
      fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath);
        } else if (entry.isFile()) {
          const stats = fs.statSync(fullPath);
          if (now - stats.mtimeMs < retentionMs) {
            const relativePath = path.relative(task.backupPath!, fullPath);
            results.push({ name: entry.name, path: fullPath, relativePath, size: stats.size, mtime: stats.mtimeMs });
          }
        }
      });
    } catch {}
  };

  scan(task.backupPath);
  return results.sort((a, b) => b.mtime - a.mtime);
});

ipcMain.handle("delete-backup-file", async (_event, taskId: string, filePath: string) => {
  // 只允许删除属于该任务的备份目录内的文件，防止任意文件删除
  const task = syncStore.getTasks().find((t) => t.id === taskId);
  if (!task?.backupPath || !resolveInRoot(task.backupPath, filePath)) {
    console.warn("[delete-backup-file] 已拒绝越界路径:", filePath);
    return false;
  }
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return false;
    // 移入废纸篓而非永久删除，提供可恢复性
    await shell.trashItem(filePath);
    return true;
  } catch (err) {
    console.error("[delete-backup-file] 删除失败:", filePath, err);
    return false;
  }
});

ipcMain.handle(
  "delete-file",
  async (
    _event,
    taskId: string,
    filePath: string,
    side: "source" | "target",
  ) => {
    const tasks = syncStore.getTasks();
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return false;

    // 越界校验，防止删除同步根目录之外的文件；并修正为磁盘上真实存在的名字
    const basePath = side === "source" ? task.sourcePath : task.targetPath;
    const relPath = resolveExistingInRoot(basePath, filePath);
    if (!relPath) return false;
    const fullPath = path.join(basePath, relPath);

    // 标记正在手动操作，防止同步引擎干扰
    syncManager.setManualSyncing(taskId, true);

    try {
      if (fs.existsSync(fullPath)) {
        // 移入废纸篓而非永久删除，提供可恢复性
        await shell.trashItem(fullPath);
        logManager.write(taskId, `[手动删除] 已删除${side === "source" ? "源端" : "目标端"}文件: ${relPath}（移入废纸篓）`);
        return true;
      }
      return false;
    } catch (err: any) {
      console.error("删除文件失败:", err);
      logManager.write(taskId, `[错误] 删除文件失败: ${err.message}`);
      return false;
    } finally {
      // 释放标记，并仅对删除的路径做 -path 增量同步，避免全量扫描
      syncManager.setManualSyncing(taskId, false);
      syncManager.requestIncrementalSync(taskId, [relPath]);
    }
  },
);

// ---- 批量操作 IPC（一次 Unison 调用处理多个文件，避免逐文件启动进程） ----

/**
 * 批量校验一组相对路径是否都在根目录内，并修正为磁盘上真实存在的名字。
 * 合法时返回解析后的完整路径数组；任一越界返回 null。
 */
function resolvePathsInRoot(root: string, paths: string[]): string[] | null {
  const resolved: string[] = [];
  for (const p of paths) {
    if (typeof p !== "string") return null;
    const full = resolveInRoot(root, p);
    if (!full) return null;
    resolved.push(full);
  }
  return resolved;
}

/**
 * resolvePathsInRoot 的"修正版"：把每条相对路径替换成该端磁盘上真实存在的名字，
 * 供批量删除 / 批量同步使用（对比结果可能因 NFC/大小写折叠与磁盘字节不同）。
 * 返回 { full, rel } 列表；任一条越界返回 null。
 */
function resolveExistingPathsInRoot(
  root: string,
  paths: string[],
): { full: string; rel: string }[] | null {
  const resolved: { full: string; rel: string }[] = [];
  for (const p of paths) {
    if (typeof p !== "string") return null;
    const rel = resolveExistingInRoot(root, p);
    if (!rel) return null;
    resolved.push({ full: path.join(root, rel), rel });
  }
  return resolved;
}

ipcMain.handle(
  "sync-files",
  async (
    _event,
    taskId: string,
    filePaths: string[],
    direction: "sourceToTarget" | "targetToSource",
  ) => {
    const tasks = syncStore.getTasks();
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return { ok: false };
    if (!Array.isArray(filePaths) || filePaths.length === 0) return { ok: true };

    // 批量越界校验（安全兜底：路径不再逐条传给 unison，但渲染进程传来的仍需校验）
    const base = direction === "sourceToTarget" ? task.sourcePath : task.targetPath;
    if (!resolvePathsInRoot(base, filePaths)) return { ok: false };

    // 标记正在手动同步，防止触发 Unison 冲突
    syncManager.setManualSyncing(taskId, true);
    try {
      const sideLabel = direction === "sourceToTarget" ? "源→目标" : "目标→源";
      logManager.write(
        taskId,
        `[手动同步] 正在以所选端为权威执行全量同步 (${sideLabel})，由 unison 引擎协调差异...`,
      );

      // 以 unison 为唯一权威：不再把 Node 对比的路径列表通过 -path 分批喂给 unison
      // （两者对"什么算差异"的判定不同，可能一致报"无变动"导致空转）。
      // 改为对整棵树跑一次 unison 协调（方向跟随按钮），同步完成后重新扫描，
      // 返回协调后的真实差异供渲染进程刷新显示。
      const ok = await syncManager.runSpecificPathSync(task, undefined, direction);
      if (!ok) return { ok: false }; // 任务被停止/离线/并发中被跳过

      // 同步完成后重新对比，让展示层反映 unison 协调后的真实状态
      const diff = await buildDirDiff(task);
      return { ok: true, diff };
    } catch (err: any) {
      console.error("批量同步失败:", err);
      logManager.write(taskId, `[错误] 批量同步失败: ${err.message}`);
      return { ok: false };
    } finally {
      // 释放手动同步标记，引擎会自动更新状态
      syncManager.setManualSyncing(taskId, false);
    }
  },
);

ipcMain.handle(
  "delete-files",
  async (_event, taskId: string, filePaths: string[], side: "source" | "target") => {
    const tasks = syncStore.getTasks();
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return false;

    const basePath = side === "source" ? task.sourcePath : task.targetPath;
    const resolved = resolveExistingPathsInRoot(basePath, filePaths);
    if (!resolved) return false;

    // 标记正在手动操作，防止同步引擎干扰
    syncManager.setManualSyncing(taskId, true);
    try {
      let deleted = 0;
      for (const { full } of resolved) {
        try {
          if (fs.existsSync(full)) {
            // 移入废纸篓而非永久删除，提供可恢复性
            await shell.trashItem(full);
            deleted++;
          }
        } catch (err) {
          console.error("批量删除单个文件失败:", full, err);
        }
      }
      if (deleted > 0) {
        logManager.write(taskId, `[手动删除] 已批量删除${side === "source" ? "源端" : "目标端"} ${deleted} 个文件（移入废纸篓）`);
      }
      return true;
    } catch (err: any) {
      console.error("批量删除失败:", err);
      logManager.write(taskId, `[错误] 批量删除失败: ${err.message}`);
      return false;
    } finally {
      // 释放标记，并仅对删除的路径做 -path 增量同步，避免全量扫描
      syncManager.setManualSyncing(taskId, false);
      syncManager.requestIncrementalSync(taskId, resolved.map((r) => r.rel));
    }
  },
);

ipcMain.handle("ignore-paths", async (_event, taskId: string, filePaths: string[]) => {
  const tasks = syncStore.getTasks();
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return false;
  if (!Array.isArray(filePaths) || filePaths.length === 0) return true;

  const ignoredPaths = task.ignoredPaths || [];
  let added = 0;
  for (const p of filePaths) {
    if (typeof p === "string" && !ignoredPaths.includes(p)) {
      ignoredPaths.push(p);
      added++;
    }
  }
  if (added > 0) {
    syncStore.updateTask(taskId, { ignoredPaths });
    logManager.write(taskId, `[手动忽略] 已批量忽略 ${added} 个路径`);
  }
  return true;
});

ipcMain.handle(
  "ignore-path",
  async (_event, taskId: string, filePath: string) => {
    const tasks = syncStore.getTasks();
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return false;

    const ignoredPaths = task.ignoredPaths || [];
    if (!ignoredPaths.includes(filePath)) {
      ignoredPaths.push(filePath);
      syncStore.updateTask(taskId, { ignoredPaths });
      logManager.write(taskId, `[手动忽略] 已将文件添加到任务忽略列表: ${filePath}`);
    }
    return true;
  },
);

ipcMain.handle(
  "unignore-path",
  async (_event, taskId: string, filePath: string) => {
    const tasks = syncStore.getTasks();
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return false;

    const ignoredPaths = (task.ignoredPaths || []).filter((p) => p !== filePath);
    syncStore.updateTask(taskId, { ignoredPaths });
    logManager.write(taskId, `[取消忽略] 已将文件从任务忽略列表移除: ${filePath}`);
    return true;
  },
);

/**
 * 计算任务两个目录的差异（Node 全量扫描 + computeDirDiff 比对）。
 * 作为 unison 协调后的展示层：同步动作以 unison 为准，这里负责把文件系统的
 * 真实状态呈现给用户，且判定语义与 unison 对齐（useFat 时路径大小写不敏感，
 * 大小相同 mtime 有差异时比对内容），使"对比差异"与"同步差异"结论一致。
 * compare-directories 与 sync-files（同步后刷新）共用。
 * @param sendProgress 扫描进度回调（每 200 文件触发一次）
 * @param signal 取消信号；abort 后抛出 compare-cancelled
 */
async function buildDirDiff(
  task: SyncTask,
  sendProgress?: (count: number) => void,
  signal?: AbortSignal,
): Promise<DiffResult> {
  // 并行扫描两个目录，并实时向渲染进程报告进度
  const [sourceFiles, targetFiles] = await Promise.all([
    getAllFiles(task.sourcePath, task.sourcePath, { count: 0 }, sendProgress, signal),
    getAllFiles(task.targetPath, task.targetPath, { count: 0 }, sendProgress, signal),
  ]);

  // 折叠冲突（同一侧存在仅 Unicode 编码/大小写不同的重名项）：
  // unison 视为同一文件、重复同步也消不掉，但同步回另一端时会静默覆盖同一目标，
  // 属于真实数据隐患 —— 汇总后写进任务日志，方便用户手工清理。
  const collisions: { side: "source" | "target"; keptPath: string; droppedPath: string }[] = [];

  // foldCase 与 sync-manager 传 -fat 的条件保持一致（useFat 默认开启）
  const diff = await computeDirDiff(sourceFiles, targetFiles, {
    sourceRoot: task.sourcePath,
    targetRoot: task.targetPath,
    ignoredPaths: task.ignoredPaths,
    foldCase: task.useFat !== false,
    signal,
    onFoldedCollision: (info) => collisions.push(info),
  });

  if (collisions.length > 0) {
    const MAX_DETAIL = 5;
    const detail = collisions
      .slice(0, MAX_DETAIL)
      .map((c) => `${c.side === "source" ? "源端" : "目标端"} ${c.droppedPath}（与 ${c.keptPath} 同名）`)
      .join("；");
    logManager.write(
      task.id,
      `[对比] 发现 ${collisions.length} 个仅 Unicode 编码/大小写不同的重名项，unison 视为同一文件、不会同步：${detail}${collisions.length > MAX_DETAIL ? " …" : ""}`,
    );
  }

  return diff;
}

ipcMain.handle("compare-directories", async (event, id: string) => {
  const tasks = syncStore.getTasks();
  const task = tasks.find((t) => t.id === id);
  if (!task) throw new Error("Task not found");

  if (task.status === "syncing") {
    throw new Error("Task is currently syncing. Cannot compare directories.");
  }

  const sendProgress = (count: number) => {
    event.sender.send("compare-progress", { id, count });
  };

  // 支持取消：创建新的 AbortController，渲染进程可通过 cancel-compare 中止本次扫描
  compareController = new AbortController();
  const signal = compareController.signal;

  try {
    return await buildDirDiff(task, sendProgress, signal);
  } catch (err) {
    // 用户取消对比：作为已取消错误抛出，渲染进程据此关闭扫描界面
    if (signal.aborted) {
      console.log("[compare] 用户已取消对比");
      throw new Error("compare-cancelled");
    }
    throw err;
  } finally {
    compareController = null;
  }
});
