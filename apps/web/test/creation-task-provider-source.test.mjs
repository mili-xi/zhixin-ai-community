import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(testDir, "..");

async function source(relativePath) {
  return readFile(path.join(webRoot, relativePath), "utf8");
}

test("root layout mounts the creation task provider", async () => {
  const layout = await source("app/layout.tsx");
  assert.match(layout, /CreationTaskProvider/);
  assert.match(layout, /<CreationTaskProvider>\s*\{children\}\s*<\/CreationTaskProvider>/s);
});

test("provider restores, reconciles and polls the single task", async () => {
  const provider = await source("src/components/creation-task-provider.tsx");
  assert.match(provider, /localStorage/);
  assert.match(provider, /\/api\/tasks/);
  assert.match(provider, /\/api\/tasks\/\$\{encodeURIComponent\(taskId\)\}/);
  assert.match(provider, /selectResumableCreationTask/);
  assert.match(provider, /registerTask/);
});

test("creation entry points hand queued work to the provider", async () => {
  for (const relativePath of ["app/ai-writer/quick-create.tsx", "app/ai-writer/writer-wizard.tsx"]) {
    const entry = await source(relativePath);
    assert.match(entry, /useCreationTask/);
    assert.match(entry, /isRestoring/);
    assert.match(entry, /registerTask\(queued\.task\)/);
    assert.match(entry, /disabled=\{busy \|\| isRestoring \|\| hasOpenTask\}/);
    assert.doesNotMatch(entry, /await pollTask\(queued\.task\.id/);
    assert.doesNotMatch(entry, /router\.push\(\`\/editor\?articleId=/);
  }
});

test("global shell and AI writer expose persistent task state", async () => {
  const shell = await source("src/components/app-shell.tsx");
  const page = await source("app/ai-writer/page.tsx");
  assert.match(shell, /useCreationTask/);
  assert.match(shell, /taskStageLabel/);
  assert.match(page, /CreationTaskPanel/);
  assert.match(page, /打开文章/);
});