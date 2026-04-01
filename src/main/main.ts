import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { syncStore } from "./libs/sync-store";
import { syncManager } from "./libs/sync-manager";
import { logManager } from "./libs/logs";
import { TrayManager } from "./libs/tray";
import { getDirStats, getAllFiles, IGNORE_PATTERNS } from "./libs/fs-utils";
import { diskManager } from "./libs/disk";
import { SyncTask } from "./libs/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(__dirname, "..");

// 修复 macOS 生产环境下的 PATH 变量
if (process.platform === "darwin") {
  process.env.PATH = `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin:/opt/local/bin`;
}

process.env.APP_ROOT = APP_ROOT;

/**
 * 获取二进制文件所在目录
 */
export function getBinDir(): string {
  const arch = process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  let binDir = path.join(app.getAppPath(), "src/resources/bin", arch);

  if (binDir.includes("app.asar")) {
    binDir = binDir.replace("app.asar", "app.asar.unpacked");
  }
  return binDir;
}

/**
 * 获取 Unison 二进制文件的路径
 */
export function getUnisonPath(): string {
  if (process.platform !== "darwin") {
    return "unison";
  }

  const binDir = getBinDir();
  const resourcePath = path.join(binDir, "unison");
  const monitorPath = path.join(binDir, "unison-fsmonitor");

  // 确保二进制文件具有可执行权限
  const fixPerms = (p: string) => {
    try {
      if (fs.existsSync(p)) {
        const stats = fs.statSync(p);
        if (!(stats.mode & 0o111)) {
          fs.chmodSync(p, 0o755);
        }
      }
    } catch (err) {
      console.error(`修复权限失败: ${p}`, err);
    }
  };

  fixPerms(resourcePath);
  fixPerms(monitorPath);

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

app.on("before-quit", () => {
  isQuitting = true;
  const tasks = syncStore.getTasks();
  tasks.forEach((task) => syncManager.stopTask(task.id));
});

app.whenReady().then(() => {
  createWindow();
  trayManager.createTray(createWindow);

  // 应用启动后自动执行所有非手动任务
  setTimeout(() => {
    const tasks = syncStore.getTasks();

    // 清理 30 天前的备份文件（递归，跳过隐藏文件）
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const cleanOldBackups = (dir: string) => {
      try {
        fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            cleanOldBackups(fullPath);
          } else if (entry.isFile()) {
            const mtime = fs.statSync(fullPath).mtimeMs;
            if (now - mtime > THIRTY_DAYS) fs.unlinkSync(fullPath);
          }
        });
      } catch {}
    };
    tasks.forEach((task) => {
      if (!task.backupPath || !fs.existsSync(task.backupPath)) return;
      cleanOldBackups(task.backupPath);
    });

    tasks.forEach((task) => {
      if (task.mode === "realtime" || task.mode === "scheduled") {
        syncManager.startTask(task);
      }
    });
  }, 1500); // 延迟 1.5 秒启动，确保 UI 和系统资源已就绪
});

// IPC 处理器绑定
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
  return path.join(app.getPath("userData"), "backups", taskId);
});

