import React, { useEffect, useState } from "react";
import { X, Archive, FolderOpen, FileIcon, RefreshCw, MapPin, Trash2, Folder, ChevronRight } from "lucide-react";
import { SyncTask, BackupFile } from "../types";
import { cn, formatSize } from "../utils";

interface BackupModalProps {
  taskId: string;
  tasks: SyncTask[];
  onClose: () => void;
}

interface TreeNode {
  name: string;
  fullPath: string;
  isDir: boolean;
  size?: number;
  mtime?: number;
  relativePath?: string;
  children: TreeNode[];
}

function buildTree(files: BackupFile[]): TreeNode[] {
  const root: TreeNode = { name: "", fullPath: "", isDir: true, children: [] };

  for (const file of files) {
    const parts = file.relativePath.split(/[/\\]/);
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      let child = node.children.find((c) => c.name === part);
      if (!child) {
        child = {
          name: part,
          fullPath: isLast ? file.path : "",
          isDir: !isLast,
          children: [],
          ...(isLast ? { size: file.size, mtime: file.mtime, relativePath: file.relativePath } : {}),
        };
        node.children.push(child);
      }
      node = child;
    }
  }

  // Sort: dirs first, then files alphabetically
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    nodes.forEach((n) => n.children.length && sortNodes(n.children));
  };
  sortNodes(root.children);

  return root.children;
}

interface TreeItemProps {
  node: TreeNode;
  depth: number;
  onDelete: (file: BackupFile) => void;
  onReveal: (filePath: string) => void;
}

