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
  const [modalError, setModalError] = useState<string | null>(null); // 弹窗中的错误提示
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
    setModalError(null);
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
    setModalError(null);
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
      setModalError(null);
      // 路径冲突校验
      for (const task of tasks) {
        // 如果是编辑现有任务，跳过自身对比
        if (task.id === currentTask.id) continue;

        const existingPaths = [task.sourcePath, task.targetPath];
        const newPaths = [currentTask.sourcePath!, currentTask.targetPath!];

        for (const newPath of newPaths) {
          for (const existingPath of existingPaths) {
            // 1. 完全相同的路径
            if (newPath === existingPath) {
              setModalError(`路径冲突：目录 "${newPath}" 已在任务 "${task.name}" 中使用。`);
              return;
            }
            // 2. 嵌套关系检查 (newPath 是 existingPath 的子目录或父目录)
            if (newPath.startsWith(existingPath + '/') || existingPath.startsWith(newPath + '/')) {
              setModalError(`路径嵌套冲突：目录 "${newPath}" 与任务 "${task.name}" 中的 "${existingPath}" 存在嵌套关系。请避免重叠同步。`);
              return;
            }
          }
        }
      }

      const updatedTasks = await window.electronAPI.saveTask(currentTask as SyncTask);
      setTasks(updatedTasks);
      setIsModalOpen(false);
      setCurrentTask(null);
    } else {
      setModalError("请填写任务名称并选择源目录和目标目录。");
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
          error={modalError}
          onClose={() => {
            setIsModalOpen(false);
            setModalError(null);
          }}
          onSave={handleSaveTask}
          onSelectDir={selectDir}
          onChange={(updates) => {
            setModalError(null);
            setCurrentTask(prev => ({ ...prev, ...updates }));
          }}
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
