import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildImagePublicationEvidence,
  isPersistentPlatformImageUrl,
  preparePlatformImageTasks,
  requireImagePublicationEvidence,
} from "../src/platform-images.mjs";

test("prepares one upload task per ordered image block", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zhixin-platform-images-"));
  const introPath = path.join(directory, "intro.png");
  const workflowPath = path.join(directory, "workflow.png");
  await writeFile(introPath, "intro-image");
  await writeFile(workflowPath, "workflow-image");

  const tasks = await preparePlatformImageTasks([
    { type: "section", sectionId: "intro", title: "介绍" },
    { type: "image", sectionId: "intro", assetId: "asset-intro" },
    { type: "section", sectionId: "workflow", title: "流程" },
    { type: "image", sectionId: "workflow", assetId: "asset-workflow" },
  ], [
    { assetId: "asset-workflow", sectionId: "workflow", path: workflowPath, altText: "流程图" },
    { assetId: "asset-intro", sectionId: "intro", path: introPath, altText: "介绍图" },
  ]);

  assert.deepEqual(tasks.map((item) => item.sectionId), ["intro", "workflow"]);
  assert.deepEqual(tasks.map((item) => item.sectionTitle), ["介绍", "流程"]);
  assert.deepEqual(tasks.map((item) => item.position), [1, 3]);
  assert.ok(tasks.every((item) => /^[a-f0-9]{64}$/.test(item.contentHash)));
  assert.ok(tasks.every((item) => item.idempotencyKey.includes(item.contentHash)));
});

test("rejects transient image urls as persistent evidence", () => {
  assert.equal(isPersistentPlatformImageUrl("data:image/png;base64,eA=="), false);
  assert.equal(isPersistentPlatformImageUrl("blob:https://example.com/image"), false);
  assert.equal(isPersistentPlatformImageUrl("/relative/image.png"), false);
  assert.equal(isPersistentPlatformImageUrl("https://pic.example.com/image.png"), true);
});

test("requires upload draft and public evidence in the expected order", () => {
  const expected = [
    { assetId: "asset-a", sectionId: "a", position: 1, idempotencyKey: "key-a" },
    { assetId: "asset-b", sectionId: "b", position: 3, idempotencyKey: "key-b" },
  ];
  const stageImages = [
    { assetId: "asset-a", sectionId: "a", position: 1, platformImageUrl: "https://cdn.example.com/a.png" },
    { assetId: "asset-b", sectionId: "b", position: 3, platformImageUrl: "https://cdn.example.com/b.png" },
  ];

  const evidence = buildImagePublicationEvidence(expected, stageImages, stageImages, stageImages);

  assert.equal(evidence.status, "verified");
  assert.equal(evidence.expectedCount, 2);
  assert.deepEqual(evidence.public.images.map((item) => item.sectionId), ["a", "b"]);
  assert.doesNotThrow(() => requireImagePublicationEvidence(evidence, "public"));
});

test("reports missing public images without leaking local paths", () => {
  const expected = [{ assetId: "asset-a", sectionId: "a", position: 1, path: "C:/secret/a.png", idempotencyKey: "key-a" }];
  const upload = [{ assetId: "asset-a", sectionId: "a", position: 1, platformImageUrl: "https://cdn.example.com/a.png" }];

  const evidence = buildImagePublicationEvidence(expected, upload, upload, []);

  assert.equal(evidence.status, "review_required");
  assert.ok(evidence.issues.includes("PUBLIC_IMAGE_MISSING"));
  assert.equal(JSON.stringify(evidence).includes("C:/secret"), false);
  assert.throws(() => requireImagePublicationEvidence(evidence, "public"), /PUBLIC_IMAGE_MISSING/);
});

test("skips image blocks whose bytes never reached this machine", async () => {
  const skipped = [];

  const tasks = await preparePlatformImageTasks([
    { type: "section", sectionId: "intro", title: "介绍" },
    { type: "image", sectionId: "intro", assetId: "asset-missing" },
    { type: "image", sectionId: "intro", assetId: "asset-gone", path: path.join(os.tmpdir(), "zhixin-gone-image.png") },
  ], [], (entry) => skipped.push(entry));

  assert.deepEqual(tasks, []);
  assert.deepEqual(skipped.map((entry) => entry.assetId), ["asset-missing", "asset-gone"]);
  assert.deepEqual(skipped.map((entry) => entry.reason), [
    "INLINE_IMAGE_LOCAL_PATH_MISSING",
    "INLINE_IMAGE_LOCAL_FILE_MISSING",
  ]);
  assert.deepEqual(skipped.map((entry) => entry.sectionId), ["intro", "intro"]);
});
