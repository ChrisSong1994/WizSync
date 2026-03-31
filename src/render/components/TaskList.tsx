import React from "react";
import { FolderSync } from "lucide-react";
import { SyncTask } from "../types";
import { TaskItem } from "./TaskItem";

interface TaskListProps {
  tasks: SyncTask[];
  onToggleSync: (task: SyncTask) => void;
  onEditTask: (task: SyncTask) => void;
  onDeleteTask: (id: string) => void;
  onShowLogs: (id: string) => void;
  onCompare: (id: string) => void;
  onShowBackup: (id: string) => void;
}

export const TaskList: React.FC<TaskListProps> = ({
  tasks,
  onToggleSync,
  onEditTask,
  onDeleteTask,
  onShowLogs,
  onCompare,
  onShowBackup,
}) => {
  return (
    <main className="flex-1 max-w-5xl mx-auto w-full p-6">
      <div className="grid gap-6">
        {tasks.length === 0 ? (
          <div className="bg-white rounded-3xl border border-dashed border-slate-300 p-20 flex flex-col items-center justify-center text-center shadow-sm">
            <div className="w-20 h-20 bg-slate-50 rounded-full flex items-center justify-center text-slate-300 mb-6">
              <FolderSync size={40} />
            </div>
            <h3 className="text-xl font-bold text-slate-700">
              开启您的同步旅程
            </h3>
            <p className="text-slate-500 max-w-xs mt-3 leading-relaxed">
              尚未创建任何同步任务。点击右上角的“添加任务”按钮，轻松实现目录自动化管理。
            </p>
          </div>
        ) : (
          tasks.map((task) => (
            <TaskItem
              key={task.id}
              task={task}
              onToggleSync={onToggleSync}
              onEditTask={onEditTask}
              onDeleteTask={onDeleteTask}
              onShowLogs={onShowLogs}
              onCompare={onCompare}
              onShowBackup={onShowBackup}
            />
          ))
        )}
      </div>
    </main>
  );
};
