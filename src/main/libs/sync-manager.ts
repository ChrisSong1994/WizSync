import { spawn, ChildProcess } from "node:child_process";
import chokidar from "chokidar";
import { BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { SyncTask } from "./types";
import { syncStore } from "./sync-store";
import { getDirStats } from "./fs-utils";
import { diskManager } from "./disk";
import { getUnisonPath, getBinDir } from "../main";
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
  private isManualSyncing: Map<string, boolean> = new Map();
  private resetDebounceTimers: Map<string, NodeJS.Timeout> = new Map();

  /**
   * 请求重置任务（带防抖，适用于批量手动操作后只重置一次）
   */
  public requestReset(id: string) {
    if (this.resetDebounceTimers.has(id)) {
      clearTimeout(this.resetDebounceTimers.get(id)!);
    }

    const timer = setTimeout(async () => {
      const tasks = syncStore.getTasks();
      const task = tasks.find((t) => t.id === id);
      if (task) {
        logManager.write(id, "[自动重置] 手动操作已完成，正在刷新引擎状态...");
        await this.resetTask(task);
      }
      this.resetDebounceTimers.delete(id);
    }, 1500);

    this.resetDebounceTimers.set(id, timer);
  }

  /**
   * 立即刷新任务统计信息
   */
  public async refreshStats(id: string) {
    const tasks = syncStore.getTasks();
    const task = tasks.find((t) => t.id === id);
    if (task) {
      await this.refreshTaskStats(id, task.status);
    }
  }

  /**
   * 设置任务的手动同步状态
   */
  public setManualSyncing(id: string, syncing: boolean) {
    if (syncing) {
      this.isManualSyncing.set(id, true);
    } else {
      this.isManualSyncing.delete(id);
    }
  }

  /**
   * 检查任务是否正在进行手动同步
   */
  public isTaskManualSyncing(id: string): boolean {
    return !!this.isManualSyncing.get(id);
  }

  /**
   * 设置主窗口引用并初始化相关组件
   */
  setWindow(win: BrowserWindow) {
    this.win = win;
    // 窗口就绪后初始化磁盘监控
    diskManager.init(
      win,
      () => this.onStatusChange?.(),
      (taskId) => {
        const tasks = syncStore.getTasks();
        const task = tasks.find((t) => t.id === taskId);
        if (task && (task.mode === "realtime" || task.mode === "scheduled")) {
          this.startTask(task);
        }
      },
      (taskId, side) => {
        this.handleDiskDisconnected(taskId, side);
      },
    );
  }

  setStatusChangeCallback(cb: () => void) {
    this.onStatusChange = cb;
  }

  /**
   * 处理磁盘断开连接
   */
  private handleDiskDisconnected(
    taskId: string,
    side: "source" | "target" | "both",
  ) {
    const tasks = syncStore.getTasks();
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;

    // 停止任务
    this.stopTask(taskId);

    // 更新状态为暂停
    this.updateStatus(taskId, "paused");

    // 记录日志
    const sideText =
      side === "source" ? "源端" : side === "target" ? "目标端" : "两端";
    logManager.write(
      taskId,
      `[磁盘断开] ${sideText}磁盘已断开连接，任务已暂停`,
    );

    // 发送通知到前端
    this.win?.webContents.send("sync-log", {
      id: taskId,
      log: `警告: ${sideText}磁盘已断开连接，任务已暂停`,
    });
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

  /**
   * 重置任务：强制清理 Unison 缓存并重新启动同步
   */
  public async resetTask(task: SyncTask) {
    this.stopTask(task.id);
    logManager.write(task.id, "=== 强制重置同步缓存 (Archive) ===");

    // 强制等待 1 秒让磁盘句柄释放
    await new Promise((resolve) => setTimeout(resolve, 1000));

    await this.cleanUnisonArchives(task);
    logManager.write(task.id, "缓存清理完成，正在重新初始化同步...");

    this.startTask(task);
  }

  private cleanUnisonArchives(task: SyncTask): Promise<void> {
    return new Promise((resolve) => {
      const unisonPath = getUnisonPath();
      const proc = spawn(unisonPath, [
        "-showarchive",
        task.sourcePath,
        task.targetPath,
      ]);
      let output = "";

      // 5 秒超时，防止进程挂死
      const timer = setTimeout(() => {
        proc.kill();
        resolve();
      }, 5000);

      proc.stdout.on("data", (data) => {
        output += data.toString();
      });
      proc.stderr.on("data", (data) => {
        output += data.toString();
      });

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

      proc.on("error", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * 启动任务
   */
  startTask(task: SyncTask) {
    this.stopTask(task.id);

    if (!fs.existsSync(task.sourcePath) || !fs.existsSync(task.targetPath)) {
      const offlinePath = !fs.existsSync(task.sourcePath)
        ? "源目录"
        : "目标目录";
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
    const storedTask = syncStore.getTasks().find((t) => t.id === id);
    if (storedTask?.pid) {
      try {
        process.kill(storedTask.pid);
      } catch {}
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
        /(^|[/\\])\../, // 所有隐藏文件和目录（以 . 开头）
        "**/node_modules/**",
        "**/desktop.ini",
        "**/Thumbs.db",
      ],
      persistent: true,
      ignoreInitial: true,
      // 降低或移除 awaitWriteFinish，依靠下方的 debounceTimers (2000ms) 来确保写入完成
      awaitWriteFinish: false,
    });

    watcher.on("all", (event, path) => {
      const isTargetEvent = path.startsWith(task.targetPath);
      logManager.write(
        task.id,
        `[监听] 发现${isTargetEvent ? "目标端" : "源端"}变更: ${event} -> ${path}`,
      );

      // 如果是单向同步且变更发生在目标端，给出警告提示
      if (
        isTargetEvent &&
        task.direction === "sourceToTarget" &&
        (event === "add" || event === "addDir")
      ) {
        logManager.write(
          task.id,
          `[提示] 检测到目标端新增文件。由于当前是"源→目标"单向同步，该文件可能会被同步引擎移除。`,
        );
      }

      // 不再依赖 Unison 内部监听模式 (-repeat watch)，而是统一通过 Chokidar 触发
      if (
        this.isCoolingDown.get(task.id) ||
        this.activeProcesses.has(task.id) ||
        this.isTaskManualSyncing(task.id)
      ) {
        if (!this.isTaskManualSyncing(task.id)) {
          this.hasPendingSync.set(task.id, true);
        }
        return;
      }

      if (this.debounceTimers.has(task.id)) {
        clearTimeout(this.debounceTimers.get(task.id)!);
      }

      // 防抖触发同步，等待文件写入稳定
      const timer = setTimeout(() => {
        if (
          !fs.existsSync(task.sourcePath) ||
          !fs.existsSync(task.targetPath)
        ) {
          this.handleOffline(task);
          return;
        }
        this.runUnison(task);
      }, 1000);

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
      "-copyonconflict",
      "-ignoreinodenumbers",
      "-fat",
      "-dontchmod",
      "-perms",
      "0",
      "-owner=false",
      "-group=false",
      "-xferbycopying",
      "-fastcheck=true",
      "-ui",
      "text",
      "-ignore",
      "Name .DS_Store",
      "-ignore",
      "Name .*",
      "-ignore",
      "Name node_modules",
      "-ignore",
      "Name Thumbs.db",
      "-ignore",
      "Name desktop.ini",
      "-label",
      task.name,
      "-ignorelocks",
      "-retry",
      "3",
    ];

    // 不再使用 -repeat watch，因为改用 Chokidar 外部触发

    // 根据同步方向优化策略
    if (task.direction === "sourceToTarget") {
      args.push("-prefer", task.sourcePath);
      args.push("-force", task.sourcePath);
      // 一向同步时，对目标端的变动不敏感，防止 "Destination updated" 报错
      args.push("-times=false");
    } else if (task.direction === "targetToSource") {
      args.push("-prefer", task.targetPath);
      args.push("-force", task.targetPath);
      args.push("-times=false");
    } else {
      // 双向同步：以最新修改为准，需保持时间戳同步以识别变动
      args.push("-prefer", "newer");
      args.push("-times");
    }

    // 添加备份配置
    if (task.backupPath) {
      try {
        if (!fs.existsSync(task.backupPath)) {
          fs.mkdirSync(task.backupPath, { recursive: true });
        }
        args.push("-backup", "Name *");
        args.push("-backuplocation", "central");
        args.push("-backupdir", task.backupPath);
        args.push("-backupprefix", "bak.$VERSION.");
      } catch (err) {
        console.error("创建备份目录失败:", err);
      }
    }

    // 添加任务自定义忽略路径
    if (task.ignoredPaths && task.ignoredPaths.length > 0) {
      task.ignoredPaths.forEach((p) => {
        args.push("-ignore", `Path ${p}`);
      });
    }

    if (task.useParallel) args.push("-maxthreads", "10");
    args.push(task.sourcePath);
    args.push(task.targetPath);

    if (task.direction === "sourceToTarget")
      args.push("-force", task.sourcePath);
    else if (task.direction === "targetToSource")
      args.push("-force", task.targetPath);

    const unisonPath = getUnisonPath();
    const binDir = getBinDir();

    const proc = spawn(unisonPath, args, {
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      },
    });
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
        this.win?.webContents.send("sync-log", {
          id: task.id,
          log: outputBuffer,
        });
        outputBuffer = "";
      }
    };

    const checkRetryNeeded = (text: string) => {
      const retryPatterns = [
        "Destination updated during synchronization",
        "Synchronization incomplete",
        "Failed to copy file",
        "Error in copying",
        "connection lost",
        "fatal error",
        "lost connection",
        "is being used by another process",
      ];
      if (retryPatterns.some((p) => text.includes(p))) {
        needsRetry = true;
      }
    };

    proc.stdout.on("data", (data) => {
      const chunk: string = data.toString();
      outputBuffer += chunk;
      checkRetryNeeded(chunk);
      if (outputBuffer.length > 2000) flushBuffer();
    });

    proc.stderr.on("data", (data) => {
      const errorMsg: string = data.toString();
      checkRetryNeeded(errorMsg);
      logManager.write(task.id, `[stderr] ${errorMsg}`);
      this.win?.webContents.send("sync-log", {
        id: task.id,
        log: `警告: ${errorMsg}`,
      });
    });

    proc.on("close", async (code) => {
      flushBuffer();
      this.activeProcesses.delete(task.id);
      syncStore.updateTask(task.id, { pid: undefined });

      if (code !== 0 && needsRetry) {
        const msg = `[自动重试] 同步遇到异常 (代码: ${code})，5 秒后尝试重新连接同步...`;
        logManager.write(task.id, msg);
        this.win?.webContents.send("sync-log", { id: task.id, log: msg });
        setTimeout(() => {
          const tasks = syncStore.getTasks();
          const currentTask = tasks.find((t) => t.id === task.id);
          if (currentTask) this.runUnison(currentTask);
        }, 5000);
        return;
      }

      const status = code === 0 ? "idle" : "error";
      await this.refreshTaskStats(task.id, status);

      logManager.write(task.id, `同步结束 (代码: ${code})`);

      this.isCoolingDown.set(task.id, true);
      setTimeout(() => {
        this.isCoolingDown.set(task.id, false);
        if (this.hasPendingSync.get(task.id)) {
          const tasks = syncStore.getTasks();
          const currentTask = tasks.find((t) => t.id === task.id);
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

  /**
   * 刷新任务统计信息（文件数、大小、磁盘空间、最后同步时间）
   */
  private async refreshTaskStats(id: string, status: SyncTask["status"]) {
    const tasks = syncStore.getTasks();
    const task = tasks.find((t) => t.id === id);
    if (!task) return;

    const lastSyncTime = new Date().toLocaleString();

    if (fs.existsSync(task.sourcePath) && fs.existsSync(task.targetPath)) {
      const [sourceStats, targetStats] = await Promise.all([
        getDirStats(task.sourcePath),
        getDirStats(task.targetPath),
      ]);

      const sourceDisk = diskManager.getDiskSpace(task.sourcePath) || undefined;
      const targetDisk = diskManager.getDiskSpace(task.targetPath) || undefined;

      syncStore.updateTask(id, {
        status,
        lastSyncTime,
        sourceStats,
        targetStats,
        sourceDisk,
        targetDisk,
      });

      this.win?.webContents.send("sync-status", {
        id,
        status,
        lastSyncTime,
        sourceStats,
        targetStats,
        sourceDisk,
        targetDisk,
      });
    } else {
      this.updateStatus(id, status);
    }
  }
}

export const syncManager = new SyncManager();
