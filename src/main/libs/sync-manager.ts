import { spawn, ChildProcess } from "node:child_process";
import chokidar from "chokidar";
import { BrowserWindow } from "electron";
import { SyncTask } from "./types";
import { syncStore } from "./sync-store";
import { getDirStats } from "./fs-utils";

export class SyncManager {
  private activeProcesses: Map<string, ChildProcess> = new Map();
  private watchers: Map<string, chokidar.FSWatcher> = new Map();
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private win: BrowserWindow | null = null;

  setWindow(win: BrowserWindow) {
    this.win = win;
  }

  startTask(task: SyncTask) {
    this.stopTask(task.id);
    this.updateStatus(task.id, "syncing");

    if (task.mode === "realtime") {
      this.setupRealtime(task);
    } else if (task.mode === "scheduled") {
      this.setupScheduled(task);
    } else {
      this.runUnison(task);
    }
  }

  stopTask(id: string) {
    this.activeProcesses.get(id)?.kill();
    this.activeProcesses.delete(id);

    this.watchers.get(id)?.close();
    this.watchers.delete(id);

    if (this.timers.has(id)) {
      clearInterval(this.timers.get(id)!);
      this.timers.delete(id);
    }

    this.updateStatus(id, "idle");
  }

  private setupRealtime(task: SyncTask) {
    this.runUnison(task);

    const watcher = chokidar.watch([task.sourcePath, task.targetPath], {
      ignored: /(^|[\/\\])\../,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 },
    });

    watcher.on("all", () => {
      if (!this.activeProcesses.has(task.id)) {
        this.runUnison(task);
      }
    });

    this.watchers.set(task.id, watcher);
  }

  private setupScheduled(task: SyncTask) {
    this.runUnison(task);
    const intervalMs = (task.interval || 5) * 60 * 1000;
    const timer = setInterval(() => this.runUnison(task), intervalMs);
    this.timers.set(task.id, timer);
  }

  private async runUnison(task: SyncTask) {
    if (this.activeProcesses.has(task.id)) return;

    this.updateStatus(task.id, "syncing");

    const args = [
      task.sourcePath,
      task.targetPath,
      "-batch",
      "-prefer", "newer",
      "-times",
      "-copyonconflict",
      "-ignoreinodenumbers",
      "-fat",
      "-ignore", "Name .DS_Store",
      "-ignore", "Name .localized",
      "-ignore", "Name .unison.*.tmp",
      "-label", task.name,
      "-ignorelocks",
    ];

    if (task.useParallel) args.push("-maxthreads", "10");
    if (task.direction === "sourceToTarget") args.push("-force", task.sourcePath);
    else if (task.direction === "targetToSource") args.push("-force", task.targetPath);

    const proc = spawn("unison", args);
    this.activeProcesses.set(task.id, proc);

    proc.stdout.on("data", (data) => {
      this.win?.webContents.send("sync-log", { id: task.id, log: data.toString() });
    });

    proc.stderr.on("data", (data) => {
      this.win?.webContents.send("sync-log", { id: task.id, log: data.toString() });
    });

    proc.on("close", async (code) => {
      this.activeProcesses.delete(task.id);
      const status = code === 0 ? "idle" : "error";
      const lastSyncTime = new Date().toLocaleString();
      
      const sourceStats = await getDirStats(task.sourcePath);
      const targetStats = await getDirStats(task.targetPath);

      syncStore.updateTask(task.id, { status, lastSyncTime, sourceStats, targetStats });
      this.win?.webContents.send("sync-status", { id: task.id, status, lastSyncTime, sourceStats, targetStats });
      this.win?.webContents.send("sync-log", { id: task.id, log: `Sync finished with code ${code}` });
    });
  }

  private updateStatus(id: string, status: SyncTask["status"]) {
    syncStore.updateTask(id, { status });
    this.win?.webContents.send("sync-status", { id, status });
  }
}

export const syncManager = new SyncManager();
