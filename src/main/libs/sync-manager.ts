import { spawn, ChildProcess } from "node:child_process";
import { BrowserWindow, app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { SyncTask } from "./types";
import { syncStore } from "./sync-store";
import { getDirStats, isPathInside, IGNORE_PATTERNS } from "./fs-utils";
import { diskManager } from "./disk";
import { getUnisonPath } from "../main";
import { logManager } from "./logs";

/**
 * Unison 的 -path / -ignore Path 参数始终使用 POSIX 分隔符，
 * Windows 下需要把 UI/对比层给出的 \ 转成 /。
 */
function toUnisonPath(p: string): string {
  return process.platform === "win32" ? p.split(/[\\/]+/).join("/") : p;
}

/**
 * 判断目录的顶级条目里是否存在「会被同步」的项。
 *
 * 与 unison 的忽略规则保持一致：隐藏文件/目录（-ignore Name .*）、
 * node_modules / Thumbs.db / desktop.ini 都不计入。
 * 用于识别「某一侧根目录被整体清空」这一危险状态——此时若直接同步，
 * unison 会把"对端全部文件已被删除"当作变更传播过去，反向清空另一侧。
 */
function hasSyncableEntries(dirPath: string): boolean {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true }).some(
      (entry) => !entry.name.startsWith(".") && !IGNORE_PATTERNS.includes(entry.name),
    );
  } catch {
    // 目录不可读时按"没有内容"处理，交由调用方的离线/异常分支兜底
    return false;
  }
}

/**
 * 判断任务是否已有 Unison 归档（ar<md5> / fp<md5>）。
 * 首次同步没有归档，此时"一侧为空"是正常情况（首次复制），不能拦截。
 */
function hasUnisonArchive(metadataDir: string): boolean {
  try {
    return fs.readdirSync(metadataDir).some((name) => /^(ar|fp)[0-9a-f]{16,}$/i.test(name));
  } catch {
    return false;
  }
}

/**
 * 备份目录快照上限：超过后放弃"修正时间戳"（大备份目录下避免每次同步都全量遍历）
 */
