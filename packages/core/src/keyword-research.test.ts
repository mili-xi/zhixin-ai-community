import { describe, expect, it } from "vitest";
import { calculateKeywordMetrics, keywordMetrics, mockCompetitors, mockKeywords, mockRankingEntries, mockSerpAnalyses, workspaceNavGroups } from "./index";

describe("keyword metrics", () => {
  it("calculates keyword metrics from keywords and ranking entries", () => {
    const metrics = calculateKeywordMetrics({ keywords: mockKeywords, rankingEntries: mockRankingEntries });
    expect(metrics.totalKeywords).toBe(mockKeywords.length);
    expect(metrics.trackingKeywords).toBe(mockKeywords.filter((keyword) => keyword.status === "tracking").length);
    expect(metrics.indexedKeywords).toBe(mockRankingEntries.filter((entry) => entry.status === "indexed").length);
  });

  it("exposes precomputed keyword metrics", () => {
    expect(keywordMetrics.totalKeywords).toBe(mockKeywords.length);
    expect(keywordMetrics.avgDifficulty).toBeGreaterThanOrEqual(0);
    expect(keywordMetrics.avgDifficulty).toBeLessThanOrEqual(100);
  });
});

describe("keyword research data shapes", () => {
  it("keywords include required fields", () => {
    expect(mockKeywords[0]).toMatchObject({
      id: expect.any(String),
      word: expect.any(String),
      searchVolume: expect.any(Number),
      difficulty: expect.any(Number),
      trend: expect.any(String),
      relatedWords: expect.any(Array),
      status: expect.any(String),
      createdAt: expect.any(String)
    });
  });

  it("serp analyses include top results and brief", () => {
    expect(mockSerpAnalyses[0].topResults.length).toBeGreaterThan(0);
    expect(mockSerpAnalyses[0].contentBrief.length).toBeGreaterThan(0);
  });

  it("competitors include coverage and backlink counts", () => {
    expect(mockCompetitors[0].contentCoverage).toBeGreaterThanOrEqual(0);
    expect(mockCompetitors[0].contentCoverage).toBeLessThanOrEqual(100);
    expect(mockCompetitors[0].backlinkCount).toBeGreaterThanOrEqual(0);
  });

  it("ranking entries include change delta", () => {
    const hasChange = mockRankingEntries.some((entry) => entry.previousPosition !== undefined);
    expect(hasChange).toBe(true);
  });
});

describe("workspace navigation", () => {
  it("keeps keyword and geo research outside the focused publishing navigation", () => {
    const allItems = workspaceNavGroups.flatMap((group) => group.items);
    expect(allItems.some((item) => item.href === "/keywords")).toBe(false);
    expect(allItems.some((item) => item.href === "/competitors")).toBe(false);
    expect(allItems.some((item) => item.href === "/geo-analysis")).toBe(false);
    expect(allItems.some((item) => item.href === "/geo-stats")).toBe(false);
    expect(allItems.some((item) => item.href === "/ai-writer")).toBe(true);
  });
});
