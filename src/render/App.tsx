import { useState, useEffect } from "react";
import { SyncTask, DiffResult } from "./types";
import { Header } from "./components/Header";
import { TaskList } from "./components/TaskList";
import { TaskModal } from "./components/TaskModal";
import { LogModal } from "./components/LogModal";
import { DiffModal } from "./components/DiffModal";

function App() {
  const [tasks, setTasks] = useState<SyncTask[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [currentTask, setCurrentTask] = useState<Partial<SyncTask> | null>(null);
  const [logs, setLogs] = useState<Record<string, string[]>>({});
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [diffData, setDiffData] = useState<DiffResult | null>(null);
  const [comparingTaskId, setComparingTaskId] = useState<string | null>(null);

  useEffect(() => {
    const fetchTasks = async () => {
      const data = await window.electronAPI.getTasks();
      setTasks(data);
    };
    fetchTasks();

    window.electronAPI.onSyncStatus(({ id, status, lastSyncTime, sourceStats, targetStats }) => {
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? { ...t, status, lastSyncTime, sourceStats, targetStats } : t)),
      );
    });

    window.electronAPI.onSyncLog(({ id, log }) => {
      setLogs((prev) => ({
        ...prev,
        [id]: [...(prev[id] || []).slice(-99), log],
      }));
    });
  }, []);

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

  const handleEditTask = (task: SyncTask) => {
    setCurrentTask(task);
    setIsModalOpen(true);
  };

  const handleDeleteTask = async (id: string) => {
    const updatedTasks = await window.electronAPI.deleteTask(id);
    setTasks(updatedTasks);
  };

  const handleSaveTask = async () => {
    if (currentTask && currentTask.name && currentTask.sourcePath && currentTask.targetPath) {
      const updatedTasks = await window.electronAPI.saveTask(currentTask as SyncTask);
      setTasks(updatedTasks);
      setIsModalOpen(false);
      setCurrentTask(null);
    }
  };

  const handleToggleSync = async (task: SyncTask) => {
    if (task.status === "syncing") {
      setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: 'idle' } : t))
      await window.electronAPI.stopSync(task.id);
    } else {
      setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: 'syncing' } : t))
      await window.electronAPI.startSync(task.id);
    }
  };

  const selectDir = async (field: "sourcePath" | "targetPath") => {
    const path = await window.electronAPI.selectDirectory();
    if (path) {
      setCurrentTask((prev) => ({ ...prev, [field]: path }));
    }
  };

  const handleCompare = async (taskId: string) => {
    setComparingTaskId(taskId);
    setDiffData(null);
    try {
      const result = await window.electronAPI.compareDirectories(taskId);
      setDiffData(result);
    } catch (error) {
      console.error("Compare error:", error);
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
