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
  MoreVertical,
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
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleReveal = (side: "source" | "target") => {
    window.electronAPI.revealInFileExplorer(task.id, "", side);
  };

  const handleDeleteClick = async () => {
    setShowMenu(false);
    if (!await window.electronAPI.showConfirm(`确定要删除任务「${task.name}」吗？\n此操作将停止同步并清理相关进程。`)) return;
    setDeleting(true);
    await onDeleteTask(task.id);
  };

  const handleReset = async () => {
    if (!await window.electronAPI.showConfirm(`确定要强制重置任务「${task.name}」吗？\n这将清理同步缓存并重新扫描所有文件，通常用于解决顽固报错。`)) return;
    setResetting(true);
    try {
      await window.electronAPI.resetSync(task.id);
    } finally {
      setResetting(false);
    }
  };

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
          <div className="flex items-center gap-2 mb-0.5">
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
                ? "实时"
                : task.mode === "scheduled"
                  ? `定时 ${task.interval}m`
                  : "手动"}
            </span>
          </div>

          {/* 最近同步时间移到这里 */}
          {task.lastSyncTime && (
            <div className="flex items-center gap-1 text-[11px] text-slate-400 mb-2">
              <Clock size={11} />
              <span>最后同步: {task.lastSyncTime}</span>
            </div>
          )}

          <div className="flex items-center gap-3 text-sm text-slate-500">
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
                    {formatSize(task.sourceStats.size)} · {task.sourceStats.count} 文件
                  </span>
                )}
                {task.sourceDisk ? (
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
                    {formatSize(task.targetStats.size)} · {task.targetStats.count} 文件
                  </span>
                )}
                {task.targetDisk ? (
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
                ) : (
                  <span className="text-[10px] text-red-500 font-bold">
                    磁盘未连接
                  </span>
                )}
                </div>
                </div>          </div>
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center gap-1">
          {/* 对比差异 - 幽灵按钮 */}
          <button
            onClick={() => onCompare(task.id)}
            className="w-10 h-10 rounded-xl flex items-center justify-center transition-all active:scale-95 text-slate-400 hover:bg-slate-100 hover:text-blue-600"
            title={task.status === "syncing" ? "查看实时同步差异" : "对比差异分析"}
          >
            <FileSearch size={18} />
          </button>
          
          {/* 强制重启 - 幽灵按钮 */}
          <button
            onClick={handleReset}
            disabled={task.status === "syncing" || resetting}
            className={cn(
              "w-10 h-10 rounded-xl flex items-center justify-center transition-all active:scale-95",
              task.status === "syncing" || resetting
                ? "text-slate-200 cursor-not-allowed"
                : "text-slate-400 hover:bg-amber-50 hover:text-amber-600"
            )}
            title="强制重置同步状态 (解决顽固报错)"
          >
            {resetting ? <Loader2 size={16} className="animate-spin" /> : <RotateCcw size={18} />}
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

          {/* 更多菜单 */}
          <div className="relative ml-1" ref={menuRef}>
            <button
              onClick={() => setShowMenu(!showMenu)}
              className={cn(
                "w-10 h-10 rounded-xl flex items-center justify-center transition-all active:scale-95",
                showMenu ? "bg-slate-100 text-slate-800" : "text-slate-300 hover:bg-slate-50 hover:text-slate-600"
              )}
            >
              <MoreVertical size={18} />
            </button>

            {showMenu && (
              <div className="absolute right-0 top-full mt-2 w-52 bg-white rounded-2xl shadow-2xl border border-slate-100 py-2 z-50 animate-in fade-in zoom-in duration-200 origin-top-right">
                <div className="px-3 py-1.5 text-[10px] font-bold text-slate-400 uppercase tracking-wider">配置与维护</div>
                <button
                  onClick={() => { onEditTask(task); setShowMenu(false); }}
                  className="w-full px-4 py-2.5 flex items-center gap-3 text-sm text-slate-600 hover:bg-slate-50 transition-colors"
                >
                  <Edit3 size={16} className="text-slate-400" />
                  <span>修改任务配置</span>
                </button>
                <button
                  onClick={() => { onShowLogs(task.id); setShowMenu(false); }}
                  className="w-full px-4 py-2.5 flex items-center gap-3 text-sm text-slate-600 hover:bg-slate-50 transition-colors"
                >
                  <Clock size={16} className="text-slate-400" />
                  <span>查看运行日志</span>
                </button>
                <button
                  onClick={() => { onShowBackup(task.id); setShowMenu(false); }}
                  className="w-full px-4 py-2.5 flex items-center gap-3 text-sm text-slate-600 hover:bg-slate-50 transition-colors"
                >
                  <Archive size={16} className="text-slate-400" />
                  <span>管理备份快照</span>
                </button>
                <div className="h-px bg-slate-50 my-1.5 mx-2" />
                <button
                  onClick={handleDeleteClick}
                  disabled={deleting}
                  className="w-full px-4 py-2.5 flex items-center gap-3 text-sm text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
                >
                  {deleting ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Trash2 size={16} />
                  )}
                  <span>移除此任务</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
