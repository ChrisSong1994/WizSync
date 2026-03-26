import fs from "node:fs";
import path from "node:path";

/**
 * 递归获取目录统计信息（总大小和文件数量）
 */
export async function getDirStats(
  dirPath: string
): Promise<{ size: number; count: number }> {
  let size = 0;
  let count = 0;
  try {
    const files = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const file of files) {
      const fullPath = path.join(dirPath, file.name);
      if (file.isDirectory()) {
        const subStats = await getDirStats(fullPath);
        size += subStats.size;
        count += subStats.count;
      } else {
        const stats = fs.statSync(fullPath);
        size += stats.size;
        count++;
      }
    }
  } catch (err) {
    console.error("获取统计信息失败:", err);
  }
  return { size, count };
}

/**
 * 递归获取目录下所有文件的详细信息，用于对比差异
 */
export function getAllFiles(
  dirPath: string,
  baseDir: string = dirPath
): Map<string, { size: number; mtime: number }> {
  const result = new Map();
  try {
    const files = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const file of files) {
      const fullPath = path.join(dirPath, file.name);
      const relPath = path.relative(baseDir, fullPath);

      if (file.isDirectory()) {
        const subFiles = getAllFiles(fullPath, baseDir);
        subFiles.forEach((v, k) => result.set(k, v));
      } else {
        const stats = fs.statSync(fullPath);
        result.set(relPath, { size: stats.size, mtime: stats.mtimeMs });
      }
    }
  } catch (err) {
    console.error("获取文件列表失败:", err);
  }
  return result;
}
