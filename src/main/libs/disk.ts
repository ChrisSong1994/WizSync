import { BrowserWindow } from "electron";
import fs from "node:fs";
import { syncStore } from "./sync-store";
import { logManager } from "./logs";

/**
 * 磁盘管理器类 (DiskManager)
 * 负责获取磁盘空间信息以及全局定时监控
 */
export class DiskManager {
  private win: BrowserWindow | null = null;
  private onStatusChange: (() => void) | null = null;
  private onDiskReconnected: ((taskId: string) => void) | null = null;
  private onDiskDisconnected: ((taskId: string, side: "source" | "target" | "both") => void) | null = null;
  private diskSpaceTimer: NodeJS.Timeout | null = null;

  /**
   * 获取路径所在磁盘的容量信息
   */
  getDiskSpace(dirPath: string): { total: number; free: number } | null {
    try {
      if (!fs.existsSync(dirPath)) return null;
      const stats = fs.statfsSync(dirPath);
      return {
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
  init(
    win: BrowserWindow, 
    onStatusChange: () => void, 
    onDiskReconnected: (taskId: string) => void,
    onDiskDisconnected: (taskId: string, side: "source" | "target" | "both") => void
  ) {
    this.win = win;
    this.onStatusChange = onStatusChange;
    this.onDiskReconnected = onDiskReconnected;
    this.onDiskDisconnected = onDiskDisconnected;
    this.startMonitoring();
  }

  /**
   * 启动全局磁盘空间监控，每 10 秒刷新一次
   */
  private startMonitoring() {
    if (this.diskSpaceTimer) clearInterval(this.diskSpaceTimer);
    
    this.diskSpaceTimer = setInterval(() => {
      const tasks = syncStore.getTasks();
      let hasAnyChange = false;

      tasks.forEach(task => {
        const wasSourceOffline = !task.sourceDisk;
        const wasTargetOffline = !task.targetDisk;
        const sourceDisk = this.getDiskSpace(task.sourcePath);
        const targetDisk = this.getDiskSpace(task.targetPath);
        const isNowSourceOnline = !!sourceDisk;
        const isNowTargetOnline = !!targetDisk;

        // 磁盘断开检测：如果之前是在线状态，现在离线了
        if ((!wasSourceOffline && !isNowSourceOnline) || (!wasTargetOffline && !isNowTargetOnline)) {
          let side: "source" | "target" | "both" = "both";
          if (!wasSourceOffline && !isNowSourceOnline && wasTargetOffline === isNowTargetOnline) {
            side = "source";
          } else if (!wasTargetOffline && !isNowTargetOnline && wasSourceOffline === isNowSourceOnline) {
            side = "target";
          }
          
          logManager.write(task.id, `[磁盘监控] 检测到磁盘断开连接 (${side === "source" ? "源端" : side === "target" ? "目标端" : "两端"})，正在停止任务...`);
          this.onDiskDisconnected?.(task.id, side);
        }

        // 自动重连逻辑：如果之前是离线状态，现在在线了，且任务处于 error 或 paused 状态
        if ((wasSourceOffline && isNowSourceOnline) || (wasTargetOffline && isNowTargetOnline)) {
          if (task.status === "error" || task.status === "paused" || task.status === "idle") {
             // 只有当两端都上线时才触发重连
             if (isNowSourceOnline && isNowTargetOnline) {
                logManager.write(task.id, "[磁盘监控] 检测到磁盘重新连接，正在尝试自动恢复同步...");
                this.onDiskReconnected?.(task.id);
             }
          }
        }

        // 显式对比关键数值
        const isSourceChanged = 
          (sourceDisk?.free !== task.sourceDisk?.free) || 
          (sourceDisk?.total !== task.sourceDisk?.total);
        
        const isTargetChanged = 
          (targetDisk?.free !== task.targetDisk?.free) || 
          (targetDisk?.total !== task.targetDisk?.total);

        if (isSourceChanged || isTargetChanged) {
          const updates = { 
            sourceDisk: sourceDisk || undefined, 
            targetDisk: targetDisk || undefined 
          };
          syncStore.updateTask(task.id, updates);
          
          this.win?.webContents.send("sync-status", { 
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
    }, 10000);  // 每 10 秒刷新一次
  }

  /**
   * 停止监控
   */
  stopMonitoring() {
    if (this.diskSpaceTimer) {
      clearInterval(this.diskSpaceTimer);
      this.diskSpaceTimer = null;
    }
  }
}

export const diskManager = new DiskManager();
