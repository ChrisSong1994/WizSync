import React, { useEffect, useState, useRef, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
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

  // 将持久化日志与当前会话日志合并为统一的「行」数组，供虚拟列表渲染。
  // 仅保留非空行；sessionLogs 的每个元素视为一个整体条目（内部换行由 pre-wrap 处理）。
  const { lines, persistentLineCount } = useMemo(() => {
    const result: string[] = [];
    if (persistentLogs) {
      for (const line of persistentLogs.split("\n")) {
        if (line.length > 0) result.push(line);
      }
    }
    const persistentLineCount = result.length;
    result.push(...sessionLogs);
    return { lines: result, persistentLineCount };
  }, [persistentLogs, sessionLogs]);

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    // 单行（12px + leading-relaxed）约 24px；换行等实际高度由 measureElement 动态修正
    estimateSize: () => 24,
    overscan: 30,
  });

  // 新日志到达且处于自动滚动时，滚动到底部
  useEffect(() => {
    if (autoScroll && lines.length > 0) {
      virtualizer.scrollToIndex(lines.length - 1, { align: "end" });
    }
  }, [lines.length, autoScroll, virtualizer]);

  // 监听滚动事件来判断用户是否手动向上滚动，如果是则暂停自动滚动
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
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

  const isErrorLine = (line: string) =>
    (line.toLowerCase().includes("error") && !line.toLowerCase().includes("0 error")) ||
    line.toLowerCase().includes("fatal") ||
    (line.toLowerCase().includes("failed") && !line.toLowerCase().includes("0 failed")) ||
    line.includes("错误:");

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
            className="flex-1 overflow-auto p-4 bg-slate-950 font-mono text-[12px] leading-relaxed relative"
          >
            {lines.length === 0 ? (
              <div className="text-slate-500 italic">暂无同步日志...</div>
            ) : (
              <div
                style={{
                  height: virtualizer.getTotalSize(),
                  position: "relative",
                  width: "100%",
                }}
              >
                {virtualizer.getVirtualItems().map((item) => {
                  const line = lines[item.index];
                  const isError = isErrorLine(line);
                  return (
                    <div
                      key={item.key}
                      data-index={item.index}
                      ref={virtualizer.measureElement}
                      className={cn(
                        "whitespace-pre-wrap break-all pb-1 text-left text-emerald-400/90",
                        isError && "text-red-400",
                        item.index < persistentLineCount && "opacity-80",
                      )}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        right: 0,
                        width: "100%",
                        minWidth: "100%",
                        boxSizing: "border-box",
                        transform: `translateY(${item.start}px)`,
                      }}
                    >
                      {line}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
