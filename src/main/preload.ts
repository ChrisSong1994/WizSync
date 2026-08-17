import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  getTasks: () => ipcRenderer.invoke('get-tasks'),
  showConfirm: (message: string) => ipcRenderer.invoke('show-confirm', message),
  saveTask: (task: any) => ipcRenderer.invoke('save-task', task),
  deleteTask: (id: string) => ipcRenderer.invoke('delete-task', id),
  startSync: (id: string) => ipcRenderer.invoke('start-sync', id),
  stopSync: (id: string) => ipcRenderer.invoke('stop-sync', id),
  resetSync: (id: string) => ipcRenderer.invoke('reset-sync', id),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  compareDirectories: (id: string) => ipcRenderer.invoke('compare-directories', id),
  cancelCompare: () => ipcRenderer.invoke('cancel-compare'),
  getPersistentLogs: (id: string) => ipcRenderer.invoke('get-persistent-logs', id),
  clearPersistentLogs: (id: string) => ipcRenderer.invoke('clear-persistent-logs', id),
  openLogFolder: (id: string) => ipcRenderer.invoke('open-log-folder', id),
  getAppDataPath: () => ipcRenderer.invoke('get-app-data-path'),
  openAppDataFolder: () => ipcRenderer.invoke('open-app-data-folder'),
  quitApp: () => ipcRenderer.invoke('quit-app'),
  getIgnorePatterns: () => ipcRenderer.invoke('get-ignore-patterns'),
  getDefaultBackupPath: (taskId: string) => ipcRenderer.invoke('get-default-backup-path', taskId),
  listBackupFiles: (taskId: string) => ipcRenderer.invoke('list-backup-files', taskId),
  openBackupFolder: (taskId: string) => ipcRenderer.invoke('open-backup-folder', taskId),
  revealBackupFile: (taskId: string, filePath: string) => ipcRenderer.invoke('reveal-backup-file', taskId, filePath),
  deleteBackupFile: (taskId: string, filePath: string) => ipcRenderer.invoke('delete-backup-file', taskId, filePath),
  syncSingleFile: (taskId: string, filePath: string, direction: string) =>
    ipcRenderer.invoke('sync-single-file', taskId, filePath, direction),
  syncFiles: (taskId: string, filePaths: string[], direction: string) =>
    ipcRenderer.invoke('sync-files', taskId, filePaths, direction),
  deleteFile: (taskId: string, filePath: string, side: string) =>
    ipcRenderer.invoke('delete-file', taskId, filePath, side),
  deleteFiles: (taskId: string, filePaths: string[], side: string) =>
    ipcRenderer.invoke('delete-files', taskId, filePaths, side),
  ignorePath: (taskId: string, filePath: string) =>
    ipcRenderer.invoke('ignore-path', taskId, filePath),
  ignorePaths: (taskId: string, filePaths: string[]) =>
    ipcRenderer.invoke('ignore-paths', taskId, filePaths),
  unignorePath: (taskId: string, filePath: string) =>
    ipcRenderer.invoke('unignore-path', taskId, filePath),
  revealInFileExplorer: (taskId: string, filePath: string, side: string) =>
    ipcRenderer.invoke('reveal-in-explorer', taskId, filePath, side),
  onSyncStatus: (callback: any) => ipcRenderer.on('sync-status', (_event, value) => callback(value)),
  onSyncLog: (callback: any) => ipcRenderer.on('sync-log', (_event, value) => callback(value)),
  onCompareProgress: (callback: any) => ipcRenderer.on('compare-progress', (_event, value) => callback(value)),
})
