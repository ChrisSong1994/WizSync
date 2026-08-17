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
 *
 * 用头指针队列替代 waiters.shift()：shift() 每次调用都整体前移数组（O(n)），
 * 在几十万文件并发等待时退化为 O(n²)，实测 5 万文件遍历从 0.3s 拖慢到 1.5s+。
 * 头指针方案 release 是 O(1)，仅当队列头部的空洞占比过大时惰性截断一次，摊平成本。
 */
class Semaphore {
  private available: number;
  private head = 0;
  private waiters: Array<(() => void) | null> = [];

  constructor(concurrency: number) {
    this.available = concurrency;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    // 先占位再回填 resolve：acquire 内到 await 之前没有其它异步点，release 不会插进来
    const idx = this.waiters.length;
    this.waiters.push(null);
    await new Promise<void>((resolve) => {
      this.waiters[idx] = resolve;
    });
  }

  release(): void {
    if (this.head < this.waiters.length) {
      const next = this.waiters[this.head];
      this.waiters[this.head] = null;
      this.head++;
      next?.(); // 让给下一个等待者，可用数保持 0
      // 惰性压缩：空洞过半且足够大时才截断，避免数组随等待队列无限膨胀
      if (this.head >= 1024 && this.head * 2 >= this.waiters.length) {
        this.waiters.splice(0, this.head);
        this.head = 0;
      }
    } else {
      this.available++;
    }
  }
}

/**
 * getDirStats 允许的最大并发 fs 操作数。
 * 实际并行度受 libuv 线程池（默认 4）限制，此值主要约束内存中 in-flight 的 Promise 数，
 * 避免大目录下同时挂起几十万次 stat（macOS 默认软限制 256 fd，取 64 留足余量）。
 */
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

/**
 * 流式比对两个文件内容是否一致（64KB 分块，遇首个差异字节即返回 false）。
 * 用于对比功能在"大小相同但 mtime 有差异"时确认是否真的不同——
 * FAT/SD 等卷的时间戳精度会把内容一致的文件误报为需要同步。
 * 任一侧无法读取时按"不相同"处理，让上层把它交给同步引擎去核实。
 */
export async function filesContentEqual(a: string, b: string): Promise<boolean> {
  const CHUNK = 64 * 1024;
  let fa: fs.promises.FileHandle | null = null;
  let fb: fs.promises.FileHandle | null = null;
  try {
    fa = await fs.promises.open(a, "r");
    fb = await fs.promises.open(b, "r");
    const bufA = Buffer.alloc(CHUNK);
    const bufB = Buffer.alloc(CHUNK);
    while (true) {
      const [ra, rb] = await Promise.all([
        fa.read(bufA, 0, CHUNK, null),
        fb.read(bufB, 0, CHUNK, null),
      ]);
      if (ra.bytesRead !== rb.bytesRead) return false;
      if (ra.bytesRead === 0) return true;
      if (!bufA.subarray(0, ra.bytesRead).equals(bufB.subarray(0, rb.bytesRead))) return false;
      if (ra.bytesRead < CHUNK) return true;
    }
  } catch {
    return false;
  } finally {
    await Promise.all([fa?.close(), fb?.close()].map(p => p?.catch(() => {})));
  }
}
