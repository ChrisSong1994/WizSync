import Store from "electron-store";
import { SyncTask } from "./types";

const store = new Store({
  name: "wizsync-tasks",
  defaults: {
    tasks: [],
  },
});

export const syncStore = {
  getTasks: (): SyncTask[] => store.get("tasks") as SyncTask[],

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

  deleteTask: (id: string): SyncTask[] => {
    const tasks = syncStore.getTasks().filter((t) => t.id !== id);
    store.set("tasks", tasks);
    return tasks;
  },

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
