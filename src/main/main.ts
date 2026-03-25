import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, ChildProcess } from 'node:child_process'
import Store from 'electron-store'
import chokidar from 'chokidar'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, '..')

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

let win: BrowserWindow | null = null

const store = new Store({
  name: 'wizsync-tasks',
  defaults: {
    tasks: []
  }
})

interface SyncTask {
  id: string
  name: string
  sourcePath: string
  targetPath: string
  mode: 'realtime' | 'scheduled' | 'manual'
  interval?: number // in minutes
  direction: 'bidirectional' | 'sourceToTarget' | 'targetToSource'
  status: 'idle' | 'syncing' | 'error'
  lastSyncTime?: string
}

const activeSyncProcesses: Map<string, ChildProcess> = new Map()
const watchers: Map<string, chokidar.FSWatcher> = new Map()
const timers: Map<string, NodeJS.Timeout> = new Map()

function createWindow() {
  win = new BrowserWindow({
    icon: path.join(process.env.VITE_PUBLIC || '', 'assets/logo.png'),
    width: 1000,
    height: 750,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
    },
    titleBarStyle: 'hiddenInset'
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
    win.webContents.openDevTools()
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.whenReady().then(createWindow)

// IPC Handlers
ipcMain.handle('get-tasks', () => {
  return store.get('tasks')
})

ipcMain.handle('save-task', (_event, task: SyncTask) => {
  const tasks = store.get('tasks') as SyncTask[]
  const index = tasks.findIndex(t => t.id === task.id)
  
  if (index > -1) {
    tasks[index] = task
  } else {
    tasks.push(task)
  }
  
  store.set('tasks', tasks)
  return tasks
})

ipcMain.handle('delete-task', (_event, id: string) => {
  stopSyncTask(id)
  const tasks = store.get('tasks') as SyncTask[]
  const filteredTasks = tasks.filter(t => t.id !== id)
  store.set('tasks', filteredTasks)
  return filteredTasks
})

ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(win!, {
    properties: ['openDirectory']
  })
  if (result.canceled) return null
  return result.filePaths[0]
})

ipcMain.handle('start-sync', (_event, id: string) => {
  const tasks = store.get('tasks') as SyncTask[]
  const task = tasks.find(t => t.id === id)
  if (!task) return false

  startSyncTask(task)
  return true
})

ipcMain.handle('stop-sync', (_event, id: string) => {
  stopSyncTask(id)
  return true
})

function startSyncTask(task: SyncTask) {
  stopSyncTask(task.id) // Ensure no existing process/watcher for this task

  if (task.mode === 'realtime') {
    setupRealtimeSync(task)
  } else if (task.mode === 'scheduled') {
    setupScheduledSync(task)
  } else {
    runUnisonSync(task)
  }
}

function stopSyncTask(id: string) {
  // Stop Unison process
  const proc = activeSyncProcesses.get(id)
  if (proc) {
    proc.kill()
    activeSyncProcesses.delete(id)
  }

  // Stop Watcher
  const watcher = watchers.get(id)
  if (watcher) {
    watcher.close()
    watchers.delete(id)
  }

  // Stop Timer
  const timer = timers.get(id)
  if (timer) {
    clearInterval(timer)
    timers.delete(id)
  }

  updateTaskStatus(id, 'idle')
}

function setupRealtimeSync(task: SyncTask) {
  // Initial sync
  runUnisonSync(task)

  // Watch for changes
  const watcher = chokidar.watch([task.sourcePath, task.targetPath], {
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 100
    }
  })

  watcher.on('all', (event, path) => {
    console.log(`File change detected: ${event} on ${path}`)
    if (activeSyncProcesses.has(task.id)) return // Skip if already syncing
    runUnisonSync(task)
  })

  watchers.set(task.id, watcher)
}

function setupScheduledSync(task: SyncTask) {
  // Initial sync
  runUnisonSync(task)

  const intervalMs = (task.interval || 5) * 60 * 1000
  const timer = setInterval(() => {
    runUnisonSync(task)
  }, intervalMs)

  timers.set(task.id, timer)
}

function runUnisonSync(task: SyncTask) {
  if (activeSyncProcesses.has(task.id)) {
    console.log(`Sync for task ${task.name} is already in progress.`)
    return
  }

  updateTaskStatus(task.id, 'syncing')

  const args = [
    task.sourcePath,
    task.targetPath,
    '-batch',
    '-prefer', 'newer',
    '-times',
    '-copyonconflict',
    '-ignoreinodenumbers',
    '-fat',
    '-ignore', 'Name .DS_Store',
    '-ignore', 'Name .localized',
    '-ignore', 'Name .unison.*.tmp',
    '-label', task.name,
    '-ignorelocks'
  ]

  if (task.direction === 'sourceToTarget') {
    args.push('-force', task.sourcePath)
  } else if (task.direction === 'targetToSource') {
    args.push('-force', task.targetPath)
  }

  const unisonProc = spawn('unison', args)
  activeSyncProcesses.set(task.id, unisonProc)

  unisonProc.stdout.on('data', (data) => {
    const log = data.toString()
    win?.webContents.send('sync-log', { id: task.id, log })
  })

  unisonProc.stderr.on('data', (data) => {
    const log = data.toString()
    win?.webContents.send('sync-log', { id: task.id, log: `ERROR: ${log}` })
  })

  unisonProc.on('close', (code) => {
    activeSyncProcesses.delete(task.id)
    const status = code === 0 ? 'idle' : 'error'
    updateTaskStatus(task.id, status, new Date().toLocaleString())
    win?.webContents.send('sync-log', { id: task.id, log: `Sync finished with code ${code}` })
  })
}

function updateTaskStatus(id: string, status: SyncTask['status'], lastSyncTime?: string) {
  const tasks = store.get('tasks') as SyncTask[]
  const index = tasks.findIndex(t => t.id === id)
  if (index > -1) {
    tasks[index].status = status
    if (lastSyncTime) {
      tasks[index].lastSyncTime = lastSyncTime
    }
    store.set('tasks', tasks)
    win?.webContents.send('sync-status', { id, status, lastSyncTime })
  }
}