ipcMain.handle("save-task", async (_event, task: SyncTask) => {
  if (!task.backupPath) {
    task.backupPath = path.join(app.getPath("userData"), "backups", task.id);
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

    // 标记正在手动同步，防止 Chokidar 触发 Unison 冲突
    syncManager.setManualSyncing(taskId, true);

    const src =
      direction === "sourceToTarget"
        ? path.join(task.sourcePath, filePath)
        : path.join(task.targetPath, filePath);

    const dest =
      direction === "sourceToTarget"
        ? path.join(task.targetPath, filePath)
        : path.join(task.sourcePath, filePath);

    try {
      const destDir = path.dirname(dest);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      
      // 执行文件复制
      fs.copyFileSync(src, dest);
      
      // 关键：复制源文件的访问时间和修改时间，确保对比逻辑一致
      const stats = fs.statSync(src);
      fs.utimesSync(dest, stats.atime, stats.mtime);
      
      logManager.write(
        taskId,
        `[手动同步] 已同步并保留时间戳: ${filePath} (${direction === "sourceToTarget" ? "源→目标" : "目标→源"})`,
      );
      return true;
    } catch (err: any) {
      console.error("单文件同步失败:", err);
      logManager.write(taskId, `[错误] 单文件同步失败: ${err.message}`);
      return false;
    } finally {
      // 释放手动同步标记并请求延迟重置
      syncManager.setManualSyncing(taskId, false);
      syncManager.requestReset(taskId);
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
    const fullPath = path.join(basePath, filePath);

    if (fs.existsSync(fullPath)) {
      shell.showItemInFolder(fullPath);
      return true;
    }
    return false;
  },
);

ipcMain.handle("reveal-backup-file", (_event, filePath: string) => {
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

ipcMain.handle("open-backup-folder", (_event, id: string) => {
  const tasks = syncStore.getTasks();
  const task = tasks.find((t) => t.id === id);
  const backupPath = task?.backupPath || path.join(app.getPath("userData"), "backups", id);
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

  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
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
          if (now - stats.mtimeMs < THIRTY_DAYS) {
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

ipcMain.handle("delete-backup-file", (_event, filePath: string) => {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return false;
    fs.unlinkSync(filePath);
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

    // 标记正在手动操作，防止同步引擎干扰
    syncManager.setManualSyncing(taskId, true);

    const basePath = side === "source" ? task.sourcePath : task.targetPath;
    const fullPath = path.join(basePath, filePath);

    try {
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        logManager.write(taskId, `[手动删除] 已删除${side === "source" ? "源端" : "目标端"}文件: ${filePath}`);
        return true;
      }
      return false;
    } catch (err: any) {
      console.error("删除文件失败:", err);
      logManager.write(taskId, `[错误] 删除文件失败: ${err.message}`);
      return false;
    } finally {
      // 释放标记并请求延迟重置
      syncManager.setManualSyncing(taskId, false);
      syncManager.requestReset(taskId);
    }
  },
);

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

ipcMain.handle("compare-directories", async (event, id: string) => {
  const tasks = syncStore.getTasks();
  const task = tasks.find((t) => t.id === id);
  if (!task) throw new Error("Task not found");

  const sendProgress = (count: number) => {
    event.sender.send("compare-progress", { id, count });
  };

  // 并行扫描两个目录，并实时向渲染进程报告进度
  const [sourceFiles, targetFiles] = await Promise.all([
    getAllFiles(task.sourcePath, task.sourcePath, { count: 0 }, sendProgress),
    getAllFiles(task.targetPath, task.targetPath, { count: 0 }, sendProgress),
  ]);

  const ignoredPaths = task.ignoredPaths || [];
  const isIgnored = (relPath: string) => {
    return ignoredPaths.some(p => relPath === p || relPath.startsWith(p + path.sep));
  };

  const diff = {
    sourceOnly: [] as any[],
    targetOnly: [] as any[],
    different: [] as any[],
    ignored: [] as any[],
  };

  let processedCount = 0;
  for (const [relPath, sInfo] of sourceFiles) {
    if (isIgnored(relPath)) {
      diff.ignored.push({ path: relPath, size: sInfo.size, side: targetFiles.has(relPath) ? 'both' : 'source' });
      continue;
    }

    const tInfo = targetFiles.get(relPath);
    if (!tInfo) {
      diff.sourceOnly.push({ path: relPath, size: sInfo.size });
    } else if (
      sInfo.size !== tInfo.size ||
      Math.abs(sInfo.mtime - tInfo.mtime) > 2000
    ) {
      diff.different.push({
        path: relPath,
        sourceSize: sInfo.size,
        targetSize: tInfo.size,
        sourceMtime: sInfo.mtime,
        targetMtime: tInfo.mtime,
      });
    }

    processedCount++;
    if (processedCount % 500 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  for (const [relPath, tInfo] of targetFiles) {
    if (sourceFiles.has(relPath)) continue;
    
    if (isIgnored(relPath)) {
      diff.ignored.push({ path: relPath, size: tInfo.size, side: 'target' });
      continue;
    }
    
    diff.targetOnly.push({ path: relPath, size: tInfo.size });
  }

  return diff;
});
