import { describe, expect, it } from "vitest";
import { mockPublishJobs } from "./index";

describe("publish job seed data", () => {
  it("keeps retry identifiers on seeded publish jobs", () => {
    for (const job of mockPublishJobs) {
      expect(job.articleId, `${job.id} articleId`).toBeTruthy();
      expect(job.siteId, `${job.id} siteId`).toBeTruthy();
    }
  });
});
