import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(testDir, "../src/components/app-shell.tsx");

test("AppShell uses the compact navigation and mobile drawer", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /lg:pl-60/);
  assert.match(source, /-translate-x-full/);
  assert.match(source, /aria-label="打开导航"/);
  assert.match(source, /lg:hidden/);
  assert.doesNotMatch(source, /totalNavItems/);
});

test("AppShell exposes contextual tabs without adding sidebar modules", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /const contextualTabs/);
  assert.match(source, /\/ai-writer\/knowledge/);
  assert.match(source, /\/articles\/history/);
  assert.match(source, /\/published/);
});
