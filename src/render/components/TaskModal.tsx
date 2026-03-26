import React from "react";
import { X, ArrowRight, ArrowLeftRight, Zap, Clock, Play } from "lucide-react";
import { SyncTask } from "../types";
import { cn } from "../utils";

interface TaskModalProps {
  currentTask: Partial<SyncTask> | null;
  onClose: () => void;
  onSave: () => void;
  onSelectDir: (field: "sourcePath" | "targetPath") => void;
  onChange: (updates: Partial<SyncTask>) => void;
}

export const TaskModal: React.FC<TaskModalProps> = ({
  currentTask,
  onClose,
  onSave,
  onSelectDir,
  onChange,
}) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white w-full max-w-md rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] animate-in zoom-in-95 duration-200">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between bg-slate-50/50 flex-shrink-0">
          <h2 className="text-xl font-bold text-slate-800">
            {currentTask?.name ? "编辑任务" : "创建同步任务"}
          </h2>
          <button
            onClick={onClose}
            style={{ WebkitAppRegion: "no-drag" } as any}
            className="p-2 hover:bg-slate-200 rounded-full text-slate-400 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        <div className="p-6 space-y-5 flex-1 overflow-y-auto">
          {/* 任务名称 */}
          <div className="space-y-1.5">
            <label className="text-sm font-bold text-slate-700 ml-1">
              任务名称
            </label>
            <input
              type="text"
              value={currentTask?.name || ""}
              onChange={(e) => onChange({ name: e.target.value })}
              placeholder="例如：备份我的设计稿"
              className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
            />
          </div>

          {/* 路径配置 */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-bold text-slate-700 ml-1">
                源目录
              </label>
              <button
                onClick={() => onSelectDir("sourcePath")}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-left text-sm text-slate-600 hover:border-blue-400 transition-colors truncate"
              >
                {currentTask?.sourcePath
                  ? currentTask.sourcePath.split("/").pop()
                  : "选择目录..."}
              </button>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-bold text-slate-700 ml-1">
                目标目录
              </label>
              <button
                onClick={() => onSelectDir("targetPath")}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-left text-sm text-slate-600 hover:border-blue-400 transition-colors truncate"
              >
                {currentTask?.targetPath
                  ? currentTask.targetPath.split("/").pop()
                  : "选择目录..."}
              </button>
            </div>
          </div>

          {/* 同步方向 */}
          <div className="space-y-1.5">
            <label className="text-sm font-bold text-slate-700 ml-1">
              同步方向
            </label>
            <div className="grid grid-cols-3 gap-2">
              {[
                { id: "bidirectional", label: "双向同步", icon: ArrowLeftRight },
                { id: "sourceToTarget", label: "源 → 目标", icon: ArrowRight },
                { id: "targetToSource", label: "目标 → 源", icon: ArrowLeftRight },
              ].map((dir) => (
                <button
                  key={dir.id}
                  onClick={() => onChange({ direction: dir.id as any })}
                  className={cn(
                    "flex flex-col items-center justify-center gap-1.5 py-3 border rounded-xl transition-all",
                    currentTask?.direction === dir.id
                      ? "bg-blue-600 border-blue-600 text-white shadow-md shadow-blue-200"
                      : "bg-white border-slate-200 text-slate-500 hover:border-slate-300",
                  )}
                >
                  <dir.icon size={18} />
                  <span className="text-[11px] font-bold">{dir.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* 执行策略 */}
          <div className="space-y-1.5">
            <label className="text-sm font-bold text-slate-700 ml-1">
              执行策略
            </label>
            <div className="grid grid-cols-3 gap-2">
              {[
                { id: "realtime", label: "实时监控", icon: Zap },
                { id: "scheduled", label: "定时检查", icon: Clock },
                { id: "manual", label: "手动执行", icon: Play },
              ].map((mode) => (
                <button
                  key={mode.id}
                  onClick={() => onChange({ mode: mode.id as any })}
                  className={cn(
                    "flex flex-col items-center justify-center gap-1.5 py-3 border rounded-xl transition-all",
                    currentTask?.mode === mode.id
                      ? "bg-blue-600 border-blue-600 text-white shadow-md shadow-blue-200"
                      : "bg-white border-slate-200 text-slate-500 hover:border-slate-300",
                  )}
                >
                  <mode.icon size={18} />
                  <span className="text-[11px] font-bold">{mode.label}</span>
                </button>
              ))}
            </div>
          </div>

          {currentTask?.mode === "scheduled" && (
            <div className="space-y-1.5 animate-in slide-in-from-top-2 duration-200">
              <label className="text-sm font-bold text-slate-700 ml-1">
                检查间隔 (分钟)
              </label>
              <input
                type="number"
                value={currentTask?.interval || 5}
                onChange={(e) => onChange({ interval: parseInt(e.target.value) })}
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
              />
            </div>
          )}

          {/* 高级选项 */}
          <div className="pt-2">
            <label className="flex items-center gap-3 cursor-pointer group">
              <div
                onClick={() => onChange({ useParallel: !currentTask?.useParallel })}
                className={cn(
                  "w-12 h-6 rounded-full transition-all relative flex items-center px-1",
                  currentTask?.useParallel ? "bg-blue-600" : "bg-slate-200",
                )}
              >
                <div
                  className={cn(
                    "w-4 h-4 bg-white rounded-full shadow-sm transition-all transform",
                    currentTask?.useParallel ? "translate-x-6" : "translate-x-0",
                  )}
                />
              </div>
              <div className="flex flex-col">
                <span className="text-sm font-bold text-slate-700">
                  启用多线程同步
                </span>
                <span className="text-[11px] text-slate-400">
                  在大批量小文件同步时显著提升速度
                </span>
              </div>
            </label>
          </div>
        </div>

        <div className="p-6 bg-slate-50/50 border-t border-slate-100 flex-shrink-0">
          <button
            onClick={onSave}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-4 rounded-2xl transition-all shadow-lg shadow-blue-200 active:scale-[0.98]"
          >
            保存同步任务
          </button>
        </div>
      </div>
    </div>
  );
};
