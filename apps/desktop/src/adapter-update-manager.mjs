import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CURRENT_FILE = "current.json";
const TRUSTED_STATE_FILE = "trusted-state.json";
const INSTALL_LOCK_DIR = "install.lock";
const INSTALL_LOCK_MAX_AGE_MS = 30 * 60 * 1000;
const INSTALL_LOCK_WAIT_MS = 60 * 1000;
const VERSION_MANIFEST_PATH = "/downloads/adapter-bundles/adapter-version.json";
const ALLOWED_ADAPTER_FILE = /^adapters\/[a-z0-9-]+\.mjs$/i;
const SIGNING_PUBLIC_KEY_NAME = "adapter_ed25519_public.pem";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopPackagePath = path.join(desktopRoot, "package.json");
const srcRoot = path.join(desktopRoot, "src");
const adaptersSrcRoot = path.join(srcRoot, "adapters");
const bridgeFiles = [
  "adapters/base.mjs",
  "adapters/browser-runtime.mjs",
  "adapters/content-platform.mjs",
  "adapters/platform-api.mjs",
  "adapters/zhihu.mjs",
  "browser-visibility.mjs",
  "editor-image-upload.mjs",
  "platform-images.mjs",
  "public-page-blocker.mjs",
  "rich-content.mjs",
  "session-manager.mjs",
];
const BUILT_IN_ADAPTER_BRIDGE_FILES = new Set([
  "adapters/base.mjs",
  "adapters/content-platform.mjs",
  "adapters/platform-api.mjs",
]);

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

export function canonicalManifest(manifest = {}) {
  const { signature: _signature, ...unsigned } = manifest || {};
  return JSON.stringify(sortValue(unsigned));
}

function cleanVersion(value = "") {
  return String(value || "").trim().replace(/[^A-Za-z0-9._-]/g, "_");
}

function versionDirRelative(bundleVersion) {
  const version = String(bundleVersion || "").trim();
  if (!version || cleanVersion(version) !== version) throw new Error(`ADAPTER_BUNDLE_VERSION_INVALID: ${bundleVersion}`);
  versionIdentifiers(version);
  return `versions/${version}`;
}

function versionIdentifiers(value) {
  const normalized = String(value || "").trim().replace(/^v(?=\d)/i, "");
  if (!/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/.test(normalized)) {
    throw new Error(`ADAPTER_BUNDLE_VERSION_INVALID: ${value}`);
  }
  return normalized.split(/[._-]/).map((identifier) => (
    /^\d+$/.test(identifier)
      ? { type: "number", value: BigInt(identifier) }
      : { type: "text", value: identifier.toLowerCase() }
  ));
}

// Exported so the bundle build scripts gate on exactly the comparison the
// device runs. A local copy here is how a 12-digit prefix once shipped as an
// "upgrade" over a 14-digit one and every device silently stayed behind.
export function compareVersions(left, right) {
  const leftParts = versionIdentifiers(left);
  const rightParts = versionIdentifiers(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (!leftPart || !rightPart) {
      const present = leftPart || rightPart;
      if (present.type === "number" && present.value === 0n) continue;
      const missingIsNewer = present.type === "text";
      return leftPart ? (missingIsNewer ? -1 : 1) : (missingIsNewer ? 1 : -1);
    }
    if (leftPart.type === rightPart.type) {
      if (leftPart.value === rightPart.value) continue;
      return leftPart.value > rightPart.value ? 1 : -1;
    }
    return leftPart.type === "number" ? 1 : -1;
  }
  return 0;
}

async function resolveDesktopVersion(desktopVersion) {
  if (desktopVersion !== undefined) {
    const explicitVersion = String(desktopVersion || "").trim();
    try {
      versionIdentifiers(explicitVersion);
    } catch {
      throw new Error("ADAPTER_BUNDLE_DESKTOP_VERSION_INVALID");
    }
    return explicitVersion;
  }
  try {
    const packageMetadata = JSON.parse(await readFile(desktopPackagePath, "utf8"));
    if (typeof packageMetadata.version !== "string") throw new Error("version missing");
    const packageVersion = packageMetadata.version.trim();
    versionIdentifiers(packageVersion);
    return packageVersion;
  } catch {
    throw new Error("ADAPTER_BUNDLE_DESKTOP_PACKAGE_VERSION_INVALID");
  }
}

async function assertDesktopVersionCompatible(manifest, desktopVersion) {
  const minimum = String(manifest.minDesktopVersion || "").trim();
  if (!minimum) return "";
  const actualDesktopVersion = await resolveDesktopVersion(desktopVersion);
  if (compareVersions(actualDesktopVersion, minimum) < 0) throw new Error("ADAPTER_BUNDLE_DESKTOP_VERSION_TOO_OLD");
  return actualDesktopVersion;
}

