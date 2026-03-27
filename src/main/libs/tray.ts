import { app, Tray, Menu, nativeImage, BrowserWindow } from "electron";
import path from "node:path";
import { syncStore } from "./sync-store";
import { syncManager } from "./sync-manager";

/**
 * 托盘管理器类
 */
export class TrayManager {
  private tray: Tray | null = null;
  private win: BrowserWindow | null = null;
  private appRoot: string;

  constructor(appRoot: string) {
    this.appRoot = appRoot;
  }

  /**
   * 设置主窗口引用
   */
  setWindow(win: BrowserWindow) {
    this.win = win;
  }

  /**
   * 创建系统托盘图标
   */
  createTray(createWindow: () => void) {
    // 根据环境选择图标路径：开发环境下使用 public/assets，生产环境下使用打包后的 dist/assets
    const isDev = !app.isPackaged;
    const iconPath = isDev 
      ? path.join(this.appRoot, "public/assets/tray-icon.png")
      : path.join(this.appRoot, "dist/assets/tray-icon.png");

    const icon = nativeImage.createFromPath(iconPath);
    
    // 如果图标为空，尝试使用备用路径或打印日志
    if (icon.isEmpty()) {
      console.error(`无法加载托盘图标，路径: ${iconPath}`);
    }

    this.tray = new Tray(icon);
    this.tray.setToolTip("WizSync");

    if (process.platform === "darwin") {
      this.tray.setIgnoreDoubleClickEvents(true);
    }

    const updateTrayMenu = () => {
      const tasks = syncStore.getTasks();
      const syncingTasks = tasks.filter((t) => t.status === "syncing");
      const otherTasks = tasks.filter((t) => t.status !== "syncing");

      const menuTemplate: any[] = [];

      // 正在运行的任务部分
      if (syncingTasks.length > 0) {
        menuTemplate.push({ label: "正在运行", enabled: false });
        syncingTasks.forEach((task) => {
          menuTemplate.push({
            label: `🔄 ${task.name}`,
            sublabel: "正在同步...",
            submenu: [
              {
                label: "停止同步",
                click: () => syncManager.stopTask(task.id),
              },
              {
                label: "查看详情",
                click: () => {
                  this.win?.show();
                  this.win?.focus();
                },
              },
            ],
          });
        });
        menuTemplate.push({ type: "separator" });
      }

      // 其他任务部分
      menuTemplate.push({ label: "同步任务", enabled: false });
      if (tasks.length === 0) {
        menuTemplate.push({ label: "暂无任务", enabled: false });
      }

      otherTasks.forEach((task) => {
        const statusIcon = task.status === "error" ? "⚠️" : "📄";
        const statusText =
          task.status === "error"
            ? "同步出错"
            : task.lastSyncTime
            ? `上次同步: ${task.lastSyncTime}`
            : "空闲";

        menuTemplate.push({
          label: `${statusIcon} ${task.name}`,
          sublabel: statusText,
          click: () => syncManager.startTask(task),
        });
      });

      const fullMenu = Menu.buildFromTemplate([
        {
          label: "仪表盘",
          click: () => {
            if (this.win) {
              this.win.show();
              this.win.focus();
            } else {
              createWindow();
            }
          },
        },
        { type: "separator" },
        ...menuTemplate,
        { type: "separator" },
        {
          label: "退出程序",
          click: () => {
            app.quit();
          },
        },
      ]);

      if (process.platform === "darwin") {
        this.tray?.on("click", () => {
          this.tray?.popUpContextMenu(fullMenu);
        });
        this.tray?.on("right-click", () => {
          this.tray?.popUpContextMenu(fullMenu);
        });

        // 更新标题显示数量
        if (syncingTasks.length > 0) {
          this.tray?.setTitle(` ${syncingTasks.length}`);
        } else {
          this.tray?.setTitle("");
        }
      } else {
        this.tray?.setContextMenu(fullMenu);
      }
    };

    syncManager.setStatusChangeCallback(updateTrayMenu);
    updateTrayMenu();
  }
}
