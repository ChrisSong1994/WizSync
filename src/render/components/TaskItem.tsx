import React from "react";
import {
  Play,
  StopCircle,
  Trash2,
  Edit3,
  Clock,
  ArrowRight,
  ArrowLeftRight,
  AlertCircle,
  CheckCircle2,
  Loader2,
  FileSearch,
} from "lucide-react";
import { SyncTask } from "../types";
import { cn, formatSize } from "../utils";

interface TaskItemProps {
  task: SyncTask;
  onToggleSync: (task: SyncTask) => void;
  onEditTask: (task: SyncTask) => void;
  onDeleteTask: (id: string) => void;
  onShowLogs: (id: string) => void;
  onCompare: (id: string) => void;
}

export const TaskItem: React.FC<TaskItemProps> = ({
  task,
  onToggleSync,
  onEditTask,
  onDeleteTask,
  onShowLogs,
  onCompare,
}) => {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow overflow-hidden group">
      <div className="p-5 flex items-center gap-6">
        {/* 状态指示器 */}
        <div className="flex-shrink-0 relative">
          <div
            className={cn(
              "w-14 h-14 rounded-2xl flex items-center justify-center transition-colors",
              task.status === "syncing"
                ? "bg-blue-50 text-blue-600"
                : task.status === "error"
                  ? "bg-red-50 text-red-600"
                  : "bg-emerald-50 text-emerald-600",
            )}
          >
            {task.status === "syncing" ? (
              <Loader2 size={28} className="animate-spin" />
            ) : task.status === "error" ? (
              <AlertCircle size={28} />
            ) : (
              <CheckCircle2 size={28} />
            )}
          </div>
        </div>

        {/* 任务信息 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-lg font-bold text-slate-800 truncate">
              {task.name}
            </h3>
            <span
              className={cn(
                "px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider",
                task.mode === "realtime"
                  ? "bg-purple-100 text-purple-700"
                  : task.mode === "scheduled"
                    ? "bg-blue-100 text-blue-700"
                    : "bg-slate-100 text-slate-700",
              )}
            >
              {task.mode === "realtime"
                ? "实时监听"
                : task.mode === "scheduled"
                  ? `定时 (${task.interval}min)`
                  : "手动同步"}
            </span>
          </div>
          <div className="flex items-center gap-3 text-sm text-slate-500">
            <div className="flex flex-col">
              <span className="truncate max-w-[180px] font-mono bg-slate-50 px-2 py-0.5 rounded border border-slate-100">
                {task.sourcePath.split("/").pop()}
              </span>
              <div className="flex flex-col mt-0.5 ml-1">
                {task.sourceStats && (
                  <span className="text-[11px] text-slate-500">
                    {formatSize(task.sourceStats.size)} · {task.sourceStats.count} 文件
                  </span>
                )}
                {task.sourceDisk && (
                  <span className="text-[10px] text-slate-500">
                    磁盘:{" "}
                    <span className={cn(
                      task.sourceDisk.free < 200 * 1024 * 1024 
                        ? "text-red-500 font-bold" 
                        : task.sourceDisk.free < 1024 * 1024 * 1024 
                          ? "text-amber-500 font-bold" 
                          : "text-slate-500"
                    )}>
                      {formatSize(task.sourceDisk.free)} 剩余
                    </span>
                    {" "}/ {formatSize(task.sourceDisk.total)}
                  </span>
                )}
                </div>
                </div>

                {task.direction === "bidirectional" ? (
                <ArrowLeftRight
                size={14}
                className="text-slate-500 flex-shrink-0"
                />
                ) : (
                <ArrowRight size={14} className="text-slate-500 flex-shrink-0" />
                )}

                <div className="flex flex-col">
                <span className="truncate max-w-[180px] font-mono bg-slate-50 px-2 py-0.5 rounded border border-slate-100">
                {task.targetPath.split("/").pop()}
                </span>
                <div className="flex flex-col mt-0.5 ml-1">
                {task.targetStats && (
                  <span className="text-[11px] text-slate-500">
                    {formatSize(task.targetStats.size)} · {task.targetStats.count} 文件
                  </span>
                )}
                {task.targetDisk && (
                  <span className="text-[10px] text-slate-500">
                    磁盘:{" "}
                    <span className={cn(
                      task.targetDisk.free < 200 * 1024 * 1024 
                        ? "text-red-500 font-bold" 
                        : task.targetDisk.free < 1024 * 1024 * 1024 
                          ? "text-amber-500 font-bold" 
                          : "text-slate-500"
                    )}>
                      {formatSize(task.targetDisk.free)} 剩余
                    </span>
                    {" "}/ {formatSize(task.targetDisk.total)}
                  </span>
                )}
                </div>
                </div>          </div>
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => onCompare(task.id)}
            className="w-11 h-11 bg-slate-50 text-slate-600 hover:bg-slate-100 rounded-xl flex items-center justify-center transition-all active:scale-95"
            title="对比差异"
          >
            <FileSearch size={20} />
          </button>
          <button
            onClick={() => onToggleSync(task)}
            className={cn(
              "w-11 h-11 rounded-xl flex items-center justify-center transition-all active:scale-95",
              task.status === "syncing"
                ? "bg-amber-100 text-amber-600 hover:bg-amber-200"
                : "bg-blue-50 text-blue-600 hover:bg-blue-100",
            )}
            title={task.status === "syncing" ? "停止同步" : "开始同步"}
          >
            {task.status === "syncing" ? (
              <StopCircle size={22} />
            ) : (
              <Play size={22} fill="currentColor" />
            )}
          </button>
          <button
            onClick={() => onEditTask(task)}
            className="w-11 h-11 bg-slate-50 text-slate-600 hover:bg-slate-100 rounded-xl flex items-center justify-center transition-all active:scale-95"
            title="编辑任务"
          >
            <Edit3 size={20} />
          </button>
          <button
            onClick={() => onDeleteTask(task.id)}
            className="w-11 h-11 bg-red-50 text-red-600 hover:bg-red-100 rounded-xl flex items-center justify-center transition-all active:scale-95"
            title="删除任务"
          >
            <Trash2 size={20} />
          </button>
        </div>
      </div>

      {/* 最近同步信息 */}
      {task.lastSyncTime && (
        <div className="px-5 py-2 bg-slate-50 border-t border-slate-100 flex items-center justify-between">
          <span className="text-[12px] text-slate-500 flex items-center gap-1">
            <Clock size={12} />
            最近同步: {task.lastSyncTime}
          </span>
          <button
            onClick={() => onShowLogs(task.id)}
            className="text-[12px] font-bold text-blue-600 hover:underline"
          >
            查看日志
          </button>
        </div>
      )}
    </div>
  );
};
