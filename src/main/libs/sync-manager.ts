import { spawn, ChildProcess } from "node:child_process";
import chokidar from "chokidar";
import { BrowserWindow } from "electron";
import fs from "node:fs";
import { SyncTask } from "./types";
import { syncStore } from "./sync-store";
import { getDirStats } from "./fs-utils";
import { getUnisonPath } from "../main";
import { logManager } from "./logs";

/**
 * 同步管理器类 (SyncManager)
 * 核心：调度 Unison 进程 + 文件监听 + 异常处理
 */
export class SyncManager {
  private activeProcesses: Map<string, ChildProcess> = new Map();
  private watchers: Map<string, chokidar.FSWatcher> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private win: BrowserWindow | null = null;
  private onStatusChange: (() => void) | null = null;

  private isCoolingDown: Map<string, boolean> = new Map();
  private hasPendingSync: Map<string, boolean> = new Map();

  setWindow(win: BrowserWindow) {
    this.win = win;
  }

  setStatusChangeCallback(cb: () => void) {
    this.onStatusChange = cb;
  }

  public getLogs(id: string): string {
    return logManager.get(id);
  }

  public clearLogs(id: string) {
    logManager.clear(id);
  }

  /**
   * 启动任务（增加路径可用性预检）
   */
  startTask(task: SyncTask) {
    this.stopTask(task.id);

    // 预检：检查磁盘是否在线
    if (!fs.existsSync(task.sourcePath) || !fs.existsSync(task.targetPath)) {
      const offlinePath = !fs.existsSync(task.sourcePath) ? "源目录" : "目标目录";
      const errorMsg = `启动失败：${offlinePath} 已离线或路径不可达。`;
      logManager.write(task.id, errorMsg);
      this.win?.webContents.send("sync-log", { id: task.id, log: errorMsg });
      this.updateStatus(task.id, "error");
      return;
    }

    logManager.write(task.id, `=== 任务启动 [模式: ${task.mode}] ===`);
    this.runUnison(task);

    if (task.mode === "realtime") {
      this.setupRealtime(task);
    } else if (task.mode === "scheduled") {
      this.setupScheduled(task);
    }
  }

  /**
   * 停止并清理任务
   */
  stopTask(id: string) {
    this.activeProcesses.get(id)?.kill();
    this.activeProcesses.delete(id);

    this.watchers.get(id)?.close();
    this.watchers.delete(id);

    if (this.timers.has(id)) {
      clearInterval(this.timers.get(id)!);
      this.timers.delete(id);
    }

    if (this.debounceTimers.has(id)) {
      clearTimeout(this.debounceTimers.get(id)!);
      this.debounceTimers.delete(id);
    }

    this.isCoolingDown.delete(id);
    this.hasPendingSync.delete(id);
    this.updateStatus(id, "idle");
  }

  /**
   * 配置实时监听（增加对监听异常的处理）
   */
  private setupRealtime(task: SyncTask) {
    const watcher = chokidar.watch([task.sourcePath, task.targetPath], {
      ignored: [
        /(^|[\/\\])\../,
        "**/node_modules/**",
        "**/.git/**",
        "**/.DS_Store",
        "**/desktop.ini",
        "**/Thumbs.db"
      ],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 },
    });

    watcher.on("all", (event, path) => {
      if (this.isCoolingDown.get(task.id)) return;

      if (this.activeProcesses.has(task.id)) {
        this.hasPendingSync.set(task.id, true);
        return;
      }

      if (this.debounceTimers.has(task.id)) {
        clearTimeout(this.debounceTimers.get(task.id)!);
      }

      const timer = setTimeout(() => {
        // 触发前再次检查路径
        if (!fs.existsSync(task.sourcePath) || !fs.existsSync(task.targetPath)) {
          this.handleOffline(task);
          return;
        }
        this.runUnison(task);
      }, 2000);

      this.debounceTimers.set(task.id, timer);
    });

    // 捕获 chokidar 的错误（如磁盘拔出导致的监听中断）
    watcher.on("error", (error) => {
      console.error(`监听器异常 (${task.name}):`, error);
      this.handleOffline(task);
    });

