const fs = require("fs");
const path = require("path");

const roots = [
  "apps/web/app",
  "apps/web/src",
  "apps/api/app",
  "apps/desktop/src",
  "apps/desktop/ui",
  "docs",
  "packages/core/src",
  "data"
];

const extensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".json", ".md", ".py", ".html", ".rs"]);

const markers = [
  "锟",
  "閿",
  "閹",
  "閺",
  "闁",
  "缁",
  "閸",
  "閻",
  "涔",
  "閵",
  "闂€",
  "婵",
  "鏅",
  "鎺",
  "绗",
  "鍙",
  "璐",
  "妗",
  "濯",
  "绱",
  "闇",
  "歿",
  "鐏忋",
  "濮濓",
  "娑撳",
  "閸掓",
  "閻樿"
];

const ignored = [
  /packages[\\/]core[\\/]src[\\/](generation|navigation)\.test\.ts$/,
  /node_modules/,
  /\.next/,
  /\.git/,
  /target[\\/]release/,
  /__pycache__/,
  /\.pytest_cache/
];

function walk(dir, files) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const filePath = path.join(dir, name);
    if (ignored.some((pattern) => pattern.test(filePath))) continue;
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      walk(filePath, files);
    } else if (extensions.has(path.extname(name))) {
      files.push(filePath);
    }
  }
}

const files = [];
roots.forEach((root) => walk(root, files));

const hits = [];
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const found = markers.filter((marker) => text.includes(marker));
  if (found.length) hits.push({ file, markers: found });
}

if (hits.length) {
  console.error("Mojibake markers found:");
  console.error(JSON.stringify(hits, null, 2));
  process.exit(1);
}

console.log(`Mojibake scan passed: ${files.length} files checked.`);
