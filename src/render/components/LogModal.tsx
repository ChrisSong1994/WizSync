import React from "react";
import { X, Clock } from "lucide-react";
import { SyncTask } from "../types";
import { cn } from "../utils";

interface LogModalProps {
  taskId: string;
  tasks: SyncTask[];
  logs: Record<string, string[]>;
  onClose: () => void;
}

export const LogModal: React.FC<LogModalProps> = ({
  taskId,
  tasks,
  logs,
  onClose,
}) => {
  const taskName = tasks.find((t) => t.id === taskId)?.name;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white w-full max-w-5xl rounded-3xl shadow-2xl overflow-hidden flex flex-col h-[90vh] animate-in zoom-in-95 duration-200">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
          <div className="flex items-center gap-2">
            <Clock size={18} className="text-blue-600" />
            <h2 className="text-xl font-bold text-slate-800">
              同步日志 - {taskName}
            </h2>
          </div>
          <button
            onClick={onClose}
            style={{ WebkitAppRegion: "no-drag" } as any}
            className="p-2 hover:bg-slate-200 rounded-full text-slate-400 transition-colors"
          >
            <X size={20} />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4 bg-slate-950 font-mono text-[13px] leading-relaxed">
          {(logs[taskId] || []).length > 0 ? (
            (logs[taskId] || []).map((log, i) => (
              <div
                key={i}
                className={cn(
                  "mb-1",
                  (log.toLowerCase().includes("error") &&
                    !log.toLowerCase().includes("0 error")) ||
                    log.toLowerCase().includes("fatal") ||
                    (log.toLowerCase().includes("failed") &&
                      !log.toLowerCase().includes("0 failed"))
                    ? "text-red-400"
                    : "text-emerald-400",
                )}
              >
                {log}
              </div>
            ))
          ) : (
            <div className="text-slate-500 italic">等待日志输出...</div>
          )}
        </div>
      </div>
    </div>
  );
};
