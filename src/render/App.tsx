import { useState, useEffect } from "react";
import { SyncTask, DiffResult } from "./types";
import { Header } from "./components/Header";
import { TaskList } from "./components/TaskList";
import { TaskModal } from "./components/TaskModal";
import { LogModal } from "./components/LogModal";
import { DiffModal } from "./components/DiffModal";

/**
 * 应用主组件，管理所有同步任务的状态和交互
 */
function App() {
  const [tasks, setTasks] = useState<SyncTask[]>([]); // 任务列表
  const [isModalOpen, setIsModalOpen] = useState(false); // 是否显示新增/编辑弹窗
  const [currentTask, setCurrentTask] = useState<Partial<SyncTask> | null>(null); // 当前正在操作的任务
  const [logs, setLogs] = useState<Record<string, string[]>>({}); // 任务日志存储
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null); // 当前选中的日志任务 ID
  const [diffData, setDiffData] = useState<DiffResult | null>(null); // 文件差异结果
  const [comparingTaskId, setComparingTaskId] = useState<string | null>(null); // 正在执行对比的任务 ID

  useEffect(() => {
    // 初始加载任务列表
    const fetchTasks = async () => {
      const data = await window.electronAPI.getTasks();
      setTasks(data);
    };
    fetchTasks();

    // 监听同步状态更新
    window.electronAPI.onSyncStatus(({ id, status, lastSyncTime, sourceStats, targetStats }) => {
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? { ...t, status, lastSyncTime, sourceStats, targetStats } : t)),
      );
    });

    // 监听同步日志
    window.electronAPI.onSyncLog(({ id, log }) => {
      setLogs((prev) => ({
        ...prev,
        [id]: [...(prev[id] || []).slice(-99), log], // 保留最近 100 条日志
      }));
    });
  }, []);

  /**
   * 初始化新增任务
   */
  const handleAddTask = () => {
    setCurrentTask({
      id: Math.random().toString(36).substr(2, 9),
      name: "",
      sourcePath: "",
      targetPath: "",
      mode: "manual",
      interval: 5,
      direction: "bidirectional",
      status: "idle",
    });
    setIsModalOpen(true);
  };

  /**
   * 编辑现有任务
   */
  const handleEditTask = (task: SyncTask) => {
    setCurrentTask(task);
    setIsModalOpen(true);
  };

  /**
   * 删除任务
   */
  const handleDeleteTask = async (id: string) => {
    const updatedTasks = await window.electronAPI.deleteTask(id);
    setTasks(updatedTasks);
  };

  /**
   * 保存任务（新增或更新）
   */
  const handleSaveTask = async () => {
    if (currentTask && currentTask.name && currentTask.sourcePath && currentTask.targetPath) {
      const updatedTasks = await window.electronAPI.saveTask(currentTask as SyncTask);
      setTasks(updatedTasks);
      setIsModalOpen(false);
      setCurrentTask(null);
    }
  };

  /**
   * 切换同步状态（启动/停止）
   */
  const handleToggleSync = async (task: SyncTask) => {
    if (task.status === "syncing") {
      setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: 'idle' } : t))
      await window.electronAPI.stopSync(task.id);
    } else {
      setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: 'syncing' } : t))
      await window.electronAPI.startSync(task.id);
    }
  };

  /**
   * 调用系统对话框选择目录
   */
  const selectDir = async (field: "sourcePath" | "targetPath") => {
    const path = await window.electronAPI.selectDirectory();
    if (path) {
      setCurrentTask((prev) => ({ ...prev, [field]: path }));
    }
  };

  /**
   * 对比两个目录的差异
   */
  const handleCompare = async (taskId: string) => {
    setComparingTaskId(taskId);
    setDiffData(null);
    try {
      const result = await window.electronAPI.compareDirectories(taskId);
      setDiffData(result);
    } catch (error) {
      console.error("对比失败:", error);
      setComparingTaskId(null);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans flex flex-col">
      <Header onAddTask={handleAddTask} />
      
      <TaskList
        tasks={tasks}
        onToggleSync={handleToggleSync}
        onEditTask={handleEditTask}
        onDeleteTask={handleDeleteTask}
        onShowLogs={setSelectedTaskId}
        onCompare={handleCompare}
      />

      {isModalOpen && (
        <TaskModal
          currentTask={currentTask}
          onClose={() => setIsModalOpen(false)}
          onSave={handleSaveTask}
          onSelectDir={selectDir}
          onChange={(updates) => setCurrentTask(prev => ({ ...prev, ...updates }))}
        />
      )}

      {selectedTaskId && (
        <LogModal
          taskId={selectedTaskId}
          tasks={tasks}
          logs={logs}
          onClose={() => setSelectedTaskId(null)}
        />
      )}

      {comparingTaskId && (
        <DiffModal
          taskId={comparingTaskId}
          tasks={tasks}
          diffData={diffData}
          onClose={() => setComparingTaskId(null)}
        />
      )}
    </div>
  );
}

export default App;
