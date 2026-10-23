import React, { useEffect } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { cn } from "../utils";

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 通用确认弹窗（前端组件实现，替代 Electron 原生 dialog.showMessageBox）。
 * - danger 控制确认按钮配色（红色 = 危险操作，默认琥珀色 = 警告操作）
 * - loading 时确认按钮转圈并禁用，用于等待删除/重置等异步动作完成
 * - 支持点击遮罩或按 Esc 取消
 */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  title,
  message,
  confirmText = "确定",
  cancelText = "取消",
  danger = false,
  loading = false,
  onConfirm,
  onCancel,
}) => {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // 操作进行中（loading）不允许通过 Esc 关闭，避免操作中断后状态丢失
      if (e.key === "Escape" && !loading) onCancel();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onCancel, loading]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm"
      onMouseDown={(e) => {
        // 操作进行中（loading）不允许点击遮罩关闭
        if (e.target === e.currentTarget && !loading) onCancel();
      }}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm">
        <div className="p-5">
          <div className="flex items-start gap-3">
            <div
              className={cn(
                "w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0",
                danger ? "bg-red-50 text-red-600" : "bg-amber-50 text-amber-600",
              )}
            >
              <AlertTriangle size={20} />
            </div>
            <div className="min-w-0">
              <h3 className="text-base font-bold text-slate-800">{title}</h3>
              <p className="text-[13px] text-slate-500 mt-1.5 leading-relaxed whitespace-pre-line">
                {message}
              </p>
            </div>
          </div>
        </div>
        <div className="px-5 py-3 bg-slate-50 border-t border-slate-100 rounded-b-2xl flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 rounded-lg text-[13px] font-bold text-slate-600 hover:bg-slate-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className={cn(
              "px-4 py-2 rounded-lg text-[13px] font-bold text-white flex items-center gap-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
              danger ? "bg-red-600 hover:bg-red-700" : "bg-amber-500 hover:bg-amber-600",
            )}
          >
            {loading && <Loader2 size={14} className="animate-spin" />}
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
};
