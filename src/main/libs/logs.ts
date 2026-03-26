import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

/**
 * 日志管理器类 (LogManager)
 * 负责应用同步日志的持久化存储、读取和清理。
 * 支持按任务 ID 分文件夹存储，并按日期（天）分割文件。
 */
export class LogManager {
  private logsBaseDir: string;

  constructor() {
    this.logsBaseDir = path.join(app.getPath("userData"), "logs");
    this.ensureDirectoryExists(this.logsBaseDir);
  }

  /**
   * 确保目录存在
   */
  private ensureDirectoryExists(dir: string) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * 获取当前日期的字符串 (yyyy-mm-dd)
   */
  private getTodayString(): string {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  /**
   * 将日志内容按天持久化到任务文件夹下
   * @param id 任务 ID
   * @param content 日志内容
   */
  write(id: string, content: string) {
    const taskLogsDir = path.join(this.logsBaseDir, id);
    this.ensureDirectoryExists(taskLogsDir);

    const logFileName = `${this.getTodayString()}.log`;
    const logPath = path.join(taskLogsDir, logFileName);
    
    const timestamp = new Date().toLocaleTimeString();
    const formattedLog = `[${timestamp}] ${content}\n`;
    
    try {
      fs.appendFileSync(logPath, formattedLog);
    } catch (err) {
      console.error(`[LogManager] 写入日志失败 (${id}):`, err);
    }
  }

  /**
   * 获取指定任务的所有日志（合并最近 7 天的日志）
   * @param id 任务 ID
   */
  get(id: string): string {
    const taskLogsDir = path.join(this.logsBaseDir, id);
    if (!fs.existsSync(taskLogsDir)) return "";

    try {
      const files = fs.readdirSync(taskLogsDir)
        .filter(f => f.endsWith(".log"))
        .sort() // 按日期排序
        .slice(-7); // 仅加载最近 7 天的日志，防止模态框加载压力过大

      let combinedLogs = "";
      for (const file of files) {
        const date = file.replace(".log", "");
        combinedLogs += `\n--- 日期: ${date} ---\n`;
        combinedLogs += fs.readFileSync(path.join(taskLogsDir, file), "utf-8");
      }
      return combinedLogs;
    } catch (err) {
      console.error(`[LogManager] 读取日志失败 (${id}):`, err);
    }
    return "";
  }

  /**
   * 清理指定任务的所有日志文件
   * @param id 任务 ID
   */
  clear(id: string) {
    const taskLogsDir = path.join(this.logsBaseDir, id);
    try {
      if (fs.existsSync(taskLogsDir)) {
        // 递归删除任务文件夹及其下的所有日志
        fs.rmSync(taskLogsDir, { recursive: true, force: true });
      }
    } catch (err) {
      console.error(`[LogManager] 清理日志失败 (${id}):`, err);
    }
  }
}

// 导出单例
export const logManager = new LogManager();
