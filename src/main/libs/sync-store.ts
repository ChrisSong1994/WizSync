import Store from "electron-store";
import { SyncTask } from "./types";

/**
 * 初始化本地存储实例，用于保存同步任务
 */
const store = new Store({
  name: "wizsync-tasks",
  defaults: {
    tasks: [],
  },
});

/**
 * 任务持久化管理对象
 */
export const syncStore = {
  /**
   * 获取所有已保存的任务
   */
  getTasks: (): SyncTask[] => store.get("tasks") as SyncTask[],

  /**
   * 保存或新增任务
   */
  saveTask: (task: SyncTask): SyncTask[] => {
    const tasks = syncStore.getTasks();
    const index = tasks.findIndex((t) => t.id === task.id);
    if (index > -1) {
      tasks[index] = task;
    } else {
      tasks.push(task);
    }
    store.set("tasks", tasks);
    return tasks;
  },

  /**
   * 根据 ID 删除任务
   */
  deleteTask: (id: string): SyncTask[] => {
    const tasks = syncStore.getTasks().filter((t) => t.id !== id);
    store.set("tasks", tasks);
    return tasks;
  },

  /**
   * 更新现有任务的指定属性
   */
  updateTask: (id: string, updates: Partial<SyncTask>) => {
    const tasks = syncStore.getTasks();
    const index = tasks.findIndex((t) => t.id === id);
    if (index > -1) {
      tasks[index] = { ...tasks[index], ...updates };
      store.set("tasks", tasks);
    }
    return tasks[index];
  },
};
