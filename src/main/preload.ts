import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  getTasks: () => ipcRenderer.invoke('get-tasks'),
  saveTask: (task: any) => ipcRenderer.invoke('save-task', task),
  deleteTask: (id: string) => ipcRenderer.invoke('delete-task', id),
  startSync: (id: string) => ipcRenderer.invoke('start-sync', id),
  stopSync: (id: string) => ipcRenderer.invoke('stop-sync', id),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  compareDirectories: (id: string) => ipcRenderer.invoke('compare-directories', id),
  getPersistentLogs: (id: string) => ipcRenderer.invoke('get-persistent-logs', id),
  clearPersistentLogs: (id: string) => ipcRenderer.invoke('clear-persistent-logs', id),
  openLogFolder: (id: string) => ipcRenderer.invoke('open-log-folder', id),
  getIgnorePatterns: () => ipcRenderer.invoke('get-ignore-patterns'),
  getDefaultBackupPath: (taskId: string) => ipcRenderer.invoke('get-default-backup-path', taskId),
  listBackupFiles: (taskId: string) => ipcRenderer.invoke('list-backup-files', taskId),
  openBackupFolder: (taskId: string) => ipcRenderer.invoke('open-backup-folder', taskId),
  revealBackupFile: (filePath: string) => ipcRenderer.invoke('reveal-backup-file', filePath),
  deleteBackupFile: (filePath: string) => ipcRenderer.invoke('delete-backup-file', filePath),
  syncSingleFile: (taskId: string, filePath: string, direction: string) => 
    ipcRenderer.invoke('sync-single-file', taskId, filePath, direction),
  deleteFile: (taskId: string, filePath: string, side: string) =>
    ipcRenderer.invoke('delete-file', taskId, filePath, side),
  ignorePath: (taskId: string, filePath: string) =>
    ipcRenderer.invoke('ignore-path', taskId, filePath),
  unignorePath: (taskId: string, filePath: string) =>
    ipcRenderer.invoke('unignore-path', taskId, filePath),
  revealInFileExplorer: (taskId: string, filePath: string, side: string) =>
    ipcRenderer.invoke('reveal-in-explorer', taskId, filePath, side),
  onSyncStatus: (callback: any) => ipcRenderer.on('sync-status', (_event, value) => callback(value)),
  onSyncLog: (callback: any) => ipcRenderer.on('sync-log', (_event, value) => callback(value)),
  onCompareProgress: (callback: any) => ipcRenderer.on('compare-progress', (_event, value) => callback(value)),
})
