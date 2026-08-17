import React, { useEffect, useState } from "react";
import { X, Settings, FolderOpen, Database } from "lucide-react";

interface SettingsModalProps {
  onClose: () => void;
}

/**
 * 设置弹窗
 * 目前包含应用数据目录的展示与打开入口，后续可在此扩展其他设置项。
 */
export const SettingsModal: React.FC<SettingsModalProps> = ({ onClose }) => {
  const [appDataPath, setAppDataPath] = useState<string>("");

  useEffect(() => {
    // 加载应用数据目录路径
    const loadAppDataPath = async () => {
      const path = await window.electronAPI.getAppDataPath();
      setAppDataPath(path);
    };
    loadAppDataPath();
  }, []);

  const handleOpenFolder = () => {
    window.electronAPI.openAppDataFolder();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white w-full max-w-lg rounded-3xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
        <div
          className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50"
          style={{ WebkitAppRegion: "drag" } as any}
        >
          <div
            className="flex items-center gap-2"
            style={{ WebkitAppRegion: "no-drag" } as any}
          >
            <Settings size={18} className="text-blue-600" />
            <h2 className="text-lg font-bold text-slate-800">设置</h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-slate-200 rounded-full text-slate-400 hover:text-slate-600 transition-colors flex items-center justify-center"
            style={{ WebkitAppRegion: "no-drag" } as any}
          >
            <X size={20} />
          </button>
        </div>

        <div className="p-6">
          <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-4">
            常规
          </h3>

          {/* 应用数据 */}
          <div className="flex items-center justify-between gap-4 bg-slate-50 rounded-xl px-4 py-3.5 border border-slate-100">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-9 h-9 bg-blue-100 rounded-lg flex items-center justify-center flex-shrink-0">
                <Database size={18} className="text-blue-600" />
              </div>
              <div className="min-w-0">
                <div className="font-semibold text-slate-700 text-sm">应用数据</div>
                <div className="text-xs text-slate-500 truncate" title={appDataPath}>
                  {appDataPath || "加载中..."}
                </div>
              </div>
            </div>
            <button
              onClick={handleOpenFolder}
              title="打开应用数据目录"
              className="flex items-center gap-1.5 bg-white hover:bg-blue-50 text-slate-600 hover:text-blue-600 border border-slate-200 px-3 py-2 rounded-lg text-xs font-semibold transition-colors flex-shrink-0"
            >
              <FolderOpen size={14} />
              打开目录
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
