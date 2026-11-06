import { describe, expect, it } from "vitest";
import {
  creationTaskViewState,
  isOpenCreationTask,
  selectResumableCreationTask
} from "./creation-task-state";
import type { AppTask } from "./tasks";

function task(overrides: Partial<AppTask> & Pick<AppTask, "id" | "status">): AppTask {
  return {
    type: "ai-generate-article",
    createdAt: "2026-07-23T08:00:00+08:00",
    updatedAt: "2026-07-23T08:00:00+08:00",
    ...overrides
  };
}

describe("creation task restoration", () => {
  it("recognizes only unfinished creation task statuses as open", () => {
    expect(isOpenCreationTask(task({ id: "queued", status: "queued" }))).toBe(true);
    expect(isOpenCreationTask(task({ id: "running", status: "running" }))).toBe(true);
    expect(isOpenCreationTask(task({ id: "done", status: "succeeded" }))).toBe(false);
    expect(isOpenCreationTask(task({ id: "failed", status: "failed" }))).toBe(false);
  });

  it("prefers the stored creation task even when it has completed", () => {
    const tasks = [
      task({ id: "new-open", status: "running", updatedAt: "2026-07-23T09:00:00+08:00" }),
      task({ id: "stored", status: "succeeded", updatedAt: "2026-07-23T08:30:00+08:00" })
    ];

    expect(selectResumableCreationTask(tasks, "stored")?.id).toBe("stored");
  });

  it("recovers the newest unfinished creation task when storage is empty", () => {
    const tasks = [
      task({ id: "older", status: "queued", updatedAt: "2026-07-23T08:10:00+08:00" }),
      task({ id: "newer", status: "running", updatedAt: "2026-07-23T08:20:00+08:00" }),
      task({ id: "completed", status: "succeeded", updatedAt: "2026-07-23T08:30:00+08:00" })
    ];

    expect(selectResumableCreationTask(tasks, null)?.id).toBe("newer");
  });

  it("ignores tasks from other workflows", () => {
    const publishTask = task({ id: "publish", status: "running", type: "auto-publish" });

    expect(selectResumableCreationTask([publishTask], "publish")).toBeNull();
  });
});

describe("creationTaskViewState", () => {
  it("exposes an explicit article result without requesting navigation", () => {
    const state = creationTaskViewState(task({
      id: "done",
      status: "succeeded",
      progress: 100,
      result: { articleId: "article-1" }
    }));

    expect(state.kind).toBe("succeeded");
    expect(state.articleId).toBe("article-1");
    expect(state.progress).toBe(100);
  });
});