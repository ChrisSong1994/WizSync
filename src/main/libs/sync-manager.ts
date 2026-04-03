import { spawn, ChildProcess } from "node:child_process";
import { BrowserWindow, app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { SyncTask } from "./types";
import { syncStore } from "./sync-store";
import { getDirStats } from "./fs-utils";
import { diskManager } from "./disk";
import { getUnisonPath } from "../main";
import { logManager } from "./logs";

/**
 * 同步管理器类 (SyncManager)
 * 核心：调度 Unison 进程 + 定时检查 + 异常处理
 */
export class SyncManager {
  private activeProcesses: Map<string, ChildProcess> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private win: BrowserWindow | null = null;
  private onStatusChange: (() => void) | null = null;

  private isManualSyncing: Map<string, boolean> = new Map();
  private resetDebounceTimers: Map<string, NodeJS.Timeout> = new Map();

  /**
   * 获取任务在应用数据目录下的专用文件夹
   */
  private getTaskDataDir(taskId: string): string {
    const baseDir = path.join(app.getPath("userData"), "task-data", taskId);
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }
    return baseDir;
  }

  /**
   * 请求增量同步（带防抖，适用于批量手动操作后只触发一次增量扫描）
   */
  public requestIncrementalSync(id: string) {
    if (this.resetDebounceTimers.has(id)) {
      clearTimeout(this.resetDebounceTimers.get(id)!);
    }

    const timer = setTimeout(async () => {
      const tasks = syncStore.getTasks();
      const task = tasks.find(t => t.id === id);
      if (task) {
        logManager.write(id, "[自动同步] 手动操作已完成，正在执行增量扫描...");
        this.startTask(task);
      }
      this.resetDebounceTimers.delete(id);
    }, 1500);

    this.resetDebounceTimers.set(id, timer);
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
    // 窗口就绪后初始化磁盘监控，增加重连回调
    diskManager.init(
      win, 
      () => this.onStatusChange?.(),
      (taskId) => this.handleDiskReconnect(taskId)
    );
  }

  /**
   * 处理磁盘重连逻辑
   */
  private handleDiskReconnect(taskId: string) {
    const tasks = syncStore.getTasks();
    const task = tasks.find(t => t.id === taskId);
    
    // 如果是定时任务且当前处于错误状态（通常是由于之前的离线导致的），则尝试重新启动
    if (task && task.mode === "scheduled" && task.status === "error") {
      logManager.write(taskId, "[磁盘监控] 检测到磁盘已重连，正在尝试自动恢复同步...");
      this.startTask(task);
    }
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
   * 删除任务：停止进程+清理缓存
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
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    await this.cleanUnisonArchives(task);
    logManager.write(task.id, "缓存清理完成，正在重新初始化同步...");
    
    this.startTask(task);
  }

  private cleanUnisonArchives(task: SyncTask): Promise<void> {
    return new Promise((resolve) => {
      const taskDataDir = this.getTaskDataDir(task.id);
      const metadataDir = path.join(taskDataDir, "unison");
      try {
        if (fs.existsSync(metadataDir)) {
          fs.rmSync(metadataDir, { recursive: true, force: true });
          logManager.write(task.id, `[清理] 已删除应用数据目录下的元数据: ${metadataDir}`);
        }
      } catch (err: any) {
        logManager.write(task.id, `[警告] 清理元数据目录失败: ${err.message}`);
      }
      resolve();
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

    if (task.mode === "scheduled") {
      this.setupScheduled(task);
    }
  }

  /**
   * 停止并清理任务
   */
  stopTask(id: string) {
    this.activeProcesses.get(id)?.kill();
    this.activeProcesses.delete(id);

    // PID fallback: kill by stored PID in case activeProcesses map was lost
    const storedTask = syncStore.getTasks().find(t => t.id === id);
    if (storedTask?.pid) {
      try { process.kill(storedTask.pid); } catch {}
      syncStore.updateTask(id, { pid: undefined });
    }

    if (this.timers.has(id)) {
      clearInterval(this.timers.get(id)!);
      this.timers.delete(id);
    }

    this.updateStatus(id, "idle");
  }

  /**
   * 强力停止所有任务（用于程序退出）
   */
  public async stopAllTasks() {
    logManager.write("global", "正在清理所有同步进程...");
    
    // 收集所有活跃 PID
    const pids = new Set<number>();
    this.activeProcesses.forEach(p => { if (p.pid) pids.add(p.pid); });
    syncStore.getTasks().forEach(t => { if (t.pid) pids.add(t.pid); });

    // 1. 停止所有定时器
    this.timers.forEach(timer => clearInterval(timer));
    this.timers.clear();

    // 2. 发送 SIGTERM 信号
    pids.forEach(pid => {
      try { process.kill(pid, "SIGTERM"); } catch {}
    });

    // 3. 等待 500ms 后检查并强制清理
    await new Promise(resolve => setTimeout(resolve, 500));
    pids.forEach(pid => {
      try {
        process.kill(pid, 0); // 检查进程是否存在
        process.kill(pid, "SIGKILL"); // 强制杀死
        console.log(`[清理] 强制终止残留进程: ${pid}`);
      } catch {}
    });

    this.activeProcesses.clear();
    syncStore.getTasks().forEach(t => {
      if (t.pid) syncStore.updateTask(t.id, { pid: undefined, status: "idle" });
    });
  }

  private handleOffline(task: SyncTask) {
    const errorMsg = `同步挂起：检测到磁盘离线或路径失效。`;
    logManager.write(task.id, errorMsg);
    this.win?.webContents.send("sync-log", { id: task.id, log: errorMsg });
    this.updateStatus(task.id, "error");
    
    // 注意：不再主动停止定时器。定时器在触发时会继续检查磁盘状态。
    // 如果磁盘一直离线，定时器会反复触发 handleOffline 并跳过 Unison。
    // 一旦磁盘重连，DiskManager 会通过 handleDiskReconnect 立即拉起任务，
    // 或者等待下一个定时周期自然恢复。
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
   * 启动单文件/特定路径的 Unison 同步
   * 这是为了替代手动的 fs.copyFileSync 和 fs.unlinkSync，让 Unison 引擎自己处理，避免 Destination updated 错误
   */
  public runSpecificPathSync(task: SyncTask, targetPathStr: string, specificDirection?: "sourceToTarget" | "targetToSource") {
    // 复用原有的 runUnison，但通过额外的 path 参数限定只同步这个路径
    return this.runUnison(task, [targetPathStr], specificDirection);
  }

  /**
   * 执行 Unison 同步
   * @param specificPaths 如果提供，则只同步这些特定的相对路径
   * @param overrideDirection 如果提供，则临时覆盖同步方向（用于单向同步）
   */
  private async runUnison(task: SyncTask, specificPaths?: string[], overrideDirection?: "sourceToTarget" | "targetToSource", retryCount: number = 0) {
    if (this.activeProcesses.has(task.id)) return;

    if (!fs.existsSync(task.sourcePath) || !fs.existsSync(task.targetPath)) {
      this.handleOffline(task);
      return;
    }

    // 检测路径冲突：解析 symlink 后再比较，防止以下两种危险情况：
    // 1. 两条路径经 symlink 指向同一真实目录 → Unison 自己同步自己，数据损坏
    // 2. symlink 绕过字符串比较，实际存在父子嵌套 → 递归创建同名目录
    let srcReal: string, tgtReal: string;
    try {
      srcReal = fs.realpathSync(task.sourcePath);
      tgtReal = fs.realpathSync(task.targetPath);
    } catch {
      // realpathSync 失败说明路径无法解析（断链 symlink 等），当作离线处理
      this.handleOffline(task);
      return;
    }
    if (srcReal === tgtReal) {
      const errMsg = `路径配置错误：源目录与目标目录解析后指向同一真实路径，拒绝同步。\n源: ${task.sourcePath} → ${srcReal}\n目标: ${task.targetPath} → ${tgtReal}`;
      console.error(errMsg);
      logManager.write(task.id, `[错误] ${errMsg}`);
      this.updateStatus(task.id, "error");
      return;
    }
    const srcNorm = srcReal.endsWith(path.sep) ? srcReal : srcReal + path.sep;
    const tgtNorm = tgtReal.endsWith(path.sep) ? tgtReal : tgtReal + path.sep;
    if (srcNorm.startsWith(tgtNorm) || tgtNorm.startsWith(srcNorm)) {
      const errMsg = `路径配置错误：源目录与目标目录存在嵌套关系（含 symlink 解析后），这会导致同步时递归创建同名目录。请检查任务配置。\n源: ${task.sourcePath} → ${srcReal}\n目标: ${task.targetPath} → ${tgtReal}`;
      console.error(errMsg);
      logManager.write(task.id, `[错误] ${errMsg}`);
      this.updateStatus(task.id, "error");
      return;
    }

    this.updateStatus(task.id, "syncing");

    const args = [
      "-batch",
      "-terse", 
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
      "-ignore", "Path .wizsync", // 强制忽略本地元数据目录
      "-label", task.name,
      "-ignorelocks",
      "-retry", "3",
      "-confirmbigdel=false", // 自动确认大批量删除，防止挂起
    ];

    // 根据同步方向优化策略
    const currentDirection = overrideDirection || task.direction;

    if (currentDirection === "sourceToTarget") {
      args.push("-prefer", task.sourcePath);
      args.push("-force", task.sourcePath);
      // 一向同步时，对目标端的变动不敏感，防止 "Destination updated" 报错
      args.push("-times=false");
    } else if (currentDirection === "targetToSource") {
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
      task.ignoredPaths.forEach(p => {
        args.push("-ignore", `Path ${p}`);
      });
    }

    // 增加指定特定路径同步的参数
    if (specificPaths && specificPaths.length > 0) {
      specificPaths.forEach(p => {
        args.push("-path", p);
      });
    }

    if (task.useParallel) args.push("-maxthreads", "10");
    args.push(task.sourcePath);
    args.push(task.targetPath);

    if (currentDirection === "sourceToTarget") args.push("-force", task.sourcePath);
    else if (currentDirection === "targetToSource") args.push("-force", task.targetPath);

    const unisonPath = getUnisonPath();
    
    // 关键：将 Unison 元数据存储在应用数据目录下的任务专用文件夹中
    const taskDataDir = this.getTaskDataDir(task.id);
    const metadataDir = path.join(taskDataDir, "unison");
    if (!fs.existsSync(metadataDir)) {
      fs.mkdirSync(metadataDir, { recursive: true });
    }
    
    const env = { 
      ...process.env, 
      UNISON: metadataDir 
    };

    // 在真正启动进程前再次确认两个根目录均存在，防止磁盘在构建参数期间被卸载
    // Unison 在根目录不存在时会自动创建，这里严禁这种行为
    if (!fs.existsSync(task.sourcePath) || !fs.existsSync(task.targetPath)) {
      const missing = !fs.existsSync(task.sourcePath) ? task.sourcePath : task.targetPath;
      const errMsg = `同步中止：根目录不存在，拒绝启动 Unison（禁止自动创建根目录）: ${missing}`;
      console.warn(errMsg);
      logManager.write(task.id, `[中止] ${errMsg}`);
      this.updateStatus(task.id, "error");
      return;
    }

    const proc = spawn(unisonPath, args, { env });
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
    let hasChanges = false; // 标记本次同步是否有文件变动
    const lastStatsUpdateTime = new Map<string, number>();

    const flushBuffer = () => {
      if (outputBuffer) {
        logManager.write(task.id, outputBuffer);
        this.win?.webContents.send("sync-log", { id: task.id, log: outputBuffer });
        outputBuffer = "";
      }
    };

    const checkStatus = (text: string) => {
      // "Destination updated during synchronization" 很多时候是我们手动操作文件后引擎的防冲突保护
      // 记录它需要重试，但不要让它显示在正常日志中，免得让用户恐慌
      const retryPatterns = [
        "Destination updated during synchronization",
        "Synchronization incomplete",
        "Failed to copy file",
        "Error in copying",
        "connection lost",
        "fatal error",
        "lost connection",
        "is being used by another process"
      ];
      if (retryPatterns.some(p => text.includes(p))) {
        needsRetry = true;
      }

      // 简单的变更检测逻辑：如果输出包含常见的操作关键词（如 copying, deleting, moved 等），认为有变动
      // 排除 "Nothing to do" 和 "Looking for changes"
      const changePatterns = [
        "copying",
        "deleting",
        "moving",
        "rename",
        "Updating propagation",
        "changed",
        "replaced"
      ];
      if (changePatterns.some(p => text.toLowerCase().includes(p.toLowerCase())) && 
          !text.includes("Nothing to do")) {
        hasChanges = true;
      }
    };

    proc.stdout.on("data", (data) => {
      const chunk: string = data.toString();

      // 过滤掉我们不希望显示的冗余警告
      if (chunk.includes("Destination updated during synchronization") || chunk.includes("Synchronization incomplete")) {
        // 静默处理这个日志，只走内部的 needsRetry 逻辑
        checkStatus(chunk);
        return;
      }

      outputBuffer += chunk;
      checkStatus(chunk);
      if (outputBuffer.length > 2000) flushBuffer();
    });

    proc.stderr.on("data", (data) => {
      const errorMsg: string = data.toString();

      // 同样在 stderr 中过滤
      if (errorMsg.includes("Destination updated during synchronization") || errorMsg.includes("Synchronization incomplete")) {
        checkStatus(errorMsg);
        return;
      }

      checkStatus(errorMsg);
      logManager.write(task.id, `[stderr] ${errorMsg}`);
      this.win?.webContents.send("sync-log", { id: task.id, log: `警告: ${errorMsg}` });
    });

    proc.on("close", async (code) => {
      flushBuffer();
      this.activeProcesses.delete(task.id);
      syncStore.updateTask(task.id, { pid: undefined });

      if (code !== 0 && needsRetry) {
        if (retryCount >= 3) {
          const msg = `[错误] 连续重试 ${retryCount} 次后仍然失败，已停止重试。请检查日志或手动处理。`;
          logManager.write(task.id, msg);
          this.win?.webContents.send("sync-log", { id: task.id, log: msg });
          this.updateStatus(task.id, "error");
          return;
        }

        const msg = `[自动重试] 增量同步准备就绪，1 秒后扫描以确认最终状态... (重试次数: ${retryCount + 1}/3)`;
        logManager.write(task.id, msg);
        this.win?.webContents.send("sync-log", { id: task.id, log: msg });
        setTimeout(() => {
          const tasks = syncStore.getTasks();
          const currentTask = tasks.find(t => t.id === task.id);
          if (currentTask) this.runUnison(currentTask, specificPaths, overrideDirection, retryCount + 1);
        }, 1000);
        return;
      }
      
      const status = code === 0 ? "idle" : "error";
      const lastSyncTime = new Date().toLocaleString();
      
      // 优化点：仅在有文件变动，或者距离上次更新超过 10 分钟时才执行昂贵的目录统计
      const now = Date.now();
      const lastUpdate = lastStatsUpdateTime.get(task.id) || 0;
      const shouldUpdateStats = hasChanges || (now - lastUpdate > 10 * 60 * 1000);

      if (fs.existsSync(task.sourcePath) && fs.existsSync(task.targetPath)) {
        const updateTaskData: Partial<SyncTask> = { status, lastSyncTime };
        
        if (shouldUpdateStats) {
          try {
            const [sourceStats, targetStats] = await Promise.all([
              getDirStats(task.sourcePath),
              getDirStats(task.targetPath)
            ]);
            updateTaskData.sourceStats = sourceStats;
            updateTaskData.targetStats = targetStats;
            lastStatsUpdateTime.set(task.id, now);
            if (hasChanges) logManager.write(task.id, "[优化] 检测到文件变动，已更新目录统计信息。");
          } catch (err) {
            console.error("更新统计信息失败:", err);
          }
        }

        const sourceDisk = diskManager.getDiskSpace(task.sourcePath) || undefined;
        const targetDisk = diskManager.getDiskSpace(task.targetPath) || undefined;
        updateTaskData.sourceDisk = sourceDisk;
        updateTaskData.targetDisk = targetDisk;

        syncStore.updateTask(task.id, updateTaskData);
        this.win?.webContents.send("sync-status", { id: task.id, ...updateTaskData });
      }

      logManager.write(task.id, `同步结束 (代码: ${code})${hasChanges ? " [有变动]" : " [无变动]"}`);
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
