import { BrowserWindow } from "electron";
import fs from "node:fs";
import { syncStore } from "./sync-store";

/**
 * 磁盘管理器类 (DiskManager)
 * 负责获取磁盘空间信息以及全局定时监控
 */
export class DiskManager {
  private win: BrowserWindow | null = null;
  private onStatusChange: (() => void) | null = null;
  private onDiskReconnect: ((taskId: string) => void) | null = null;
  private diskSpaceTimer: NodeJS.Timeout | null = null;

  /**
   * 获取路径所在磁盘的容量和名称信息
   */
  getDiskSpace(dirPath: string): { name: string; total: number; free: number } | null {
    try {
      if (!fs.existsSync(dirPath)) return null;
      const stats = fs.statfsSync(dirPath);
      
      let name = "本地磁盘";
      if (process.platform === "win32") {
        // Windows 以盘符作为磁盘名称，例如 "C:\Users\foo" → "C 盘"
        const drive = /^([a-zA-Z]):/.exec(dirPath);
        if (drive) name = `${drive[1].toUpperCase()} 盘`;
      } else if (dirPath.startsWith("/Volumes/")) {
        name = dirPath.split("/")[2] || "外置磁盘";
      } else if (process.platform === "darwin" && (dirPath === "/" || dirPath.startsWith("/Users"))) {
        name = "Macintosh HD";
      }

      return {
        name,
        total: stats.bsize * stats.blocks,
        free: stats.bsize * stats.bfree,
      };
    } catch (err) {
      console.error(`[DiskManager] 获取磁盘空间失败 (${dirPath}):`, err);
      return null;
    }
  }

  /**
   * 设置窗口和回调引用
   */
  init(win: BrowserWindow, onStatusChange: () => void, onDiskReconnect?: (taskId: string) => void) {
    this.win = win;
    this.onStatusChange = onStatusChange;
    this.onDiskReconnect = onDiskReconnect || null;
    this.startMonitoring();
  }

  /**
   * 启动全局磁盘空间监控
   */
  private startMonitoring() {
    if (this.diskSpaceTimer) clearInterval(this.diskSpaceTimer);
    
    // 立即执行一次
    this.checkAllDisks();
    
    // 然后每 10 秒刷新一次
    this.diskSpaceTimer = setInterval(() => {
      try {
        this.checkAllDisks();
      } catch (err) {
        // 退出流程中窗口可能已销毁，任何异常都不该冒泡成 Uncaught Exception 弹窗
        console.error("[DiskManager] 磁盘检测失败:", err);
      }
    }, 10000);
  }

  /**
   * 安全推送消息到渲染进程。
   * 窗口关闭（native 对象已销毁）后 webContents 访问会抛
   * "TypeError: Object has been destroyed"，必须先做双重销毁检查。
   */
  private sendToRenderer(channel: string, payload: unknown) {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const webContents = win.webContents;
    if (!webContents || webContents.isDestroyed()) return;
    webContents.send(channel, payload);
  }

  /**
   * 检查所有任务关联的磁盘空间
   */
  private checkAllDisks() {
    const tasks = syncStore.getTasks();
    let hasAnyChange = false;

    tasks.forEach(task => {
      const sourceDisk = this.getDiskSpace(task.sourcePath);
      const targetDisk = this.getDiskSpace(task.targetPath);

      // 检测磁盘恢复：之前有磁盘缺失（或记录显示缺失），现在全部在线
      const wasOffline = !task.sourceDisk || !task.targetDisk;
      const isOnline = !!sourceDisk && !!targetDisk;

      const reconnectCb = this.onDiskReconnect;
      if (wasOffline && isOnline && reconnectCb) {
        // 使用 setImmediate 确保不阻塞监控主循环；回调先捕获引用，
        // 避免延后执行时 stopMonitoring() 已把 onDiskReconnect 置空
        setImmediate(() => reconnectCb(task.id));
      }

      // 显式对比关键数值（增加名称对比）
      const isSourceChanged = 
        (sourceDisk?.free !== task.sourceDisk?.free) || 
        (sourceDisk?.total !== task.sourceDisk?.total) ||
        (sourceDisk?.name !== task.sourceDisk?.name);
      
      const isTargetChanged = 
        (targetDisk?.free !== task.targetDisk?.free) || 
        (targetDisk?.total !== task.targetDisk?.total) ||
        (targetDisk?.name !== task.targetDisk?.name);

      if (isSourceChanged || isTargetChanged) {
        const updates = { 
          sourceDisk: sourceDisk || undefined, 
          targetDisk: targetDisk || undefined 
        };
        syncStore.updateTask(task.id, updates);
        
        this.sendToRenderer("sync-status", { 
          id: task.id, 
          status: task.status,
          ...updates
        });
        hasAnyChange = true;
      }
    });

    if (hasAnyChange) {
      this.onStatusChange?.();
    }
  }

  /**
   * 停止监控
   */
  stopMonitoring() {
    if (this.diskSpaceTimer) {
      clearInterval(this.diskSpaceTimer);
      this.diskSpaceTimer = null;
    }
    this.win = null;
    this.onDiskReconnect = null;
  }
}

export const diskManager = new DiskManager();
