import { describe, expect, it } from "vitest";
import { taskStageLabel } from "./tasks";

describe("taskStageLabel", () => {
  it("describes illustrated writing stages in Chinese", () => {
    expect(taskStageLabel({ status: "running", stage: "writing", progress: 30 })).toBe("正在生成文章结构与正文 / 30%");
    expect(taskStageLabel({ status: "running", stage: "images", progress: 78 })).toBe("正在生成并保存配图 / 78%");
    expect(taskStageLabel({ status: "succeeded", stage: "complete", progress: 100 })).toBe("图文文章已生成 / 100%");
  });
});
