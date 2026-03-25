import React from "react";
import { Plus } from "lucide-react";

interface HeaderProps {
  onAddTask: () => void;
}

export const Header: React.FC<HeaderProps> = ({ onAddTask }) => {
  return (
    <header
      className="bg-white border-b border-slate-200 pl-20 pr-6 py-4 flex items-center justify-between sticky top-0 z-10 shadow-sm"
      style={{ WebkitAppRegion: "drag" } as any}
    >
      <div
        className="flex items-center gap-3"
        style={{ WebkitAppRegion: "no-drag" } as any}
      >
        <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center overflow-hidden shadow-md">
          <img
            src="/assets/logo.png"
            alt="WizSync Logo"
            className="w-full h-full object-cover"
          />
        </div>
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-800 leading-none">
            WizSync
          </h1>
          <p className="text-xs text-slate-500 mt-1 font-medium">
            高效目录同步专家
          </p>
        </div>
      </div>
      <button
        onClick={onAddTask}
        style={{ WebkitAppRegion: "no-drag" } as any}
        className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-xl font-semibold transition-all shadow-lg shadow-blue-200 hover:shadow-blue-300 active:scale-95"
      >
        <Plus size={18} />
        <span>添加任务</span>
      </button>
    </header>
  );
};
