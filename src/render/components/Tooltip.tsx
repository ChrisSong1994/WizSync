import React from "react";
import { cn } from "../utils";

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "bottom";
  /** 距触发元素的最小边距，用于居中时避免溢出屏幕 */
  offset?: number;
}

/**
 * 自定义悬浮提示组件
 * 相比原生 title 属性：响应更快、样式更明显、带箭头指向触发元素。
 */
export const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  side = "top",
}) => {
  return (
    <span className="relative inline-flex group/tooltip">
      {children}
      <span
        role="tooltip"
        className={cn(
          "absolute left-1/2 -translate-x-1/2 z-50 pointer-events-none",
          "px-2.5 py-1 rounded-lg bg-slate-800/95 backdrop-blur-sm text-white text-xs font-medium whitespace-nowrap",
          "shadow-xl shadow-slate-900/20 border border-slate-700/50",
          "opacity-0 scale-95 transition-all duration-150",
          "group-hover/tooltip:opacity-100 group-hover/tooltip:scale-100",
          side === "top" ? "bottom-full mb-2" : "top-full mt-2",
        )}
      >
        {content}
        {/* 指向触发元素的箭头 */}
        <span
          className={cn(
            "absolute left-1/2 -translate-x-1/2 w-2 h-2 bg-slate-800/95 rotate-45",
            side === "top" ? "top-full -mt-1" : "bottom-full -mb-1",
          )}
        />
      </span>
    </span>
  );
};
