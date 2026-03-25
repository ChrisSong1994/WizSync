import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  getTasks: () => ipcRenderer.invoke('get-tasks'),
  saveTask: (task: any) => ipcRenderer.invoke('save-task', task),
  deleteTask: (id: string) => ipcRenderer.invoke('delete-task', id),
  startSync: (id: string) => ipcRenderer.invoke('start-sync', id),
  stopSync: (id: string) => ipcRenderer.invoke('stop-sync', id),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  onSyncStatus: (callback: any) => ipcRenderer.on('sync-status', (_event, value) => callback(value)),
  onSyncLog: (callback: any) => ipcRenderer.on('sync-log', (_event, value) => callback(value)),
})
