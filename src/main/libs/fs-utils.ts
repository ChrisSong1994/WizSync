import fs from "node:fs";
import path from "node:path";
import { DiffResult } from "./types";

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
          if (file.isSymbolicLink()) {
            // 跳过符号链接：unison 默认忽略链接，目录统计口径需与同步/对比保持一致
            return null;
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
 * 文件名 Unicode 归一化（NFC），用于对齐 unison 的判定口径。
 *
 * unison 默认 unicode=true，会把两端文件名都归一化成 NFC 后再比较和传播：
 * macOS 上以 NFD 存储的名字（带重音的拉丁字母、日文浊音假名「が」、韩文组合字母等）
 * 被 unison 复制到目标端后会写成 NFC。此时两端内容已经完全一致，若对比层按原始
 * UTF-8 字节比较，同一个文件就会同时被误报成「仅在源目录」+「仅在目标目录」，
 * 而且重复同步永远消不掉——因为 unison 归一化后认为两端是同一个文件、无事可做。
 */
function normalizeName(p: string): string {
  return p.normalize("NFC");
}

/**
 * 把相对路径解析成父目录里真实存在的名字，找不到时返回 null。
 *
 * 对比层按 NFC + 大小写折叠做匹配（与 unison 一致），返回的路径不一定与磁盘上的
 * 字节完全相同（例如源端 NFD、目标端 NFC）。删除 / 定位 / 单文件同步等操作必须作用在
 * 真实存在的名字上，否则在 exFAT 这类「大小写不敏感但 Unicode 归一化敏感」的卷上会 ENOENT。
 *
 * 逐段解析：先按原样匹配，失败后在该目录下按 NFC + 小写比较目录项。
 * 拒绝含 `..` 的路径（越界兜底，调用方仍应先用 resolveInside 做校验）。
 */
export function resolveExistingRelativePath(
  root: string,
  relPath: string,
): string | null {
  const segments = relPath.split(path.sep).filter((s) => s.length > 0 && s !== ".");
  if (segments.some((s) => s === "..")) return null;
  let currentAbs = path.resolve(root);
  const matched: string[] = [];

  for (const segment of segments) {
    const direct = path.join(currentAbs, segment);
    if (fs.existsSync(direct)) {
      currentAbs = direct;
      matched.push(segment);
      continue;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentAbs, { withFileTypes: true });
    } catch {
      return null;
    }
    const wanted = normalizeName(segment).toLowerCase();
    const hit = entries.find((e) => normalizeName(e.name).toLowerCase() === wanted);
    if (!hit) return null;

    currentAbs = path.join(currentAbs, hit.name);
    matched.push(hit.name);
  }

  return matched.length > 0 ? matched.join(path.sep) : null;
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

      // 单条失败只跳过该路径，不让整个目录扫描作废（例如断链 symlink 导致 stat 抛错时，
      // 之前会让本目录所有文件都从结果里消失，误报为"仅在另一侧"）。
      try {
        if (file.isDirectory()) {
          const subFiles = await getAllFiles(fullPath, baseDir, state, onProgress, signal);
          subFiles.forEach((v, k) => result.set(k, v));
        } else if (file.isSymbolicLink()) {
          // unison 默认（未启用 -links）会完全忽略符号链接：既不复制也不删除。
          // 若这里跟随链接（fs.stat 会解析到链接目标），会把"仅一端存在的链接"误报为
          // sourceOnly/targetOnly/different，导致"同步完成后再次对比仍残留差异"。
          // 因此直接跳过，与 unison 的同步语义对齐。
          continue;
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
      } catch (err) {
        // 取消导致的 AbortError 继续向上抛，由调用方识别并处理
        if (signal?.aborted) throw err;
        console.error(`跳过无法读取的路径: ${fullPath}`, err);
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

/**
 * 计算两份文件清单（getAllFiles 结果）之间的差异，作为"对比目录"的展示层。
 *
 * 判定语义与 unison 对齐，使"对比差异"和"同步差异"对"什么算不同"的结论一致：
 * - foldCase（对应 unison 的 -fat）：路径大小写不敏感。unison 把源端 `photos/a.jpg`
 *   与目标端 `Photos/A.jpg` 视为同一个文件、不报差异；这里折叠成同一键后比对，
 *   否则 Node 会同时报"仅在源目录"+"仅在目标目录"，unison 却报"无变动"——这正是
 *   手动同步后对比仍残留差异的根因。折叠在 buildDirDiff 入口按整条相对路径小写化。
 * - Unicode NFC 归一化（对应 unison 的 unicode=true）：unison 会把 NFD 名字在目标端
 *   写成 NFC（见 normalizeName），这里按 NFC 折叠，否则同样会残留"同步后仍有差异"。
 * - 大小不同必然不同；大小相同但 mtime 有差异时流式比对内容（unison 在 fastcheck
 *   判定有变后、传播前也会做安全内容校验，这里保持一致）。
 *
 * 同侧出现折叠冲突（大小写敏感卷上 `Foo/x` 与 `foo/x` 并存，或 exFAT 上 NFD/NFC
 * 两种编码的重名文件并存）时保留先扫到的条目，行为确定。这类重名项在 unison 眼里是
 * 同一个文件，重复同步永远不会消除，但"另一端只有一个"时同步回去会静默覆盖同一目标，
 * 属于真实的数据隐患，因此通过 onFoldedCollision 上报给调用方记录日志。
 *
 * @param sourceFiles getAllFiles 对源目录的结果（相对路径 → 大小/mtime）
 * @param targetFiles getAllFiles 对目标目录的结果
 * @param opts.onFoldedCollision 同侧折叠冲突回调（保留项 / 被折叠掉的项），用于提示用户
 */
export async function computeDirDiff(
  sourceFiles: Map<string, { size: number; mtime: number }>,
  targetFiles: Map<string, { size: number; mtime: number }>,
  opts: {
    sourceRoot: string;
    targetRoot: string;
    ignoredPaths?: string[];
    foldCase: boolean;
    signal?: AbortSignal;
    onFoldedCollision?: (info: {
      side: "source" | "target";
      keptPath: string;
      droppedPath: string;
    }) => void;
  },
): Promise<DiffResult> {
  const { sourceRoot, targetRoot, ignoredPaths = [], foldCase, signal, onFoldedCollision } = opts;

  const throwIfCancelled = () => {
    if (signal?.aborted) throw new Error("compare-cancelled");
  };
  // 忽略规则也按 NFC 归一化比较，避免忽略列表里的 NFD 路径匹配不到 NFC 文件名
  const isIgnored = (relPath: string) => {
    const normalized = normalizeName(relPath);
    return ignoredPaths.some(p => {
      const pattern = normalizeName(p);
      return normalized === pattern || normalized.startsWith(pattern + path.sep);
    });
  };

  // 折叠键：先按 NFC 归一化（unison 归一化文件名），再按 useFat（默认开）小写化，
  // 两者都与 unison 的 unicode=true / -fat 判定保持一致。
  const foldKey = (p: string) => {
    const nfc = normalizeName(p);
    return foldCase ? normalizeName(nfc.toLowerCase()) : nfc;
  };
  const buildFolded = (
    files: Map<string, { size: number; mtime: number }>,
    side: "source" | "target",
  ): Map<string, { path: string; size: number; mtime: number }> => {
    const m = new Map<string, { path: string; size: number; mtime: number }>();
    for (const [relPath, info] of files) {
      const key = foldKey(relPath);
      const kept = m.get(key);
      if (kept) {
        // 同一侧出现归一化重名（exFAT 上 NFD/NFC 并存等）：保留先扫到的，另一个上报
        if (kept.path !== relPath) {
          onFoldedCollision?.({ side, keptPath: kept.path, droppedPath: relPath });
        }
        continue;
      }
      m.set(key, { path: relPath, size: info.size, mtime: info.mtime });
    }
    return m;
  };
  const srcFolded = buildFolded(sourceFiles, "source");
  const tgtFolded = buildFolded(targetFiles, "target");

  const diff: DiffResult = {
    sourceOnly: [],
    targetOnly: [],
    different: [],
    renamed: [],
    ignored: [],
  };

  let processedCount = 0;
  for (const [key, s] of srcFolded) {
    if (isIgnored(s.path)) {
      diff.ignored.push({
        path: s.path,
        size: s.size,
        side: tgtFolded.has(key) ? "both" : "source",
      });
      continue;
    }

    const t = tgtFolded.get(key);
    if (!t) {
      diff.sourceOnly.push({ path: s.path, size: s.size });
    } else if (s.size !== t.size) {
      // 大小不同：一定需要同步
      diff.different.push({
        path: s.path,
        sourceSize: s.size,
        targetSize: t.size,
        sourceMtime: s.mtime,
        targetMtime: t.mtime,
      });
    } else if (Math.abs(s.mtime - t.mtime) > 2000) {
      // 大小相同但 mtime 差超过容差：FAT/APFS 时间戳精度噪音常见，仅靠 mtime
      // 会把内容一致的文件误报为"不同"。流式比对内容，与 unison 的判定保持一致
      // （unison 在 fastcheck 判定 mtime 有差异后也会走内容比对）。
      throwIfCancelled();
      const sameContent = await filesContentEqual(
        path.join(sourceRoot, s.path),
        path.join(targetRoot, t.path),
      );
      if (!sameContent) {
        diff.different.push({
          path: s.path,
          sourceSize: s.size,
          targetSize: t.size,
          sourceMtime: s.mtime,
          targetMtime: t.mtime,
        });
      }
    }

    throwIfCancelled();
    processedCount++;
    if (processedCount % 500 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  for (const [key, t] of tgtFolded) {
    if (srcFolded.has(key)) continue;

    throwIfCancelled();
    if (isIgnored(t.path)) {
      diff.ignored.push({ path: t.path, size: t.size, side: "target" });
      continue;
    }

    diff.targetOnly.push({ path: t.path, size: t.size });
  }

  return diff;
}
