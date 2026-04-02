import React, { useEffect, useState, useRef } from "react";
import { X, Clock, Trash2, FolderOpen, ArrowDownToLine, ArrowDownFromLine } from "lucide-react";
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
  const [autoScroll, setAutoScroll] = useState(true);
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

    return () => {
      // 清理监听器（如果 preload 提供了移除方法的话，目前是全局监听）
    };
  }, [taskId]);

  // 当日志更新时自动滚动到底部
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [persistentLogs, sessionLogs, autoScroll]);

  // 监听滚动事件来判断用户是否手动向上滚动，如果是则暂停自动滚动
  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    // 如果距离底部超过 50px，则关闭自动滚动
    if (scrollHeight - scrollTop - clientHeight > 50) {
      if (autoScroll) setAutoScroll(false);
    } else {
      if (!autoScroll) setAutoScroll(true);
    }
  };

  const handleClearLogs = async () => {
    if (await window.electronAPI.showConfirm("确定要清空该任务的所有持久化日志吗？")) {
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
          "mb-1 whitespace-pre-wrap break-all text-emerald-400/90",
          isError && "text-red-400"
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
          className="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between bg-slate-50/50"
          style={{ WebkitAppRegion: "drag" } as any}
        >
          <div className="flex items-center gap-2" style={{ WebkitAppRegion: "no-drag" } as any}>
            <Clock size={16} className="text-blue-600" />
            <h2 className="text-lg font-bold text-slate-800">
              同步日志 - {taskName}
            </h2>
          </div>
          <div className="flex items-center gap-1" style={{ WebkitAppRegion: "no-drag" } as any}>
            <button
              onClick={() => window.electronAPI.openLogFolder(taskId)}
              title="打开日志文件夹"
              className="p-2 hover:bg-blue-50 rounded-full text-slate-400 hover:text-blue-600 transition-all flex items-center justify-center"
            >
              <FolderOpen size={18} />
            </button>
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
        <div className="relative flex-1 flex flex-col overflow-hidden">
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            title={autoScroll ? "关闭自动滚动" : "开启自动滚动并滚到底部"}
            className={cn(
              "absolute right-6 top-4 z-10 p-2 rounded-full shadow-lg transition-all flex items-center justify-center backdrop-blur-md border",
              autoScroll
                ? "bg-blue-500/20 text-blue-400 border-blue-500/30 hover:bg-blue-500/30"
                : "bg-slate-800/80 text-slate-400 border-slate-700 hover:text-white hover:bg-slate-700/80 animate-pulse"
            )}
          >
            {autoScroll ? <ArrowDownFromLine size={16} /> : <ArrowDownToLine size={16} />}
          </button>
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="flex-1 overflow-auto p-4 bg-slate-950 font-mono text-[12px] leading-relaxed scroll-smooth relative"
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
    </div>
  );
};
