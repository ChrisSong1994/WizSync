import React, { useEffect, useState, useRef } from "react";
import { X, Clock, Trash2 } from "lucide-react";
import { SyncTask } from "../types";
import { cn } from "../utils";

interface LogModalProps {
  taskId: string;
  tasks: SyncTask[];
  onClose: () => void;
}

export const LogModal: React.FC<LogModalProps> = ({
  taskId,
  tasks,
  onClose,
}) => {
  const [persistentLogs, setPersistentLogs] = useState<string>("");
  const [sessionLogs, setSessionLogs] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taskName = tasks.find((t) => t.id === taskId)?.name;

  useEffect(() => {
    // 初始加载持久化日志
    const loadLogs = async () => {
      const logs = await window.electronAPI.getPersistentLogs(taskId);
      setPersistentLogs(logs);
    };
    loadLogs();

    // 监听实时日志追加
    const handleLog = (data: { id: string; log: string }) => {
      if (data.id === taskId) {
        setSessionLogs((prev) => [...prev, data.log]);
      }
    };

    window.electronAPI.onSyncLog(handleLog);

    // 自动滚动到底部
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [taskId]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [persistentLogs, sessionLogs]);

  const handleClearLogs = async () => {
    if (confirm("确定要清空该任务的所有持久化日志吗？")) {
      await window.electronAPI.clearPersistentLogs(taskId);
      setPersistentLogs("");
      setSessionLogs([]);
    }
  };

  const renderLogLine = (line: string, index: number | string) => {
    const isError = 
      (line.toLowerCase().includes("error") && !line.toLowerCase().includes("0 error")) ||
      line.toLowerCase().includes("fatal") ||
      (line.toLowerCase().includes("failed") && !line.toLowerCase().includes("0 failed")) ||
      line.includes("错误:");

    return (
      <div
        key={index}
        className={cn(
          "mb-1 whitespace-pre-wrap break-all",
          isError ? "text-red-400" : "text-emerald-400/90",
        )}
      >
        {line}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white w-full max-w-5xl rounded-3xl shadow-2xl overflow-hidden flex flex-col h-[90vh] animate-in zoom-in-95 duration-200">
        <div 
          className="px-4 py-3 border-b border-slate-100 flex items-center justify-between bg-slate-50/50"
          style={{ WebkitAppRegion: "drag" } as any}
        >
          <div className="flex items-center gap-2" style={{ WebkitAppRegion: "no-drag" } as any}>
            <Clock size={18} className="text-blue-600" />
            <h2 className="text-xl font-bold text-slate-800">
              同步日志 - {taskName}
            </h2>
          </div>
          <div className="flex items-center gap-1" style={{ WebkitAppRegion: "no-drag" } as any}>
            <button
              onClick={handleClearLogs}
              title="清空日志"
              className="p-2 hover:bg-red-50 rounded-full text-slate-400 hover:text-red-500 transition-all flex items-center justify-center"
            >
              <Trash2 size={18} />
            </button>
            <button
              onClick={onClose}
              className="p-2 hover:bg-slate-200 rounded-full text-slate-400 hover:text-slate-600 transition-colors flex items-center justify-center"
            >
              <X size={20} />
            </button>
          </div>
        </div>
        <div 
          ref={scrollRef}
          className="flex-1 overflow-auto p-4 bg-slate-950 font-mono text-[12px] leading-relaxed scroll-smooth"
        >
          {/* 历史持久化日志 */}
          {persistentLogs && (
            <div className="opacity-80">
              {persistentLogs.split('\n').map((line, i) => line && renderLogLine(line, `p-${i}`))}
            </div>
          )}
          
          {/* 当前会话日志 */}
          {sessionLogs.map((log, i) => renderLogLine(log, `s-${i}`))}

          {!persistentLogs && sessionLogs.length === 0 && (
            <div className="text-slate-500 italic">暂无同步日志...</div>
          )}
        </div>
      </div>
    </div>
  );
};
