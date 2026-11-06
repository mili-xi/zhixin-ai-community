import { taskArticleId, taskStageLabel, type AppTask } from "./tasks";

const OPEN_CREATION_STATUSES = new Set(["queued", "pending", "running", "retry"]);

export type CreationTaskViewState = {
  kind: "idle" | "queued" | "running" | "succeeded" | "failed";
  isOpen: boolean;
  label: string;
  progress: number;
  articleId: string;
  errorMessage: string;
};

export function isCreationTask(task: AppTask | null | undefined): task is AppTask {
  return task?.type === "ai-generate-article";
}

export function isOpenCreationTask(task: AppTask | null | undefined) {
  return isCreationTask(task) && OPEN_CREATION_STATUSES.has(task.status);
}

function taskTimestamp(task: AppTask) {
  const value = Date.parse(task.updatedAt || task.createdAt || "");
  return Number.isFinite(value) ? value : 0;
}

export function selectResumableCreationTask(tasks: AppTask[], storedTaskId?: string | null) {
  const creationTasks = tasks.filter(isCreationTask);
  if (storedTaskId) {
    const storedTask = creationTasks.find((task) => task.id === storedTaskId);
    if (storedTask) return storedTask;
  }

  return creationTasks
    .filter(isOpenCreationTask)
    .sort((left, right) => taskTimestamp(right) - taskTimestamp(left))[0] ?? null;
}

export function creationTaskViewState(task: AppTask | null): CreationTaskViewState {
  if (!task || !isCreationTask(task)) {
    return {
      kind: "idle",
      isOpen: false,
      label: "当前没有文章生成任务",
      progress: 0,
      articleId: "",
      errorMessage: ""
    };
  }

  const progress = Math.max(0, Math.min(100, Number(task.progress) || 0));
  if (task.status === "succeeded") {
    return {
      kind: "succeeded",
      isOpen: false,
      label: "图文文章已生成",
      progress: progress || 100,
      articleId: taskArticleId(task),
      errorMessage: ""
    };
  }
  if (task.status === "failed") {
    return {
      kind: "failed",
      isOpen: false,
      label: "文章生成失败",
      progress,
      articleId: "",
      errorMessage: task.errorMessage || "任务执行失败，请清除后重新开始。"
    };
  }

  return {
    kind: task.status === "queued" || task.status === "pending" ? "queued" : "running",
    isOpen: true,
    label: taskStageLabel(task),
    progress,
    articleId: "",
    errorMessage: ""
  };
}