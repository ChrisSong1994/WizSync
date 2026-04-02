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
  private diskSpaceTimer: NodeJS.Timeout | null = null;

  /**
   * 获取路径所在磁盘的容量和名称信息
   */
  getDiskSpace(dirPath: string): { name: string; total: number; free: number } | null {
    try {
      if (!fs.existsSync(dirPath)) return null;
      const stats = fs.statfsSync(dirPath);
      
      let name = "本地磁盘";
      if (dirPath.startsWith("/Volumes/")) {
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
  init(win: BrowserWindow, onStatusChange: () => void) {
    this.win = win;
    this.onStatusChange = onStatusChange;
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
      this.checkAllDisks();
    }, 10000);
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
