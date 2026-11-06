#!/usr/bin/env node

// Build a cumulative adapter bundle from the bundle that is currently live.
//
// Adapter hot-update is a whole-bundle replacement, so a bundle that only ships
// the adapter you just fixed would silently downgrade every other platform back
// to the version baked into each user's installer. This script reads the live
// zip, swaps in only the adapter files named on the command line, and re-packs
// everything else byte-for-byte.
//
// It exists because the working tree drifts ahead of what old installs can
// import: an adapter under src/adapters may reference symbols that only shipped
// in a later desktop release, and bundling it wholesale breaks installs that
// have not updated yet (ADAPTER_BUNDLE_SMOKE_IMPORT_FAILED -> refresh_failed).
// Porting the fix onto the live file keeps minDesktopVersion honest.
//
// A platform the live bundle stopped shipping needs --add rather than
// --override: 202610120015 was built from a six-adapter base and silently
// dropped toutiao.mjs and jianshu.mjs, and every later bundle copied that
// smaller file set forward. Restoring a dropped platform is the one case where
// the new bundle is deliberately larger than the live one.
//
// Usage:
//   node apps/desktop/scripts/create-adapter-bundle-from-live.mjs \
//     --version 20261015-sohu-sms-gate \
//     --live-zip live.zip --override sohu=src/adapters/sohu-ported.mjs \
//     --add toutiao=src/adapters/toutiao.mjs

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createPrivateKey, createHash, sign as edSign } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions } from "../src/adapter-update-manager.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privateKeyPath = path.join(homedir(), ".zhixin-ai-community-signing", "adapter_ed25519_private.pem");
const publicKeyPath = path.join(desktopRoot, "resources", "adapter_ed25519_public.pem");
const REQUIRED_ADAPTER_SUPPORT_FILES = ["adapters/browser-runtime.mjs"];
const allowedPlatforms = new Set(["zhihu", "baijiahao", "sohu", "csdn", "netease", "penguin", "toutiao", "jianshu", "douyin"]);

function parseArgs(argv) {
  const args = { _: [], override: [], add: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item.startsWith("--")) {
      const [key, inlineValue] = item.slice(2).split("=");
      const next = argv[index + 1];
      let value;
      if (inlineValue !== undefined) value = inlineValue;
      else if (next && !next.startsWith("--")) {
        value = next;
        index += 1;
      } else value = true;
      // Repeated --override/--add flags accumulate; a repeated single-value flag
      // still keeps last-wins. Without this, only the final --override survived.
      if ((key === "override" || key === "add") && Array.isArray(args[key])) args[key].push(value);
      else args[key] = value;
    } else args._.push(item);
  }
  for (const pair of [].concat(args.override || [])) {
    const [platform, filePath] = String(pair).split("=");
    if (!platform || !filePath) throw new Error(`Invalid --override (want platform=path): ${pair}`);
    if (!allowedPlatforms.has(platform)) throw new Error(`Unknown adapter platform in --override: ${platform}`);
    args.overrideMap = args.overrideMap || {};
    args.overrideMap[`adapters/${platform}.mjs`] = filePath;
  }
  for (const pair of [].concat(args.add || [])) {
    const [platform, filePath] = String(pair).split("=");
    if (!platform || !filePath) throw new Error(`Invalid --add (want platform=path): ${pair}`);
    if (!allowedPlatforms.has(platform)) throw new Error(`Unknown adapter platform in --add: ${platform}`);
    args.addMap = args.addMap || {};
    args.addMap[`adapters/${platform}.mjs`] = filePath;
  }
  return args;
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