function platformFromBundlePath(filePath = "") {
  return path.basename(String(filePath || ""), ".mjs").toLowerCase();
}

function assertAllowedBundleFile(filePath = "") {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  if (!ALLOWED_ADAPTER_FILE.test(normalized) || normalized.includes("..")) {
    throw new Error(`ADAPTER_BUNDLE_FILE_NOT_ALLOWED: ${filePath}`);
  }
  return normalized;
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function ensureBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value || ""), "utf8");
}

function normalizeBaseUrl(apiBaseUrl = "") {
  return String(apiBaseUrl || "").replace(/\/+$/, "");
}

function manifestAndBundleUrls(options = {}) {
  const manifestUrl = String(options.adapterBundleManifestUrl || "").trim();
  if (manifestUrl) {
    return {
      manifestUrl,
      bundleUrl: (bundleFile) => new URL(bundleFile, manifestUrl).href,
    };
  }
  const apiBaseUrl = normalizeBaseUrl(options.adapterBundleBaseUrl || options.apiBaseUrl || "");
  if (!apiBaseUrl) return null;
  return {
    manifestUrl: `${apiBaseUrl}${VERSION_MANIFEST_PATH}`,
    bundleUrl: (bundleFile) => `${apiBaseUrl}/downloads/adapter-bundles/${encodeURIComponent(bundleFile)}`,
  };
}

function stateDirFromOptions({ stateDir, statePath } = {}) {
  if (stateDir) return stateDir;
  if (statePath) return path.dirname(statePath);
  return "";
}

export function adapterBundleRoot(stateDir) {
  return path.join(stateDir, "adapter-bundles");
}

export function hotAdapterPath(stateDir, platform, bundleVersion = "") {
  const root = adapterBundleRoot(stateDir);
  const activeRoot = bundleVersion
    ? path.join(root, ...versionDirRelative(bundleVersion).split("/"))
    : path.join(root, "current");
  return path.join(activeRoot, "adapters", `${String(platform || "").toLowerCase()}.mjs`);
}

export function adapterBundlePublicKeyCandidates() {
  return [
    path.join(desktopRoot, "..", SIGNING_PUBLIC_KEY_NAME),
    path.join(desktopRoot, "src-tauri", "resources", SIGNING_PUBLIC_KEY_NAME),
    path.join(desktopRoot, "resources", SIGNING_PUBLIC_KEY_NAME),
  ];
}

export async function readAdapterBundlePublicKey(options = {}) {
  if (options.publicKeyPem) return options.publicKeyPem;
  for (const candidate of adapterBundlePublicKeyCandidates()) {
    const text = await readFile(candidate, "utf8").catch(() => "");
    if (text.trim()) return text;
  }
  throw new Error("ADAPTER_BUNDLE_PUBLIC_KEY_MISSING");
}

function verifyManifestSignature(manifest, publicKeyPem) {
  if (!manifest.signature) throw new Error("ADAPTER_BUNDLE_SIGNATURE_REQUIRED");
  const publicKey = createPublicKey(publicKeyPem);
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("ADAPTER_BUNDLE_SIGNING_KEY_NOT_ED25519");
  const ok = verify(null, Buffer.from(canonicalManifest(manifest)), publicKey, Buffer.from(String(manifest.signature), "base64"));
  if (!ok) throw new Error("ADAPTER_BUNDLE_SIGNATURE_INVALID");
}

function normalizeManifestFiles(files) {
  if (!files || typeof files !== "object" || Array.isArray(files)) throw new Error("ADAPTER_BUNDLE_FILES_REQUIRED");
  const normalizedFiles = {};
  for (const [filePath, descriptor] of Object.entries(files)) {
    const normalized = assertAllowedBundleFile(filePath);
    if (BUILT_IN_ADAPTER_BRIDGE_FILES.has(normalized)) {
      throw new Error(`ADAPTER_BUNDLE_BRIDGE_FILE_NOT_ALLOWED: ${filePath}`);
    }
    if (typeof descriptor === "string") {
      if (!descriptor.trim()) throw new Error(`ADAPTER_BUNDLE_FILE_EMPTY: ${filePath}`);
      normalizedFiles[normalized] = descriptor;
      continue;
    }
    if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
      throw new Error(`ADAPTER_BUNDLE_FILE_DESCRIPTOR_INVALID: ${filePath}`);
    }
    const fileSha = String(descriptor.sha256 || "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(fileSha)) throw new Error(`ADAPTER_BUNDLE_FILE_SHA256_REQUIRED: ${filePath}`);
    normalizedFiles[normalized] = {
      sha256: fileSha,
      bytes: Number.isFinite(Number(descriptor.bytes)) ? Number(descriptor.bytes) : undefined,
    };
  }
  return normalizedFiles;
}

