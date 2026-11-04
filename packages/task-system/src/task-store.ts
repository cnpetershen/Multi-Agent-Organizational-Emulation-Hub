import type { Task } from './task-types.js';

export interface TaskStore {
  get(taskId: string): Task | null;
  has(taskId: string): boolean;
  save(task: Task): void;
  /** Drop a record the log has just deleted. Idempotent: an unknown id is simply gone. */
  delete(taskId: string): void;
  all(): readonly Task[];
}

export function createInMemoryTaskStore(): TaskStore {
  const tasks = new Map<string, Task>();
  return {
    get(taskId) {
      return tasks.get(taskId) ?? null;
    },
    has(taskId) {
      return tasks.has(taskId);
    },
    save(task) {
      tasks.set(task.taskId, task);
    },
    delete(taskId) {
      tasks.delete(taskId);
    },
    all() {
      return Object.freeze([...tasks.values()]);
    },
  };
}
