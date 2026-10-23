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

/** 目录对比结果，与渲染进程 types.d.ts 中的 DiffResult 保持一致 */
export interface DiffResult {
  sourceOnly: { path: string; size: number }[];
  targetOnly: { path: string; size: number }[];
  different: {
    path: string;
    sourceSize: number;
    targetSize: number;
    sourceMtime: number;
    targetMtime: number;
  }[];
  renamed: { oldPath: string; newPath: string; size: number; side: "sourceToTarget" | "targetToSource" }[];
  ignored: { path: string; size: number; side: "source" | "target" | "both" }[];
}