const BACKUP_SNAPSHOT_LIMIT = 20000;

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
  /** 已登记的同步失败重试定时器；stopTask 时需要取消并解除等待，防止任务复活 */
  private pendingRetries: Map<string, { timer: NodeJS.Timeout; resolve: (ok: boolean) => void }> = new Map();
  /** 正在执行停止操作的任务 id；进程 close 处理器据此跳过重试与状态更新 */
  private stopRequested: Set<string> = new Set();

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
   * @param paths 可选：仅对指定相对路径做 -path 增量同步，避免大目录全量扫描
   */
  public requestIncrementalSync(id: string, paths?: string[]) {
    if (this.resetDebounceTimers.has(id)) {
      clearTimeout(this.resetDebounceTimers.get(id)!);
    }

    const timer = setTimeout(async () => {
      const tasks = syncStore.getTasks();
      const task = tasks.find(t => t.id === id);
      if (task) {
        if (paths && paths.length > 0) {
          this.log(id, `[自动同步] 手动操作已完成，正在对 ${paths.length} 个路径执行增量同步...`);
          try {
            await this.runSpecificPathsChunked(task, paths);
          } catch (err: any) {
            this.log(id, `[自动同步] 增量同步失败: ${err?.message ?? String(err)}`);
          }
        } else {
          this.log(id, "[自动同步] 手动操作已完成，正在执行增量扫描...");
          await this.startTask(task);
        }
      }
      this.resetDebounceTimers.delete(id);
    }, 1500);

    this.resetDebounceTimers.set(id, timer);
  }

  /**
   * 将待同步路径按每批 400 个 -path 分块串行执行，避免 exec 参数超限（ARG_MAX）
   */
  private async runSpecificPathsChunked(task: SyncTask, paths: string[]): Promise<void> {
    const CHUNK_SIZE = 400;
    for (let i = 0; i < paths.length; i += CHUNK_SIZE) {
      const chunk = paths.slice(i, i + CHUNK_SIZE);
      const ok = await this.runSpecificPathSync(task, chunk);
      if (!ok) break; // 任务被停止或离线，中止剩余批次
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
    
    // 如果是定时任务且当前处于错误状态（通常是由于之前的离线导致的），则尝试重新启动。
    // 注意：warning 状态的任务同步本身是正常的（只是有文件被跳过），不需要在这里重拉。
    if (task && task.mode === "scheduled" && task.status === "error") {
      this.log(taskId, "[磁盘监控] 检测到磁盘已重连，正在尝试自动恢复同步...");
      this.startTask(task);
    }
  }

  setStatusChangeCallback(cb: () => void) {
    this.onStatusChange = cb;
  }

  /**
   * 安全推送消息到渲染进程：窗口销毁后访问 webContents 会抛
   * "TypeError: Object has been destroyed"（退出流程中尤其容易出现）。
   */
  private sendToRenderer(channel: string, payload: unknown) {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const webContents = win.webContents;
    if (!webContents || webContents.isDestroyed()) return;
    webContents.send(channel, payload);
  }

  /**
   * 写入持久化日志，并同时推送到渲染进程（LogModal 实时展示）。
   * 之前生命周期日志（任务启动 / 状态更新 / PID / 同步结束等）只落盘、未 send，
   * 导致同步过程中 LogModal 只能靠打开时一次性加载持久化日志，收不到实时日志。
   */
  private log(id: string, content: string) {
    logManager.write(id, content);
    this.sendToRenderer("sync-log", { id, log: content });
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
  async deleteTask(task: SyncTask) {
    await this.stopTask(task.id);
    await this.cleanUnisonArchives(task).catch(() => {});
  }

  /**
   * 重置任务：强制清理 Unison 缓存并重新启动同步
   */
  public async resetTask(task: SyncTask) {
    // stopTask 会等待进程真正退出（close 事件）后再返回，归档目录可安全清理
    await this.stopTask(task.id);
    this.log(task.id, "=== 强制重置同步缓存 (Archive) ===");
    await this.cleanUnisonArchives(task);
    this.log(task.id, "缓存清理完成，正在重新初始化同步...");
    this.startTask(task);
  }

  /**
   * 记录备份目录当前的「文件 → mtime」快照（超过上限则放弃，返回 null）。
   * 用于在同步结束后识别本次新增的备份文件。
   */
  private snapshotBackupDir(dir: string): Map<string, number> | null {
    const snapshot = new Map<string, number>();
    const walk = (current: string): boolean => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return true;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!walk(full)) return false;
        } else if (entry.isFile()) {
          if (snapshot.size >= BACKUP_SNAPSHOT_LIMIT) return false;
          try {
            snapshot.set(full, fs.statSync(full).mtimeMs);
          } catch {
            // 单个文件读取失败忽略
          }
        }
      }
      return true;
    };
    return walk(dir) ? snapshot : null;
  }

  /**
   * 把本次同步新增（或内容被改写）的备份文件 mtime 更新为当前时间。
   *
   * unison 的 -times 会让备份沿用被覆盖版本的 mtime（用户视角这是"版本时间"，合理），
   * 但备份保留期清理按 mtime 判断，导致刚产生备份的老文件被当成过期文件删除。
   * 因此保留期只应作用于"备份产生时间"：这里把新增备份的 mtime 改为当前时间。
   */
  private refreshBackupTimestamps(dir: string, snapshot: Map<string, number>): void {
    const now = new Date();
    const walk = (current: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          const before = snapshot.get(full);
          const after = fs.statSync(full).mtimeMs;
          // 快照中不存在 = 本次新增；mtime 变化 = 本次被覆盖写入同一备份名
          if (before === undefined || before !== after) {
            fs.utimesSync(full, now, now);
          }
        } catch {
          // 单个文件处理失败不影响同步结果
        }
      }
    };
    walk(dir);
  }

  private cleanUnisonArchives(task: SyncTask): Promise<void> {
    return new Promise((resolve) => {
      const taskDataDir = this.getTaskDataDir(task.id);
      const metadataDir = path.join(taskDataDir, "unison");
      try {
        if (fs.existsSync(metadataDir)) {
          fs.rmSync(metadataDir, { recursive: true, force: true });
          this.log(task.id, `[清理] 已删除应用数据目录下的元数据: ${metadataDir}`);
        }
      } catch (err: any) {
        this.log(task.id, `[警告] 清理元数据目录失败: ${err.message}`);
      }
      resolve();
    });
  }

  /**
   * 启动任务
   */
  async startTask(task: SyncTask) {
    // 等待旧进程完全退出后再启动新进程，杜绝同任务双开
    await this.stopTask(task.id);

    if (!fs.existsSync(task.sourcePath) || !fs.existsSync(task.targetPath)) {
      const offlinePath = !fs.existsSync(task.sourcePath) ? "源目录" : "目标目录";
      const errorMsg = `启动失败：${offlinePath} 已离线。`;
      this.log(task.id, errorMsg);
      this.updateStatus(task.id, "error");
      return;
    }

    this.log(task.id, `=== 任务启动 [模式: ${task.mode}] ===`);
    this.runUnison(task);

    if (task.mode === "scheduled") {
      this.setupScheduled(task);
    }
  }

  /**
   * 停止并清理任务
   * 关键点：等待进程真正退出（close 事件）后再返回，避免旧进程尚未结束就启动新进程导致双开；
   * 同时取消所有 pending 定时器，防止任务被自动复活。
   */
  async stopTask(id: string) {
    // 取消待执行的增量同步防抖与失败重试（重试取消时会解除等待中的同步 Promise）
    this.cancelIncrementalSync(id);
    this.cancelPendingRetry(id);

    // 停止定时任务的轮询定时器
    if (this.timers.has(id)) {
      clearInterval(this.timers.get(id)!);
      this.timers.delete(id);
    }

    // 优先使用 activeProcesses 中的 ChildProcess 句柄。
    // 不再回读持久化的 pid 用 process.kill：存储里的 pid 在上次崩溃重启后即为陈旧值，
    // 且可能已被系统复用，直接 kill 存在误杀无关进程的风险。
    const proc = this.activeProcesses.get(id);
    this.activeProcesses.delete(id);
    syncStore.updateTask(id, { pid: undefined });

    // 进程仍在运行：立即发终止信号，再等待 close 事件；确保 close 处理器在
    // stopRequested 下跳过重试/状态更新，然后再移除标记，避免竞态导致停止后任务复活
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      this.stopRequested.add(id);
      this.log(id, "[停止] 正在终止同步进程...");
      // 立即终止：POSIX 上为优雅 SIGTERM（unison 会清理退出），Windows 上为强制终止
      try { proc.kill("SIGTERM"); } catch {}
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        // 3 秒兜底：SIGTERM 未生效则强制 SIGKILL，close 事件必然随后触发
        const forceKillTimer = setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch {}
        }, 3000);
        proc.once("close", () => {
          clearTimeout(forceKillTimer);
          finish();
        });
      });
      this.stopRequested.delete(id);
    }

    this.updateStatus(id, "idle");
  }

  /** 取消指定任务的增量同步防抖定时器 */
  private cancelIncrementalSync(id: string) {
    const timer = this.resetDebounceTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.resetDebounceTimers.delete(id);
    }
  }

  /** 取消指定任务的失败重试定时器，并解除等待中的同步 Promise（返回 false 表示被中断） */
  private cancelPendingRetry(id: string) {
    const pending = this.pendingRetries.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve(false);
      this.pendingRetries.delete(id);
    }
  }

  /**
   * 强力停止所有任务（用于程序退出）
   */
  public async stopAllTasks() {
    logManager.write("global", "正在清理所有同步进程...");

    // 覆盖所有持久化任务 + 仍活跃的进程/重试
    const ids = new Set<string>(syncStore.getTasks().map(t => t.id));
    this.activeProcesses.forEach((_, id) => ids.add(id));
    this.pendingRetries.forEach((_, id) => ids.add(id));

    // 并发停止；stopTask 内部负责 SIGTERM → 等待 close → SIGKILL 兜底，并清理各任务定时器
    await Promise.all([...ids].map(id => this.stopTask(id)));
  }

  private handleOffline(task: SyncTask) {
    const errorMsg = `同步挂起：检测到磁盘离线或路径失效。`;
    this.log(task.id, errorMsg);
    this.updateStatus(task.id, "error");
    
    // 注意：不再主动停止定时器。定时器在触发时会继续检查磁盘状态。
    // 如果磁盘一直离线，定时器会反复触发 handleOffline 并跳过 Unison。
    // 一旦磁盘重连，DiskManager 会通过 handleDiskReconnect 立即拉起任务，
    // 或者等待下一个定时周期自然恢复。
  }

  private setupScheduled(task: SyncTask) {
    const intervalMs = (task.interval || 5) * 60 * 1000;
    const timer = setInterval(() => {
      // 手动批量同步进行中：跳过定时触发，避免在分块同步的间隙并发
      if (this.isManualSyncing.get(task.id)) return;
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
   * @param specificPaths 一个或多个要同步的相对路径，会通过多个 -path 参数一次传给 Unison，避免逐文件启动进程
   */
  public runSpecificPathSync(task: SyncTask, specificPaths?: string[], specificDirection?: "sourceToTarget" | "targetToSource") {
    // 复用原有的 runUnison。传入 specificPaths 时通过 -path 限定只同步这些路径；
    // 不传（undefined）则对整棵树协调，用于"以 unison 为唯一权威"的手动全量同步。
    return this.runUnison(task, specificPaths, specificDirection);
  }

  /**
   * 执行 Unison 同步
   * @param specificPaths 如果提供，则只同步这些特定的相对路径
   * @param overrideDirection 如果提供，则临时覆盖同步方向（用于单向同步）
   */
  private runUnison(task: SyncTask, specificPaths?: string[], overrideDirection?: "sourceToTarget" | "targetToSource", retryCount: number = 0): Promise<boolean> {
    // 返回的 Promise 在本次同步真正完成（含重试链路）或提前中止时才 resolve。
    // true = 完整执行完；false = 被停止/离线/仍在并发中被跳过，调用方应中止后续分批。
    let onDone: (ok: boolean) => void = () => {};
    const exitPromise = new Promise<boolean>((resolve) => { onDone = resolve; });

    if (this.activeProcesses.has(task.id)) return Promise.resolve(false);

    if (!fs.existsSync(task.sourcePath) || !fs.existsSync(task.targetPath)) {
      this.handleOffline(task);
      return Promise.resolve(false);
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
      return Promise.resolve(false);
    }
    if (isPathInside(srcReal, tgtReal) && isPathInside(tgtReal, srcReal)) {
      const errMsg = `路径配置错误：源目录与目标目录解析后指向同一真实路径，拒绝同步。\n源: ${task.sourcePath} → ${srcReal}\n目标: ${task.targetPath} → ${tgtReal}`;
      console.error(errMsg);
      this.log(task.id, `[错误] ${errMsg}`);
      this.updateStatus(task.id, "error");
      return Promise.resolve(false);
    }
    // isPathInside 已处理大小写不敏感文件系统（Windows/macOS）
    if (isPathInside(srcReal, tgtReal) || isPathInside(tgtReal, srcReal)) {
      const errMsg = `路径配置错误：源目录与目标目录存在嵌套关系（含 symlink 解析后），这会导致同步时递归创建同名目录。请检查任务配置。\n源: ${task.sourcePath} → ${srcReal}\n目标: ${task.targetPath} → ${tgtReal}`;
      console.error(errMsg);
      this.log(task.id, `[错误] ${errMsg}`);
      this.updateStatus(task.id, "error");
      return Promise.resolve(false);
    }

    // 「一侧根目录被整体清空」保护（对应 unison 的 confirmbigdel 语义，但给出可操作提示）。
    // 典型场景：SD 卡/移动硬盘拔插后挂载点复用、卷被重新格式化——目录还在但内容为空。
    // 若不拦截，unison 会把"对端文件都被删除"当作变更传播，反向清空另一侧，造成数据丢失。
    //
    // 仅在「全量协调」时检查：对比页的单文件/批量 -path 同步只作用于指定路径，
    // 一侧为空可能只是 -path 落在另一侧，此时拦截会误伤正常操作。
    const taskDataDir = this.getTaskDataDir(task.id);
    const metadataDir = path.join(taskDataDir, "unison");
    const isFullTreeSync = !specificPaths || specificPaths.length === 0;
    // 单向镜像（-force）下"一侧为空"是用户明确表达的意图（把目标刷成源端的模样），
    // 不拦截；双向同步下才视为磁盘异常。
    const isMirror = (overrideDirection || task.direction) !== "bidirectional";
    if (isFullTreeSync && !isMirror && hasUnisonArchive(metadataDir)) {
      const srcEmpty = !hasSyncableEntries(task.sourcePath);
      const tgtEmpty = !hasSyncableEntries(task.targetPath);
      if (srcEmpty !== tgtEmpty) {
        const emptySide = srcEmpty ? "源目录" : "目标目录";
        const otherSide = srcEmpty ? "目标目录" : "源目录";
        const errMsg =
          `同步中止：检测到${emptySide}为空，而${otherSide}仍有文件。\n` +
          `这通常是磁盘未正确挂载或目录被整体清空导致的。若继续同步，另一侧的文件会被当作"已删除"传播出去。\n` +
          `请确认磁盘挂载正常后重试。若确实要把文件同步删除，请在「对比差异」中删除对应文件（该操作按路径执行，不受此限制）。`;
        console.error(errMsg);
        this.log(task.id, `[错误] ${errMsg}`);
        this.updateStatus(task.id, "error");
        return Promise.resolve(false);
      }
    }

    this.updateStatus(task.id, "syncing");

    const args = [
      "-batch",
      "-ignoreinodenumbers",
      "-dontchmod",
      "-perms", "0", // 必须与 -dontchmod 搭配：unison 要求 dontchmod 时 perms=0，否则拒绝启动 (exit 3)
      "-owner=false",
      "-group=false",
      "-ui", "text",
      "-ignore", "Name .*",
      "-ignore", "Name node_modules",
      "-ignore", "Name Thumbs.db",
      "-ignore", "Name desktop.ini",
      "-ignore", "Path .wizsync", // 强制忽略本地元数据目录
      "-label", task.name,
      "-confirmbigdel=false", // 自动确认大批量删除，防止挂起
    ];

    // 快速检查：默认开启（大小 + 整秒 mtime），大数据量下扫描快；
    // 关闭后每次做全量内容哈希，可识别"同一秒内等长修改"这类 fastcheck 会漏掉的变更。
    args.push(task.useFastcheck === false ? "-fastcheck=false" : "-fastcheck=true");

    // FAT 文件系统兼容（默认开启，面向 FAT/exFAT 移动卷；大小写敏感卷可关闭）
    if (task.useFat !== false) args.push("-fat");

    // 根据同步方向优化策略
    const currentDirection = overrideDirection || task.direction;

    // -copyonconflict 只在双向同步时使用。
    // 它与 -force（单向镜像 / 对比页「使用某端版本」）组合时，unison 不会删除被覆盖方的
    // 文件，而是保留为 "xxx (conflict_on_YYYY-MM-DD).txt"；下一次同步又会把该副本再复制
    // 一份，文件名不断叠加。单向同步的语义是"强镜像"，被覆盖方多余文件应直接删除。
    if (currentDirection === "bidirectional") args.push("-copyonconflict");

    if (currentDirection === "sourceToTarget") {
      // 单向 = 强镜像：-force 让源端在所有差异（含删除）中获胜。
      // 该版本 unison 对本地同步不启用锁保护，并发安全完全由应用的
      // 单飞守卫 + 跨任务重叠校验保证，因此不再需要 -ignorelocks。
      // 注意：-force 下 -prefer 无额外作用，不再重复传入。
      args.push("-force", task.sourcePath);
      // 单向同步也需传播时间戳：让 -fastcheck 能用 size+mtime 判定一致。
      // 若用 -times=false，目标端 mtime 永远是"现在"，与源端不符，
      // 每次同步都会触发全量内容哈希比对，表现为"永远同步不完/很慢"。
      args.push("-times");
    } else if (currentDirection === "targetToSource") {
      args.push("-force", task.targetPath);
      args.push("-times");
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
        // 注：unison 2.53.8 不支持 -backupdel；凡命中 -backup 模式的文件，
        // 无论更新还是删除都会默认写入备份目录，无需额外参数。
      } catch (err) {
        console.error("创建备份目录失败:", err);
      }
    }

    // 添加任务自定义忽略路径
    if (task.ignoredPaths && task.ignoredPaths.length > 0) {
      task.ignoredPaths.forEach(p => {
        // Unison 的忽略 / 增量路径始终使用 /，Windows 下需要把 \ 转回 /
        args.push("-ignore", `Path ${toUnisonPath(p)}`);
      });
    }

    // 增加指定特定路径同步的参数
    if (specificPaths && specificPaths.length > 0) {
      specificPaths.forEach(p => {
        args.push("-path", toUnisonPath(p));
      });
    }

    if (task.useParallel) args.push("-maxthreads", "10");
    args.push(task.sourcePath);
    args.push(task.targetPath);

    const unisonPath = getUnisonPath();

    // 关键：将 Unison 元数据存储在应用数据目录下的任务专用文件夹中
    // （taskDataDir / metadataDir 已在清空校验时计算，这里确保目录存在即可）
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
      this.log(task.id, `[中止] ${errMsg}`);
      this.updateStatus(task.id, "error");
      return Promise.resolve(false);
    }

    // 打印完整 unison 命令行，便于排查同步问题
    this.log(task.id, `[Unison] 命令: ${unisonPath} ${args.join(" ")}`);

    // 备份快照：-times 会让备份文件沿用被覆盖版本的原始 mtime，
    // 而保留期清理按 mtime 判断，刚备份的老文件会在下次启动被误删。
    // 这里记录同步前备份目录的既有文件，close 时只把「新增的备份」mtime 改为当前时间。
    const backupSnapshot = task.backupPath ? this.snapshotBackupDir(task.backupPath) : null;

    const proc = spawn(unisonPath, args, { env });
    this.activeProcesses.set(task.id, proc);

    // 记录 pid 到任务数据
    if (proc.pid) {
      syncStore.updateTask(task.id, { pid: proc.pid });
      this.log(task.id, `[进程] PID: ${proc.pid}`);
    }

    proc.on("error", (err: any) => {
      this.activeProcesses.delete(task.id);
      syncStore.updateTask(task.id, { pid: undefined });
      if (this.stopRequested.has(task.id)) {
        onDone(false);
        return;
      }
      this.log(task.id, `启动失败 (${unisonPath}): ${err.message}`);
      this.updateStatus(task.id, "error");
      onDone(false);
    });

    // stdout / stderr 均按行缓冲处理，便于过滤扫描噪声、只保留具体动作。
    const stdoutLineBuffer = { current: "" };
    const stderrLineBuffer = { current: "" };
    let stdoutNoArchive = false; // 是否处于“无归档文件”警告块（首次同步的扫描提示）
    let scanProgressAnnounced = false; // 扫描阶段是否已提示“文件扫描中”（进度逐文件刷新，只提示一次）
    let needsRetry = false;
    let hasChanges = false; // 标记本次同步是否有文件变动
    const skippedFiles: { path: string; reason: string }[] = []; // 被 Unison 跳过的文件与原因（退出码 1 的来源）
    // Unison 判定的冲突（两边都改过、无法自动收敛）。这是"对比差异"里能查出未同步文件的权威来源：
    // 本地扫描只看 size/mtime，无法可靠推断属性冲突（实测 415 个文件里有 162 个 mtime 落在噪声区间）。
    const conflicts: { path: string; kind: "content" | "props" | "other" }[] = [];
    const lastStatsUpdateTime = new Map<string, number>();

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

    /**
     * 判断一行 Unison 输出是否为扫描/进度噪声。
     * 日志只显示具体动作（任务启动、文件对比、复制、删除、同步完成等），
     * 扫描信息（Looking for changes、Nothing to do、无归档文件提示、百分比进度等）不记录。
     */
    const isScanNoise = (t: string) =>
      /^Looking for changes/.test(t) ||
      /^Waiting for changes from other replicas/.test(t) ||
      /^Scanning/.test(t) ||
      /^[|/\\-]\s+\S/.test(t) || // 扫描进度：旋转光标 + 路径（按行到达时兜底过滤）
      /^Nothing to do:/.test(t) ||
      /Contacting server/.test(t) ||
      /^Starting\.\.\./.test(t) ||
      /^\d+%\s/.test(t);

    /** stderr 中属于正常动作/阶段的信息行（其余非噪声行按警告处理） */
    const isStderrInfoLine = (t: string) =>
      t.startsWith("[BGN]") ||
      t.startsWith("[END]") ||
      t.includes("Synchronization complete") ||
      t === "Reconciling changes" ||
      /^\d+ items? will be synced/.test(t) ||
      /to be synced from /.test(t) ||
      t === "Propagating updates" ||
      t.includes("started propagating changes") ||
      t.includes("finished propagating changes") ||
      t === "Saving synchronizer state";

    /** 过滤并写入一行 Unison 输出 */
    const logUnisonLine = (stream: "stdout" | "stderr", rawLine: string) => {
      const line = rawLine.replace(/\r$/, "");
      const t = line.trim();
      if (!t) return;

      // 冲突重试类提示：只走内部重试逻辑（checkStatus 已在 chunk 层处理），不写入日志
      if (line.includes("Destination updated during synchronization") || line.includes("Synchronization incomplete")) {
        return;
      }

      // 冲突行形如 "props    <-?-> props      路径"、"changed  <-?-> changed  路径"，
      // 首轮（无 archive）则是 "new file <-?-> new file  路径" —— 状态文本可能含空格，
      // 所以按 <-?-> 拆开后取最后一段作为路径（与之前的列间隔 2 个以上空格）。
      // 必须在所有噪声过滤（尤其 stdoutNoArchive 块）之前捕获，否则首轮同步会漏掉。
      if (t.includes("<-?->")) {
        const halves = t.split("<-?->");
        if (halves.length === 2) {
          const left = halves[0].trim();
          const rest = /^\s*(.*?)\s{2,}(.+?)\s*$/.exec(halves[1]);
          if (rest) {
            const status = `${left} ${rest[1]}`;
            const conflictPath = rest[2];
            const kind: "content" | "props" | "other" =
              status.includes("props")
                ? "props"
                : status.includes("changed") || status.includes("new file")
                  ? "content"
                  : "other";
            conflicts.push({ path: conflictPath, kind });
          }
        }
      }

      // 无归档文件警告块（首次同步的扫描提示，仅 stdout 出现）：整块过滤
      if (stream === "stdout") {
        if (stdoutNoArchive) {
          if (/^(file|new file|new dir|changed|deleted|moved)\b/.test(t) || /^(====>|<====)/.test(t) || /---->|<----/.test(t)) {
            stdoutNoArchive = false;
          } else {
            return;
          }
        } else if (/^Warning: No archive files were found/.test(t)) {
          stdoutNoArchive = true;
          return;
        }
      }

      if (isScanNoise(t)) return;

      if (stream === "stderr" && !isStderrInfoLine(t)) {
        // 记录被跳过的文件（形如 "skipped: a.png (properties changed on both sides)"）。
        // 这是 Unison 退出码 1 的唯一来源，close 阶段据此给出明确的日志说明，
        // 避免"卡片显示 error、日志里却看不到任何线索"。
        const skipped = /^\s*skipped:\s+(.+?)\s*\((.+)\)\s*$/.exec(t);
        if (skipped) skippedFiles.push({ path: skipped[1], reason: skipped[2] });
        this.log(task.id, `警告: ${line}`);
      } else {
        this.log(task.id, line);
      }
    };

    /** 检测到扫描进度时只提示一次“文件扫描中”，避免逐文件路径刷屏 */
    const announceScanProgress = (raw: string) => {
      if (scanProgressAnnounced) return;
      // 扫描进度段形如 "/ path"、"- path"、"| path"、"\ path"（旋转光标 + 路径），
      // 复制进度段是 " 42% ..." 百分比，不属于扫描提示
      if (/(?:^|\r)[|/\\-]\s+\S/.test(raw)) {
        scanProgressAnnounced = true;
        this.log(task.id, "文件扫描中...");
      }
    };

    /**
     * 剥离 Unison 的裸 \r 进度刷新段（原地覆盖输出），只返回该行最后的真实内容。
     * 扫描/复制进度均用裸 \r 刷新：扫描段是“旋转光标 + 路径”，复制段是百分比。
     */
    const stripProgress = (raw: string): string => {
      const segments = raw.split(/\r/);
      if (segments.length > 1) announceScanProgress(raw);
      return segments[segments.length - 1];
    };

    /** 将数据按行拆分处理，末尾不完整的行留在缓冲中等待下一次数据 */
    const drainLineBuffer = (stream: "stdout" | "stderr", buffer: { current: string }, chunk: string) => {
      buffer.current += chunk;
      // 真实行以 \r\n 或 \n 结尾；Unison 的扫描/复制进度用裸 \r 原地刷新，不作为行结束
      const parts = buffer.current.split(/\r\n|\n/);
      buffer.current = parts.pop() ?? "";
      for (const part of parts) {
        const real = stripProgress(part);
        if (real.trim()) logUnisonLine(stream, real);
      }
    };

    proc.stdout.on("data", (data) => {
      const chunk: string = data.toString();
      checkStatus(chunk);
      // 扫描进度用裸 \r 原地刷新、不会触发按行 flush，这里实时检测并提示一次“文件扫描中”
      announceScanProgress(chunk);
      // 即时落盘：实时把 unison 的同步日志写入磁盘并推送到 LogModal，
      // 避免长扫描期间日志长时间无输出，看起来像卡死。
      drainLineBuffer("stdout", stdoutLineBuffer, chunk);
    });

    proc.stderr.on("data", (data) => {
      const chunk: string = data.toString();
      checkStatus(chunk);
      drainLineBuffer("stderr", stderrLineBuffer, chunk);
    });

    proc.on("close", async (code) => {
      // 冲刷残留在行缓冲中的最后一行（若有）；同样先剥离裸 \r 进度刷新段
      if (stdoutLineBuffer.current) {
        const real = stripProgress(stdoutLineBuffer.current);
        if (real.trim()) logUnisonLine("stdout", real);
      }
      if (stderrLineBuffer.current) {
        const real = stripProgress(stderrLineBuffer.current);
        if (real.trim()) logUnisonLine("stderr", real);
      }
      // 仅当本进程仍是该任务的活跃进程时才清理，避免误删“停止后立刻重启”的新进程
      if (this.activeProcesses.get(task.id) === proc) {
        this.activeProcesses.delete(task.id);
        syncStore.updateTask(task.id, { pid: undefined });
      }

      // 任务被主动停止：不重试、不更新状态，直接结束本次同步
      if (this.stopRequested.has(task.id)) {
        onDone(false);
        return;
      }

      if (code !== 0 && needsRetry) {
        if (retryCount >= 3) {
          const msg = `[错误] 连续重试 ${retryCount} 次后仍然失败，已停止重试。请检查日志或手动处理。`;
          this.log(task.id, msg);
          this.updateStatus(task.id, "error");
          onDone(false);
          return;
        }

        const msg = `[自动重试] 检测到同步未完成，1 秒后自动重试... (重试次数: ${retryCount + 1}/3)`;
        this.log(task.id, msg);

        // 登记重试定时器（可被 stopTask 取消），并在重试真正完成后才解析本次同步，
        // 避免分批同步时出现“假成功”；重试被取消/跳过时 resolve(false) 让调用方中止剩余批次。
        const timer = setTimeout(() => {
          this.pendingRetries.delete(task.id);
          const currentTask = syncStore.getTasks().find(t => t.id === task.id);
          if (currentTask) {
            this.runUnison(currentTask, specificPaths, overrideDirection, retryCount + 1).then(onDone);
          } else {
            onDone(false);
          }
        }, 1000);
        this.pendingRetries.set(task.id, { timer, resolve: onDone });
        return;
      }

      // Unison 退出码语义（2.53）：0 = 全部同步成功；1 = 有文件被跳过（如冲突、属性无法统一），
      // 同步本身正常结束；2 = 传输过程中出现非致命失败；3 = 致命错误。
      // 1 记为 warning（同步成功但有文件未同步），而不是 error，也不是静默的 idle：
      // 此前把 1 记成 error，导致"仅跳过几个文件"时卡片变红、日志里却全是
      // "Synchronization complete ... 0 failed"，用户完全看不出哪里错了。
      const status = code === 0 ? "idle" : code === 1 ? "warning" : "error";
      const lastSyncTime = new Date().toLocaleString();
      
      // 优化点：仅在有文件变动，或者距离上次更新超过 10 分钟时才执行昂贵的目录统计
      const now = Date.now();
      const lastUpdate = lastStatsUpdateTime.get(task.id) || 0;
      const shouldUpdateStats = hasChanges || (now - lastUpdate > 10 * 60 * 1000);

      if (fs.existsSync(task.sourcePath) && fs.existsSync(task.targetPath)) {
        const updateTaskData: Partial<SyncTask> = { lastSyncTime };
        
        if (shouldUpdateStats) {
          try {
            const [sourceStats, targetStats] = await Promise.all([
              getDirStats(task.sourcePath),
              getDirStats(task.targetPath)
            ]);
            updateTaskData.sourceStats = sourceStats;
            updateTaskData.targetStats = targetStats;
            lastStatsUpdateTime.set(task.id, now);
            if (hasChanges) this.log(task.id, "[优化] 检测到文件变动，已更新目录统计信息。");
          } catch (err) {
            console.error("更新统计信息失败:", err);
          }
        }

        const sourceDisk = diskManager.getDiskSpace(task.sourcePath) || undefined;
        const targetDisk = diskManager.getDiskSpace(task.targetPath) || undefined;
        updateTaskData.sourceDisk = sourceDisk;
        updateTaskData.targetDisk = targetDisk;

        syncStore.updateTask(task.id, updateTaskData);
        this.sendToRenderer("sync-status", { id: task.id, ...updateTaskData });
      }

      if (backupSnapshot && task.backupPath && fs.existsSync(task.backupPath)) {
        this.refreshBackupTimestamps(task.backupPath, backupSnapshot);
      }

      this.log(task.id, `同步结束 (代码: ${code})${hasChanges ? " [有变动]" : " [无变动]"}`);

      // 跳过/失败原因必须落进日志，且状态统一走 updateStatus()：
      // 保证"状态变了"这件事一定有对应日志，卡片状态与日志永远对得上。
      if (code === 1) {
        this.log(
          task.id,
          skippedFiles.length > 0
            ? `[警告] Unison 退出码 1：${skippedFiles.length} 个文件被跳过未同步（其余文件已同步完成），本次同步按正常结束处理。`
            : "[警告] Unison 退出码 1：有文件被跳过未同步（其余文件已同步完成），本次同步按正常结束处理。",
        );
        skippedFiles.forEach((f) =>
          this.log(task.id, `[警告] 未同步: ${f.path}（${f.reason}）`),
        );
      } else if (code !== 0) {
        const hint =
          code === 2
            ? "（传输过程中出现非致命失败，部分文件可能未同步）"
            : code === 3
              ? "（致命错误，本次同步未完成）"
              : "";
        this.log(task.id, `[错误] Unison 退出码 ${code}${hint}，请检查上方日志或手动处理。`);
      }

      // 局部同步（单文件 / 批量 -path）只覆盖本次涉及的路径，其余冲突必须保留：
      // 否则在对比页修好一个文件，整张冲突表就被清空了。
      const pathKey = (p: string) => toUnisonPath(p).replace(/^\.?\/+/, "");
      const scope = (specificPaths ?? []).map(pathKey);
      const inScope = (p: string) => {
        const key = pathKey(p);
        return scope.some((s) => key === s || key.startsWith(`${s}/`));
      };
      const previousConflicts =
        syncStore.getTasks().find((t) => t.id === task.id)?.conflicts ?? [];
      const carriedConflicts =
        scope.length > 0 ? previousConflicts.filter((c) => !inScope(c.path)) : [];
      const mergedConflicts = [
        ...carriedConflicts.filter(
          (c) => !conflicts.some((n) => pathKey(n.path) === pathKey(c.path)),
        ),
        ...conflicts,
      ];

      // 冲突必须显式提示：这类文件"两边都被改过"，不会被自动同步，需要用户在对比页选择保留哪一版
      if (mergedConflicts.length > 0) {
        const contentCount = mergedConflicts.filter((c) => c.kind === "content").length;
        const propsCount = mergedConflicts.filter((c) => c.kind === "props").length;
        const detail = [
          contentCount ? `${contentCount} 个内容冲突` : "",
          propsCount ? `${propsCount} 个属性/时间戳冲突` : "",
        ].filter(Boolean).join("、");
        this.log(
          task.id,
          `[冲突] ${mergedConflicts.length} 个文件两边都被修改且无法自动收敛（${detail}），未同步。请在"对比差异"中选择保留哪一版。`,
        );
        conflicts.forEach((c) =>
          this.log(task.id, `[冲突] ${c.kind === "props" ? "属性不同" : c.kind === "content" ? "内容不同" : "冲突"}: ${c.path}`),
        );
      }

      // 跳过明细与冲突随状态一起下发：卡片可点开查看，对比页的"两边都改过"区块也依赖它
      this.updateStatus(task.id, status, {
        skippedCount: skippedFiles.length,
        skippedFiles,
        conflicts: mergedConflicts,
      });
      onDone(true);
    });

    return exitPromise;
  }

  private updateStatus(
    id: string,
    status: SyncTask["status"],
    extra: Partial<SyncTask> = {},
  ) {
    syncStore.updateTask(id, { status, ...extra });
    this.log(id, `状态更新: ${status}`);
    this.sendToRenderer("sync-status", { id, status, ...extra });
    this.onStatusChange?.();
  }
}

export const syncManager = new SyncManager();
