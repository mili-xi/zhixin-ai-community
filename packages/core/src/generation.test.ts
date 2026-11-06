import { describe, expect, it } from "vitest";
import { generateArticleDraft, scoreArticleContent } from "./index";

const articleInput = {
  keyword: "GEO 内容营销",
  productDescription: "自动生成、评分、发布并追踪收录的内容增长工作台",
  targetAudience: "企业内容运营和 SEO 团队",
  brandProfile: "智心AI",
  intent: "GEO 引用友好长文",
  tone: "专业可信",
  wordCount: 1800,
  includeFaq: true,
  includeInternalLinks: true
};

describe("generateArticleDraft", () => {
  it("creates a readable Chinese article draft from keyword and business material", () => {
    const draft = generateArticleDraft(articleInput);

    expect(draft.title).toContain("企业如何使用 GEO 内容营销");
    expect(draft.summary).toContain("智心AI");
    expect(draft.contentMarkdown).toContain("## FAQ");
    expect(draft.metaDescription).toContain("GEO 内容营销");
    expect(draft.keywords).toContain("GEO 内容营销");
    expect(`${draft.title}${draft.summary}${draft.contentMarkdown}`).not.toMatch(/[锟�]|鎴|鏇|閫|绔/);
  });
});

describe("scoreArticleContent", () => {
  it("scores generated content with semantic and GEO dimensions", () => {
    const draft = generateArticleDraft(articleInput);

    const score = scoreArticleContent({
      title: draft.title,
      summary: draft.summary,
      contentMarkdown: draft.contentMarkdown,
      keywords: draft.keywords
    });

    expect(score.totalScore).toBeGreaterThanOrEqual(75);
    expect(score.items.some((item) => item.dimension === "semantic")).toBe(true);
    expect(score.items.some((item) => item.dimension === "geo")).toBe(true);
  });
});
