"use client";

import {
  creationTaskViewState,
  isOpenCreationTask,
  selectResumableCreationTask,
  type CreationTaskViewState
} from "@/lib/creation-task-state";
import { jsonFetch, type AppTask } from "@/lib/tasks";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";

const CREATION_TASK_STORAGE_KEY = "zhixin-ai.active-creation-task-id";
const CREATION_TASK_POLL_INTERVAL_MS = 2500;

type CreationTaskContextValue = {
  task: AppTask | null;
  viewState: CreationTaskViewState;
  hasOpenTask: boolean;
  isRestoring: boolean;
  registerTask: (task: AppTask) => boolean;
  clearTask: () => void;
  refreshTask: () => Promise<AppTask | null>;
};

const CreationTaskContext = createContext<CreationTaskContextValue | null>(null);

export function CreationTaskProvider({ children }: { children: ReactNode }) {
  const [task, setTask] = useState<AppTask | null>(null);
  const [isRestoring, setIsRestoring] = useState(true);
  const taskRef = useRef<AppTask | null>(null);

  const replaceTask = useCallback((nextTask: AppTask | null) => {
    taskRef.current = nextTask;
    setTask(nextTask);
    if (nextTask) window.localStorage.setItem(CREATION_TASK_STORAGE_KEY, nextTask.id);
    else window.localStorage.removeItem(CREATION_TASK_STORAGE_KEY);
  }, []);

  useEffect(() => {
    let canceled = false;

    async function restoreTask() {
      const storedTaskId = window.localStorage.getItem(CREATION_TASK_STORAGE_KEY);
      try {
        const tasks = await jsonFetch<AppTask[]>("/api/tasks", { cache: "no-store" });
        if (canceled || taskRef.current) return;
        replaceTask(selectResumableCreationTask(tasks, storedTaskId));
      } catch {
        if (!canceled && storedTaskId && !taskRef.current) {
          try {
            const storedTask = await jsonFetch<AppTask>(`/api/tasks/${encodeURIComponent(storedTaskId)}`, { cache: "no-store" });
            if (!canceled && !taskRef.current) replaceTask(storedTask.type === "ai-generate-article" ? storedTask : null);
          } catch {
            if (!canceled && !taskRef.current) replaceTask(null);
          }
        }
      } finally {
        if (!canceled) setIsRestoring(false);
      }
    }

    void restoreTask();
    return () => {
      canceled = true;
    };
  }, [replaceTask]);

  const refreshTask = useCallback(async () => {
    const taskId = taskRef.current?.id;
    if (!taskId) return null;
    const refreshed = await jsonFetch<AppTask>(`/api/tasks/${encodeURIComponent(taskId)}`, { cache: "no-store" });
    if (taskRef.current?.id === taskId) replaceTask(refreshed);
    return refreshed;
  }, [replaceTask]);

  useEffect(() => {
    if (!task?.id || !isOpenCreationTask(task)) return;
    let canceled = false;
    let timer: number | undefined;

    async function poll() {
      try {
        const refreshed = await refreshTask();
        if (!canceled && refreshed && isOpenCreationTask(refreshed)) {
          timer = window.setTimeout(poll, CREATION_TASK_POLL_INTERVAL_MS);
        }
      } catch {
        if (!canceled) timer = window.setTimeout(poll, CREATION_TASK_POLL_INTERVAL_MS);
      }
    }

    timer = window.setTimeout(poll, CREATION_TASK_POLL_INTERVAL_MS);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshTask();
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      canceled = true;
      if (timer) window.clearTimeout(timer);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [task?.id, task?.status, refreshTask]);

  const registerTask = useCallback((nextTask: AppTask) => {
    const currentTask = taskRef.current;
    if (currentTask && currentTask.id !== nextTask.id && isOpenCreationTask(currentTask)) return false;
    replaceTask(nextTask);
    setIsRestoring(false);
    return true;
  }, [replaceTask]);

  const clearTask = useCallback(() => {
    if (isOpenCreationTask(taskRef.current)) return;
    replaceTask(null);
  }, [replaceTask]);

  const value = useMemo<CreationTaskContextValue>(() => ({
    task,
    viewState: creationTaskViewState(task),
    hasOpenTask: isOpenCreationTask(task),
    isRestoring,
    registerTask,
    clearTask,
    refreshTask
  }), [task, isRestoring, registerTask, clearTask, refreshTask]);

  return <CreationTaskContext.Provider value={value}>{children}</CreationTaskContext.Provider>;
}

export function useCreationTask() {
  const context = useContext(CreationTaskContext);
  if (!context) throw new Error("useCreationTask must be used within CreationTaskProvider");
  return context;
}