import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(testDir, "..");
const repoRoot = path.resolve(webRoot, "../..");

async function source(relativePath) {
  return readFile(path.resolve(webRoot, relativePath), "utf8");
}

test("root layout installs one shared desktop requirement provider", async () => {
  const layout = await source("app/layout.tsx");

  assert.match(layout, /DesktopRequirementProvider/);
  assert.match(layout, /<DesktopRequirementProvider>/);
});

test("browser desktop-only workflows use the shared requirement gate", async () => {
  const files = await Promise.all([
    source("app/free-media/page.tsx"),
    source("app/editor/editor-inner.tsx"),
    source("app/auto-publish/page.tsx"),
    source("app/published/page.tsx")
  ]);

  for (const file of files) {
    assert.match(file, /useDesktopRequirement/);
    assert.match(file, /requireDesktop/);
  }
});

test("web shell does not poll or display desktop device health", async () => {
  const shell = await source("src/components/app-shell.tsx");

  assert.doesNotMatch(shell, /\/api\/desktop-devices/);
  assert.doesNotMatch(shell, /desktopOnline/);
  assert.doesNotMatch(shell, /桌面端在线|桌面端离线|检测桌面端/);
  assert.match(shell, /AccountMenu/);
});

test("free media page does not expose a desktop status panel", async () => {
  const page = await source("app/free-media/page.tsx");

  assert.doesNotMatch(page, /refreshDevices|selectedDevice|setDevices/);
  assert.doesNotMatch(page, /title="桌面端状态"/);
});

test("desktop shell is a full-window workspace with a hidden bridge", async () => {
  const desktopShell = await readFile(path.resolve(repoRoot, "apps/desktop/ui/index.html"), "utf8");

  assert.match(desktopShell, /zhixin:agent-command/);
  assert.match(desktopShell, /agent_command_detached/);
  assert.doesNotMatch(desktopShell, /agent-status|agent-dot|status-button|refreshAgentStatus/);
  assert.doesNotMatch(desktopShell, /class="topbar"/);
  assert.match(desktopShell, /html, body, \.frame-wrap[^{]*\{[^}]*height:\s*100%/s);
});
