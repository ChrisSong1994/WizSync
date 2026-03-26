import React, { useEffect, useState } from "react";
import {
  X,
  FileSearch,
  Loader2,
  CheckCircle2,
  FileCode,
  ArrowRight,
  ArrowUpRight,
  ArrowDownLeft,
  ShieldAlert,
} from "lucide-react";
import { SyncTask, DiffResult } from "../types";
import { formatSize } from "../utils";

interface DiffModalProps {
  taskId: string;
  tasks: SyncTask[];
  diffData: DiffResult | null;
  onClose: () => void;
}

export const DiffModal: React.FC<DiffModalProps> = ({
  taskId,
  tasks,
  diffData,
  onClose,
}) => {
  const [ignorePatterns, setIgnorePatterns] = useState<string[]>([]);
  const [scanCount, setScanCount] = useState(0);
  const taskName = tasks.find((t) => t.id === taskId)?.name;

  useEffect(() => {
    // 获取忽略规则
    const fetchPatterns = async () => {
      const patterns = await window.electronAPI.getIgnorePatterns();
      setIgnorePatterns(patterns);
    };
    fetchPatterns();

    // 监听扫描进度
    const handleProgress = (data: { id: string; count: number }) => {
      if (data.id === taskId) {
        setScanCount(data.count);
      }
    };
    window.electronAPI.onCompareProgress(handleProgress);
  }, [taskId]);

  // 限制显示的差异项数量，防止 DOM 过载
  const MAX_DISPLAY = 1000;
  const totalDiffs = diffData ? 
    diffData.different.length + diffData.sourceOnly.length + diffData.targetOnly.length : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white w-full max-w-5xl rounded-3xl shadow-2xl overflow-hidden flex flex-col h-[90vh] animate-in zoom-in-95 duration-200">
        <div 
          className="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between bg-slate-50/50"
          style={{ WebkitAppRegion: "drag" } as any}
        >
          <div className="flex items-center gap-2" style={{ WebkitAppRegion: "no-drag" } as any}>
            <FileSearch size={16} className="text-blue-600" />
            <h2 className="text-lg font-bold text-slate-800">
              目录对比 - {taskName}
            </h2>
          </div>
          <div style={{ WebkitAppRegion: "no-drag" } as any}>
            <button
              onClick={onClose}
              className="p-2 hover:bg-slate-200 rounded-full text-slate-400 hover:text-slate-600 transition-colors flex items-center justify-center"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-6 space-y-8">
          {!diffData ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-400 gap-4 py-20">
              <div className="relative">
                <Loader2 size={48} className="animate-spin text-blue-500" />
                <div className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-blue-600">
                  {scanCount > 999 ? `${(scanCount/1000).toFixed(1)}k` : scanCount}
                </div>
              </div>
              <div className="text-center">
                <p className="font-bold text-slate-700">正在扫描文件差异...</p>
                <p className="text-xs text-slate-400 mt-1">已检索 {scanCount.toLocaleString()} 个文件</p>
              </div>
            </div>
          ) : (
            <>
              {totalDiffs === 0 ? (
                <div className="flex flex-col items-center justify-center text-center py-12">
                  <div className="w-16 h-16 bg-emerald-50 text-emerald-500 rounded-full flex items-center justify-center mb-4">
                    <CheckCircle2 size={32} />
                  </div>
                  <h3 className="text-lg font-bold text-slate-800">目录已同步</h3>
                  <p className="text-slate-500 mt-1">源目录与目标目录内容完全一致。</p>
                </div>
              ) : (
                <>
                  {totalDiffs > MAX_DISPLAY && (
                    <div className="bg-amber-50 border border-amber-100 text-amber-700 px-4 py-3 rounded-xl text-xs flex items-center gap-2">
                      <ShieldAlert size={14} />
                      注意：检测到共有 {totalDiffs.toLocaleString()} 处差异，下方仅展示前 {MAX_DISPLAY} 项以保证流畅度。
                    </div>
                  )}

                  {/* 差异内容渲染... */}
                  {diffData.different.length > 0 && (
                    <section>
                      <h3 className="text-sm font-bold text-amber-600 mb-3 flex items-center gap-2">
                        <FileCode size={16} />
                        内容不一致 ({diffData.different.length})
                      </h3>
                      <div className="space-y-2">
                        {diffData.different.slice(0, MAX_DISPLAY).map((file, i) => (
                          <div key={i} className="bg-slate-50 border border-slate-100 rounded-xl p-3 flex items-center justify-between group hover:border-amber-200 transition-colors">
                            <span className="text-sm font-mono text-slate-700 truncate max-w-md">{file.path}</span>
                            <div className="flex items-center gap-4 text-[11px]">
                              <div className="text-right">
                                <div className="text-slate-400 uppercase font-bold text-[9px]">源端</div>
                                <div className="text-slate-600 font-medium">{formatSize(file.sourceSize)}</div>
                              </div>
                              <ArrowRight size={12} className="text-slate-300" />
                              <div className="text-left">
                                <div className="text-slate-400 uppercase font-bold text-[9px]">目标端</div>
                                <div className="text-slate-600 font-medium">{formatSize(file.targetSize)}</div>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  {diffData.sourceOnly.length > 0 && (
                    <section>
                      <h3 className="text-sm font-bold text-blue-600 mb-3 flex items-center gap-2">
                        <ArrowUpRight size={16} />
                        仅在源目录 ({diffData.sourceOnly.length})
                      </h3>
                      <div className="space-y-2">
                        {diffData.sourceOnly.slice(0, MAX_DISPLAY).map((file, i) => (
                          <div key={i} className="bg-blue-50/30 border border-blue-100 rounded-xl p-3 flex items-center justify-between">
                            <span className="text-sm font-mono text-slate-700 truncate max-w-md">{file.path}</span>
                            <span className="text-[11px] font-bold text-blue-600">{formatSize(file.size)}</span>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  {diffData.targetOnly.length > 0 && (
                    <section>
                      <h3 className="text-sm font-bold text-emerald-600 mb-3 flex items-center gap-2">
                        <ArrowDownLeft size={16} />
                        仅在目标目录 ({diffData.targetOnly.length})
                      </h3>
                      <div className="space-y-2">
                        {diffData.targetOnly.slice(0, MAX_DISPLAY).map((file, i) => (
                          <div key={i} className="bg-emerald-50/30 border border-emerald-100 rounded-xl p-3 flex items-center justify-between">
                            <span className="text-sm font-mono text-slate-700 truncate max-w-md">{file.path}</span>
                            <span className="text-[11px] font-bold text-emerald-600">{formatSize(file.size)}</span>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}
                </>
              )}

              {/* 忽略规则 */}
              <section className="pt-4 border-t border-slate-100">
                <div className="bg-slate-50 rounded-2xl p-4">
                  <h3 className="text-xs font-bold text-slate-400 mb-3 flex items-center gap-2 uppercase tracking-wider">
                    <ShieldAlert size={14} />
                    自动忽略的规则 (不参与对比与同步)
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {ignorePatterns.map((pattern, i) => (
                      <span key={i} className="px-2.5 py-1 bg-white border border-slate-200 text-slate-500 rounded-lg text-[11px] font-mono shadow-sm">
                        {pattern}
                      </span>
                    ))}
                  </div>
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
