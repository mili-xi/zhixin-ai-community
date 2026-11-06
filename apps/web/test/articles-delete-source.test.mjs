import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(testDir, "../app/articles/page.tsx");

test("article management exposes single and batch deletion with a safety confirmation", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /Trash2/);
  assert.match(source, /\/api\/articles\/batch-delete/);
  assert.match(source, /method:\s*"DELETE"/);
  assert.match(source, /确认删除/);
  assert.match(source, /已发布到外部平台的内容不会被删除/);
  assert.match(source, /deleteError/);
  assert.match(source, /role="alert"/);
});
