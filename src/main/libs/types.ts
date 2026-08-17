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
  useFat?: boolean; // FAT 文件系统兼容；默认开启（undefined 视为开启）
  sourceStats?: { size: number; count: number };
  targetStats?: { size: number; count: number };
  sourceDisk?: { name: string; total: number; free: number };
  targetDisk?: { name: string; total: number; free: number };
  ignoredPaths?: string[];
  backupPath?: string;
  backupRetentionDays?: number; // 备份保留天数，0 或未设置时用默认值 30
  pid?: number; // 当前 Unison 进程 ID
}
