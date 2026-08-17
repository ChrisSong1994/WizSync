import fs from "node:fs";
import path from "node:path";

/**
 * 定义全局统一的忽略规则
 */
export const IGNORE_PATTERNS = [
  "node_modules",
  "Thumbs.db",
  "desktop.ini",
];

/**
 * 更鲁棒的忽略检查：跳过所有隐藏文件/目录（以 . 开头）及固定黑名单
 */
function shouldSkip(name: string): boolean {
  if (name.startsWith(".")) return true;
  return IGNORE_PATTERNS.some(p => name === p);
}

/**
 * 简单信号量：限制同时进行的异步文件系统操作数量，
 * 防止大目录下一次性并发上万 stat 导致 EMFILE（文件描述符耗尽）。
 */
class Semaphore {
  private available: number;
  private waiters: Array<() => void> = [];

  constructor(concurrency: number) {
    this.available = concurrency;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next(); // 让给下一个等待者，可用数保持 0
    } else {
      this.available++;
    }
  }
}

/** getDirStats 允许的最大并发 fs 操作数（macOS 默认软限制 256 fd，取 64 留足余量） */
const STAT_CONCURRENCY = 64;

/**
 * 递归获取目录统计信息（异步非阻塞版）。
 * 整棵遍历共享同一个信号量，readdir/stat 均被限流，
 * 单个文件失败只跳过该文件并记日志，不会让整棵统计静默归零。
 */
export async function getDirStats(
  dirPath: string
): Promise<{ size: number; count: number }> {
  const sem = new Semaphore(STAT_CONCURRENCY);

  const walk = async (dir: string): Promise<{ size: number; count: number }> => {
    let size = 0;
    let count = 0;
    try {
      if (!fs.existsSync(dir)) return { size: 0, count: 0 };

      await sem.acquire();
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } finally {
        sem.release();
      }

      const results = await Promise.all(entries.map(async (file) => {
        if (shouldSkip(file.name)) return null;
        const fullPath = path.join(dir, file.name);
        try {
          if (file.isDirectory()) {
            return walk(fullPath);
          }
          await sem.acquire();
          try {
            const stats = await fs.promises.stat(fullPath);
            return { size: stats.size, count: 1 };
          } finally {
            sem.release();
          }
        } catch (err) {
          console.error(`获取文件统计失败，已跳过: ${fullPath}`, err);
          return null;
        }
      }));

      for (const r of results) {
        if (!r) continue;
        size += r.size;
        count += r.count;
      }
    } catch (err) {
      console.error(`获取目录统计信息失败: ${dir}`, err);
    }
    return { size, count };
  };

  return walk(dirPath);
}

/**
 * 判断 target 绝对路径是否位于 base 目录之内（含 base 本身）。
 * 用于 IPC 边界校验，防止路径穿越导致越权删除/同步。
 */
export function isPathInside(base: string, target: string): boolean {
  const baseResolved = path.resolve(base);
  const targetResolved = path.resolve(target);
  return (
    targetResolved === baseResolved ||
    targetResolved.startsWith(baseResolved + path.sep)
  );
}

/**
 * 将 relPath 解析到 base 目录下，若越界则返回 null。
 * 越界时由调用方拒绝操作并记录日志。
 */
export function resolveInside(base: string, relPath: string): string | null {
  const full = path.resolve(base, relPath);
  return isPathInside(base, full) ? full : null;
}

/**
 * 递归获取目录下所有文件的详细信息
 * @param onProgress 进度回调，返回当前已扫描的文件数
 * @param signal 取消信号：调用方 abort 后立即停止扫描并抛出 AbortError
 */
export async function getAllFiles(
  dirPath: string,
  baseDir: string = dirPath,
  state: { count: number } = { count: 0 },
  onProgress?: (count: number) => void,
  signal?: AbortSignal
): Promise<Map<string, { size: number; mtime: number }>> {
  const result = new Map<string, { size: number; mtime: number }>();

  // 取消时抛出可识别的 AbortError，而不是吞掉后返回空结果
  const throwIfAborted = () => {
    if (signal?.aborted) {
      const err = new Error("compare-cancelled");
      err.name = "AbortError";
      throw err;
    }
  };

  try {
    throwIfAborted();
    if (!fs.existsSync(dirPath)) return result;
    const files = await fs.promises.readdir(dirPath, { withFileTypes: true });

    for (const file of files) {
      throwIfAborted();
      if (shouldSkip(file.name)) continue;

      const fullPath = path.join(dirPath, file.name);
      const relPath = path.relative(baseDir, fullPath);

      if (file.isDirectory()) {
        const subFiles = await getAllFiles(fullPath, baseDir, state, onProgress, signal);
        subFiles.forEach((v, k) => result.set(k, v));
      } else {
        const stats = await fs.promises.stat(fullPath);
        result.set(relPath, { size: stats.size, mtime: stats.mtimeMs });
        state.count++;

        // 每 200 个文件报告一次进度，减少回调频率
        if (state.count % 200 === 0) {
          onProgress?.(state.count);
          await new Promise(resolve => setImmediate(resolve));
        }
      }
    }
  } catch (err) {
    // 取消导致的 AbortError 继续向上抛，由调用方识别并处理
    if (signal?.aborted) throw err;
    console.error("获取文件列表失败:", err);
  }
  return result;
}
