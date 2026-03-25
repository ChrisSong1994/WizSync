import React from "react";
import {
  X,
  FileSearch,
  Loader2,
  CheckCircle2,
  FileCode,
  ArrowRight,
  ArrowUpRight,
  ArrowDownLeft,
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
  const taskName = tasks.find((t) => t.id === taskId)?.name;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white w-full max-w-5xl rounded-3xl shadow-2xl overflow-hidden flex flex-col h-[90vh] animate-in zoom-in-95 duration-200">
        <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
          <div className="flex items-center gap-2">
            <FileSearch size={18} className="text-blue-600" />
            <h2 className="text-xl font-bold text-slate-800">
              目录对比 - {taskName}
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

        <div className="flex-1 overflow-auto p-6 space-y-8">
          {!diffData ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-400 gap-4">
              <Loader2 size={40} className="animate-spin text-blue-500" />
              <p className="font-medium">正在扫描文件差异...</p>
            </div>
          ) : diffData.sourceOnly.length === 0 &&
            diffData.targetOnly.length === 0 &&
            diffData.different.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center py-12">
              <div className="w-16 h-16 bg-emerald-50 text-emerald-500 rounded-full flex items-center justify-center mb-4">
                <CheckCircle2 size={32} />
              </div>
              <h3 className="text-lg font-bold text-slate-800">目录已同步</h3>
              <p className="text-slate-500 mt-1">源目录与目标目录内容完全一致。</p>
            </div>
          ) : (
            <>
              {/* Different Files */}
              {diffData.different.length > 0 && (
                <section>
                  <h3 className="text-sm font-bold text-amber-600 mb-3 flex items-center gap-2">
                    <FileCode size={16} />
                    内容不一致 ({diffData.different.length})
                  </h3>
                  <div className="space-y-2">
                    {diffData.different.map((file, i) => (
                      <div
                        key={i}
                        className="bg-slate-50 border border-slate-100 rounded-xl p-3 flex items-center justify-between group hover:border-amber-200 transition-colors"
                      >
                        <span className="text-sm font-mono text-slate-700 truncate max-w-md">
                          {file.path}
                        </span>
                        <div className="flex items-center gap-4 text-[11px]">
                          <div className="text-right">
                            <div className="text-slate-400 uppercase font-bold text-[9px]">
                              源端
                            </div>
                            <div className="text-slate-600 font-medium">
                              {formatSize(file.sourceSize)}
                            </div>
                          </div>
                          <ArrowRight size={12} className="text-slate-300" />
                          <div className="text-left">
                            <div className="text-slate-400 uppercase font-bold text-[9px]">
                              目标端
                            </div>
                            <div className="text-slate-600 font-medium">
                              {formatSize(file.targetSize)}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Source Only */}
              {diffData.sourceOnly.length > 0 && (
                <section>
                  <h3 className="text-sm font-bold text-blue-600 mb-3 flex items-center gap-2">
                    <ArrowUpRight size={16} />
                    仅在源目录 ({diffData.sourceOnly.length})
                  </h3>
                  <div className="space-y-2">
                    {diffData.sourceOnly.map((file, i) => (
                      <div
                        key={i}
                        className="bg-blue-50/30 border border-blue-100 rounded-xl p-3 flex items-center justify-between"
                      >
                        <span className="text-sm font-mono text-slate-700 truncate max-w-md">
                          {file.path}
                        </span>
                        <span className="text-[11px] font-bold text-blue-600">
                          {formatSize(file.size)}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Target Only */}
              {diffData.targetOnly.length > 0 && (
                <section>
                  <h3 className="text-sm font-bold text-emerald-600 mb-3 flex items-center gap-2">
                    <ArrowDownLeft size={16} />
                    仅在目标目录 ({diffData.targetOnly.length})
                  </h3>
                  <div className="space-y-2">
                    {diffData.targetOnly.map((file, i) => (
                      <div
                        key={i}
                        className="bg-emerald-50/30 border border-emerald-100 rounded-xl p-3 flex items-center justify-between"
                      >
                        <span className="text-sm font-mono text-slate-700 truncate max-w-md">
                          {file.path}
                        </span>
                        <span className="text-[11px] font-bold text-emerald-600">
                          {formatSize(file.size)}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
