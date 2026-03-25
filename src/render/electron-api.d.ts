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
}

export interface ElectronAPI {
  getTasks: () => Promise<SyncTask[]>
  saveTask: (task: SyncTask) => Promise<SyncTask[]>
  deleteTask: (id: string) => Promise<SyncTask[]>
  startSync: (id: string) => Promise<boolean>
  stopSync: (id: string) => Promise<boolean>
  selectDirectory: () => Promise<string | null>
  onSyncStatus: (callback: (status: { id: string, status: SyncTask['status'], lastSyncTime?: string }) => void) => void
  onSyncLog: (callback: (log: { id: string, log: string }) => void) => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
