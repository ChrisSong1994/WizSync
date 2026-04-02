export interface SyncTask {
  id: string;
  name: string;
  sourcePath: string;
  targetPath: string;
  mode: "scheduled" | "manual";
  interval?: number; // 单位：分钟
  direction: "bidirectional" | "sourceToTarget" | "targetToSource";
  status: "idle" | "syncing" | "error";
  lastSyncTime?: string;
  useParallel?: boolean;
  sourceStats?: { size: number; count: number };
  targetStats?: { size: number; count: number };
  sourceDisk?: { name: string; total: number; free: number };
  targetDisk?: { name: string; total: number; free: number };
  ignoredPaths?: string[];
  backupPath?: string;
  pid?: number; // 当前 Unison 进程 ID
}
