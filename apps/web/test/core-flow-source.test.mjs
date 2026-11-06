import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(testDir, "../app/auto-publish/page.tsx");
const publishingSurfacePaths = [
  sourcePath,
  path.resolve(testDir, "../app/ai-writer/writer-wizard.tsx"),
  path.resolve(testDir, "../app/dashboard/page.tsx"),
  path.resolve(testDir, "../app/editor/editor-inner.tsx")
];
const publishingRecordSurfacePaths = [
  path.resolve(testDir, "../app/articles/page.tsx"),
  path.resolve(testDir, "../app/published/page.tsx")
];

test("auto publish uses only active canonical free-media accounts", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /\/api\/media-accounts/);
  assert.match(source, /isMediaAccountPublishable/);
  assert.match(source, /href="\/free-media"/);
  assert.doesNotMatch(source, /\/api\/sites/);
  assert.doesNotMatch(source, /\bSite\b/);
  assert.doesNotMatch(source, /软文媒体平台/);
});

test("auto publish can continue from an existing article", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /useSearchParams/);
  assert.match(source, /searchParams\.get\("articleId"\)/);
  assert.match(source, /articleIds:/);
  assert.match(source, /mediaAccountIds:/);
});

test("publishing surfaces exclude stale media credentials", async () => {
  for (const filePath of publishingSurfacePaths) {
    const source = await readFile(filePath, "utf8");
    assert.match(source, /isMediaAccountPublishable/);
  }
});

test("publishing surfaces do not request the removed search-index workflow", async () => {
  for (const filePath of publishingSurfacePaths) {
    const source = await readFile(filePath, "utf8");
    assert.doesNotMatch(source, /submitIndex\s*:\s*true/);
    assert.doesNotMatch(source, /\u53d1\u5e03\u5e76\u63d0\u4ea4\u7d22\u5f15/);
  }
});

test("article and publication records expose platform publication state without search-index controls", async () => {
  for (const filePath of publishingRecordSurfacePaths) {
    const source = await readFile(filePath, "utf8");
    assert.doesNotMatch(source, /check-inclusion/);
    assert.doesNotMatch(source, /inclusionStatus/);
    assert.doesNotMatch(source, /indexSubmission/);
    assert.doesNotMatch(source, /submit-index/);
    assert.doesNotMatch(source, /inclusion_checked/);
    assert.doesNotMatch(source, /index_submitted/);
    assert.doesNotMatch(source, /submitIndex\s*:\s*true/);
  }
});

test("published center never renders unverified review URLs as clickable backlinks", async () => {
  const source = await readFile(path.resolve(testDir, "../app/published/page.tsx"), "utf8");

  assert.doesNotMatch(source, /href=\{record\.reviewUrl\}/);
  assert.doesNotMatch(source, /href=\{detail\.record\.reviewUrl\}/);
  assert.match(source, /publishedUrl/);
});

test("auto publish retries failed desktop attempts instead of rerunning a completed worker task", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /\/api\/auto-publish\/\$\{encodeURIComponent\(batch\.id\)\}\/retry-publishes/);
  assert.match(source, /batch\.publishFailedCount/);
  assert.match(source, /failure-center\/\$\{encodeURIComponent\(batch\.taskId\)\}\/retry/);
});
