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
  ChevronDown,
  ChevronRight,
  MapPin,
  Trash2,
  EyeOff,
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
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set(['ignored']));
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

  const toggleSection = (section: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  };

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

  const handleDelete = async (filePath: string, side: 'source' | 'target') => {
    if (!confirm(`确定要删除${side === 'source' ? '源目录' : '目标目录'}中的文件吗？\n${filePath}`)) return;
    
    const success = await window.electronAPI.deleteFile(taskId, filePath, side);
    if (success) {
      setResolvedPaths(prev => new Set(prev).add(filePath));
    }
  };

  const handleIgnore = async (filePath: string) => {
    if (!confirm(`确定要忽略此路径吗？忽略后在后续对比中将不再显示。\n${filePath}`)) return;
    
    const success = await window.electronAPI.ignorePath(taskId, filePath);
    if (success) {
      setResolvedPaths(prev => new Set(prev).add(filePath));
    }
  };

  const handleReveal = (filePath: string, side: 'source' | 'target') => {
    window.electronAPI.revealInFileExplorer(taskId, filePath, side);
  };

  const MAX_DISPLAY = 1000;
  
  const activeDifferent = diffData?.different.filter(f => !resolvedPaths.has(f.path)) || [];
  const activeSourceOnly = diffData?.sourceOnly.filter(f => !resolvedPaths.has(f.path)) || [];
  const activeTargetOnly = diffData?.targetOnly.filter(f => !resolvedPaths.has(f.path)) || [];
  const totalActiveDiffs = activeDifferent.length + activeSourceOnly.length + activeTargetOnly.length;

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
              {totalActiveDiffs === 0 && (!diffData.ignored || diffData.ignored.length === 0) ? (
                <div className="flex flex-col items-center justify-center text-center py-12">
                  <div className="w-16 h-16 bg-emerald-50 text-emerald-500 rounded-full flex items-center justify-center mb-4">
                    <CheckCircle2 size={32} />
                  </div>
                  <h3 className="text-lg font-bold text-slate-800">目录已同步</h3>
                </div>
              ) : (
                <>
                  {/* 同步完成但有忽略文件时的提示 */}
                  {totalActiveDiffs === 0 && diffData.ignored && diffData.ignored.length > 0 && (
                    <div className="flex flex-col items-center justify-center text-center py-8 bg-slate-50 rounded-2xl border border-slate-100">
                      <div className="w-12 h-12 bg-blue-50 text-blue-500 rounded-full flex items-center justify-center mb-3">
                        <CheckCircle2 size={24} />
                      </div>
                      <h3 className="text-md font-bold text-slate-800">所有非忽略文件已同步</h3>
                      <p className="text-xs text-slate-500 mt-1">共有 {diffData.ignored.length} 个路径被规则忽略</p>
                    </div>
                  )}

                  {/* 内容不一致 */}
                  {activeDifferent.length > 0 && (
                    <section>
                      <button 
                        onClick={() => toggleSection('different')}
                        className="w-full flex items-center justify-between group mb-3"
                      >
                        <h3 className="text-sm font-bold text-amber-600 flex items-center gap-2">
                          <FileCode size={16} />
                          内容不一致 ({activeDifferent.length})
                        </h3>
                        <div className="text-slate-400 group-hover:text-amber-500 transition-colors">
                          {collapsedSections.has('different') ? <ChevronRight size={18} /> : <ChevronDown size={18} />}
                        </div>
                      </button>
                      {!collapsedSections.has('different') && (
                        <div className="space-y-2 animate-in slide-in-from-top-1 duration-200">
                          {activeDifferent.slice(0, MAX_DISPLAY).map((file, i) => (
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
                      )}
                    </section>
                  )}

                  {/* 仅在源目录 */}
                  {activeSourceOnly.length > 0 && (
                    <section>
                      <button 
                        onClick={() => toggleSection('sourceOnly')}
                        className="w-full flex items-center justify-between group mb-3"
                      >
                        <h3 className="text-sm font-bold text-blue-600 flex items-center gap-2">
                          <ArrowUpRight size={16} />
                          仅在源目录 ({activeSourceOnly.length})
                        </h3>
                        <div className="text-slate-400 group-hover:text-blue-500 transition-colors">
                          {collapsedSections.has('sourceOnly') ? <ChevronRight size={18} /> : <ChevronDown size={18} />}
                        </div>
                      </button>
                      {!collapsedSections.has('sourceOnly') && (
                        <div className="space-y-2 animate-in slide-in-from-top-1 duration-200">
                          {activeSourceOnly.slice(0, MAX_DISPLAY).map((file, i) => (
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
                              <div className="flex items-center gap-2">
                                <span className="text-[11px] font-bold text-blue-600 mr-2">{formatSize(file.size)}</span>
                                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                  <button
                                    onClick={() => handleSyncFile(file.path, 'sourceToTarget')}
                                    className="px-2 py-1 bg-blue-600 text-white text-[10px] font-bold rounded-lg"
                                  >
                                    同步到目标端
                                  </button>
                                  <button
                                    onClick={() => handleIgnore(file.path)}
                                    className="p-1.5 bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-700 rounded-lg transition-colors"
                                    title="忽略此路径"
                                  >
                                    <EyeOff size={14} />
                                  </button>
                                  <button
                                    onClick={() => handleDelete(file.path, 'source')}
                                    className="p-1.5 bg-red-50 text-red-500 hover:bg-red-100 hover:text-red-700 rounded-lg transition-colors"
                                    title="删除源端文件"
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </section>
                  )}

                  {/* 仅在目标目录 */}
                  {activeTargetOnly.length > 0 && (
                    <section>
                      <button 
                        onClick={() => toggleSection('targetOnly')}
                        className="w-full flex items-center justify-between group mb-3"
                      >
                        <h3 className="text-sm font-bold text-emerald-600 flex items-center gap-2">
                          <ArrowDownLeft size={16} />
                          仅在目标目录 ({activeTargetOnly.length})
                        </h3>
                        <div className="text-slate-400 group-hover:text-emerald-500 transition-colors">
                          {collapsedSections.has('targetOnly') ? <ChevronRight size={18} /> : <ChevronDown size={18} />}
                        </div>
                      </button>
                      {!collapsedSections.has('targetOnly') && (
                        <div className="space-y-2 animate-in slide-in-from-top-1 duration-200">
                          {activeTargetOnly.slice(0, MAX_DISPLAY).map((file, i) => (
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
                              <div className="flex items-center gap-2">
                                <span className="text-[11px] font-bold text-emerald-600 mr-2">{formatSize(file.size)}</span>
                                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                  <button
                                    onClick={() => handleSyncFile(file.path, 'targetToSource')}
                                    className="px-2 py-1 bg-emerald-600 text-white text-[10px] font-bold rounded-lg"
                                  >
                                    同步到源端
                                  </button>
                                  <button
                                    onClick={() => handleIgnore(file.path)}
                                    className="p-1.5 bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-700 rounded-lg transition-colors"
                                    title="忽略此路径"
                                  >
                                    <EyeOff size={14} />
                                  </button>
                                  <button
                                    onClick={() => handleDelete(file.path, 'target')}
                                    className="p-1.5 bg-red-50 text-red-500 hover:bg-red-100 hover:text-red-700 rounded-lg transition-colors"
                                    title="删除目标端文件"
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </section>
                  )}

                  {/* 忽略的文件 */}
                  {diffData.ignored && diffData.ignored.length > 0 && (
                    <section className="mt-8 pt-8 border-t border-slate-100">
                      <button 
                        onClick={() => toggleSection('ignored')}
                        className="w-full flex items-center justify-between group mb-3"
                      >
                        <h3 className="text-sm font-bold text-slate-400 flex items-center gap-2">
                          <EyeOff size={16} />
                          已忽略的文件 ({diffData.ignored.length})
                        </h3>
                        <div className="text-slate-300 group-hover:text-slate-500 transition-colors">
                          {collapsedSections.has('ignored') ? <ChevronRight size={18} /> : <ChevronDown size={18} />}
                        </div>
                      </button>
                      {!collapsedSections.has('ignored') && (
                        <div className="space-y-2 opacity-60">
                          {diffData.ignored.map((file, i) => (
                            <div key={i} className="bg-slate-50 border border-slate-100 rounded-xl p-3 flex items-center justify-between group">
                              <span className="text-sm font-mono text-slate-500 truncate max-w-md">{file.path}</span>
                              <div className="flex items-center gap-3">
                                <span className="text-[10px] text-slate-400 font-bold uppercase">
                                  {file.side === 'both' ? '双端存在' : file.side === 'source' ? '仅源端' : '仅目标端'}
                                </span>
                                <span className="text-[11px] font-bold text-slate-400">{formatSize(file.size)}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
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
