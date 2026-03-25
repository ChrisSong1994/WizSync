import { useState, useEffect } from 'react'
import { FolderSync, Plus, Play, StopCircle, Trash2, Edit3, Clock, Zap, ArrowRight, ArrowLeftRight, X, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'
import { SyncTask } from './electron-api'
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

function App() {
  const [tasks, setTasks] = useState<SyncTask[]>([])
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [currentTask, setCurrentTask] = useState<Partial<SyncTask> | null>(null)
  const [logs, setLogs] = useState<Record<string, string[]>>({})
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)

  const handleShowLogs = (taskId: string) => {
    setSelectedTaskId(taskId)
  }

  useEffect(() => {
    const fetchTasks = async () => {
      const data = await window.electronAPI.getTasks()
      setTasks(data)
    }
    fetchTasks()

    window.electronAPI.onSyncStatus(({ id, status, lastSyncTime }) => {
      setTasks(prev => prev.map(t => t.id === id ? { ...t, status, lastSyncTime } : t))
    })

    window.electronAPI.onSyncLog(({ id, log }) => {
      setLogs(prev => ({
        ...prev,
        [id]: [...(prev[id] || []).slice(-99), log]
      }))
    })
  }, [])

  const handleAddTask = () => {
    setCurrentTask({
      id: Math.random().toString(36).substr(2, 9),
      name: '',
      sourcePath: '',
      targetPath: '',
      mode: 'manual',
      interval: 5,
      direction: 'bidirectional',
      status: 'idle'
    })
    setIsModalOpen(true)
  }

  const handleEditTask = (task: SyncTask) => {
    setCurrentTask(task)
    setIsModalOpen(true)
  }

  const handleDeleteTask = async (id: string) => {
    const updatedTasks = await window.electronAPI.deleteTask(id)
    setTasks(updatedTasks)
  }

  const handleSaveTask = async () => {
    if (currentTask && currentTask.name && currentTask.sourcePath && currentTask.targetPath) {
      const updatedTasks = await window.electronAPI.saveTask(currentTask as SyncTask)
      setTasks(updatedTasks)
      setIsModalOpen(false)
      setCurrentTask(null)
    }
  }

  const handleToggleSync = async (task: SyncTask) => {
    if (task.status === 'syncing') {
      await window.electronAPI.stopSync(task.id)
    } else {
      await window.electronAPI.startSync(task.id)
    }
  }

  const selectDir = async (field: 'sourcePath' | 'targetPath') => {
    const path = await window.electronAPI.selectDirectory()
    if (path) {
      setCurrentTask(prev => ({ ...prev, [field]: path }))
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between sticky top-0 z-10 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center overflow-hidden shadow-md">
            <img src="/assets/logo.png" alt="WizSync Logo" className="w-full h-full object-cover" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-800 leading-none">WizSync</h1>
            <p className="text-xs text-slate-500 mt-1 font-medium">高效目录同步专家</p>
          </div>
        </div>
        <button 
          onClick={handleAddTask}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl font-semibold transition-all shadow-lg shadow-blue-200 hover:shadow-blue-300 active:scale-95"
        >
          <Plus size={18} />
          <span>添加任务</span>
        </button>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-5xl mx-auto w-full p-6">
        <div className="grid gap-6">
          {tasks.length === 0 ? (
            <div className="bg-white rounded-3xl border border-dashed border-slate-300 p-20 flex flex-col items-center justify-center text-center shadow-sm">
              <div className="w-20 h-20 bg-slate-50 rounded-full flex items-center justify-center text-slate-300 mb-6">
                <FolderSync size={40} />
              </div>
              <h3 className="text-xl font-bold text-slate-700">开启您的同步旅程</h3>
              <p className="text-slate-500 max-w-xs mt-3 leading-relaxed">
                尚未创建任何同步任务。点击右上角的“添加任务”按钮，轻松实现目录自动化管理。
              </p>
            </div>
          ) : (
            tasks.map(task => (
              <div key={task.id} className="bg-white rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow overflow-hidden group">
                <div className="p-5 flex items-center gap-6">
                  {/* Status Indicator */}
                  <div className="flex-shrink-0 relative">
                    <div className={cn(
                      "w-14 h-14 rounded-2xl flex items-center justify-center transition-colors",
                      task.status === 'syncing' ? "bg-blue-50 text-blue-600" :
                      task.status === 'error' ? "bg-red-50 text-red-600" :
                      "bg-emerald-50 text-emerald-600"
                    )}>
                      {task.status === 'syncing' ? <Loader2 size={28} className="animate-spin" /> : 
                       task.status === 'error' ? <AlertCircle size={28} /> : 
                       <CheckCircle2 size={28} />}
                    </div>
                  </div>

                  {/* Task Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-lg font-bold text-slate-800 truncate">{task.name}</h3>
                      <span className={cn(
                        "px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider",
                        task.mode === 'realtime' ? "bg-purple-100 text-purple-700" :
                        task.mode === 'scheduled' ? "bg-blue-100 text-blue-700" :
                        "bg-slate-100 text-slate-700"
                      )}>
                        {task.mode === 'realtime' ? '实时监听' : task.mode === 'scheduled' ? `定时 (${task.interval}min)` : '手动同步'}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-sm text-slate-500">
                      <span className="truncate max-w-[180px] font-mono bg-slate-50 px-2 py-0.5 rounded border border-slate-100">{task.sourcePath.split('/').pop()}</span>
                      {task.direction === 'bidirectional' ? <ArrowLeftRight size={14} className="text-slate-400" /> : <ArrowRight size={14} className="text-slate-400" />}
                      <span className="truncate max-w-[180px] font-mono bg-slate-50 px-2 py-0.5 rounded border border-slate-100">{task.targetPath.split('/').pop()}</span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2">
                    <button 
                      onClick={() => handleToggleSync(task)}
                      className={cn(
                        "w-11 h-11 rounded-xl flex items-center justify-center transition-all active:scale-95",
                        task.status === 'syncing' 
                          ? "bg-amber-100 text-amber-600 hover:bg-amber-200" 
                          : "bg-blue-50 text-blue-600 hover:bg-blue-100"
                      )}
                      title={task.status === 'syncing' ? "停止同步" : "开始同步"}
                    >
                      {task.status === 'syncing' ? <StopCircle size={22} /> : <Play size={22} fill="currentColor" />}
                    </button>
                    <button 
                      onClick={() => handleEditTask(task)}
                      className="w-11 h-11 bg-slate-50 text-slate-600 hover:bg-slate-100 rounded-xl flex items-center justify-center transition-all active:scale-95"
                      title="编辑任务"
                    >
                      <Edit3 size={20} />
                    </button>
                    <button 
                      onClick={() => handleDeleteTask(task.id)}
                      className="w-11 h-11 bg-red-50 text-red-600 hover:bg-red-100 rounded-xl flex items-center justify-center transition-all active:scale-95"
                      title="删除任务"
                    >
                      <Trash2 size={20} />
                    </button>
                  </div>
                </div>
                
                {/* Last Sync Info */}
                {task.lastSyncTime && (
                  <div className="px-5 py-2 bg-slate-50 border-t border-slate-100 flex items-center justify-between">
                    <span className="text-[11px] text-slate-400 flex items-center gap-1">
                      <Clock size={12} />
                      最近同步: {task.lastSyncTime}
                    </span>
                    <button 
                      onClick={() => handleShowLogs(task.id)}
                      className="text-[11px] font-bold text-blue-600 hover:underline"
                    >
                      查看日志
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </main>

      {/* Log Modal */}
      {selectedTaskId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white w-full max-w-2xl rounded-3xl shadow-2xl overflow-hidden flex flex-col h-[70vh] animate-in zoom-in-95 duration-200">
            <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
              <div className="flex items-center gap-2">
                <Clock size={18} className="text-blue-600" />
                <h2 className="text-xl font-bold text-slate-800">同步日志 - {tasks.find(t => t.id === selectedTaskId)?.name}</h2>
              </div>
              <button onClick={() => setSelectedTaskId(null)} className="p-2 hover:bg-slate-200 rounded-full text-slate-400 transition-colors">
                <X size={20} />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4 bg-slate-950 font-mono text-[13px] leading-relaxed">
              {(logs[selectedTaskId] || []).length > 0 ? (
                (logs[selectedTaskId] || []).map((log, i) => (
                  <div key={i} className={cn(
                    "mb-1",
                    log.includes('ERROR') ? "text-red-400" : "text-emerald-400"
                  )}>
                    {log}
                  </div>
                ))
              ) : (
                <div className="text-slate-500 italic">等待日志输出...</div>
              )}
            </div>
            <div className="p-4 border-t border-slate-100 bg-white flex justify-end">
              <button 
                onClick={() => setSelectedTaskId(null)}
                className="px-6 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl transition-all"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white w-full max-w-lg rounded-3xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
              <h2 className="text-xl font-bold text-slate-800">{currentTask?.name ? '编辑任务' : '创建同步任务'}</h2>
              <button onClick={() => setIsModalOpen(false)} className="p-2 hover:bg-slate-200 rounded-full text-slate-400 transition-colors">
                <X size={20} />
              </button>
            </div>
            
            <div className="p-6 space-y-5">
              {/* Task Name */}
              <div className="space-y-1.5">
                <label className="text-sm font-bold text-slate-700 ml-1">任务名称</label>
                <input 
                  type="text" 
                  value={currentTask?.name || ''} 
                  onChange={e => setCurrentTask(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="例如：备份我的设计稿"
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                />
              </div>

              {/* Paths */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-sm font-bold text-slate-700 ml-1">源目录</label>
                  <button 
                    onClick={() => selectDir('sourcePath')}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-left text-sm text-slate-600 hover:border-blue-400 transition-colors truncate"
                  >
                    {currentTask?.sourcePath ? currentTask.sourcePath.split('/').pop() : '选择目录...'}
                  </button>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-bold text-slate-700 ml-1">目标目录</label>
                  <button 
                    onClick={() => selectDir('targetPath')}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-left text-sm text-slate-600 hover:border-blue-400 transition-colors truncate"
                  >
                    {currentTask?.targetPath ? currentTask.targetPath.split('/').pop() : '选择目录...'}
                  </button>
                </div>
              </div>

              {/* Direction */}
              <div className="space-y-1.5">
                <label className="text-sm font-bold text-slate-700 ml-1">同步方向</label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { id: 'bidirectional', label: '双向同步', icon: ArrowLeftRight },
                    { id: 'sourceToTarget', label: '源 → 目标', icon: ArrowRight },
                    { id: 'targetToSource', label: '目标 → 源', icon: ArrowLeftRight },
                  ].map(dir => (
                    <button
                      key={dir.id}
                      onClick={() => setCurrentTask(prev => ({ ...prev, direction: dir.id as any }))}
                      className={cn(
                        "flex flex-col items-center justify-center gap-1.5 py-3 border rounded-xl transition-all",
                        currentTask?.direction === dir.id 
                          ? "bg-blue-600 border-blue-600 text-white shadow-md shadow-blue-200" 
                          : "bg-white border-slate-200 text-slate-500 hover:border-slate-300"
                      )}
                    >
                      <dir.icon size={18} />
                      <span className="text-[11px] font-bold">{dir.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Mode */}
              <div className="space-y-1.5">
                <label className="text-sm font-bold text-slate-700 ml-1">执行策略</label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { id: 'realtime', label: '实时监控', icon: Zap },
                    { id: 'scheduled', label: '定时检查', icon: Clock },
                    { id: 'manual', label: '手动执行', icon: Play },
                  ].map(mode => (
                    <button
                      key={mode.id}
                      onClick={() => setCurrentTask(prev => ({ ...prev, mode: mode.id as any }))}
                      className={cn(
                        "flex flex-col items-center justify-center gap-1.5 py-3 border rounded-xl transition-all",
                        currentTask?.mode === mode.id 
                          ? "bg-blue-600 border-blue-600 text-white shadow-md shadow-blue-200" 
                          : "bg-white border-slate-200 text-slate-500 hover:border-slate-300"
                      )}
                    >
                      <mode.icon size={18} />
                      <span className="text-[11px] font-bold">{mode.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {currentTask?.mode === 'scheduled' && (
                <div className="space-y-1.5 animate-in slide-in-from-top-2 duration-200">
                  <label className="text-sm font-bold text-slate-700 ml-1">检查间隔 (分钟)</label>
                  <input 
                    type="number" 
                    value={currentTask?.interval || 5} 
                    onChange={e => setCurrentTask(prev => ({ ...prev, interval: parseInt(e.target.value) }))}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                </div>
              )}
            </div>

            <div className="p-6 bg-slate-50/50 border-t border-slate-100">
              <button 
                onClick={handleSaveTask}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-4 rounded-2xl transition-all shadow-lg shadow-blue-200 active:scale-[0.98]"
              >
                保存同步任务
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
