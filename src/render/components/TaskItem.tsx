import React, { useState, useRef, useEffect } from "react";
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
  MapPin,
  Archive,
  RotateCcw,
} from "lucide-react";
import { SyncTask } from "../types";
import { cn, formatSize } from "../utils";

interface TaskItemProps {
  task: SyncTask;
  onToggleSync: (task: SyncTask) => void;
  onEditTask: (task: SyncTask) => void;
  onDeleteTask: (id: string) => Promise<void>;
  onShowLogs: (id: string) => void;
  onCompare: (id: string) => void;
  onShowBackup: (id: string) => void;
}

export const TaskItem: React.FC<TaskItemProps> = ({
  task,
  onToggleSync,
  onEditTask,
  onDeleteTask,
  onShowLogs,
  onCompare,
  onShowBackup,
}) => {
  const [deleting, setDeleting] = useState(false);
  const [resetting, setResetting] = useState(false);

  const handleReveal = (side: "source" | "target") => {
    window.electronAPI.revealInFileExplorer(task.id, "", side);
  };

  const handleDeleteClick = async () => {
    if (
      !(await window.electronAPI.showConfirm(
        `确定要删除任务「${task.name}」吗？\n此操作将停止同步并清理相关进程。`,
      ))
    )
      return;
    setDeleting(true);
    await onDeleteTask(task.id);
  };

  const handleReset = async () => {
    if (
      !(await window.electronAPI.showConfirm(
        `确定要强制重置任务「${task.name}」吗？\n这将清理同步缓存并重新扫描所有文件，通常用于解决顽固报错。`,
      ))
    )
      return;
    setResetting(true);
    try {
      await window.electronAPI.resetSync(task.id);
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition-all duration-200 overflow-hidden group hover:border-slate-300">
      <div className="flex items-center gap-3 mb-0.5 px-5 pt-2 pb-2 border-b border-slate-100/60">
        <h3 className="text-[17px] font-bold text-slate-800 truncate tracking-tight">
          {task.name}
        </h3>
        <span
          className={cn(
            "px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider shadow-sm",
            task.mode === "realtime"
              ? "bg-purple-100 text-purple-700 ring-1 ring-purple-200"
              : task.mode === "scheduled"
                ? "bg-blue-100 text-blue-700 ring-1 ring-blue-200"
                : "bg-slate-100 text-slate-700 ring-1 ring-slate-200",
          )}
        >
          {task.mode === "realtime"
            ? "实时"
            : task.mode === "scheduled"
              ? `定时 ${task.interval}m`
              : "手动"}
        </span>

        {/* 头部操作按钮 */}
        <div className="flex items-center gap-1.5 ml-auto opacity-70 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() => onEditTask(task)}
            className="w-8 h-8 rounded-lg flex items-center justify-center transition-all active:scale-95 text-slate-500 hover:bg-slate-100 hover:text-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-100"
            title="修改任务配置"
          >
            <Edit3 size={15} />
          </button>
          <button
            onClick={handleDeleteClick}
            disabled={deleting}
            className={cn(
              "w-8 h-8 rounded-lg flex items-center justify-center transition-all active:scale-95 focus:outline-none focus:ring-2 focus:ring-red-100",
              deleting
                ? "text-slate-300 cursor-not-allowed"
                : "text-slate-500 hover:bg-red-50 hover:text-red-600",
            )}
            title="移除此任务"
          >
            {deleting ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <Trash2 size={15} />
            )}
          </button>
        </div>
      </div>

      <div className="p-3 flex items-center gap-6">
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
          <div className="flex items-center gap-3 text-sm text-slate-500 mb-3">
            <div className="flex flex-col">
              <div className="flex items-center gap-1 group/path">
                <span className="truncate max-w-[180px] font-mono bg-slate-50 px-2 py-0.5 rounded border border-slate-100">
                  {task.sourcePath.split("/").pop()}
                </span>
                <button
                  onClick={() => handleReveal("source")}
                  className="p-1 hover:bg-slate-100 rounded text-slate-400 hover:text-blue-600 transition-colors"
                  title="在访达/资源管理器中定位"
                >
                  <MapPin size={12} />
                </button>
              </div>
              <div className="flex flex-col mt-0.5 ml-1">
                {task.sourceStats && (
                  <span className="text-[11px] text-slate-500">
                    {formatSize(task.sourceStats.size)} ·{" "}
                    {task.sourceStats.count} 文件
                  </span>
                )}
                {task.sourceDisk ? (
                  <span className="text-[10px] text-slate-500">
                    磁盘:{" "}
                    <span
                      className={cn(
                        task.sourceDisk.free < 200 * 1024 * 1024
                          ? "text-red-500 font-bold"
                          : task.sourceDisk.free < 1024 * 1024 * 1024
                            ? "text-amber-500 font-bold"
                            : "text-slate-500",
                      )}
                    >
                      {formatSize(task.sourceDisk.free)} 剩余
                    </span>{" "}
                    / {formatSize(task.sourceDisk.total)}
                  </span>
                ) : (
                  <span className="text-[10px] text-red-500 font-bold">
                    磁盘未连接
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
              <div className="flex items-center gap-1 group/path">
                <span className="truncate max-w-[180px] font-mono bg-slate-50 px-2 py-0.5 rounded border border-slate-100">
                  {task.targetPath.split("/").pop()}
                </span>
                <button
                  onClick={() => handleReveal("target")}
                  className="p-1 hover:bg-slate-100 rounded text-slate-400 hover:text-blue-600 transition-colors"
                  title="在访达/资源管理器中定位"
                >
                  <MapPin size={12} />
                </button>
              </div>
              <div className="flex flex-col mt-0.5 ml-1">
                {task.targetStats && (
                  <span className="text-[11px] text-slate-500">
                    {formatSize(task.targetStats.size)} ·{" "}
                    {task.targetStats.count} 文件
                  </span>
                )}
                {task.targetDisk ? (
                  <span className="text-[10px] text-slate-500">
                    磁盘:{" "}
                    <span
                      className={cn(
                        task.targetDisk.free < 200 * 1024 * 1024
                          ? "text-red-500 font-bold"
                          : task.targetDisk.free < 1024 * 1024 * 1024
                            ? "text-amber-500 font-bold"
                            : "text-slate-500",
                      )}
                    >
                      {formatSize(task.targetDisk.free)} 剩余
                    </span>{" "}
                    / {formatSize(task.targetDisk.total)}
                  </span>
                ) : (
                  <span className="text-[10px] text-red-500 font-bold">
                    磁盘未连接
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1">
          {/* 对比差异 - 幽灵按钮 */}
          <button
            onClick={() => onCompare(task.id)}
            className="w-10 h-10 rounded-xl flex items-center justify-center transition-all active:scale-95 text-slate-400 hover:bg-slate-100 hover:text-blue-600"
            title={
              task.status === "syncing" ? "查看实时同步差异" : "对比差异分析"
            }
          >
            <FileSearch size={18} />
          </button>

          <button
            onClick={() => onShowBackup(task.id)}
            className="w-10 h-10 rounded-xl flex items-center justify-center transition-all active:scale-95 text-slate-400 hover:bg-slate-100 hover:text-blue-600"
            title="管理备份快照"
          >
            <Archive size={18} />
          </button>

          {/* 强制重启 - 幽灵按钮 */}
          <button
            onClick={handleReset}
            disabled={task.status === "syncing" || resetting}
            className={cn(
              "w-10 h-10 rounded-xl flex items-center justify-center transition-all active:scale-95",
              task.status === "syncing" || resetting
                ? "text-slate-200 cursor-not-allowed"
                : "text-slate-400 hover:bg-amber-50 hover:text-amber-600",
            )}
            title="强制重置同步状态 (解决顽固报错)"
          >
            {resetting ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <RotateCcw size={18} />
            )}
          </button>

          {/* 分隔线 */}
          <div className="w-px h-6 bg-slate-100 mx-1" />

          {/* 同步主按钮 - 核心视觉焦点 */}
          <button
            onClick={() => onToggleSync(task)}
            className={cn(
              "h-10 px-4 rounded-xl flex items-center justify-center gap-2 transition-all active:scale-95 shadow-sm",
              task.status === "syncing"
                ? "bg-amber-100 text-amber-600 hover:bg-amber-200"
                : "bg-blue-600 text-white shadow-blue-100 hover:bg-blue-700 hover:shadow-lg hover:shadow-blue-200",
            )}
            title={task.status === "syncing" ? "停止当前同步" : "立即开始同步"}
          >
            {task.status === "syncing" ? (
              <>
                <StopCircle size={18} />
                <span className="text-sm font-bold">停止</span>
              </>
            ) : (
              <>
                <Play size={18} fill="currentColor" />
                <span className="text-sm font-bold">同步</span>
              </>
            )}
          </button>
        </div>
      </div>
      {/* 底部信息栏：最后同步 & 运行日志 */}
      <div className="flex items-center justify-between text-[11px] text-slate-400 mt-2 pt-2 border-t border-slate-100 bg-slate-50/50 px-5 pb-2">
        <div className="flex items-center gap-1.5 ">
          {task.lastSyncTime ? (
            <>
              <Clock size={12} className="text-slate-400" />
              <span>最后同步: {task.lastSyncTime}</span>
            </>
          ) : (
            <span className="text-slate-400">尚未同步</span>
          )}
        </div>
        <button
          onClick={() => onShowLogs(task.id)}
          className="flex items-center gap-1  text-slate-500 hover:text-blue-600 transition-colors font-medium group/log"
          title="查看运行日志"
        >
          <span>运行日志</span>
          <ArrowRight size={12} className="group-hover/log:translate-x-0.5 transition-transform" />
        </button>
      </div>
    </div>
  );
};
