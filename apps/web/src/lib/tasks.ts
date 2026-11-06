export type TaskStatus = "queued" | "pending" | "running" | "succeeded" | "failed" | string;

export type AppTask = {
  id: string;
  type: string;
  title?: string;
  status: TaskStatus;
  progress?: number;
  stage?: "context" | "writing" | "draft" | "images" | "quality" | "complete" | string;
  queue?: string;
  errorMessage?: string;
  createdAt?: string;
  updatedAt?: string;
  result?: {
    articleId?: string;
    generatedArticleIds?: string[];
    indexSubmissionId?: string;
    backlinkUrl?: string;
    assetIds?: string[];
    imageSucceeded?: number;
    imageFailed?: number;
    stage?: string;
    [key: string]: unknown;
  };
};

export async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}

export function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function taskStageLabel(task: Pick<AppTask, "status" | "stage" | "progress">) {
  const labels: Record<string, string> = {
    context: "正在整理规则、知识和素材上下文",
    writing: "正在生成文章结构与正文",
    draft: "文章草稿已生成，正在规划配图",
    images: "正在生成并保存配图",
    quality: "正在装配图文并执行质量检查",
    complete: "图文文章已生成"
  };
  const label = labels[String(task.stage ?? "")] ?? (task.status === "queued" ? "任务已入队" : `任务状态：${task.status}`);
  return typeof task.progress === "number" ? `${label} / ${task.progress}%` : label;
}

export async function pollTask(
  taskId: string,
  options: {
    intervalMs?: number;
    timeoutMs?: number;
    onUpdate?: (task: AppTask) => void;
  } = {}
) {
  const intervalMs = options.intervalMs ?? 2500;
  const timeoutMs = options.timeoutMs ?? 180000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const task = await jsonFetch<AppTask>(`/api/tasks/${encodeURIComponent(taskId)}`);
    options.onUpdate?.(task);
    if (task.status === "succeeded") return task;
    if (task.status === "failed") throw new Error(task.errorMessage || `任务 ${taskId} 执行失败`);
    await wait(intervalMs);
  }

  throw new Error(`任务 ${taskId} 等待超时，请到创作历史或失败重试中心查看。`);
}

export function taskArticleId(task: AppTask) {
  return task.result?.articleId || task.result?.generatedArticleIds?.[0] || "";
}
