import { describe, expect, it } from "vitest";
import type { PublishedCenterRecord } from "@zengxing/core";
import { publicationGroup, publicationStatus, canRetryPublication } from "./publication-presentation";

const record: PublishedCenterRecord = { id: "media:1", sourceId: "1", sourceType: "media", articleTitle: "文章", channelName: "账号", channelType: "免费媒体", status: "succeeded", indexStatus: "not_submitted", inclusionStatus: "unchecked", updatedAt: "2026-10-30" };

describe("publication presentation preserves evidence boundaries", () => {
  it("does not treat success or a backend review URL as public evidence", () => {
    expect(publicationGroup(record)).toBe("unconfirmed");
    expect(publicationGroup({ ...record, reviewUrl: "https://example.com/admin/123" })).toBe("unconfirmed");
    expect(publicationGroup({ ...record, publishedUrl: "https://example.com/article/123" })).toBe("public");
  });
  it.each([
    { status: "review_required" as const },
    { backlinkStatus: "reviewing" as const },
    { reviewStatus: "pending_public_visibility" },
    { publicDiscoveryStatus: "candidate_found" as const },
  ])("does not present contradictory review evidence as public: %o", (patch) => {
    expect(publicationGroup({ ...record, publishedUrl: "https://example.com/article/123", ...patch })).not.toBe("public");
  });
  it("prioritizes manual action and distribution restrictions", () => {
    expect(publicationGroup({ ...record, status: "review_required", platformStatus: "manual_verification_required" })).toBe("attention");
    expect(publicationGroup({ ...record, platformStatus: "published_restricted", publishedUrl: "https://example.com/123" })).toBe("attention");
    expect(publicationStatus({ ...record, status: "failed", errorMessage: "请完成滑块安全验证" })).toBe("manual_verification_required");
  });
  it("groups active jobs independently of completion", () => {
    expect(publicationGroup({ ...record, status: "running" })).toBe("publishing");
    expect(publicationGroup({ ...record, status: "pending" })).toBe("publishing");
    expect(publicationGroup({ ...record, status: "canceled" })).toBe("unconfirmed");
  });
  it("routes expired account authorization to account recovery instead of retrying", () => {
    const expired = { ...record, status: "failed" as const, errorMessage: "登录状态已失效，请重新授权后再发布。" };
    expect(publicationStatus(expired)).toBe("needs_reauth");
    expect(publicationGroup(expired)).toBe("attention");
    expect(canRetryPublication(expired)).toBe(false);
    expect(canRetryPublication(expired, true)).toBe(true);
  });
  it("does not offer blind retries for review, manual verification, or a known URL repair case", () => {
    expect(canRetryPublication({ ...record, status: "failed" })).toBe(true);
    expect(canRetryPublication({ ...record, status: "review_required" })).toBe(false);
    expect(canRetryPublication({ ...record, status: "failed", platformStatus: "manual_verification_required" })).toBe(false);
    expect(canRetryPublication({ ...record, status: "failed", platform: "zhihu", mediaAccountId: "account:1" })).toBe(false);
    expect(canRetryPublication({ ...record, status: "failed", publishedUrl: "https://example.com/123" })).toBe(false);
  });
  it("allows a failed manual-verification task to resume only after explicit acknowledgement", () => {
    const verification = { ...record, status: "failed" as const, platformStatus: "manual_verification_required" };
    expect(canRetryPublication(verification, true)).toBe(true);
    expect(canRetryPublication({ ...verification, status: "review_required" }, true)).toBe(false);
  });
});
