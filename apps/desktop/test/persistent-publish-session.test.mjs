import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const adapterDir = path.resolve(testDir, "../src/adapters");

async function readAdapter(name) {
  return readFile(path.join(adapterDir, `${name}.mjs`), "utf8");
}

test("Toutiao and Jianshu publishing never create temporary browser contexts", async () => {
  for (const platform of ["toutiao", "jianshu"]) {
    const source = await readAdapter(platform);
    assert.doesNotMatch(source, /chromium\.launch\s*\(/, `${platform} must use its persistent account profile`);
    assert.doesNotMatch(source, /injectedBrowser\.newContext\s*\(/, `${platform} must not create a disposable context`);
  }
});

test("every real publishing adapter refreshes credentials before closing its profile", async () => {
  for (const platform of ["zhihu", "baijiahao", "sohu", "csdn", "netease", "penguin", "toutiao", "jianshu"]) {
    const source = await readAdapter(platform);
    assert.match(
      source,
      /refreshCredentialAfterOperation\s*\(/,
      `${platform} must refresh its credential artifact after a browser operation`
    );
  }
});
