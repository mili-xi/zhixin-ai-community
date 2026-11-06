import { describe, expect, it } from "vitest";
import { workspaceNavGroups, workspaceNavItems } from "./index";

describe("workspace navigation", () => {
  it("exposes only the media publishing workflow", () => {
    expect(workspaceNavGroups.map((group) => group.label)).toEqual(["运营", "内容", "发布", "接入"]);
    expect(workspaceNavItems.map((item) => item.href)).toEqual([
      "/dashboard",
      "/ai-writer",
      "/articles",
      "/free-media",
      "/auto-publish",
      "/video-publish",
      "/published",
      "/agent-access"
    ]);
  });

  it("keeps creation resources and technical diagnostics out of primary navigation", () => {
    const hrefs = workspaceNavItems.map((item) => item.href);

    expect(hrefs).not.toContain("/generation-rules");
    expect(hrefs).not.toContain("/knowledge-base");
    expect(hrefs).not.toContain("/assets");
    expect(hrefs).not.toContain("/keywords");
    expect(hrefs).not.toContain("/geo-analysis");
    expect(hrefs).not.toContain("/failure-center");
    expect(hrefs).not.toContain("/llm-requests");
    expect(hrefs).not.toContain("/notifications");
  });

  it("orders the retained flow from creation through publishing", () => {
    expect(workspaceNavGroups[1]?.items.map((item) => item.label)).toEqual(["AI 创作", "文章管理"]);
    expect(workspaceNavGroups[2]?.items.map((item) => item.label)).toEqual([
      "媒体账号",
      "自动发布",
      "抖音视频",
      "发布记录"
    ]);
  });

  it("does not expose account billing pages", () => {
    const hrefs = workspaceNavItems.map((item) => item.href);

    expect(hrefs).not.toContain("/employees");
    expect(hrefs).not.toContain("/invite-users");
    expect(hrefs).not.toContain("/pricing");
  });
});