    this.watchers.set(task.id, watcher);
  }

  /**
   * 处理磁盘离线的情况
   */
  private handleOffline(task: SyncTask) {
    const errorMsg = `同步异常：检测到磁盘已离线或路径不可达，实时监控已挂起。`;
    logManager.write(task.id, errorMsg);
    this.win?.webContents.send("sync-log", { id: task.id, log: errorMsg });
    this.updateStatus(task.id, "error");
    
    // 如果是磁盘拔出，建议停止监听器，避免占用 CPU
    const watcher = this.watchers.get(task.id);
    if (watcher) {
      watcher.close();
      this.watchers.delete(task.id);
    }
  }

  private setupScheduled(task: SyncTask) {
    const intervalMs = (task.interval || 5) * 60 * 1000;
    const timer = setInterval(() => {
      if (!fs.existsSync(task.sourcePath) || !fs.existsSync(task.targetPath)) {
        this.handleOffline(task);
        return;
      }
      this.runUnison(task);
    }, intervalMs);
    this.timers.set(task.id, timer);
  }

  /**
   * 调度 Unison 同步
   */
  private async runUnison(task: SyncTask) {
    if (this.activeProcesses.has(task.id)) return;

    // 最后一次路径校验
    if (!fs.existsSync(task.sourcePath) || !fs.existsSync(task.targetPath)) {
      this.handleOffline(task);
      return;
    }

    this.updateStatus(task.id, "syncing");
    this.hasPendingSync.set(task.id, false);

    const args = [
      task.sourcePath,
      task.targetPath,
      "-batch",
      "-prefer", "newer",
      "-times",
      "-copyonconflict",
      "-ignoreinodenumbers",
      "-fat",
      "-ui", "text",
      "-ignore", "Name {.DS_Store,.git,node_modules,Thumbs.db,desktop.ini,.localized}",
      "-ignore", "Name .unison.*.tmp",
      "-label", task.name,
      "-ignorelocks",
    ];

    if (task.useParallel) args.push("-maxthreads", "10");
    if (task.direction === "sourceToTarget") args.push("-force", task.sourcePath);
    else if (task.direction === "targetToSource") args.push("-force", task.targetPath);

    const unisonPath = getUnisonPath();
    const proc = spawn(unisonPath, args);
    this.activeProcesses.set(task.id, proc);

    proc.on("error", (err: any) => {
      this.activeProcesses.delete(task.id);
      const errorMsg = `同步进程启动失败: ${err.message}`;
      logManager.write(task.id, `错误: ${errorMsg}`);
      this.win?.webContents.send("sync-log", { id: task.id, log: errorMsg });
      this.updateStatus(task.id, "error");
    });

    let outputBuffer = "";
    const flushBuffer = () => {
      if (outputBuffer) {
        logManager.write(task.id, outputBuffer);
        this.win?.webContents.send("sync-log", { id: task.id, log: outputBuffer });
        outputBuffer = "";
      }
    };

    proc.stdout.on("data", (data) => {
      outputBuffer += data.toString();
      if (outputBuffer.length > 1000) flushBuffer();
    });

    proc.on("close", async (code) => {
      flushBuffer();
      this.activeProcesses.delete(task.id);
      
      const status = code === 0 ? "idle" : "error";
      const lastSyncTime = new Date().toLocaleString();
      
      // 只有在线时才尝试统计
      if (fs.existsSync(task.sourcePath) && fs.existsSync(task.targetPath)) {
        getDirStats(task.sourcePath).then(sourceStats => {
          getDirStats(task.targetPath).then(targetStats => {
            syncStore.updateTask(task.id, { status, lastSyncTime, sourceStats, targetStats });
            this.win?.webContents.send("sync-status", { id: task.id, status, lastSyncTime, sourceStats, targetStats });
            this.onStatusChange?.();
          });
        });
      }

      logManager.write(task.id, `=== 同步完成 (退出码: ${code}) ===`);
      this.win?.webContents.send("sync-log", { id: task.id, log: `同步完成 (代码: ${code})` });

      this.isCoolingDown.set(task.id, true);
      setTimeout(() => {
        this.isCoolingDown.set(task.id, false);
        if (this.hasPendingSync.get(task.id)) {
          const tasks = syncStore.getTasks();
          const currentTask = tasks.find(t => t.id === task.id);
          if (currentTask) this.runUnison(currentTask);
        }
      }, 3000);
      
      this.onStatusChange?.();
    });
  }

  private updateStatus(id: string, status: SyncTask["status"]) {
    syncStore.updateTask(id, { status });
    logManager.write(id, `状态更新: ${status}`);
    this.win?.webContents.send("sync-status", { id, status });
    this.onStatusChange?.();
  }
}

export const syncManager = new SyncManager();
