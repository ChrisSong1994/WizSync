import { spawn, ChildProcess } from "node:child_process";
import chokidar from "chokidar";
import { BrowserWindow } from "electron";
import { SyncTask } from "./types";
import { syncStore } from "./sync-store";
import { getDirStats } from "./fs-utils";
import { getUnisonPath } from "../main";

/**
 * 同步管理器类 (SyncManager)
 * 
 * 该类是 WizSync 的核心调度引擎，负责：
 * 1. 管理所有同步任务的生命周期（启动、停止、重启）。
 * 2. 使用 chokidar 监听文件系统变更并触发同步。
 * 3. 调度 Unison 二进制进程执行实际的文件对比与传输。
 * 4. 实现智能队列、防抖和回环保护，确保同步的稳定性和及时性。
 */
export class SyncManager {
  // 正在运行的 Unison 子进程映射表 (key: 任务ID)
  private activeProcesses: Map<string, ChildProcess> = new Map();
  // 活动中的 chokidar 文件监听器映射表 (key: 任务ID)
  private watchers: Map<string, chokidar.FSWatcher> = new Map();
  // 定时任务 (Scheduled) 的计时器映射表
  private timers: Map<string, NodeJS.Timeout> = new Map();
  // 实时任务 (Realtime) 的防抖计时器映射表，用于合并高频变更
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  // Electron 主窗口引用，用于发送 IPC 消息给渲染进程
  private win: BrowserWindow | null = null;
  // 状态变化回调，用于通知 TrayManager 等外部组件刷新 UI
  private onStatusChange: (() => void) | null = null;

  /**
   * 回环保护机制 (Loop Prevention):
   * 当 Unison 正在同步文件时，目标目录的变化会反向触发监听器，导致无限递归。
   * isCoolingDown 用于在同步完成后进入短暂的“冷却期”，期间忽略所有文件变更事件。
   */
  private isCoolingDown: Map<string, boolean> = new Map();

  /**
   * 变更待处理标记 (Pending Sync):
   * 如果 Unison 正在运行期间，用户又修改了文件，我们不能丢弃这个变更。
   * 设置此标记后，当前同步一结束，会立即链式启动下一次同步，确保最终一致性。
   */
  private hasPendingSync: Map<string, boolean> = new Map();

  /**
   * 初始化窗口引用
   */
  setWindow(win: BrowserWindow) {
    this.win = win;
  }

  /**
   * 设置状态变化回调
   */
  setStatusChangeCallback(cb: () => void) {
    this.onStatusChange = cb;
  }

  /**
   * 启动任务
   * 流程：先停止旧任务（如果存在） -> 执行一次全量同步 -> 根据模式开启监听或定时器
   */
  startTask(task: SyncTask) {
    this.stopTask(task.id);
    
    // 启动时先行同步，确保基准一致
    this.runUnison(task);

    if (task.mode === "realtime") {
      this.setupRealtime(task);
    } else if (task.mode === "scheduled") {
      this.setupScheduled(task);
    }
  }

  /**
   * 彻底停止并销毁任务相关的所有资源
   */
  stopTask(id: string) {
    // 杀死正在运行的子进程
    this.activeProcesses.get(id)?.kill();
    this.activeProcesses.delete(id);

    // 关闭文件监听
    this.watchers.get(id)?.close();
    this.watchers.delete(id);

    // 清理所有计时器
    if (this.timers.has(id)) {
      clearInterval(this.timers.get(id)!);
      this.timers.delete(id);
    }

    if (this.debounceTimers.has(id)) {
      clearTimeout(this.debounceTimers.get(id)!);
      this.debounceTimers.delete(id);
    }

    // 重置状态标记
    this.isCoolingDown.delete(id);
    this.hasPendingSync.delete(id);
    this.updateStatus(id, "idle");
  }

  /**
   * 配置实时同步逻辑
   * 核心：chokidar 事件驱动 + 2秒防抖 + 状态保护
   */
  private setupRealtime(task: SyncTask) {
    const watcher = chokidar.watch([task.sourcePath, task.targetPath], {
      ignored: [
        /(^|[\/\\])\../,  // 忽略隐藏文件
        "**/node_modules/**",
        "**/.git/**",
        "**/.DS_Store",
        "**/desktop.ini",
        "**/Thumbs.db"
      ],
      persistent: true,
      ignoreInitial: true,
      // 稳定性检查：文件停止变化 1s 后再触发，防止读取到正在写入的文件
      awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 },
    });

