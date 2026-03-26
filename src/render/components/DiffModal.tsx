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
  ChevronLeft,
  ChevronRight,
  MapPin,
} from "lucide-react";
import { SyncTask, DiffResult } from "../types";
import { formatSize, cn } from "../utils";

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
  const [syncingPaths, setSyncingPaths] = useState<Set<string>>(new Set());
  const [resolvedPaths, setResolvedPaths] = useState<Set<string>>(new Set());
  const taskName = tasks.find((t) => t.id === taskId)?.name;

  useEffect(() => {
    const fetchPatterns = async () => {
      const patterns = await window.electronAPI.getIgnorePatterns();
      setIgnorePatterns(patterns);
    };
    fetchPatterns();

    const handleProgress = (data: { id: string; count: number }) => {
      if (data.id === taskId) {
        setScanCount(data.count);
      }
    };
    window.electronAPI.onCompareProgress(handleProgress);
  }, [taskId]);

  const handleSyncFile = async (filePath: string, direction: 'sourceToTarget' | 'targetToSource') => {
    const key = `${filePath}-${direction}`;
    setSyncingPaths(prev => new Set(prev).add(key));
    const success = await window.electronAPI.syncSingleFile(taskId, filePath, direction);
    setSyncingPaths(prev => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    if (success) {
      setResolvedPaths(prev => new Set(prev).add(filePath));
    }
  };

  const handleReveal = (filePath: string, side: 'source' | 'target') => {
    window.electronAPI.revealInFileExplorer(taskId, filePath, side);
  };

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
              <p className="font-bold text-slate-700">已检索 {scanCount.toLocaleString()} 个文件...</p>
            </div>
          ) : (
            <>
              {totalDiffs === 0 ? (
                <div className="flex flex-col items-center justify-center text-center py-12">
                  <div className="w-16 h-16 bg-emerald-50 text-emerald-500 rounded-full flex items-center justify-center mb-4">
                    <CheckCircle2 size={32} />
                  </div>
                  <h3 className="text-lg font-bold text-slate-800">目录已同步</h3>
                </div>
              ) : (
                <>
                  {/* 内容不一致 */}
                  {diffData.different.length > 0 && (
                    <section>
                      <h3 className="text-sm font-bold text-amber-600 mb-3 flex items-center gap-2">
                        <FileCode size={16} />
                        内容不一致 ({diffData.different.length})
                      </h3>
                      <div className="space-y-2">
                        {diffData.different.slice(0, MAX_DISPLAY).map((file, i) => !resolvedPaths.has(file.path) && (
                          <div key={i} className="bg-slate-50 border border-slate-100 rounded-xl p-3 flex items-center justify-between group hover:border-amber-200 transition-colors">
                            <span className="text-sm font-mono text-slate-700 truncate max-w-sm mr-4" title={file.path}>
                              {file.path}
                            </span>
                            
                            <div className="flex items-center gap-2">
                              {/* 源端控制组 */}
                              <div className="flex items-center gap-1 bg-white p-1 rounded-xl border border-slate-100">
                                <button 
                                  onClick={() => handleReveal(file.path, 'source')}
                                  className="p-1.5 hover:bg-blue-50 rounded-lg text-slate-400 hover:text-blue-600 transition-all"
                                  title="在源端定位文件"
                                >
                                  <MapPin size={14} />
                                </button>
                                <button
                                  onClick={() => handleSyncFile(file.path, 'sourceToTarget')}
                                  disabled={syncingPaths.has(`${file.path}-sourceToTarget`)}
                                  className="px-2 py-1 hover:bg-blue-50 rounded-lg text-blue-600 flex flex-col items-center disabled:opacity-50"
                                >
                                  <span className="text-[8px] font-bold uppercase">使用此版本</span>
                                  <span className="text-[10px] font-medium">{formatSize(file.sourceSize)}</span>
                                </button>
                              </div>

                              <ArrowRight size={14} className="text-slate-300 mx-1" />

                              {/* 目标端控制组 */}
                              <div className="flex items-center gap-1 bg-white p-1 rounded-xl border border-slate-100">
                                <button
                                  onClick={() => handleSyncFile(file.path, 'targetToSource')}
                                  disabled={syncingPaths.has(`${file.path}-targetToSource`)}
                                  className="px-2 py-1 hover:bg-emerald-50 rounded-lg text-emerald-600 flex flex-col items-center disabled:opacity-50"
                                >
                                  <span className="text-[8px] font-bold uppercase">使用此版本</span>
                                  <span className="text-[10px] font-medium">{formatSize(file.targetSize)}</span>
                                </button>
                                <button 
                                  onClick={() => handleReveal(file.path, 'target')}
                                  className="p-1.5 hover:bg-emerald-50 rounded-lg text-slate-400 hover:text-emerald-600 transition-all"
                                  title="在目标端定位文件"
                                >
                                  <MapPin size={14} />
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  {/* 仅在源目录 */}
                  {diffData.sourceOnly.length > 0 && (
                    <section>
                      <h3 className="text-sm font-bold text-blue-600 mb-3 flex items-center gap-2">
                        <ArrowUpRight size={16} />
                        仅在源目录 ({diffData.sourceOnly.length})
                      </h3>
                      <div className="space-y-2">
                        {diffData.sourceOnly.slice(0, MAX_DISPLAY).map((file, i) => !resolvedPaths.has(file.path) && (
                          <div key={i} className="bg-blue-50/30 border border-blue-100 rounded-xl p-3 flex items-center justify-between group">
                            <div className="flex items-center gap-2 min-w-0">
                              <button 
                                onClick={() => handleReveal(file.path, 'source')}
                                className="p-1.5 hover:bg-white rounded-lg text-blue-400 hover:text-blue-600 transition-all shrink-0"
                                title="在访达/资源管理器中定位"
                              >
                                <MapPin size={14} />
                              </button>
                              <span className="text-sm font-mono text-slate-700 truncate max-w-md">{file.path}</span>
                            </div>
                            <div className="flex items-center gap-3">
                              <span className="text-[11px] font-bold text-blue-600">{formatSize(file.size)}</span>
                              <button
                                onClick={() => handleSyncFile(file.path, 'sourceToTarget')}
                                className="px-2 py-1 bg-blue-600 text-white text-[10px] font-bold rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"
                              >
                                同步到目标端
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  {/* 仅在目标目录 */}
                  {diffData.targetOnly.length > 0 && (
                    <section>
                      <h3 className="text-sm font-bold text-emerald-600 mb-3 flex items-center gap-2">
                        <ArrowDownLeft size={16} />
                        仅在目标目录 ({diffData.targetOnly.length})
                      </h3>
                      <div className="space-y-2">
                        {diffData.targetOnly.slice(0, MAX_DISPLAY).map((file, i) => !resolvedPaths.has(file.path) && (
                          <div key={i} className="bg-emerald-50/30 border border-emerald-100 rounded-xl p-3 flex items-center justify-between group">
                            <div className="flex items-center gap-2 min-w-0">
                              <button 
                                onClick={() => handleReveal(file.path, 'target')}
                                className="p-1.5 hover:bg-white rounded-lg text-emerald-400 hover:text-emerald-600 transition-all shrink-0"
                                title="在访达/资源管理器中定位"
                              >
                                <MapPin size={14} />
                              </button>
                              <span className="text-sm font-mono text-slate-700 truncate max-w-md">{file.path}</span>
                            </div>
                            <div className="flex items-center gap-3">
                              <span className="text-[11px] font-bold text-emerald-600">{formatSize(file.size)}</span>
                              <button
                                onClick={() => handleSyncFile(file.path, 'targetToSource')}
                                className="px-2 py-1 bg-emerald-600 text-white text-[10px] font-bold rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"
                              >
                                同步到源端
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
