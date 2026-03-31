import { spawn, ChildProcess } from "node:child_process";
import chokidar from "chokidar";
import { BrowserWindow } from "electron";
import fs from "node:fs";
import { SyncTask } from "./types";
import { syncStore } from "./sync-store";
import { getDirStats } from "./fs-utils";
import { diskManager } from "./disk";
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

  /**
   * 设置主窗口引用并初始化相关组件
   */
  setWindow(win: BrowserWindow) {
    this.win = win;
    // 窗口就绪后初始化磁盘监控
    diskManager.init(win, () => this.onStatusChange?.());
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
   * 删除任务：停止进程+监听，archive 清理异步后台执行不阻塞
   */
  deleteTask(task: SyncTask) {
    this.stopTask(task.id);
    this.cleanUnisonArchives(task).catch(() => {});
  }

  private cleanUnisonArchives(task: SyncTask): Promise<void> {
    return new Promise((resolve) => {
      const unisonPath = getUnisonPath();
      const proc = spawn(unisonPath, ["-showarchive", task.sourcePath, task.targetPath]);
      let output = "";

      // 5 秒超时，防止进程挂死
      const timer = setTimeout(() => { proc.kill(); resolve(); }, 5000);

      proc.stdout.on("data", (data) => { output += data.toString(); });
      proc.stderr.on("data", (data) => { output += data.toString(); });

      proc.on("close", () => {
        clearTimeout(timer);
        const matches = [...output.matchAll(/[Aa]rchive\s+file[^:]*:\s*(.+)/g)];
        for (const match of matches) {
          const archivePath = match[1].trim();
          try {
            if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
          } catch {}
        }
        resolve();
      });

      proc.on("error", () => { clearTimeout(timer); resolve(); });
    });
  }

  /**
   * 启动任务
   */
  startTask(task: SyncTask) {
    this.stopTask(task.id);

    if (!fs.existsSync(task.sourcePath) || !fs.existsSync(task.targetPath)) {
      const offlinePath = !fs.existsSync(task.sourcePath) ? "源目录" : "目标目录";
      const errorMsg = `启动失败：${offlinePath} 已离线。`;
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

    // PID fallback: kill by stored PID in case activeProcesses map was lost (e.g., after restart)
    const storedTask = syncStore.getTasks().find(t => t.id === id);
    if (storedTask?.pid) {
      try { process.kill(storedTask.pid); } catch {}
      syncStore.updateTask(id, { pid: undefined });
    }

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
   * 配置实时监听
   */
  private setupRealtime(task: SyncTask) {
    const watcher = chokidar.watch([task.sourcePath, task.targetPath], {
      ignored: [
        /(^|[/\\])\../,   // 所有隐藏文件和目录（以 . 开头）
        "**/node_modules/**",
        "**/desktop.ini",
        "**/Thumbs.db"
      ],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { 
        stabilityThreshold: 2000,
        pollInterval: 200 
      },
    });

    watcher.on("all", (event, path) => {
      if (this.isCoolingDown.get(task.id) || this.activeProcesses.has(task.id)) {
        this.hasPendingSync.set(task.id, true);
        return;
      }

      if (this.debounceTimers.has(task.id)) {
        clearTimeout(this.debounceTimers.get(task.id)!);
      }

      const timer = setTimeout(() => {
        if (!fs.existsSync(task.sourcePath) || !fs.existsSync(task.targetPath)) {
          this.handleOffline(task);
          return;
        }
        this.runUnison(task);
      }, 1500);

      this.debounceTimers.set(task.id, timer);
    });

    watcher.on("error", (error) => {
      console.error(`[Watcher Error] ${task.name}:`, error);
      this.handleOffline(task);
    });

    this.watchers.set(task.id, watcher);
  }

  private handleOffline(task: SyncTask) {
    const errorMsg = `同步挂起：检测到磁盘离线或路径失效。`;
    logManager.write(task.id, errorMsg);
    this.win?.webContents.send("sync-log", { id: task.id, log: errorMsg });
    this.updateStatus(task.id, "error");
    
    this.watchers.get(task.id)?.close();
    this.watchers.delete(task.id);
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
   * 执行 Unison 同步
   */
  private async runUnison(task: SyncTask) {
    if (this.activeProcesses.has(task.id)) return;

    if (!fs.existsSync(task.sourcePath) || !fs.existsSync(task.targetPath)) {
      this.handleOffline(task);
      return;
    }

    this.updateStatus(task.id, "syncing");
    this.hasPendingSync.set(task.id, false); 

    const args = [
      "-batch",
      "-terse", 
      "-prefer", "newer",
      "-times",
      "-copyonconflict",
      "-ignoreinodenumbers",
      "-fat",
      "-dontchmod",
      "-perms", "0",
      "-owner=false",
      "-group=false",
      "-xferbycopying",
      "-fastcheck=true",
      "-ui", "text",
      "-ignore", "Name .*",
      "-ignore", "Name node_modules",
      "-ignore", "Name Thumbs.db",
      "-ignore", "Name desktop.ini",
      "-label", task.name,
      "-ignorelocks",
    ];

    // 添加备份配置
    if (task.backupPath) {
      try {
        if (!fs.existsSync(task.backupPath)) {
          fs.mkdirSync(task.backupPath, { recursive: true });
        }
        args.push("-backup", "Name *");
        args.push("-backuplocation", "central");
        args.push("-backupdir", task.backupPath);
      } catch (err) {
        console.error("创建备份目录失败:", err);
      }
    }

    // 添加任务自定义忽略路径
    if (task.ignoredPaths && task.ignoredPaths.length > 0) {
      task.ignoredPaths.forEach(p => {
        args.push("-ignore", `Path ${p}`);
      });
    }

    if (task.useParallel) args.push("-maxthreads", "10");
    args.push(task.sourcePath);
    args.push(task.targetPath);

    if (task.direction === "sourceToTarget") args.push("-force", task.sourcePath);
    else if (task.direction === "targetToSource") args.push("-force", task.targetPath);

    const unisonPath = getUnisonPath();
    const proc = spawn(unisonPath, args);
    this.activeProcesses.set(task.id, proc);

    // 记录 pid 到任务数据
    if (proc.pid) {
      syncStore.updateTask(task.id, { pid: proc.pid });
      logManager.write(task.id, `[进程] PID: ${proc.pid}`);
    }

    proc.on("error", (err: any) => {
      this.activeProcesses.delete(task.id);
      syncStore.updateTask(task.id, { pid: undefined });
      logManager.write(task.id, `启动失败: ${err.message}`);
      this.updateStatus(task.id, "error");
    });

    let outputBuffer = "";
    let needsRetry = false;

    const flushBuffer = () => {
      if (outputBuffer) {
        logManager.write(task.id, outputBuffer);
        this.win?.webContents.send("sync-log", { id: task.id, log: outputBuffer });
        outputBuffer = "";
      }
    };

    proc.stdout.on("data", (data) => {
      const chunk: string = data.toString();
      outputBuffer += chunk;
      if (chunk.includes("Destination updated during synchronization") ||
          chunk.includes("Synchronization incomplete")) {
        needsRetry = true;
      }
      if (outputBuffer.length > 2000) flushBuffer();
    });

    proc.stderr.on("data", (data) => {
      const errorMsg: string = data.toString();
      if (errorMsg.includes("Destination updated during synchronization") ||
          errorMsg.includes("Synchronization incomplete")) {
        needsRetry = true;
      }
      logManager.write(task.id, `[stderr] ${errorMsg}`);
      this.win?.webContents.send("sync-log", { id: task.id, log: `警告: ${errorMsg}` });
    });

    proc.on("close", async (code) => {
      flushBuffer();
      this.activeProcesses.delete(task.id);
      syncStore.updateTask(task.id, { pid: undefined });

      if (code !== 0 && needsRetry) {
        const msg = "[自动重试] 同步中断，3 秒后重新同步...";
        logManager.write(task.id, msg);
        this.win?.webContents.send("sync-log", { id: task.id, log: msg });
        setTimeout(() => {
          const tasks = syncStore.getTasks();
          const currentTask = tasks.find(t => t.id === task.id);
          if (currentTask) this.runUnison(currentTask);
        }, 3000);
        return;
      }
      
      const status = code === 0 ? "idle" : "error";
      const lastSyncTime = new Date().toLocaleString();
      
      if (fs.existsSync(task.sourcePath) && fs.existsSync(task.targetPath)) {
        Promise.all([
          getDirStats(task.sourcePath),
          getDirStats(task.targetPath)
        ]).then(([sourceStats, targetStats]) => {
          const sourceDisk = diskManager.getDiskSpace(task.sourcePath) || undefined;
          const targetDisk = diskManager.getDiskSpace(task.targetPath) || undefined;

          syncStore.updateTask(task.id, { 
            status, 
            lastSyncTime, 
            sourceStats, 
            targetStats,
            sourceDisk,
            targetDisk
          });
          
          this.win?.webContents.send("sync-status", { 
            id: task.id, 
            status, 
            lastSyncTime, 
            sourceStats, 
            targetStats,
            sourceDisk,
            targetDisk
          });
        });
      }

      logManager.write(task.id, `同步结束 (代码: ${code})`);

      this.isCoolingDown.set(task.id, true);
      setTimeout(() => {
        this.isCoolingDown.set(task.id, false);
        if (this.hasPendingSync.get(task.id)) {
          const tasks = syncStore.getTasks();
          const currentTask = tasks.find(t => t.id === task.id);
          if (currentTask) {
            logManager.write(task.id, "检测到冷却期内的变更，正在追加同步...");
            this.runUnison(currentTask);
          }
        }
      }, 2000);
      
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
