import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncStore } from "./libs/sync-store";
import { syncManager } from "./libs/sync-manager";
import { TrayManager } from "./libs/tray";
import { getDirStats, getAllFiles } from "./libs/fs-utils";
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
  
  if (app.isPackaged) {
    // 打包后的应用，二进制文件位于 resources 目录
    return path.join(process.resourcesPath, "src/resources/bin", arch, "unison");
  } else {
    // 开发环境下
    return path.join(APP_ROOT, "src/resources/bin", arch, "unison");
  }
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
});

// IPC 处理器绑定
ipcMain.handle("get-tasks", () => syncStore.getTasks());

ipcMain.handle("save-task", async (_event, task: SyncTask) => {
  task.sourceStats = await getDirStats(task.sourcePath);
  task.targetStats = await getDirStats(task.targetPath);
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
