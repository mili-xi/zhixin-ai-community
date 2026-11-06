import { describe, expect, it } from "vitest";
import {
  calculateInclusionWorkflowSummary,
  createPublishedRecords,
  getInclusionCheckQueue,
  getIndexablePublishOptions,
  resolveIndexSubmissionInput,
  type IndexSubmission,
  type MediaOrder,
  type PublishJob
} from "./index";

const publishJobs: PublishJob[] = [
  {
    id: "publish-ok",
    articleId: "article-1",
    articleTitle: "Indexable article",
    siteId: "site-1",
    siteName: "Main site",
    connectorType: "WordPress",
    status: "succeeded",
    attempts: 1,
    publishedUrl: "https://example.com/articles/indexable",
    updatedAt: "today"
  },
  {
    id: "publish-no-url",
    articleTitle: "Succeeded without URL",
    siteName: "Main site",
    connectorType: "Webhook",
    status: "succeeded",
    attempts: 1,
    updatedAt: "today"
  },
  {
    id: "publish-failed",
    articleTitle: "Failed article",
    siteName: "Main site",
    connectorType: "Webhook",
    status: "failed",
    attempts: 1,
    publishedUrl: "https://example.com/articles/failed",
    updatedAt: "today"
  }
];

describe("indexing workflow helpers", () => {
  it("returns only successful publish jobs with real published URLs", () => {
    expect(getIndexablePublishOptions(publishJobs)).toEqual([
      {
        jobId: "publish-ok",
        articleTitle: "Indexable article",
        siteName: "Main site",
        url: "https://example.com/articles/indexable"
      }
    ]);
  });

  it("uses the selected published job before manual URL fields", () => {
    expect(
      resolveIndexSubmissionInput({
        publishJobs,
        selectedJobId: "publish-ok",
        manualTitle: "Manual title",
        manualUrl: "https://manual.example/articles/manual",
        provider: "IndexNow"
      })
    ).toEqual({
      articleTitle: "Indexable article",
      provider: "IndexNow",
      source: "publish_job",
      url: "https://example.com/articles/indexable"
    });
  });

  it("falls back to trimmed manual URL fields when no publish job is selected", () => {
    expect(
      resolveIndexSubmissionInput({
        publishJobs,
        selectedJobId: "",
        manualTitle: "  Manual article  ",
        manualUrl: "  https://manual.example/articles/manual  ",
        provider: "Baidu"
      })
    ).toEqual({
      articleTitle: "Manual article",
      provider: "Baidu",
      source: "manual",
      url: "https://manual.example/articles/manual"
    });
  });

  it("rejects incomplete index submission input", () => {
    expect(
      resolveIndexSubmissionInput({
        publishJobs,
        selectedJobId: "",
        manualTitle: "Manual article",
        manualUrl: "",
        provider: "Sitemap"
      })
    ).toBeNull();
  });

  it("summarizes the index submission to inclusion check funnel", () => {
    const submissions: IndexSubmission[] = [
      { id: "s1", articleTitle: "A", provider: "IndexNow", submitted: true, inclusionStatus: "unchecked", checkedAt: "today", url: "https://example.com/a" },
      { id: "s2", articleTitle: "B", provider: "Baidu", submitted: true, inclusionStatus: "indexed", checkedAt: "today", url: "https://example.com/b" },
      { id: "s3", articleTitle: "C", provider: "Sitemap", submitted: true, inclusionStatus: "not_indexed", checkedAt: "today", url: "https://brand.example/c" },
      { id: "s4", articleTitle: "D", provider: "Sitemap", submitted: true, inclusionStatus: "failed", checkedAt: "today", url: "bad-url" },
      { id: "s5", articleTitle: "E", provider: "Baidu", submitted: true, inclusionStatus: "checking", checkedAt: "today", url: "https://example.com/e" },
      { id: "s6", articleTitle: "F", provider: "Google", status: "pending", submitted: false, inclusionStatus: "unchecked", checkedAt: "", url: "https://example.com/f" }
    ];

    expect(calculateInclusionWorkflowSummary(submissions)).toEqual({
      totalSubmitted: 5,
      unchecked: 2,
      checking: 1,
      indexed: 1,
      notIndexed: 1,
      failed: 1,
      checked: 3,
      checkable: 4,
      inclusionRate: 33
    });
  });

  it("builds a re-check queue with unchecked URLs first", () => {
    const submissions: IndexSubmission[] = [
      { id: "indexed", articleTitle: "Indexed", provider: "IndexNow", submitted: true, inclusionStatus: "indexed", checkedAt: "today", url: "https://example.com/indexed" },
      { id: "failed", articleTitle: "Failed", provider: "Baidu", submitted: true, inclusionStatus: "failed", checkedAt: "today", url: "bad-url" },
      { id: "unchecked", articleTitle: "Unchecked", provider: "Sitemap", submitted: true, inclusionStatus: "unchecked", checkedAt: "today", url: "https://brand.example/unchecked" },
      { id: "checking", articleTitle: "Checking", provider: "Sitemap", submitted: true, inclusionStatus: "checking", checkedAt: "today", url: "https://example.com/checking" },
      { id: "pending", articleTitle: "Pending", provider: "Google", status: "pending", submitted: false, inclusionStatus: "unchecked", checkedAt: "", url: "https://example.com/pending" },
      { id: "missing-url", articleTitle: "Missing", provider: "Baidu", submitted: true, inclusionStatus: "unchecked", checkedAt: "today" }
    ];

    expect(getInclusionCheckQueue(submissions).map((item) => item.id)).toEqual(["unchecked", "failed", "indexed"]);
  });

  it("merges website publishes and media backlinks into published center records", () => {
    const mediaOrders: MediaOrder[] = [
      {
        id: "media-ok",
        articleTitle: "Media backlink article",
        resourceId: "media-res-1",
        resourceName: "People Media",
        status: "succeeded",
        backlinkStatus: "published",
        backlinkUrl: "https://example.com/backlink/media-ok",
        createdAt: "today 09:00",
        updatedAt: "today 10:00"
      },
      {
        id: "media-running",
        articleTitle: "Media running article",
        resourceId: "media-res-2",
        resourceName: "Tech Media",
        status: "running",
        backlinkStatus: "pending",
        createdAt: "today 09:30",
        updatedAt: "today 09:30"
      }
    ];
    const submissions: IndexSubmission[] = [
      {
        id: "site-index",
        articleTitle: "Indexable article",
        provider: "IndexNow",
        submitted: true,
        inclusionStatus: "indexed",
        checkedAt: "today 10:30",
        url: "https://example.com/articles/indexable"
      },
      {
        id: "media-index",
        articleTitle: "Media backlink article",
        provider: "Baidu",
        status: "pending",
        submitted: false,
        inclusionStatus: "unchecked",
        checkedAt: "today 10:35",
        url: "https://example.com/backlink/media-ok"
      }
    ];

    const records = createPublishedRecords({ publishJobs, mediaOrders, indexSubmissions: submissions });

    expect(records.map((record) => record.id)).toEqual(["media:media-ok", "media:media-running", "site:publish-ok", "site:publish-no-url", "site:publish-failed"]);
    expect(records[2]).toMatchObject({
      sourceType: "site",
      articleTitle: "Indexable article",
      channelName: "Main site",
      publishedUrl: "https://example.com/articles/indexable",
      indexStatus: "submitted",
      inclusionStatus: "indexed"
    });
    expect(records[0]).toMatchObject({
      sourceType: "media",
      articleTitle: "Media backlink article",
      channelName: "People Media",
      publishedUrl: "https://example.com/backlink/media-ok",
      indexStatus: "pending",
      inclusionStatus: "unchecked"
    });
    expect(records[1]).toMatchObject({
      sourceType: "media",
      articleTitle: "Media running article",
      publishedUrl: undefined,
      indexStatus: "not_submitted",
      inclusionStatus: "unchecked"
    });
  });
});
