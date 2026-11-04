export interface SyncTask {
  id: string;
  name: string;
  sourcePath: string;
  targetPath: string;
  mode: "scheduled" | "manual";
  interval?: number; // 单位：分钟
  direction: "bidirectional" | "sourceToTarget" | "targetToSource";
  // warning：同步正常结束，但有文件被跳过未同步（对应 Unison 退出码 1）
  status: "idle" | "syncing" | "warning" | "error";
  lastSyncTime?: string;
  useParallel?: boolean;
  useFat?: boolean; // FAT 文件系统兼容；默认开启（undefined 视为开启）
  // 快速检查（大小 + 整秒 mtime）默认开启。关闭后 unison 每次都做全量内容哈希：
  // 能识别"同一秒内、等长"的修改（fastcheck 会漏检），代价是大数据量下扫描明显变慢。
  useFastcheck?: boolean;
  sourceStats?: { size: number; count: number };
  targetStats?: { size: number; count: number };
  sourceDisk?: { name: string; total: number; free: number };
  targetDisk?: { name: string; total: number; free: number };
  ignoredPaths?: string[];
  backupPath?: string;
  backupRetentionDays?: number; // 备份保留天数，0 或未设置时用默认值 30
  pid?: number; // 当前 Unison 进程 ID
  skippedCount?: number; // 最近一次同步被跳过的文件数（退出码 1 时 > 0）
  skippedFiles?: { path: string; reason: string }[]; // 被跳过的文件与原因，供卡片展示细节
  // Unison 判定的冲突（两边都改过、无法自动收敛）：content = 内容冲突，props = 属性/时间戳冲突。
  // 这是“对比差异”里能查出未同步文件的权威来源（本地扫描无法可靠推断属性冲突）。
  conflicts?: { path: string; kind: "content" | "props" | "other" }[];
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