export function verifyAdapterManifest(manifest = {}, publicKeyPem = "") {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("ADAPTER_BUNDLE_MANIFEST_INVALID");
  if (manifest.schemaVersion !== 1) throw new Error("ADAPTER_BUNDLE_SCHEMA_UNSUPPORTED");
  const rawBundleVersion = String(manifest.bundleVersion || "").trim();
  if (!rawBundleVersion) throw new Error("ADAPTER_BUNDLE_VERSION_REQUIRED");
  versionDirRelative(rawBundleVersion);
  const bundleVersion = rawBundleVersion;
  if (manifest.minDesktopVersion) versionIdentifiers(manifest.minDesktopVersion);

  const files = normalizeManifestFiles(manifest.files);
  if (manifest.bundleFile || manifest.bundleSha256) {
    const bundleFile = String(manifest.bundleFile || "").trim();
    if (!/^[A-Za-z0-9._-]+\.zip$/.test(bundleFile)) throw new Error("ADAPTER_BUNDLE_ZIP_NAME_INVALID");
    const bundleSha256 = String(manifest.bundleSha256 || "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(bundleSha256)) throw new Error("ADAPTER_BUNDLE_SHA256_REQUIRED");
  }

  verifyManifestSignature(manifest, publicKeyPem);
  return {
    ...manifest,
    bundleVersion,
    files,
    bundleFile: manifest.bundleFile ? String(manifest.bundleFile).trim() : "",
    bundleSha256: manifest.bundleSha256 ? String(manifest.bundleSha256).trim().toLowerCase() : "",
  };
}

function findEndOfCentralDirectory(zip) {
  const min = Math.max(0, zip.length - 0xffff - 22);
  for (let offset = zip.length - 22; offset >= min; offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("ADAPTER_BUNDLE_ZIP_EOCD_MISSING");
}

function readZipEntries(zipData) {
  const zip = ensureBuffer(zipData);
  const eocd = findEndOfCentralDirectory(zip);
  const entryCount = zip.readUInt16LE(eocd + 10);
  const centralSize = zip.readUInt32LE(eocd + 12);
  const centralOffset = zip.readUInt32LE(eocd + 16);
  if (centralOffset + centralSize > zip.length) throw new Error("ADAPTER_BUNDLE_ZIP_CENTRAL_DIRECTORY_INVALID");

  const entries = {};
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) throw new Error("ADAPTER_BUNDLE_ZIP_ENTRY_INVALID");
    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const uncompressedSize = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;

    if (flags & 0x08) throw new Error(`ADAPTER_BUNDLE_ZIP_DATA_DESCRIPTOR_UNSUPPORTED: ${name}`);
    const normalized = assertAllowedBundleFile(name);
    if (![0, 8].includes(method)) throw new Error(`ADAPTER_BUNDLE_ZIP_METHOD_UNSUPPORTED: ${name}`);
    if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`ADAPTER_BUNDLE_ZIP_LOCAL_HEADER_INVALID: ${name}`);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > zip.length) throw new Error(`ADAPTER_BUNDLE_ZIP_DATA_INVALID: ${name}`);
    const compressed = zip.subarray(dataStart, dataEnd);
    const data = method === 0 ? compressed : inflateRawSync(compressed);
    if (data.length !== uncompressedSize) throw new Error(`ADAPTER_BUNDLE_ZIP_SIZE_MISMATCH: ${name}`);
    entries[normalized] = data.toString("utf8");
  }
  return entries;
}

function materializeBundleFiles(verified, bundleData) {
  if (!verified.bundleFile) {
    const files = {};
    for (const [filePath, source] of Object.entries(verified.files)) {
      if (typeof source !== "string") throw new Error(`ADAPTER_BUNDLE_FILE_SOURCE_REQUIRED: ${filePath}`);
      files[filePath] = source;
    }
    return files;
  }

  const zip = ensureBuffer(bundleData);
  if (sha256(zip) !== verified.bundleSha256) throw new Error("ADAPTER_BUNDLE_SHA256_MISMATCH");
  const extracted = readZipEntries(zip);
  const files = {};
  for (const [filePath, descriptor] of Object.entries(verified.files)) {
    const source = extracted[filePath];
    if (typeof source !== "string") throw new Error(`ADAPTER_BUNDLE_FILE_MISSING: ${filePath}`);
    if (sha256(Buffer.from(source, "utf8")) !== descriptor.sha256) throw new Error(`ADAPTER_BUNDLE_FILE_SHA256_MISMATCH: ${filePath}`);
    if (descriptor.bytes !== undefined && Buffer.byteLength(source) !== descriptor.bytes) throw new Error(`ADAPTER_BUNDLE_FILE_SIZE_MISMATCH: ${filePath}`);
    files[filePath] = source;
  }
  for (const filePath of Object.keys(extracted)) {
    if (!Object.hasOwn(verified.files, filePath)) throw new Error(`ADAPTER_BUNDLE_FILE_UNDECLARED: ${filePath}`);
  }
  return files;
}

