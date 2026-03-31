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
 * 递归获取目录统计信息（异步非阻塞版）
 */
export async function getDirStats(
  dirPath: string
): Promise<{ size: number; count: number }> {
  let size = 0;
  let count = 0;
  try {
    if (!fs.existsSync(dirPath)) return { size: 0, count: 0 };
    const files = await fs.promises.readdir(dirPath, { withFileTypes: true });
    await Promise.all(files.map(async (file) => {
      if (shouldSkip(file.name)) return;
      const fullPath = path.join(dirPath, file.name);
      if (file.isDirectory()) {
        const subStats = await getDirStats(fullPath);
        size += subStats.size;
        count += subStats.count;
      } else {
        const stats = await fs.promises.stat(fullPath);
        size += stats.size;
        count++;
      }
    }));
  } catch (err) {
    console.error("获取统计信息失败:", err);
  }
  return { size, count };
}

/**
 * 递归获取目录下所有文件的详细信息
 * @param onProgress 进度回调，返回当前已扫描的文件数
 */
export async function getAllFiles(
  dirPath: string,
  baseDir: string = dirPath,
  state: { count: number } = { count: 0 },
  onProgress?: (count: number) => void
): Promise<Map<string, { size: number; mtime: number }>> {
  const result = new Map<string, { size: number; mtime: number }>();
  
  try {
    if (!fs.existsSync(dirPath)) return result;
    const files = await fs.promises.readdir(dirPath, { withFileTypes: true });
    
    for (const file of files) {
      if (shouldSkip(file.name)) continue;

      const fullPath = path.join(dirPath, file.name);
      const relPath = path.relative(baseDir, fullPath);

      if (file.isDirectory()) {
        const subFiles = await getAllFiles(fullPath, baseDir, state, onProgress);
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
    console.error("获取文件列表失败:", err);
  }
  return result;
}
