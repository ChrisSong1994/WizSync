import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

/**
 * 日志管理器类 (LogManager)
 * 负责应用同步日志的持久化存储、读取、轮转和清理
 */
export class LogManager {
  private logsDir: string;
  private readonly MAX_LOG_SIZE = 5 * 1024 * 1024; // 单个日志文件最大 5MB

  constructor() {
    this.logsDir = path.join(app.getPath("userData"), "logs");
    this.ensureDirectoryExists();
  }

  /**
   * 确保日志目录存在
   */
  private ensureDirectoryExists() {
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }
  }

  /**
   * 将日志内容持久化到文件
   * @param id 任务 ID
   * @param content 日志内容
   */
  write(id: string, content: string) {
    const logPath = path.join(this.logsDir, `${id}.log`);
    const timestamp = new Date().toLocaleString();
    const formattedLog = `[${timestamp}] ${content}\n`;
    
    try {
      // 检查文件大小，实现简易的日志轮转（备份旧日志）
      if (fs.existsSync(logPath) && fs.statSync(logPath).size > this.MAX_LOG_SIZE) {
        fs.renameSync(logPath, `${logPath}.old`);
      }
      fs.appendFileSync(logPath, formattedLog);
    } catch (err) {
      console.error(`[LogManager] 写入日志失败 (${id}):`, err);
    }
  }

  /**
   * 获取指定任务的完整日志
   * @param id 任务 ID
   */
  get(id: string): string {
    const logPath = path.join(this.logsDir, `${id}.log`);
    try {
      if (fs.existsSync(logPath)) {
        return fs.readFileSync(logPath, "utf-8");
      }
    } catch (err) {
      console.error(`[LogManager] 读取日志失败 (${id}):`, err);
    }
    return "";
  }

  /**
   * 清理指定任务的日志文件
   * @param id 任务 ID
   */
  clear(id: string) {
    const logPath = path.join(this.logsDir, `${id}.log`);
    try {
      if (fs.existsSync(logPath)) {
        fs.unlinkSync(logPath);
      }
      // 同时清理备份文件
      const oldLogPath = `${logPath}.old`;
      if (fs.existsSync(oldLogPath)) {
        fs.unlinkSync(oldLogPath);
      }
    } catch (err) {
      console.error(`[LogManager] 清理日志失败 (${id}):`, err);
    }
  }
}

// 导出单例
export const logManager = new LogManager();