function canonicalManifest(manifest = {}) {
  const { signature: _signature, ...unsigned } = manifest || {};
  return JSON.stringify(sortValue(unsigned));
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

const crcTable = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  const now = dosDateTime();
  let offset = 0;
  for (const [name, source] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name, "utf8");
    const data = Buffer.isBuffer(source) ? source : Buffer.from(source, "utf8");
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(now.time, 10);
    local.writeUInt16LE(now.day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuffer, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(now.time, 12);
    central.writeUInt16LE(now.day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

// Minimal deflate reader: enough to pull the live bundle apart without shelling
// out to unzip, and it refuses anything it does not understand.
function readZip(buffer) {
  let eocd = -1;
  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd < 0) throw new Error("Live bundle is not a zip: end-of-central-directory record not found.");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error(`Corrupt central directory at ${offset}.`);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (method !== 8) throw new Error(`Unsupported compression method ${method} for ${name}.`);
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`Corrupt local header for ${name}.`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    files.set(name, inflateRawSync(compressed));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function cleanVersion(value = "") {
  return String(value || "").trim().replace(/[^A-Za-z0-9._-]/g, "_");
}

async function loadNotes(args) {
  if (args["notes-file"]) {
    const raw = await readFile(args["notes-file"], "utf8");
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) return JSON.parse(trimmed).map((item) => String(item).trim()).filter(Boolean);
    return raw.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  }
  return args.notes ? String(args.notes).split("|").map((item) => item.trim()).filter(Boolean) : [];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = cleanVersion(args.version || "");
  if (!version) throw new Error("Adapter bundle version is required.");
  const liveZip = args["live-zip"];
  if (!liveZip) throw new Error("--live-zip is required.");
  // Both build scripts name the zip <bundleVersion>.zip, so the live zip's own
  // filename is the version devices are running right now. Deriving it keeps the
  // guard from being an optional flag someone forgets; --live-version still
  // overrides it for a renamed zip.
  const derivedLiveVersion = path.basename(String(liveZip)).replace(/\.zip$/i, "");
  const liveVersion = cleanVersion(args["live-version"] || derivedLiveVersion);
  if (!liveVersion) throw new Error("--live-version is required to prove the new bundle is newer than the live one.");
  // compareVersions is imported from the runtime module on purpose: the gate the
  // device applies has to be the same one the build applies. 202610231500 lost to
  // 20261018201000 because a 12-digit prefix is numerically smaller than any
  // 14-digit one, and the resulting bundle was silently refused everywhere.
  if (compareVersions(version, liveVersion) <= 0) {
    throw new Error(
      `Adapter bundle version ${version} is not newer than live bundle ${liveVersion}; `
      + "every device would keep the bundle it already has. Use a 14-digit yyyyMMddHHmmss prefix."
    );
  }
  const overrides = args.overrideMap || {};
  const additions = args.addMap || {};
  if (!Object.keys(overrides).length && !Object.keys(additions).length) {
    throw new Error("At least one --override or --add platform=path is required.");
  }
  const minDesktopVersion = String(args["min-desktop-version"] || "0.1.7");
  const notes = await loadNotes(args);

  const liveFiles = readZip(await readFile(liveZip));
  for (const required of REQUIRED_ADAPTER_SUPPORT_FILES) {
    if (!liveFiles.has(required)) throw new Error(`Live bundle is missing ${required}.`);
  }
  for (const filePath of Object.keys(overrides)) {
    if (!liveFiles.has(filePath)) {
      throw new Error(`Live bundle has no ${filePath}; a fresh full build is needed instead of a cumulative patch.`);
    }
  }
  for (const filePath of Object.keys(additions)) {
    if (liveFiles.has(filePath)) {
      throw new Error(`Live bundle already ships ${filePath}; use --override to replace it.`);
    }
    if (overrides[filePath]) throw new Error(`${filePath} is both overridden and added.`);
  }

  const entries = {};
  for (const [filePath, data] of liveFiles) {
    entries[filePath] = overrides[filePath] ? await readFile(overrides[filePath]) : data;
  }
  for (const [filePath, source] of Object.entries(additions)) {
    entries[filePath] = await readFile(source);
  }
  // Refresh the dependencies together only when the Douyin module is replaced;
  // unrelated cumulative patches preserve the live helper bytes.
  if(overrides['adapters/douyin.mjs']||additions['adapters/douyin.mjs']){
    for(const name of ['douyin-enrichment.mjs','douyin-ai-cover.mjs'])entries[`adapters/${name}`]=await readFile(path.join(desktopRoot,'src','adapters',name));
  }

  // Hot updates replace the whole bundle, so a bundle that quietly ships fewer
  // platform adapters than the live one downgrades every user of that platform
  // to the installer's built-in adapter. 202610120015 was built from a
  // six-adapter base and dropped toutiao.mjs and jianshu.mjs; every bundle
  // after it copied that smaller set forward until 20261017190500 restored
  // them by hand. Refuse to build instead of letting the gap propagate.
  const missingAdapters = [...allowedPlatforms].filter((platform) => platform !== "douyin")
    .map((platform) => `adapters/${platform}.mjs`)
    .filter((filePath) => !entries[filePath] && !additions[filePath]);
  if (missingAdapters.length) {
    throw new Error(
      `Cumulative bundle would drop ${missingAdapters.join(", ")}; `
      + `restore with --add (for example --add jianshu=src/adapters/jianshu.mjs) `
      + "or run a full build instead of patching the live zip."
    );
  }

  const zip = createZip(entries);
  const bundleFile = `${version}.zip`;
  const files = Object.fromEntries(Object.entries(entries).map(([filePath, source]) => [filePath, {
    sha256: sha256(Buffer.isBuffer(source) ? source : Buffer.from(source, "utf8")),
    bytes: Buffer.isBuffer(source) ? source.length : Buffer.byteLength(source),
  }]));
  const manifest = {
    schemaVersion: 1,
    bundleVersion: version,
    minDesktopVersion,
    bundleFile,
    bundleSha256: sha256(zip),
    files,
    notes,
    builtAt: new Date().toISOString(),
  };

  const privatePem = await readFile(privateKeyPath, "utf8");
  if (!privatePem.trim()) throw new Error(`Adapter signing private key missing: ${privateKeyPath}`);
  manifest.signature = edSign(null, Buffer.from(canonicalManifest(manifest)), createPrivateKey(privatePem)).toString("base64");

  const distRoot = path.join(desktopRoot, "dist", "adapter-bundles");
  await mkdir(distRoot, { recursive: true });
  await writeFile(path.join(distRoot, bundleFile), zip);
  await writeFile(path.join(distRoot, "adapter-version.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(JSON.stringify({
    version,
    overridden: Object.keys(overrides),
    added: Object.keys(additions),
    bundle: path.join(distRoot, bundleFile),
    manifest: path.join(distRoot, "adapter-version.json"),
    publicKeyPath,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
// Shells mangle non-ASCII argv on Windows, so release notes can also be read
// from a UTF-8 file: either a JSON array of strings or one note per line.
