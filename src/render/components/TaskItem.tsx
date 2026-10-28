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
import { Tooltip } from "./Tooltip";
import { ConfirmDialog } from "./ConfirmDialog";

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
  // 前端确认弹窗：'delete' | 'reset'，null 表示未打开
  const [confirmAction, setConfirmAction] = useState<"delete" | "reset" | null>(null);
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

  // 打开前端确认弹窗（真正的删除/重置动作在 confirmDelete / confirmReset 中执行）
  const handleDeleteClick = () => {
    setShowMenu(false);
    setConfirmAction("delete");
  };

  const handleReset = () => {
    setShowMenu(false);
    setConfirmAction("reset");
  };

  const confirmDelete = async () => {
    setDeleting(true);
    try {
      await onDeleteTask(task.id);
    } finally {
      setDeleting(false);
      setConfirmAction(null);
    }
  };

  const confirmReset = async () => {
    setResetting(true);
    try {
      await window.electronAPI.resetSync(task.id);
    } finally {
      setResetting(false);
      setConfirmAction(null);
    }
  };

  // 各操作按钮的提示文案（随状态变化）
  const diskDisconnected = !task.sourceDisk || !task.targetDisk;
  const compareTooltip =
    task.status === "syncing"
      ? "同步进行中，无法对比"
      : diskDisconnected
        ? "磁盘未连接，无法对比"
        : "对比两个目录的差异";
  const syncTooltip =
    task.status === "syncing"
      ? "停止同步"
      : diskDisconnected
        ? "磁盘未连接，无法同步"
        : "开始同步";

  // 注意：卡片上不能加 overflow-hidden，否则右下角 More 的下拉菜单会被卡片裁掉
  return (
    <>
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow group">
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
                task.mode === "scheduled"
                  ? "bg-blue-100 text-blue-700"
                  : "bg-slate-100 text-slate-700",
              )}
            >
              {task.mode === "scheduled"
                ? `定时 (${task.interval}min)`
                : "手动同步"}
            </span>
          </div>
          <div className="flex items-center gap-3 text-sm text-slate-500">
            <div className="flex flex-col">
              {task.sourceDisk?.name && (
                <span className="text-[10px] font-black text-blue-600 ml-1 mb-0.5 uppercase tracking-tighter">
                  {task.sourceDisk.name}
                </span>
              )}
              <div className="flex items-center gap-1 group/path">
                <span className="truncate max-w-[200px] font-mono bg-slate-50 px-2 py-0.5 rounded border border-slate-100 text-slate-700 font-bold">
                  {task.sourcePath.split("/").filter(Boolean).pop() || "/"}
                </span>
                <Tooltip content="定位到源目录" side="bottom">
                  <button
                    onClick={() => handleReveal("source")}
                    className="p-1 hover:bg-slate-100 rounded text-slate-400 hover:text-blue-600 transition-colors"
                  >
                    <MapPin size={12} />
                  </button>
                </Tooltip>
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
                className="text-slate-500 flex-shrink-0 mt-3"
              />
            ) : (
              <ArrowRight size={14} className="text-slate-500 flex-shrink-0 mt-3" />
            )}
            <div className="flex flex-col">
              {task.targetDisk?.name && (
                <span className="text-[10px] font-black text-blue-600 ml-1 mb-0.5 uppercase tracking-tighter">
                  {task.targetDisk.name}
                </span>
              )}
              <div className="flex items-center gap-1 group/path">
                <span className="truncate max-w-[200px] font-mono bg-slate-50 px-2 py-0.5 rounded border border-slate-100 text-slate-700 font-bold">
                  {task.targetPath.split("/").filter(Boolean).pop() || "/"}
                </span>
                <Tooltip content="定位到目标目录" side="bottom">
                  <button
                    onClick={() => handleReveal("target")}
                    className="p-1 hover:bg-slate-100 rounded text-slate-400 hover:text-blue-600 transition-colors"
                  >
                    <MapPin size={12} />
                  </button>
                </Tooltip>
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
            </div>{" "}
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center gap-2">
          <Tooltip content={compareTooltip}>
            <button
              onClick={() => onCompare(task.id)}
              disabled={task.status === "syncing" || diskDisconnected}
              className={cn(
                "w-11 h-11 rounded-xl flex items-center justify-center transition-all active:scale-95",
                task.status === "syncing" || diskDisconnected
                  ? "bg-slate-50 text-slate-300 cursor-not-allowed"
                  : "bg-slate-50 text-slate-600 hover:bg-slate-100",
              )}
            >
              <FileSearch size={20} />
            </button>
          </Tooltip>
          <Tooltip content={syncTooltip}>
            <button
              onClick={() => onToggleSync(task)}
              disabled={diskDisconnected && task.status !== "syncing"}
              className={cn(
                "w-11 h-11 rounded-xl flex items-center justify-center transition-all active:scale-95",
                diskDisconnected && task.status !== "syncing"
                  ? "bg-slate-50 text-slate-300 cursor-not-allowed"
                  : task.status === "syncing"
                    ? "bg-amber-100 text-amber-600 hover:bg-amber-200"
                    : "bg-blue-50 text-blue-600 hover:bg-blue-100",
              )}
            >
              {task.status === "syncing" ? (
                <StopCircle size={22} />
              ) : (
                <Play size={22} fill="currentColor" />
              )}
            </button>
          </Tooltip>
          <Tooltip content="编辑任务">
            <button
              onClick={() => onEditTask(task)}
              className="w-11 h-11 bg-slate-50 text-slate-600 hover:bg-slate-100 rounded-xl flex items-center justify-center transition-all active:scale-95"
            >
              <Edit3 size={20} />
            </button>
          </Tooltip>

          {/* 更多操作：备份 / 重置 / 删除 */}
          <div className="relative" ref={menuRef}>
            <Tooltip content="更多操作">
              <button
                onClick={() => setShowMenu((v) => !v)}
                className="w-11 h-11 bg-slate-50 text-slate-600 hover:bg-slate-100 rounded-xl flex items-center justify-center transition-all active:scale-95"
              >
                <MoreVertical size={20} />
              </button>
            </Tooltip>

            {showMenu && (
              <div className="absolute right-0 top-full mt-1.5 w-44 bg-white rounded-xl border border-slate-200 shadow-lg z-50 py-1.5">
                <button
                  onClick={() => {
                    setShowMenu(false);
                    onShowBackup(task.id);
                  }}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2 text-[13px] text-slate-700 hover:bg-slate-50 transition-colors"
                >
                  <Archive size={16} className="text-slate-400" />
                  查看备份数据
                </button>
                <button
                  onClick={handleReset}
                  disabled={task.status === "syncing" || resetting || diskDisconnected}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2 text-[13px] text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {resetting ? (
                    <Loader2 size={16} className="animate-spin text-amber-500" />
                  ) : (
                    <RotateCcw size={16} className="text-amber-500" />
                  )}
                  强制重置
                </button>
                <div className="border-t border-slate-100 my-1" />
                <button
                  onClick={handleDeleteClick}
                  disabled={deleting}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2 text-[13px] text-red-600 hover:bg-red-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {deleting ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Trash2 size={16} />
                  )}
                  删除任务
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 最近同步信息 */}
      {task.lastSyncTime && (
        <div className="px-5 py-2 bg-slate-50 border-t border-slate-100 rounded-b-2xl flex items-center justify-between">
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

    {/* 前端确认弹窗（替代 Electron 原生 dialog） */}
      {confirmAction === "delete" && (
        <ConfirmDialog
          title="删除任务"
          message={`确定要删除任务「${task.name}」吗？\n此操作将停止同步并清理相关进程。`}
          confirmText="删除"
          cancelText="取消"
          danger
          loading={deleting}
          onConfirm={confirmDelete}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {confirmAction === "reset" && (
        <ConfirmDialog
          title="强制重置"
          message={`确定要强制重置任务「${task.name}」吗？\n这将清理同步缓存并重新扫描所有文件，通常用于解决顽固报错。`}
          confirmText="重置"
          cancelText="取消"
          loading={resetting}
          onConfirm={confirmReset}
          onCancel={() => setConfirmAction(null)}
        />
      )}
    </>
  );
};