const TreeItem: React.FC<TreeItemProps> = ({ node, depth, onDelete, onReveal }) => {
  const [open, setOpen] = useState(true);
  const indent = depth * 16;

  if (node.isDir) {
    return (
      <div>
        <div
          className="flex items-center gap-2 px-4 py-1.5 hover:bg-slate-50 rounded-lg cursor-pointer group select-none"
          style={{ paddingLeft: `${16 + indent}px` }}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronRight
            size={14}
            className={cn("text-slate-400 transition-transform flex-shrink-0", open && "rotate-90")}
          />
          <Folder size={15} className="text-blue-400 flex-shrink-0" />
          <span className="text-sm font-semibold text-slate-600 truncate">{node.name}</span>
          <span className="text-[11px] text-slate-400 ml-1">({node.children.length})</span>
        </div>
        {open && node.children.map((child, i) => (
          <TreeItem key={i} node={child} depth={depth + 1} onDelete={onDelete} onReveal={onReveal} />
        ))}
      </div>
    );
  }

  return (
    <div
      className="grid items-center px-4 py-2 hover:bg-slate-50 rounded-xl transition-colors group"
      style={{
        paddingLeft: `${16 + indent}px`,
        gridTemplateColumns: "1fr 100px 160px 64px",
      }}
    >
      <div className="flex items-center gap-2 min-w-0">
        <FileIcon size={14} className="text-slate-300 flex-shrink-0" />
        <span className="text-sm text-slate-700 truncate" title={node.fullPath}>
          {node.name}
        </span>
      </div>
      <div className="text-sm text-slate-400 font-mono">{formatSize(node.size ?? 0)}</div>
      <div className="text-[11px] text-slate-400">
        {node.mtime ? new Date(node.mtime).toLocaleString() : ""}
      </div>
      <div className="flex justify-end items-center gap-1">
        <button
          onClick={() => onReveal(node.fullPath)}
          className="p-1.5 opacity-0 group-hover:opacity-100 hover:bg-blue-50 rounded-lg text-slate-400 hover:text-blue-600 transition-all"
          title="在访达中定位"
        >
          <MapPin size={13} />
        </button>
        <button
          onClick={() =>
            onDelete({
              name: node.name,
              path: node.fullPath,
              relativePath: node.relativePath ?? "",
              size: node.size ?? 0,
              mtime: node.mtime ?? 0,
            })
          }
          className="p-1.5 opacity-0 group-hover:opacity-100 hover:bg-red-50 rounded-lg text-slate-400 hover:text-red-600 transition-all"
          title="删除此备份文件"
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
};

export const BackupModal: React.FC<BackupModalProps> = ({ taskId, tasks, onClose }) => {
  const [backupFiles, setBackupFiles] = useState<BackupFile[]>([]);
  const [loading, setLoading] = useState(true);
  const task = tasks.find((t) => t.id === taskId);
  const taskName = task?.name;

  const loadBackupFiles = async () => {
    setLoading(true);
    try {
      const files = await window.electronAPI.listBackupFiles(taskId);
      setBackupFiles(files);
    } catch (error) {
      console.error("加载备份文件失败:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadBackupFiles();
  }, [taskId]);

  const handleDeleteFile = async (file: BackupFile) => {
    if (!await window.electronAPI.showConfirm(`确定要删除此备份文件吗？\n${file.name}`)) return;
    const success = await window.electronAPI.deleteBackupFile(file.path);
    if (success) {
      setBackupFiles((prev) => prev.filter((f) => f.path !== file.path));
    } else {
      alert(`删除失败，请检查文件是否存在：\n${file.path}`);
    }
  };

  const treeNodes = buildTree(backupFiles);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white w-full max-w-4xl rounded-3xl shadow-2xl overflow-hidden flex flex-col h-[80vh] animate-in zoom-in-95 duration-200">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center text-blue-600">
              <Archive size={22} />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-800">备份数据 - {taskName}</h2>
              <p className="text-[11px] text-slate-400 font-medium uppercase tracking-wider">
                存放同步过程中被覆盖或删除的文件
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={loadBackupFiles}
              className="p-2 hover:bg-slate-100 rounded-full text-slate-400 hover:text-slate-600 transition-colors"
              title="刷新列表"
            >
              <RefreshCw size={18} className={cn(loading && "animate-spin")} />
            </button>
            <button
              onClick={() => window.electronAPI.openBackupFolder(taskId)}
              className="flex items-center gap-2 px-4 py-2 bg-blue-50 text-blue-600 hover:bg-blue-100 rounded-xl text-sm font-bold transition-all"
            >
              <FolderOpen size={16} />
              打开目录
            </button>
            <button
              onClick={onClose}
              className="p-2 hover:bg-slate-100 rounded-full text-slate-400 hover:text-slate-600 transition-colors"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {loading ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-400 gap-3">
              <RefreshCw size={32} className="animate-spin" />
              <p className="text-sm font-medium">正在读取备份目录...</p>
            </div>
          ) : backupFiles.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-slate-400 gap-4">
              <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center">
                <Archive size={32} className="opacity-20" />
              </div>
              <p className="text-sm font-medium">暂无备份文件</p>
            </div>
          ) : (
            <div>
              <div
                className="grid px-4 py-2 text-[11px] font-bold text-slate-400 uppercase tracking-wider border-b border-slate-100 mb-1"
                style={{ gridTemplateColumns: "1fr 100px 160px 64px" }}
              >
                <span>文件名</span>
                <span>大小</span>
                <span>备份时间</span>
                <span></span>
              </div>
              {treeNodes.map((node, i) => (
                <TreeItem
                  key={i}
                  node={node}
                  depth={0}
                  onDelete={handleDeleteFile}
                  onReveal={(p) => window.electronAPI.revealBackupFile(p)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="px-6 py-4 bg-slate-50 border-t border-slate-100">
          <p className="text-[11px] text-slate-400 leading-relaxed">
            提示：备份文件带有时间戳后缀（由 Unison 自动管理），保留{" "}
            <span className="font-bold text-slate-500">30 天</span>后自动清理。如需恢复，请手动从备份目录复制回原位。
          </p>
        </div>
      </div>
    </div>
  );
};