    watcher.on("all", (event, path) => {
      // 1. 如果处于同步完成后的冷却期（3秒内），则忽略此事件
      if (this.isCoolingDown.get(task.id)) return;

      // 2. 如果当前正在同步，则标记有“待处理”的任务，等待当前同步完成后执行
      if (this.activeProcesses.has(task.id)) {
        this.hasPendingSync.set(task.id, true);
        return;
      }

      // 3. 防抖逻辑：2秒内如果连续触发，则重置计时器，合并变更
      if (this.debounceTimers.has(task.id)) {
        clearTimeout(this.debounceTimers.get(task.id)!);
      }

      const timer = setTimeout(() => {
        this.runUnison(task);
      }, 2000);

      this.debounceTimers.set(task.id, timer);
    });

    this.watchers.set(task.id, watcher);
  }

  /**
   * 配置定时同步逻辑
   */
  private setupScheduled(task: SyncTask) {
    const intervalMs = (task.interval || 5) * 60 * 1000;
    const timer = setInterval(() => this.runUnison(task), intervalMs);
    this.timers.set(task.id, timer);
  }

  /**
   * 调度 Unison 核心同步进程
   * 
   * 参数配置说明：
   * -batch: 自动化运行，不要求用户交互
   * -prefer newer: 双向同步冲突时，保留修改时间更新的文件
   * -copyonconflict: 冲突时保留备份
   * -fat: 兼容性配置，处理跨系统（如 Mac 到 FAT 格式优盘）同步时的权限限制
   */
  private async runUnison(task: SyncTask) {
    // 互斥保护：不允许同一个任务并发执行多个 Unison 实例
    if (this.activeProcesses.has(task.id)) return;

    this.updateStatus(task.id, "syncing");
    this.hasPendingSync.set(task.id, false); // 开始同步，重置待处理标记

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

    // 错误处理：通常是路径权限或二进制文件缺失
    proc.on("error", (err: any) => {
      this.activeProcesses.delete(task.id);
      this.win?.webContents.send("sync-log", { id: task.id, log: `错误: ${err.message}` });
      this.updateStatus(task.id, "error");
    });

    // 汇总输出，通过 Buffer 减少 IPC 通信开销
    let outputBuffer = "";
    const flushBuffer = () => {
      if (outputBuffer) {
        this.win?.webContents.send("sync-log", { id: task.id, log: outputBuffer });
        outputBuffer = "";
      }
    };

    proc.stdout.on("data", (data) => {
      outputBuffer += data.toString();
      if (outputBuffer.length > 1000) flushBuffer();
    });

    // 进程结束逻辑
    proc.on("close", async (code) => {
      flushBuffer();
      this.activeProcesses.delete(task.id);
      
      const status = code === 0 ? "idle" : "error";
      const lastSyncTime = new Date().toLocaleString();
      
      // 异步更新目录统计信息（大小、文件数），完成后再持久化到 Store
      getDirStats(task.sourcePath).then(sourceStats => {
        getDirStats(task.targetPath).then(targetStats => {
          syncStore.updateTask(task.id, { status, lastSyncTime, sourceStats, targetStats });
          this.win?.webContents.send("sync-status", { id: task.id, status, lastSyncTime, sourceStats, targetStats });
          this.onStatusChange?.();
        });
      });

      this.win?.webContents.send("sync-log", { id: task.id, log: `同步完成 (代码: ${code})` });

      /**
       * 后置链式调度逻辑：
       * 1. 启动 3 秒冷却期，忽略这段时间内由同步操作引起的文件变更（回环防止）。
       * 2. 冷却结束后，检查在此期间是否有积压的变更 (hasPendingSync)，如果有，则立即启动新一轮同步。
       */
      this.isCoolingDown.set(task.id, true);
      setTimeout(() => {
        this.isCoolingDown.set(task.id, false);
        if (this.hasPendingSync.get(task.id)) {
          // 重新获取最新的任务配置进行同步
          const tasks = syncStore.getTasks();
          const currentTask = tasks.find(t => t.id === task.id);
          if (currentTask) this.runUnison(currentTask);
        }
      }, 3000);
      
      this.onStatusChange?.();
    });
  }

  /**
   * 状态统一更新方法
   */
  private updateStatus(id: string, status: SyncTask["status"]) {
    syncStore.updateTask(id, { status });
    this.win?.webContents.send("sync-status", { id, status });
    this.onStatusChange?.();
  }
}

export const syncManager = new SyncManager();