function manifestFileSha256(verifiedManifest, filePath) {
  const descriptor = verifiedManifest.files[filePath];
  if (typeof descriptor === "string") return sha256(Buffer.from(descriptor, "utf8"));
  return descriptor?.sha256 || "";
}

function bridgeSource(relativePath) {
  const targetPath = path.join(srcRoot, relativePath.replace(/\//g, path.sep));
  const targetUrl = pathToFileURL(targetPath).href;
  return `export * from ${JSON.stringify(targetUrl)};\n`;
}

async function writeBridgeFiles(targetDir, files) {
  const hotFiles = new Set(Object.keys(files));
  for (const relativePath of bridgeFiles) {
    if (hotFiles.has(relativePath)) continue;
    const fullPath = path.join(targetDir, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, bridgeSource(relativePath), "utf8");
  }
}

// A bridge shim re-exports the install's own module over an absolute file://
// URL, so the bytes written at install time encode where the app lived then.
// Reinstalling, upgrading or moving the app leaves every installed bundle
// pointing at a path that no longer exists, and a byte comparison then reports
// the whole bundle as corrupt. That is how 202610070105 was rolled back with
// ADAPTER_BUNDLE_CURRENT_BRIDGE_MISMATCH after the install moved: the fix was
// discarded along with the bundle and every platform fell back to the
// installer's built-in adapter.
//
// Rewriting a stale shim is safe and is the only repair that keeps the bundle
// usable, because the shim is regenerated from the current install on every
// pass. A file that is no longer a re-export at all is a different failure:
// something put real module content where only a generated shim belongs, and
// silently replacing it would hide that.
const BRIDGE_SHIM_PATTERN = /^export \* from "file:\/\/[^"]*";\n?$/;

function isBridgeShim(text) {
  return BRIDGE_SHIM_PATTERN.test(text);
}

async function ensureCurrentBridgeFiles(targetDir, hotFiles) {
  const healed = [];
  for (const relativePath of bridgeFiles) {
    if (Object.hasOwn(hotFiles, relativePath)) continue;
    const fullPath = path.join(targetDir, relativePath);
    const expected = Buffer.from(bridgeSource(relativePath), "utf8");
    let actual = null;
    try {
      actual = await readFile(fullPath);
    } catch {
      actual = null;
    }
    if (actual && actual.equals(expected)) continue;
    if (actual && !isBridgeShim(actual.toString("utf8"))) {
      throw new Error(`ADAPTER_BUNDLE_CURRENT_BRIDGE_MISMATCH: ${relativePath}`);
    }
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, expected, "utf8");
    healed.push(relativePath);
  }
  return healed;
}

async function verifyManifestFiles(targetDir, verifiedManifest, current = null) {
  for (const filePath of Object.keys(verifiedManifest.files)) {
    const expectedSha256 = manifestFileSha256(verifiedManifest, filePath);
    if (current && current.fileSha256?.[filePath] !== expectedSha256) {
      throw new Error(`ADAPTER_BUNDLE_CURRENT_FILE_SHA256_INVALID: ${filePath}`);
    }
    let fileData;
    try {
      fileData = await readFile(path.join(targetDir, filePath));
    } catch {
      throw new Error(`ADAPTER_BUNDLE_CURRENT_FILE_MISSING: ${filePath}`);
    }
    if (!fileData.length || sha256(fileData) !== expectedSha256) {
      throw new Error(`ADAPTER_BUNDLE_CURRENT_FILE_SHA256_MISMATCH: ${filePath}`);
    }
  }
}

