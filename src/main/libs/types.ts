export interface SyncTask {
  id: string;
  name: string;
  sourcePath: string;
  targetPath: string;
  mode: "realtime" | "scheduled" | "manual";
  interval?: number; // 单位：分钟
  direction: "bidirectional" | "sourceToTarget" | "targetToSource";
  status: "idle" | "syncing" | "error";
  lastSyncTime?: string;
  useParallel?: boolean;
  sourceStats?: { size: number; count: number };
  targetStats?: { size: number; count: number };
}
