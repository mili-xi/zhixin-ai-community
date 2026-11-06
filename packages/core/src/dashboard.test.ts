import { describe, expect, it } from "vitest";
import { calculateDashboardMetrics, mockArticles, mockIndexSubmissions, mockPublishJobs } from "./index";

describe("calculateDashboardMetrics", () => {
  it("summarizes articles, publishing, index submissions, and inclusion state", () => {
    const metrics = calculateDashboardMetrics({
      articles: mockArticles,
      publishJobs: mockPublishJobs,
      indexSubmissions: mockIndexSubmissions
    });

    expect(metrics.totalArticles).toBe(18);
    expect(metrics.drafts).toBe(5);
    expect(metrics.published).toBe(11);
    expect(metrics.publishSuccessRate).toBe(86);
    expect(metrics.submittedIndexes).toBe(14);
    expect(metrics.includedUrls).toBe(9);
  });
});
