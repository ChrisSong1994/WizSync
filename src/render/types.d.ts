export interface SyncTask {
  id: string
  name: string
  sourcePath: string
  targetPath: string
  mode: 'realtime' | 'scheduled' | 'manual'
  interval?: number
  direction: 'bidirectional' | 'sourceToTarget' | 'targetToSource'
  status: 'idle' | 'syncing' | 'error'
  lastSyncTime?: string
  useParallel?: boolean
  sourceStats?: { size: number; count: number }
  targetStats?: { size: number; count: number }
  sourceDisk?: { total: number; free: number }
  targetDisk?: { total: number; free: number }
  ignoredPaths?: string[]
}

export interface DiffResult {
  sourceOnly: { path: string; size: number }[]
  targetOnly: { path: string; size: number }[]
  different: { path: string; sourceSize: number; targetSize: number; sourceMtime: number; targetMtime: number }[]
  ignored: { path: string; size: number; side: 'source' | 'target' | 'both' }[]
}

export interface ElectronAPI {
  getTasks: () => Promise<SyncTask[]>
  saveTask: (task: SyncTask) => Promise<SyncTask[]>
  deleteTask: (id: string) => Promise<SyncTask[]>
  startSync: (id: string) => Promise<boolean>
  stopSync: (id: string) => Promise<boolean>
  selectDirectory: () => Promise<string | null>
  compareDirectories: (id: string) => Promise<DiffResult>
  getPersistentLogs: (id: string) => Promise<string>
  clearPersistentLogs: (id: string) => Promise<boolean>
  openLogFolder: (id: string) => Promise<boolean>
  getIgnorePatterns: () => Promise<string[]>
  syncSingleFile: (taskId: string, filePath: string, direction: 'sourceToTarget' | 'targetToSource') => Promise<boolean>
  deleteFile: (taskId: string, filePath: string, side: 'source' | 'target') => Promise<boolean>
  ignorePath: (taskId: string, filePath: string) => Promise<boolean>
  revealInFileExplorer: (taskId: string, filePath: string, side: 'source' | 'target') => Promise<boolean>
  onSyncStatus: (callback: (data: { id: string; status: SyncTask['status']; lastSyncTime?: string; sourceStats?: any; targetStats?: any }) => void) => void
  onSyncLog: (callback: (data: { id: string; log: string }) => void) => void
  onCompareProgress: (callback: (data: { id: string; count: number }) => void) => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
