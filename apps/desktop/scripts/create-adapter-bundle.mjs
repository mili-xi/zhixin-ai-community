#!/usr/bin/env node

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createPrivateKey, createPublicKey, createHash, sign as edSign } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const adaptersRoot = path.join(desktopRoot, "src", "adapters");
const distRoot = path.join(desktopRoot, "dist", "adapter-bundles");
const privateKeyPath = path.join(homedir(), ".zhixin-ai-community-signing", "adapter_ed25519_private.pem");
const publicKeyPath = path.join(desktopRoot, "resources", "adapter_ed25519_public.pem");
const REQUIRED_ADAPTER_SUPPORT_FILES = ["adapters/browser-runtime.mjs"];
const allowedPlatforms = new Set(["zhihu", "baijiahao", "sohu", "csdn", "netease", "penguin", "toutiao", "jianshu", "douyin"]);
const allowedAdapterFile = /^adapters\/[a-z0-9-]+\.mjs$/i;

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item.startsWith("--")) {
      const [key, inlineValue] = item.slice(2).split("=");
      const next = argv[index + 1];
      if (inlineValue !== undefined) args[key] = inlineValue;
      else if (next && !next.startsWith("--")) {
        args[key] = next;
        index += 1;
      } else args[key] = true;
    } else args._.push(item);
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
    const data = Buffer.from(source, "utf8");
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

function cleanVersion(value = "") {
  return String(value || "").trim().replace(/[^A-Za-z0-9._-]/g, "_");
}

function platformList(value = "penguin") {
  const requested = String(value || "penguin").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  const invalid = requested.filter((item) => !allowedPlatforms.has(item));
  if (invalid.length) throw new Error(`Unknown adapter platform(s): ${invalid.join(", ")}`);
  return [...new Set(requested)];
}

function includedAdapterFiles(value = "") {
  return [...new Set(String(value || "")
    .split(",")
    .map((item) => item.trim().replace(/\\/g, "/"))
    .filter(Boolean)
    .map((item) => {
      const withDirectory = item.startsWith("adapters/") ? item : `adapters/${item}`;
      const normalized = withDirectory.endsWith(".mjs") ? withDirectory : `${withDirectory}.mjs`;
      if (!allowedAdapterFile.test(normalized) || normalized.includes("..")) {
        throw new Error(`ADAPTER_BUNDLE_INCLUDE_FILE_NOT_ALLOWED: ${item}`);
      }
      return normalized;
    }))];
}

async function loadSigningKeys() {
  const privatePem = await readFile(privateKeyPath, "utf8").catch(() => "");
  if (!privatePem.trim()) {
    throw new Error(`Adapter signing private key missing: ${privateKeyPath}\nGenerate it locally with: node apps/desktop/scripts/create-adapter-bundle.mjs --init-key`);
  }
  const privateKey = createPrivateKey(privatePem);
  const publicPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" });
  await mkdir(path.dirname(publicKeyPath), { recursive: true });
  await writeFile(publicKeyPath, publicPem, "utf8");
  return { privatePem, publicPem };
}

async function initKey() {
  const exists = await access(privateKeyPath).then(() => true).catch(() => false);
  if (exists) {
    throw new Error(`Adapter signing private key already exists and was not overwritten: ${privateKeyPath}`);
  }
  const { generateKeyPairSync } = await import("node:crypto");
  const pair = generateKeyPairSync("ed25519");
  const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicPem = pair.publicKey.export({ type: "spki", format: "pem" });
  await mkdir(path.dirname(privateKeyPath), { recursive: true });
  await writeFile(privateKeyPath, privatePem, { encoding: "utf8", mode: 0o600 });
  await mkdir(path.dirname(publicKeyPath), { recursive: true });
  await writeFile(publicKeyPath, publicPem, "utf8");
  console.log(JSON.stringify({ privateKeyPath, publicKeyPath }, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args["init-key"]) return initKey();

  // 14 digits (yyyyMMddHHmmss), not 12. compareVersions reads the leading
  // numeric segment as an integer, so a 12-digit prefix loses to any 14-digit
  // one no matter how new it is: 202610231500 < 20261018201000. A bundle built
  // with the old default was rejected by every device as "not newer" and the
  // fix it carried never landed.
  const version = cleanVersion(args.version || new Date().toISOString().replace(/[-:TZ]/g, "").slice(0, 14));
  if (!version) throw new Error("Adapter bundle version is required.");
  const platforms = platformList(args.platforms || args.platform || "penguin");
  const requestedFiles = includedAdapterFiles(args.include || args.includes || "");
  if (requestedFiles.includes("adapters/browser-runtime.mjs")) {
    throw new Error("ADAPTER_BUNDLE_INCLUDE_FILE_BUNDLED_BY_DEFAULT: adapters/browser-runtime.mjs");
  }
  const douyinSupport=platforms.includes('douyin')?['adapters/douyin-enrichment.mjs','adapters/douyin-ai-cover.mjs']:[];
  const includedFiles = [...new Set([...requestedFiles, ...REQUIRED_ADAPTER_SUPPORT_FILES,...douyinSupport])];
  const minDesktopVersion = String(args["min-desktop-version"] || "0.1.6");
  const notes = args.notes ? String(args.notes).split("|").map((item) => item.trim()).filter(Boolean) : [];
  const { privatePem } = await loadSigningKeys();

  const entries = {};
  for (const platform of platforms) {
    const sourcePath = path.join(adaptersRoot, `${platform}.mjs`);
    const source = await readFile(sourcePath, "utf8");
    entries[`adapters/${platform}.mjs`] = source;
  }
  for (const filePath of includedFiles) {
    const sourcePath = path.join(desktopRoot, "src", filePath.replace(/\//g, path.sep));
    const source = await readFile(sourcePath, "utf8");
    entries[filePath] = source;
  }

  const zip = createZip(entries);
  const bundleFile = `${version}.zip`;
  const files = Object.fromEntries(Object.entries(entries).map(([filePath, source]) => [filePath, {
    sha256: sha256(Buffer.from(source, "utf8")),
    bytes: Buffer.byteLength(source),
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
  manifest.signature = edSign(null, Buffer.from(canonicalManifest(manifest)), privatePem).toString("base64");

  await mkdir(distRoot, { recursive: true });
  await writeFile(path.join(distRoot, bundleFile), zip);
  await writeFile(path.join(distRoot, "adapter-version.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(JSON.stringify({
    version,
    platforms,
    includedAdapterFiles: includedFiles,
    bundle: path.join(distRoot, bundleFile),
    manifest: path.join(distRoot, "adapter-version.json"),
    privateKeyPath,
    publicKeyPath,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
