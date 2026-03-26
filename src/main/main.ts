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
 * 获取 Unison 二进制文件的路径
 */
export function getUnisonPath(): string {
  if (process.platform !== "darwin") {
    return "unison";
  }

  const arch = process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  
  // 使用 app.getAppPath() 获取应用根目录
  let resourcePath = path.join(app.getAppPath(), "src/resources/bin", arch, "unison");
  
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

/**
 * 创建主窗口
 */
function createWindow() {
  win = new BrowserWindow({
    icon: path.join(process.env.VITE_PUBLIC || "", "assets/logo.png"),
    width: 1000,
    height: 750,
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
});

app.whenReady().then(() => {
  createWindow();
  trayManager.createTray(createWindow);

  // 应用启动后自动执行所有非手动任务
  setTimeout(() => {
    const tasks = syncStore.getTasks();
    tasks.forEach((task) => {
      if (task.mode === "realtime" || task.mode === "scheduled") {
        syncManager.startTask(task);
      }
    });
  }, 1500); // 延迟 1.5 秒启动，确保 UI 和系统资源已就绪
});

// IPC 处理器绑定
ipcMain.handle("get-tasks", () => syncStore.getTasks());

ipcMain.handle("save-task", async (_event, task: SyncTask) => {
  task.sourceStats = await getDirStats(task.sourcePath);
  task.targetStats = await getDirStats(task.targetPath);
  task.sourceDisk = diskManager.getDiskSpace(task.sourcePath) || undefined;
  task.targetDisk = diskManager.getDiskSpace(task.targetPath) || undefined;
  return syncStore.saveTask(task);
});

ipcMain.handle("delete-task", (_event, id: string) => {
  syncManager.stopTask(id);
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

ipcMain.handle("open-log-folder", (_event, id: string) => {
  const dir = logManager.getTaskDir(id);
  shell.openPath(dir);
  return true;
});

ipcMain.handle("compare-directories", async (_event, id: string) => {
  const tasks = syncStore.getTasks();
  const task = tasks.find((t) => t.id === id);
  if (!task) throw new Error("Task not found");

  const sourceFiles = getAllFiles(task.sourcePath);
  const targetFiles = getAllFiles(task.targetPath);

  const diff = {
    sourceOnly: [] as any[],
    targetOnly: [] as any[],
    different: [] as any[],
  };

  sourceFiles.forEach((sInfo, relPath) => {
    const tInfo = targetFiles.get(relPath);
    if (!tInfo) {
      diff.sourceOnly.push({ path: relPath, size: sInfo.size });
    } else if (
      sInfo.size !== tInfo.size ||
      Math.abs(sInfo.mtime - tInfo.mtime) > 1000
    ) {
      diff.different.push({
        path: relPath,
        sourceSize: sInfo.size,
        targetSize: tInfo.size,
        sourceMtime: sInfo.mtime,
        targetMtime: tInfo.mtime,
      });
    }
  });

  targetFiles.forEach((tInfo, relPath) => {
    if (!sourceFiles.has(relPath)) {
      diff.targetOnly.push({ path: relPath, size: tInfo.size });
    }
  });

  return diff;
});