async function smokeImportAdapterFiles(targetDir, files) {
  for (const filePath of Object.keys(files)) {
    const moduleUrl = `${pathToFileURL(path.join(targetDir, filePath)).href}?smoke=${Date.now()}`;
    await import(moduleUrl).catch((error) => {
      throw new Error(`ADAPTER_BUNDLE_SMOKE_IMPORT_FAILED: ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

async function writeBundleFiles(targetDir, files) {
  await rm(targetDir, { recursive: true, force: true });
  for (const [filePath, source] of Object.entries(files)) {
    const fullPath = path.join(targetDir, filePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, source, "utf8");
  }
  await writeBridgeFiles(targetDir, files);
}

async function atomicWriteJson(filePath, value) {
  const parentDir = path.dirname(filePath);
  const tempPath = path.join(parentDir, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(parentDir, { recursive: true });
  try {
    await writeFile(tempPath, JSON.stringify(value, null, 2), { encoding: "utf8", flag: "wx" });
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function publishImmutableVersion(root, verified, files) {
  const versionsRoot = path.join(root, "versions");
  const versionDir = path.join(root, ...versionDirRelative(verified.bundleVersion).split("/"));
  const stagingDir = path.join(versionsRoot, `.staging-${randomUUID()}`);
  await mkdir(versionsRoot, { recursive: true });
  try {
    await writeBundleFiles(stagingDir, files);
    await smokeImportAdapterFiles(stagingDir, files);
    try {
      await rename(stagingDir, versionDir);
    } catch (error) {
      const existingVersion = await stat(versionDir).catch(() => null);
      if (!existingVersion?.isDirectory()) throw error;
      await verifyManifestFiles(versionDir, verified);
      await ensureCurrentBridgeFiles(versionDir, verified.files);
    }
    return versionDir;
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

async function currentAdapterBundleText(stateDir) {
  const currentPath = path.join(adapterBundleRoot(stateDir), CURRENT_FILE);
  try {
    return await readFile(currentPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return "";
    throw error;
  }
}

export async function currentAdapterBundleMetadata(stateDir) {
  const text = await currentAdapterBundleText(stateDir);
  if (!text.trim()) return null;
  return JSON.parse(text);
}

function verifyCurrentAdapterBundleMetadata(current, publicKeyPem) {
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    throw new Error("ADAPTER_BUNDLE_CURRENT_METADATA_INVALID");
  }
  const verifiedManifest = verifyAdapterManifest(current.manifest, publicKeyPem);
  if (verifiedManifest.bundleVersion !== current.bundleVersion) {
    throw new Error("ADAPTER_BUNDLE_CURRENT_VERSION_MISMATCH");
  }
  const expectedVersionDir = versionDirRelative(verifiedManifest.bundleVersion);
  if (current.versionDir !== undefined && current.versionDir !== expectedVersionDir) {
    throw new Error("ADAPTER_BUNDLE_CURRENT_VERSION_DIR_INVALID");
  }
  return {
    metadata: current,
    verifiedManifest,
    versionDir: expectedVersionDir,
    needsPointerMigration: current.versionDir === undefined,
  };
}

async function readTrustedAdapterBundleState(stateDir) {
  const trustedStatePath = path.join(adapterBundleRoot(stateDir), TRUSTED_STATE_FILE);
  let text;
  try {
    text = await readFile(trustedStatePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw new Error("ADAPTER_BUNDLE_TRUSTED_STATE_UNREADABLE");
  }
  try {
    const trustedState = JSON.parse(text);
    if (!trustedState || typeof trustedState !== "object" || Array.isArray(trustedState)) throw new Error("invalid");
    return trustedState;
  } catch {
    throw new Error("ADAPTER_BUNDLE_TRUSTED_STATE_INVALID");
  }
}

async function verifiedTrustedAdapterBundleState(stateDir, publicKeyPem) {
  const trustedState = await readTrustedAdapterBundleState(stateDir);
  if (!trustedState) return null;
  if (trustedState.schemaVersion !== 1) throw new Error("ADAPTER_BUNDLE_TRUSTED_STATE_INVALID");
  const verifiedManifest = verifyAdapterManifest(trustedState.manifest, publicKeyPem);
  if (trustedState.highestBundleVersion !== verifiedManifest.bundleVersion) {
    throw new Error("ADAPTER_BUNDLE_TRUSTED_STATE_VERSION_MISMATCH");
  }
  return trustedState;
}

async function writeTrustedAdapterBundleState(stateDir, manifest, bundleVersion) {
  const root = adapterBundleRoot(stateDir);
  await mkdir(root, { recursive: true });
  const trustedState = {
    schemaVersion: 1,
    highestBundleVersion: bundleVersion,
    recordedAt: new Date().toISOString(),
    manifest,
  };
  await atomicWriteJson(path.join(root, TRUSTED_STATE_FILE), trustedState);
  return trustedState;
}

function highestInstalledVersion(current, trustedState) {
  const versions = [current?.bundleVersion, trustedState?.highestBundleVersion].filter(Boolean);
  return versions.reduce((highest, version) => (
    !highest || compareVersions(version, highest) > 0 ? version : highest
  ), "");
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && error.code === "EPERM");
  }
}

async function installLockIsStale(lockDir) {
  let owner = null;
  try {
    owner = JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8"));
  } catch {
    // A process may have created the directory but not written its owner yet.
  }
  const lockStat = await stat(lockDir).catch(() => null);
  if (!lockStat) return false;
  const createdAt = Date.parse(String(owner?.createdAt || ""));
  const age = Date.now() - (Number.isFinite(createdAt) ? createdAt : lockStat.mtimeMs);
  return owner ? !processIsAlive(owner.pid) : age > INSTALL_LOCK_MAX_AGE_MS;
}

async function recoverStaleInstallLock(root, lockDir) {
  const recoveryDir = path.join(root, `${INSTALL_LOCK_DIR}.recovery`);
  try {
    await mkdir(recoveryDir);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") return false;
    throw error;
  }

  try {
    if (!await installLockIsStale(lockDir)) return false;
    const staleDir = path.join(root, `.install-lock-stale-${randomUUID()}`);
    try {
      await rename(lockDir, staleDir);
    } catch (error) {
      if (error && typeof error === "object" && ["ENOENT", "EACCES", "EPERM"].includes(error.code)) return false;
      throw error;
    }
    await rm(staleDir, { recursive: true, force: true });
    return true;
  } finally {
    await rm(recoveryDir, { recursive: true, force: true });
  }
}

async function acquireInstallLock(stateDir) {
  const root = adapterBundleRoot(stateDir);
  const lockDir = path.join(root, INSTALL_LOCK_DIR);
  const token = randomUUID();
  const deadline = Date.now() + INSTALL_LOCK_WAIT_MS;
  await mkdir(root, { recursive: true });

  while (true) {
    try {
      await mkdir(lockDir);
      try {
        await writeFile(path.join(lockDir, "owner.json"), JSON.stringify({
          pid: process.pid,
          token,
          createdAt: new Date().toISOString(),
        }), { encoding: "utf8", flag: "wx" });
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true });
        throw error;
      }
      return async () => {
        try {
          const owner = JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8"));
          if (owner.token !== token) return;
          const releasedDir = path.join(root, `.install-lock-released-${randomUUID()}`);
          await rename(lockDir, releasedDir);
          await rm(releasedDir, { recursive: true, force: true });
        } catch (error) {
          if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "EEXIST") throw error;
    }

    if (await recoverStaleInstallLock(root, lockDir)) continue;
    if (Date.now() >= deadline) throw new Error("ADAPTER_BUNDLE_INSTALL_LOCK_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function verifiedCurrentStateForInstall(stateDir, publicKeyPem) {
  let currentText = "";
  let current;
  try {
    currentText = await currentAdapterBundleText(stateDir);
    if (!currentText.trim()) return null;
    current = JSON.parse(currentText);
    return {
      ...verifyCurrentAdapterBundleMetadata(current, publicKeyPem),
      currentText,
    };
  } catch (error) {
    await rollbackAdapterBundleUnlocked({
      actualStateDir: stateDir,
      expectedCurrentText: currentText,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function rollbackAdapterBundleUnlocked({ actualStateDir, reason = "", expectedCurrentText, expectedBundleVersion } = {}) {
  const root = adapterBundleRoot(actualStateDir);
  const currentPath = path.join(root, CURRENT_FILE);
  const currentText = await currentAdapterBundleText(actualStateDir).catch(() => "");
  let previous = null;
  try {
    previous = currentText.trim() ? JSON.parse(currentText) : null;
  } catch {
    previous = null;
  }
  const pointerChanged = expectedCurrentText !== undefined && currentText !== expectedCurrentText;
  const versionChanged = expectedBundleVersion !== undefined && previous?.bundleVersion !== expectedBundleVersion;
  if (pointerChanged || versionChanged) {
    return {
      status: "superseded",
      previous,
      reason,
      rolledBackAt: new Date().toISOString(),
    };
  }
  await rm(currentPath, { force: true });
  const rollback = {
    status: previous ? "rolled_back" : "noop",
    previous,
    reason,
    rolledBackAt: new Date().toISOString(),
  };
  if (previous) await atomicWriteJson(path.join(root, "rollback.json"), rollback);
  return rollback;
}

export async function rollbackAdapterBundle({
  stateDir,
  statePath,
  reason = "",
  expectedCurrentText,
  expectedBundleVersion,
} = {}) {
  const actualStateDir = stateDirFromOptions({ stateDir, statePath });
  if (!actualStateDir) throw new Error("ADAPTER_BUNDLE_STATE_DIR_REQUIRED");
  const releaseLock = await acquireInstallLock(actualStateDir);
  try {
    return await rollbackAdapterBundleUnlocked({
      actualStateDir,
      reason,
      expectedCurrentText,
      expectedBundleVersion,
    });
  } finally {
    await releaseLock();
  }
}

export async function installAdapterBundle({ manifest, bundleData, stateDir, statePath, publicKeyPem, desktopVersion } = {}) {
  const actualStateDir = stateDirFromOptions({ stateDir, statePath });
  if (!actualStateDir) throw new Error("ADAPTER_BUNDLE_STATE_DIR_REQUIRED");
  const verified = verifyAdapterManifest(manifest, publicKeyPem);
  await assertDesktopVersionCompatible(verified, desktopVersion);
  const releaseLock = await acquireInstallLock(actualStateDir);
  try {
    const currentState = await verifiedCurrentStateForInstall(actualStateDir, publicKeyPem);
    const trustedState = await verifiedTrustedAdapterBundleState(actualStateDir, publicKeyPem);
    const installedVersion = highestInstalledVersion(currentState?.metadata, trustedState);
    if (installedVersion && compareVersions(verified.bundleVersion, installedVersion) <= 0) {
      throw new Error("ADAPTER_BUNDLE_VERSION_NOT_NEWER");
    }
    const files = materializeBundleFiles(verified, bundleData);
    const root = adapterBundleRoot(actualStateDir);
    await publishImmutableVersion(root, verified, files);

    const commitCurrentState = await verifiedCurrentStateForInstall(actualStateDir, publicKeyPem);
    const commitTrustedState = await verifiedTrustedAdapterBundleState(actualStateDir, publicKeyPem);
    const commitInstalledVersion = highestInstalledVersion(commitCurrentState?.metadata, commitTrustedState);
    if (commitInstalledVersion && compareVersions(verified.bundleVersion, commitInstalledVersion) <= 0) {
      throw new Error("ADAPTER_BUNDLE_VERSION_NOT_NEWER");
    }
    const platforms = Object.fromEntries(Object.keys(files).map((filePath) => [platformFromBundlePath(filePath), verified.bundleVersion]));
    const metadata = {
      schemaVersion: verified.schemaVersion,
      bundleVersion: verified.bundleVersion,
      versionDir: versionDirRelative(verified.bundleVersion),
      minDesktopVersion: verified.minDesktopVersion || "",
      bundleFile: verified.bundleFile || "",
      installedAt: new Date().toISOString(),
      platforms,
      notes: Array.isArray(verified.notes) ? verified.notes : [],
      manifest,
      fileSha256: Object.fromEntries(Object.entries(files).map(([filePath, source]) => [
        filePath,
        sha256(Buffer.from(source, "utf8")),
      ])),
    };
    const currentPath = path.join(root, CURRENT_FILE);
    await atomicWriteJson(currentPath, metadata);
    try {
      await writeTrustedAdapterBundleState(actualStateDir, manifest, verified.bundleVersion);
    } catch (error) {
      if (commitCurrentState?.metadata) {
        await atomicWriteJson(currentPath, commitCurrentState.metadata);
      } else {
        await rm(currentPath, { force: true });
      }
      throw error;
    }
    return metadata;
  } finally {
    await releaseLock();
  }
}

function compareCurrentManifestToTrusted(verified, current, trustedState) {
  if (!trustedState) return 1;
  const comparison = compareVersions(verified.bundleVersion, trustedState.highestBundleVersion);
  if (comparison < 0) throw new Error("ADAPTER_BUNDLE_CURRENT_VERSION_BELOW_TRUSTED_STATE");
  if (comparison === 0 && canonicalManifest(current.manifest) !== canonicalManifest(trustedState.manifest)) {
    throw new Error("ADAPTER_BUNDLE_CURRENT_MANIFEST_MISMATCH");
  }
  return comparison;
}

async function trustVerifiedCurrentIfUnchanged({
  actualStateDir,
  currentText,
  current,
  verified,
  publicKeyPem,
}) {
  const releaseLock = await acquireInstallLock(actualStateDir);
  try {
    if (await currentAdapterBundleText(actualStateDir) !== currentText) return false;
    const trustedState = await verifiedTrustedAdapterBundleState(actualStateDir, publicKeyPem);
    const comparison = compareCurrentManifestToTrusted(verified, current, trustedState);
    if (!trustedState || comparison > 0) {
      await writeTrustedAdapterBundleState(actualStateDir, current.manifest, verified.bundleVersion);
    }
    return true;
  } finally {
    await releaseLock();
  }
}

export async function loadVerifiedHotAdapter({ platform, stateDir, statePath, publicKeyPem } = {}) {
  const actualStateDir = stateDirFromOptions({ stateDir, statePath });
  const key = String(platform || "").trim().toLowerCase();
  if (!key || !actualStateDir) return null;
  let currentText = "";
  let current;
  try {
    currentText = await currentAdapterBundleText(actualStateDir);
    if (!currentText.trim()) return null;
    current = JSON.parse(currentText);
  } catch (error) {
    await rollbackAdapterBundle({
      stateDir: actualStateDir,
      expectedCurrentText: currentText,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  try {
    const actualPublicKeyPem = await readAdapterBundlePublicKey({ publicKeyPem });
    const currentState = verifyCurrentAdapterBundleMetadata(current, actualPublicKeyPem);
    const verified = currentState.verifiedManifest;
    const versionDir = path.join(adapterBundleRoot(actualStateDir), ...currentState.versionDir.split("/"));
    const adapterFile = `adapters/${key}.mjs`;
    const filePath = path.join(versionDir, adapterFile);
    const trustedState = await verifiedTrustedAdapterBundleState(actualStateDir, actualPublicKeyPem);
    compareCurrentManifestToTrusted(verified, current, trustedState);
    await verifyManifestFiles(versionDir, verified, current);
    await ensureCurrentBridgeFiles(versionDir, verified.files);
    if (!Object.hasOwn(verified.files, adapterFile)) {
      await trustVerifiedCurrentIfUnchanged({
        actualStateDir,
        currentText,
        current,
        verified,
        publicKeyPem: actualPublicKeyPem,
      });
      return null;
    }
    const module = await import(`${pathToFileURL(filePath).href}?bundle=${Date.now()}`);
    await trustVerifiedCurrentIfUnchanged({
      actualStateDir,
      currentText,
      current,
      verified,
      publicKeyPem: actualPublicKeyPem,
    });
    return { module, bundleVersion: verified.bundleVersion };
  } catch (error) {
    await rollbackAdapterBundle({
      stateDir: actualStateDir,
      expectedCurrentText: currentText,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function loadHotAdapterModule(options = {}) {
  return (await loadVerifiedHotAdapter(options))?.module || null;
}

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`ADAPTER_BUNDLE_MANIFEST_FETCH_FAILED: HTTP_${response.status}`);
  return text ? JSON.parse(text) : {};
}

async function fetchBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`ADAPTER_BUNDLE_ZIP_FETCH_FAILED: HTTP_${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function refreshAdapterBundleIfAvailable(options = {}) {
  const stateDir = stateDirFromOptions(options);
  if (!stateDir) return { status: "skipped", reason: "state-dir-missing" };
  try {
    const urls = manifestAndBundleUrls(options);
    if (!urls) return { status: "skipped", reason: "base-url-missing" };
    const publicKeyPem = await readAdapterBundlePublicKey(options);
    const manifest = await fetchJson(urls.manifestUrl);
    const verified = verifyAdapterManifest(manifest, publicKeyPem);
    let desktopVersion;
    try {
      desktopVersion = await assertDesktopVersionCompatible(verified, options.desktopVersion);
    } catch (error) {
      if (error instanceof Error && error.message === "ADAPTER_BUNDLE_DESKTOP_VERSION_TOO_OLD") {
        return {
          status: "rejected",
          reason: "desktop-version-too-old",
          metadata: await currentAdapterBundleMetadata(stateDir).catch(() => null),
        };
      }
      throw error;
    }
    const current = await currentAdapterBundleMetadata(stateDir);
    const trustedState = await verifiedTrustedAdapterBundleState(stateDir, publicKeyPem);
    const installedVersion = highestInstalledVersion(current, trustedState);
    if (installedVersion) {
      const comparison = compareVersions(verified.bundleVersion, installedVersion);
      const matchesActiveCurrent = comparison === 0 && current?.bundleVersion === installedVersion;
      if (matchesActiveCurrent) return { status: "current", metadata: current };
      if (comparison <= 0) return { status: "rejected", reason: "bundle-version-not-newer", metadata: current };
    }
    const bundleData = verified.bundleFile
      ? await fetchBuffer(urls.bundleUrl(verified.bundleFile))
      : undefined;
    const metadata = await installAdapterBundle({
      manifest,
      bundleData,
      stateDir,
      publicKeyPem,
      desktopVersion,
    });
    return { status: "installed", metadata };
  } catch (error) {
    return {
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      metadata: await currentAdapterBundleMetadata(stateDir).catch(() => null),
    };
  }
}

export function adapterSourcePath(platform) {
  return path.join(adaptersSrcRoot, `${String(platform || "").toLowerCase()}.mjs`);
}
