// Playwright 运行时定位。
//
// 适配器既可能从打包目录 `resources/agent/src/adapters/` 加载，也可能从热更新目录
// `<home>/.zhixin-ai/adapter-bundles/versions/<ver>/adapters/` 加载。后者向上没有任何
// `node_modules`，直接 `import("playwright")` 会抛 ERR_MODULE_NOT_FOUND；该错误没有前缀码，
// 最后只会以 DESKTOP_COMMAND_EXECUTION_FAILED 的形式瞬时失败，看不出真实原因。
// 所以这里先走常规解析，失败后再按进程已知运行目录逐个定位 playwright。

import { createRequire } from "node:module";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLAYWRIGHT_PACKAGES = ["playwright", "playwright-core"];
const MAX_ANCESTOR_DEPTH = 6;
const RUNTIME_SUBDIRS = ["agent", "agent/src", "resources/agent", "resources/agent/src", "resources/runtime"];

function isFileLike(value) {
  return /\.(?:mjs|cjs|js|json)$/i.test(String(value || ""));
}

function pickChromium(loaded) {
  return loaded?.chromium || loaded?.default?.chromium || null;
}

function addAncestors(dirs, value) {
  let current = String(value || "").trim();
  if (!current) return;
  if (isFileLike(current)) current = path.dirname(current);
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    dirs.add(current);
    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }
}

function addRuntimeSubdirs(dirs, fromPath) {
  let current = String(fromPath || "").trim();
  if (!current) return;
  if (isFileLike(current)) current = path.dirname(current);
  for (const subdir of RUNTIME_SUBDIRS) {
    dirs.add(path.join(current, ...subdir.split("/")));
  }
}

function collectAnchorDirs() {
  const dirs = new Set();
  try {
    addAncestors(dirs, fileURLToPath(import.meta.url));
  } catch {}
  try {
    const entry = process.argv?.[1];
    if (typeof entry === "string" && entry.trim()) addAncestors(dirs, path.resolve(entry.trim()));
  } catch {}
  try {
    addAncestors(dirs, process.cwd());
  } catch {}
  const executableDir = process.execPath ? path.dirname(process.execPath) : "";
  if (executableDir) {
    addRuntimeSubdirs(dirs, executableDir);
    addRuntimeSubdirs(dirs, path.dirname(executableDir));
  }
  return [...dirs].filter((dir) => dir && !dir.includes(`${path.sep}node_modules${path.sep}`));
}

async function importPlaywrightFromDir(dir) {
  for (const pkg of PLAYWRIGHT_PACKAGES) {
    const packageJson = path.join(dir, "node_modules", ...pkg.split("/"), "package.json");
    let installed = false;
    try {
      await access(packageJson);
      installed = true;
    } catch {}
    if (!installed) continue;
    try {
      const requireFromDir = createRequire(path.join(dir, "__zhixin_playwright_anchor.cjs"));
      const chromium = pickChromium(requireFromDir(pkg));
      if (chromium) return chromium;
    } catch {}
    try {
      const entry = pathToFileURL(path.join(dir, "node_modules", ...pkg.split("/"), "index.js")).href;
      const chromium = pickChromium(await import(entry));
      if (chromium) return chromium;
    } catch {}
  }
  return null;
}

export async function importPlaywrightChromium() {
  try {
    const chromium = pickChromium(await import("playwright"));
    if (chromium) return chromium;
  } catch {}
  for (const dir of collectAnchorDirs()) {
    const chromium = await importPlaywrightFromDir(dir);
    if (chromium) return chromium;
  }
  throw new Error("PLAYWRIGHT_RUNTIME_UNAVAILABLE: playwright is not resolvable from the adapter bundle directory");
}
