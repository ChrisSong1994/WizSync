import fs from "node:fs";
import path from "node:path";

/**
 * 定义全局统一的忽略规则
 */
export const IGNORE_PATTERNS = [
  ".DS_Store",
  ".git",
  "node_modules",
  "Thumbs.db",
  "desktop.ini",
  ".localized",
  ".unison." // Unison 临时文件
];

/**
 * 判断路径是否应该被忽略
 */
function isIgnored(name: string): boolean {
  return IGNORE_PATTERNS.some(pattern => {
    if (name === pattern) return true;
    if (name.startsWith('.') && name === pattern) return true;
    return name.includes(`/${pattern}/`) || name.startsWith(`${pattern}/`) || name.endsWith(`/${pattern}`);
  });
}

/**
 * 更鲁棒的忽略检查（供统计和列表扫描使用）
 */
function shouldSkip(name: string): boolean {
  return IGNORE_PATTERNS.some(p => name === p || name.includes(p));
}

/**
 * 获取路径所在磁盘的容量信息
 */
export function getDiskSpace(dirPath: string): { total: number; free: number } | null {
  try {
    if (!fs.existsSync(dirPath)) return null;
    // 使用 statfs 获取磁盘统计信息
    const stats = fs.statfsSync(dirPath);
    return {
      total: stats.bsize * stats.blocks,
      free: stats.bsize * stats.bfree,
    };
  } catch (err) {
    console.error("获取磁盘空间失败:", err);
    return null;
  }
}

/**
 * 递归获取目录统计信息（排除忽略文件）
 */
export async function getDirStats(
  dirPath: string
): Promise<{ size: number; count: number }> {
  let size = 0;
  let count = 0;
  try {
    if (!fs.existsSync(dirPath)) return { size: 0, count: 0 };
    
    const files = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const file of files) {
      // 过滤忽略的文件或目录
      if (shouldSkip(file.name)) continue;

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
 * 递归获取目录下所有文件的详细信息（排除忽略文件）
 */
export function getAllFiles(
  dirPath: string,
  baseDir: string = dirPath
): Map<string, { size: number; mtime: number }> {
  const result = new Map();
  try {
    if (!fs.existsSync(dirPath)) return result;

    const files = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const file of files) {
      // 过滤忽略的文件或目录
      if (shouldSkip(file.name)) continue;

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
