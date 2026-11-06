import { describe, expect, it } from "vitest";

import { articlePublishLabel, articlePublishState, isArticlePublishLocked, isArticleTargetPublishLocked } from "./article-publish-state";

const article = (overrides: Record<string, unknown> = {}) => ({
  id: "article-1",
  title: "Article",
  status: "ready",
  siteName: "",
  keyword: "seo",
  updatedAt: "07/21 10:00",
  ...overrides,
});

describe("article publication state", () => {
  it.each(["pending", "queued", "running", "publishing", "manual_verification_required", "review_required", "submitted_for_review", "account_under_review", "succeeded", "published"])(
    "locks an article while publication status is %s",
    (publishStatus) => {
      expect(isArticlePublishLocked(article({ publishStatus }))).toBe(true);
    },
  );

  it.each([undefined, "", "not_published", "failed", "canceled", "cancelled"])(
    "allows publication when the article status is %s",
    (publishStatus) => {
      expect(isArticlePublishLocked(article({ publishStatus }))).toBe(false);
    },
  );

  it("uses the latest linked publication record when article fields are absent", () => {
    const orders = [
      { id: "old", status: "failed", updatedAt: "07/21 09:00" },
      { id: "current", status: "review_required", updatedAt: "07/21 10:00" },
    ];

    expect(articlePublishState(article(), orders)).toBe("review_required");
    expect(isArticlePublishLocked(article(), orders)).toBe(true);
  });

  it("keeps an explicit failed article retryable even when old successful history remains", () => {
    const orders = [{ id: "old", status: "succeeded", updatedAt: "07/20 10:00", backlinkUrl: "https://example.test/old" }];

    expect(articlePublishState(article({ publishStatus: "failed" }), orders)).toBe("failed");
    expect(isArticlePublishLocked(article({ publishStatus: "failed" }), orders)).toBe(false);
  });

  it("locks media publishing per target account instead of the whole article", () => {
    const orders = [
      { id: "zhihu", status: "review_required", mediaAccountId: "media-account-zhihu", updatedAt: "07/21 10:00" },
      { id: "sohu", status: "failed", mediaAccountId: "media-account-sohu", updatedAt: "07/21 10:01" },
    ];

    expect(isArticleTargetPublishLocked(article({ publishStatus: "review_required" }), orders, [], "media:media-account-zhihu")).toBe(true);
    expect(isArticleTargetPublishLocked(article({ publishStatus: "review_required" }), orders, [], "media:media-account-sohu")).toBe(false);
    expect(isArticleTargetPublishLocked(article({ publishStatus: "review_required" }), orders, [], "media:media-account-new")).toBe(false);
  });

  it("describes platform review without claiming the article is publicly published", () => {
    expect(articlePublishLabel("submitted_for_review")).toBe("平台审核中");
    expect(articlePublishLabel("failed")).toBe("发布失败，可重试");
    expect(articlePublishLabel("published")).toBe("已发布");
  });
  it("locks and labels a distribution-restricted publication", () => {
    expect(articlePublishState(article({ publishStatus: "published_restricted" }))).toBe("published_restricted");
    expect(isArticlePublishLocked(article({ publishStatus: "published_restricted" }))).toBe(true);
    expect(articlePublishLabel("published_restricted")).toBe("\u5df2\u53d1\u5e03\uff0c\u5206\u53d1\u53d7\u9650");
  });
});
