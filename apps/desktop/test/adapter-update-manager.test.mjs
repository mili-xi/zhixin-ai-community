import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  adapterBundleRoot,
  currentAdapterBundleMetadata,
  hotAdapterPath,
  installAdapterBundle,
  loadHotAdapterModule,
  refreshAdapterBundleIfAvailable,
  rollbackAdapterBundle,
  verifyAdapterManifest,
} from "../src/adapter-update-manager.mjs";

const TEST_DESKTOP_VERSION = "0.1.6";

function keyPair() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }),
  };
}

function canonicalManifest(manifest) {
  function sortValue(value) {
    if (Array.isArray(value)) return value.map(sortValue);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  const { signature: _signature, ...unsigned } = manifest;
  return JSON.stringify(sortValue(unsigned));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function createStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, source] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name, "utf8");
    const data = Buffer.from(source, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
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

function signedManifest(privateKeyPem, overrides = {}) {
  const manifest = {
    schemaVersion: 1,
    bundleVersion: "2026.07.29.1",
    minDesktopVersion: "",
    files: {
      "adapters/penguin.mjs": "export class PenguinAdapter { constructor(){ this.platform = 'penguin-hot'; } }\n",
    },
    notes: ["hot penguin"],
    ...overrides,
  };
  manifest.signature = sign(null, Buffer.from(canonicalManifest(manifest)), privateKeyPem).toString("base64");
  return manifest;
}

test("verifies a signed adapter manifest and rejects tampering", () => {
  const keys = keyPair();
  const manifest = signedManifest(keys.privateKeyPem);

  assert.equal(verifyAdapterManifest(manifest, keys.publicKeyPem).bundleVersion, "2026.07.29.1");

  const tampered = { ...manifest, bundleVersion: "2026.07.29.2" };
  assert.throws(() => verifyAdapterManifest(tampered, keys.publicKeyPem), /ADAPTER_BUNDLE_SIGNATURE_INVALID/);

  const tamperedFile = {
    ...manifest,
    files: { "adapters/penguin.mjs": "export class PenguinAdapter { constructor(){ this.platform = 'penguin-tampered'; } }\n" },
  };
  assert.throws(() => verifyAdapterManifest(tamperedFile, keys.publicKeyPem), /ADAPTER_BUNDLE_SIGNATURE_INVALID/);
});

test("rejects a manifest signed by a non-Ed25519 key", () => {
  const pair = generateKeyPairSync("ed448");
  const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" });
  const manifest = signedManifest(privateKeyPem);

  assert.throws(
    () => verifyAdapterManifest(manifest, publicKeyPem),
    /ADAPTER_BUNDLE_SIGNING_KEY_NOT_ED25519/
  );
});

test("keeps adapter bundle storage inside the provided desktop state directory", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-root-"));
  try {
    assert.equal(adapterBundleRoot(stateDir), path.join(stateDir, "adapter-bundles"));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("installs adapter files from a signed zip bundle and checks file hashes", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-bundle-zip-"));
  try {
    const source = "export class PenguinAdapter { constructor(){ this.platform = 'penguin-zip-hot'; } }\n";
    const zip = createStoredZip({ "adapters/penguin.mjs": source });
    const manifest = signedManifest(keys.privateKeyPem, {
      bundleVersion: "2026.07.29.zip",
      bundleFile: "2026.07.29.zip.zip",
      bundleSha256: sha256(zip),
      files: {
        "adapters/penguin.mjs": { sha256: sha256(source), bytes: Buffer.byteLength(source) },
      },
    });

    const installed = await installAdapterBundle({ manifest, bundleData: zip, stateDir, publicKeyPem: keys.publicKeyPem, desktopVersion: TEST_DESKTOP_VERSION });

    assert.equal(installed.bundleVersion, "2026.07.29.zip");
    assert.equal(await readFile(hotAdapterPath(stateDir, "penguin", installed.bundleVersion), "utf8"), source);

    const badManifest = signedManifest(keys.privateKeyPem, {
      bundleVersion: "2026.07.30.bad-hash",
      bundleFile: "2026.07.30.bad-hash.zip",
      bundleSha256: sha256(zip),
      files: { "adapters/penguin.mjs": { sha256: "0".repeat(64), bytes: Buffer.byteLength(source) } },
    });
    await assert.rejects(
      () => installAdapterBundle({ manifest: badManifest, bundleData: zip, stateDir, publicKeyPem: keys.publicKeyPem, desktopVersion: TEST_DESKTOP_VERSION }),
      /ADAPTER_BUNDLE_FILE_SHA256_MISMATCH/
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("refresh downloads a signed adapter zip manifest and installs it", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-refresh-"));
  const source = "export class PenguinAdapter { constructor(){ this.platform = 'penguin-refreshed'; } }\n";
  const zip = createStoredZip({ "adapters/penguin.mjs": source });
  const manifest = signedManifest(keys.privateKeyPem, {
    bundleVersion: "2026.07.29.refresh",
    bundleFile: "2026.07.29.refresh.zip",
    bundleSha256: sha256(zip),
    files: { "adapters/penguin.mjs": { sha256: sha256(source), bytes: Buffer.byteLength(source) } },
  });
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url === "/downloads/adapter-bundles/adapter-version.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(manifest));
      return;
    }
    if (request.url === "/downloads/adapter-bundles/2026.07.29.refresh.zip") {
      response.writeHead(200, { "content-type": "application/zip" });
      response.end(zip);
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ detail: "missing" }));
  });

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const result = await refreshAdapterBundleIfAvailable({ apiBaseUrl: baseUrl, stateDir, publicKeyPem: keys.publicKeyPem, desktopVersion: TEST_DESKTOP_VERSION });

    assert.equal(result.status, "installed");
    assert.equal(result.metadata.bundleVersion, "2026.07.29.refresh");
    assert.equal(await readFile(hotAdapterPath(stateDir, "penguin", result.metadata.bundleVersion), "utf8"), source);
    assert.deepEqual(requests, [
      "/downloads/adapter-bundles/adapter-version.json",
      "/downloads/adapter-bundles/2026.07.29.refresh.zip",
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("refresh rejects a signed manifest older than the installed bundle", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-replay-"));
  const currentSource = "export const generation = 'current';\n";
  const oldSource = "export const generation = 'old';\n";
  const oldManifest = signedManifest(keys.privateKeyPem, {
    bundleVersion: "2026.07.29.9",
    files: { "adapters/penguin.mjs": oldSource },
  });
  const server = createServer((request, response) => {
    if (request.url === "/downloads/adapter-bundles/adapter-version.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(oldManifest));
      return;
    }
    response.writeHead(404).end();
  });

  try {
    await installAdapterBundle({
      manifest: signedManifest(keys.privateKeyPem, {
        bundleVersion: "2026.07.30.1",
        files: { "adapters/penguin.mjs": currentSource },
      }),
      stateDir,
      publicKeyPem: keys.publicKeyPem,
      desktopVersion: "0.1.6",
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    const result = await refreshAdapterBundleIfAvailable({
      apiBaseUrl: `http://127.0.0.1:${server.address().port}`,
      stateDir,
      publicKeyPem: keys.publicKeyPem,
      desktopVersion: "0.1.6",
    });

    assert.equal(result.status, "rejected");
    assert.equal(result.reason, "bundle-version-not-newer");
    assert.equal(result.metadata.bundleVersion, "2026.07.30.1");
    assert.equal(await readFile(hotAdapterPath(stateDir, "penguin", "2026.07.30.1"), "utf8"), currentSource);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("refresh rejects a bundle that requires a newer desktop version", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-min-desktop-"));
  const manifest = signedManifest(keys.privateKeyPem, {
    bundleVersion: "2026.07.30.2",
    minDesktopVersion: "0.2.0",
  });
  const server = createServer((request, response) => {
    if (request.url === "/downloads/adapter-bundles/adapter-version.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(manifest));
      return;
    }
    response.writeHead(404).end();
  });

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    const result = await refreshAdapterBundleIfAvailable({
      apiBaseUrl: `http://127.0.0.1:${server.address().port}`,
      stateDir,
      publicKeyPem: keys.publicKeyPem,
      desktopVersion: "0.1.9",
    });

    assert.equal(result.status, "rejected");
    assert.equal(result.reason, "desktop-version-too-old");
    assert.equal(await currentAdapterBundleMetadata(stateDir), null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("refresh can install from an explicit staged manifest URL", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-refresh-staged-"));
  const source = "export class PenguinAdapter { constructor(){ this.platform = 'penguin-staged'; } }\n";
  const zip = createStoredZip({ "adapters/penguin.mjs": source });
  const manifest = signedManifest(keys.privateKeyPem, {
    bundleVersion: "2026.07.29.staged",
    bundleFile: "2026.07.29.staged.zip",
    bundleSha256: sha256(zip),
    files: { "adapters/penguin.mjs": { sha256: sha256(source), bytes: Buffer.byteLength(source) } },
  });
  const server = createServer((request, response) => {
    if (request.url === "/staging/2026.07.29.staged/adapter-version.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(manifest));
      return;
    }
    if (request.url === "/staging/2026.07.29.staged/2026.07.29.staged.zip") {
      response.writeHead(200, { "content-type": "application/zip" });
      response.end(zip);
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ detail: "missing" }));
  });

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const manifestUrl = `http://127.0.0.1:${server.address().port}/staging/2026.07.29.staged/adapter-version.json`;

    const result = await refreshAdapterBundleIfAvailable({ adapterBundleManifestUrl: manifestUrl, stateDir, publicKeyPem: keys.publicKeyPem, desktopVersion: TEST_DESKTOP_VERSION });

    assert.equal(result.status, "installed");
    assert.equal(await readFile(hotAdapterPath(stateDir, "penguin", result.metadata.bundleVersion), "utf8"), source);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("rejects adapter bundles outside the adapters mjs whitelist", () => {
  const keys = keyPair();
  const manifest = signedManifest(keys.privateKeyPem, {
    files: {
      "adapters/penguin.mjs": "export class PenguinAdapter {}\n",
      "../agent-core.mjs": "export const pwned = true;\n",
    },
  });

  assert.throws(() => verifyAdapterManifest(manifest, keys.publicKeyPem), /ADAPTER_BUNDLE_FILE_NOT_ALLOWED/);
});

test("rejects built-in adapter bridges as hot-update manifest files", () => {
  const keys = keyPair();
  const manifest = signedManifest(keys.privateKeyPem, {
    files: {
      "adapters/platform-api.mjs": "export const bridgeOverride = true;\n",
    },
  });

  assert.throws(
    () => verifyAdapterManifest(manifest, keys.publicKeyPem),
    /ADAPTER_BUNDLE_BRIDGE_FILE_NOT_ALLOWED/
  );
});

test("installs a signed adapter bundle after smoke import and records current metadata", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-bundle-"));
  try {
    const manifest = signedManifest(keys.privateKeyPem);

    const installed = await installAdapterBundle({ manifest, stateDir, publicKeyPem: keys.publicKeyPem, desktopVersion: TEST_DESKTOP_VERSION });

    assert.equal(installed.bundleVersion, "2026.07.29.1");
    assert.equal(installed.platforms.penguin, "2026.07.29.1");
    assert.equal(await readFile(hotAdapterPath(stateDir, "penguin", installed.bundleVersion), "utf8"), manifest.files["adapters/penguin.mjs"]);
    assert.equal((await currentAdapterBundleMetadata(stateDir)).bundleVersion, "2026.07.29.1");
    assert.match(adapterBundleRoot(stateDir), /adapter-bundles$/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("installs and smoke imports the real Zhihu adapter as an adapter-only bundle", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-bundle-zhihu-"));
  try {
    const launchCalls = [];
    const fakeContext = {};
    const zhihuSource = await readFile(new URL("../src/adapters/zhihu.mjs", import.meta.url), "utf8");
    const manifest = signedManifest(keys.privateKeyPem, {
      bundleVersion: "2026.08.02.zhihu",
      files: { "adapters/zhihu.mjs": zhihuSource },
      notes: ["real zhihu adapter smoke import"],
    });

    const installed = await installAdapterBundle({
      manifest,
      stateDir,
      publicKeyPem: keys.publicKeyPem,
      desktopVersion: TEST_DESKTOP_VERSION,
    });
    const loaded = await loadHotAdapterModule({
      platform: "zhihu",
      stateDir,
      publicKeyPem: keys.publicKeyPem,
    });

    assert.equal(installed.platforms.zhihu, "2026.08.02.zhihu");
    assert.equal(typeof loaded.ZhihuAdapter, "function");
    const adapter = new loaded.ZhihuAdapter({
      browser: {
        async launchPersistentContext(userDataDir, options) {
          launchCalls.push({ userDataDir, options });
          return fakeContext;
        },
      },
    });
    const profileRoot = path.join(stateDir, "profiles");
    const context = await adapter.launchAuthEnvironment({
      profileRoot,
      profileKey: "zhihu-smoke-account",
      headless: true,
    });
    adapter.reportCredentialRefresh = async (input, activeContext, page) => ({
      refreshed: input.marker === "smoke" && activeContext === fakeContext && page.id === "page-1",
    });
    const refreshed = await adapter.refreshCredentialAfterOperation(
      { marker: "smoke" },
      fakeContext,
      { id: "page-1" },
    );

    assert.equal(context, fakeContext);
    assert.equal(launchCalls.length, 1);
    assert.equal(launchCalls[0].userDataDir, path.join(profileRoot, "zhihu", "zhihu-smoke-account"));
    assert.equal(launchCalls[0].options.headless, true);
    assert.deepEqual(refreshed, { refreshed: true });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("atomically points current metadata at an immutable version directory", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-immutable-current-"));
  try {
    const source = "export const version = '13.0.0';\n";
    const manifest = signedManifest(keys.privateKeyPem, {
      bundleVersion: "13.0.0",
      files: { "adapters/penguin.mjs": source },
    });

    const installed = await installAdapterBundle({
      manifest,
      stateDir,
      publicKeyPem: keys.publicKeyPem,
      desktopVersion: TEST_DESKTOP_VERSION,
    });

    assert.equal(installed.versionDir, "versions/13.0.0");
    assert.equal(
      await readFile(path.join(adapterBundleRoot(stateDir), "versions", "13.0.0", "adapters", "penguin.mjs"), "utf8"),
      source
    );
    await assert.rejects(() => access(path.join(adapterBundleRoot(stateDir), "current")));
    const loaded = await loadHotAdapterModule({ platform: "penguin", stateDir, publicKeyPem: keys.publicKeyPem });
    assert.equal(loaded.version, "13.0.0");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("runtime rejects tampered signed current metadata and clears the hot adapter", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-runtime-signature-"));
  try {
    const manifest = signedManifest(keys.privateKeyPem, {
      bundleVersion: "4.0.0",
      files: { "adapters/penguin.mjs": "export const integrity = 'signed';\n" },
    });
    await installAdapterBundle({
      manifest,
      stateDir,
      publicKeyPem: keys.publicKeyPem,
      desktopVersion: TEST_DESKTOP_VERSION,
    });
    const metadata = await currentAdapterBundleMetadata(stateDir);
    assert.deepEqual(metadata.manifest, manifest);
    assert.equal(metadata.fileSha256["adapters/penguin.mjs"], sha256(manifest.files["adapters/penguin.mjs"]));

    metadata.manifest.bundleVersion = "4.0.1";
    await writeFile(path.join(adapterBundleRoot(stateDir), "current.json"), JSON.stringify(metadata), "utf8");

    const loaded = await loadHotAdapterModule({
      platform: "penguin",
      stateDir,
      publicKeyPem: keys.publicKeyPem,
    });

    assert.equal(loaded, null);
    assert.equal(await currentAdapterBundleMetadata(stateDir), null);
    assert.equal(await readFile(hotAdapterPath(stateDir, "penguin", "4.0.0"), "utf8"), manifest.files["adapters/penguin.mjs"]);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("runtime rejects a current adapter whose file hash no longer matches", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-runtime-file-hash-"));
  try {
    const manifest = signedManifest(keys.privateKeyPem, {
      bundleVersion: "4.0.1",
      files: { "adapters/penguin.mjs": "export const integrity = 'signed';\n" },
    });
    await installAdapterBundle({
      manifest,
      stateDir,
      publicKeyPem: keys.publicKeyPem,
      desktopVersion: TEST_DESKTOP_VERSION,
    });
    await writeFile(hotAdapterPath(stateDir, "penguin", "4.0.1"), "export const integrity = 'tampered';\n", "utf8");

    const loaded = await loadHotAdapterModule({
      platform: "penguin",
      stateDir,
      publicKeyPem: keys.publicKeyPem,
    });

    assert.equal(loaded, null);
    assert.equal(await currentAdapterBundleMetadata(stateDir), null);
    assert.equal(await readFile(hotAdapterPath(stateDir, "penguin", "4.0.1"), "utf8"), "export const integrity = 'tampered';\n");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("runtime validates every signed dependency before entering the hot module graph", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-runtime-helper-"));
  const sideEffectKey = "__zhixinTamperedHelperExecuted";
  try {
    delete globalThis[sideEffectKey];
    const manifest = signedManifest(keys.privateKeyPem, {
      bundleVersion: "4.0.14",
      files: {
        "adapters/penguin.mjs": "import { helperVersion } from './penguin-helper.mjs';\nexport const version = helperVersion;\n",
        "adapters/penguin-helper.mjs": "export const helperVersion = 'signed-helper';\n",
      },
    });
    await installAdapterBundle({
      manifest,
      stateDir,
      publicKeyPem: keys.publicKeyPem,
      desktopVersion: TEST_DESKTOP_VERSION,
    });
    const trustedStatePath = path.join(adapterBundleRoot(stateDir), "trusted-state.json");
    const trustedStateBefore = await readFile(trustedStatePath);
    const helperPath = path.join(adapterBundleRoot(stateDir), "versions", "4.0.14", "adapters", "penguin-helper.mjs");
    await writeFile(
      helperPath,
      `globalThis.${sideEffectKey} = true;\nexport const helperVersion = 'tampered-helper';\n`,
      "utf8"
    );

    const loaded = await loadHotAdapterModule({
      platform: "penguin",
      stateDir,
      publicKeyPem: keys.publicKeyPem,
    });

    assert.equal(loaded, null);
    assert.equal(globalThis[sideEffectKey], undefined);
    assert.equal(await currentAdapterBundleMetadata(stateDir), null);
    assert.deepEqual(await readFile(trustedStatePath), trustedStateBefore);
  } finally {
    delete globalThis[sideEffectKey];
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("runtime rejects a tampered built-in bridge before importing the current adapter", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-runtime-bridge-"));
  try {
    const manifest = signedManifest(keys.privateKeyPem, {
      bundleVersion: "4.0.15",
      files: {
        "adapters/penguin.mjs": "import './platform-api.mjs';\nexport const integrity = 'signed';\n",
      },
    });
    await installAdapterBundle({
      manifest,
      stateDir,
      publicKeyPem: keys.publicKeyPem,
      desktopVersion: TEST_DESKTOP_VERSION,
    });
    const trustedStatePath = path.join(adapterBundleRoot(stateDir), "trusted-state.json");
    const trustedStateBefore = await readFile(trustedStatePath);
    const bridgePath = path.join(adapterBundleRoot(stateDir), "versions", "4.0.15", "adapters", "platform-api.mjs");
    await writeFile(bridgePath, "export const bridgeTampered = true;\n", "utf8");

    const loaded = await loadHotAdapterModule({
      platform: "penguin",
      stateDir,
      publicKeyPem: keys.publicKeyPem,
    });

    assert.equal(loaded, null);
    assert.equal(await currentAdapterBundleMetadata(stateDir), null);
    assert.equal(await readFile(hotAdapterPath(stateDir, "penguin", "4.0.15"), "utf8"), manifest.files["adapters/penguin.mjs"]);
    assert.deepEqual(await readFile(trustedStatePath), trustedStateBefore);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("runtime rewrites a stale bridge shim instead of rolling back the bundle", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-runtime-stale-bridge-"));
  try {
    const manifest = signedManifest(keys.privateKeyPem, {
      bundleVersion: "4.0.18",
      files: {
        "adapters/penguin.mjs": "import './platform-api.mjs';\nexport const integrity = 'signed';\n",
      },
    });
    await installAdapterBundle({
      manifest,
      stateDir,
      publicKeyPem: keys.publicKeyPem,
      desktopVersion: TEST_DESKTOP_VERSION,
    });
    // Simulate the app being reinstalled or moved: the installed shim still
    // points at the install path it was generated under, which no longer
    // exists. This is the state 202610070105 was rolled back from.
    const bridgePath = path.join(adapterBundleRoot(stateDir), "versions", "4.0.18", "adapters", "platform-api.mjs");
    await writeFile(bridgePath, 'export * from "file:///E:/ZhixinAI/resources/agent/src/adapters/platform-api.mjs";\n', "utf8");

    const loaded = await loadHotAdapterModule({
      platform: "penguin",
      stateDir,
      publicKeyPem: keys.publicKeyPem,
    });

    assert.notEqual(loaded, null);
    assert.equal(loaded.integrity, "signed");
    assert.notEqual(await currentAdapterBundleMetadata(stateDir), null);
    const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const expectedShim = `export * from ${JSON.stringify(pathToFileURL(path.join(desktopRoot, "src", "adapters", "platform-api.mjs")).href)};\n`;
    assert.equal(await readFile(bridgePath, "utf8"), expectedShim);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("loads a hot Baijiahao adapter that imports the session manager bridge", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-session-bridge-"));
  try {
    const manifest = signedManifest(keys.privateKeyPem, {
      bundleVersion: "4.0.16",
      files: {
        "adapters/baijiahao.mjs": "import '../session-manager.mjs';\nexport const hotSessionBridge = true;\n",
      },
    });
    await installAdapterBundle({
      manifest,
      stateDir,
      publicKeyPem: keys.publicKeyPem,
      desktopVersion: TEST_DESKTOP_VERSION,
    });

    const loaded = await loadHotAdapterModule({
      platform: "baijiahao",
      stateDir,
      publicKeyPem: keys.publicKeyPem,
    });

    assert.equal(loaded.hotSessionBridge, true);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("loads a hot adapter that imports the public page blocker bridge", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-page-blocker-bridge-"));
  try {
    const manifest = signedManifest(keys.privateKeyPem, {
      bundleVersion: "4.0.17",
      files: {
        "adapters/sohu.mjs": "import '../public-page-blocker.mjs';\nexport const hotPageBlockerBridge = true;\n",
      },
    });
    await installAdapterBundle({
      manifest,
      stateDir,
      publicKeyPem: keys.publicKeyPem,
      desktopVersion: TEST_DESKTOP_VERSION,
    });

    const loaded = await loadHotAdapterModule({
      platform: "sohu",
      stateDir,
      publicKeyPem: keys.publicKeyPem,
    });

    assert.equal(loaded.hotPageBlockerBridge, true);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("runtime loads a current adapter after signature and file hash verification", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-runtime-valid-"));
  try {
    const manifest = signedManifest(keys.privateKeyPem, {
      bundleVersion: "4.0.2",
      files: { "adapters/penguin.mjs": "export const integrity = 'verified';\n" },
    });
    await installAdapterBundle({
      manifest,
      stateDir,
      publicKeyPem: keys.publicKeyPem,
      desktopVersion: TEST_DESKTOP_VERSION,
    });
    await rm(path.join(adapterBundleRoot(stateDir), "trusted-state.json"), { force: true });

    const loaded = await loadHotAdapterModule({
      platform: "penguin",
      stateDir,
      publicKeyPem: keys.publicKeyPem,
    });

    assert.equal(loaded.integrity, "verified");
    assert.equal((await currentAdapterBundleMetadata(stateDir)).bundleVersion, "4.0.2");
    const trustedState = JSON.parse(await readFile(path.join(adapterBundleRoot(stateDir), "trusted-state.json"), "utf8"));
    assert.equal(trustedState.highestBundleVersion, "4.0.2");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("a failing stale loader cannot clear a concurrently installed current bundle", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-stale-loader-"));
  const startedKey = `__zhixinOldLoaderStarted${Date.now()}`;
  try {
    const oldManifest = signedManifest(keys.privateKeyPem, {
      bundleVersion: "4.1.0",
      files: {
        "adapters/penguin.mjs": `
if (import.meta.url.includes('/versions/4.1.0/')) {
  globalThis.${startedKey}?.();
  await new Promise((resolve) => setTimeout(resolve, 100));
  throw new Error('old loader failed');
}
export const version = '4.1.0';
`,
      },
    });
    await installAdapterBundle({
      manifest: oldManifest,
      stateDir,
      publicKeyPem: keys.publicKeyPem,
      desktopVersion: TEST_DESKTOP_VERSION,
    });

    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    globalThis[startedKey] = markStarted;
    const staleLoad = loadHotAdapterModule({
      platform: "penguin",
      stateDir,
      publicKeyPem: keys.publicKeyPem,
    });
    await started;

    const newManifest = signedManifest(keys.privateKeyPem, {
      bundleVersion: "4.2.0",
      files: { "adapters/penguin.mjs": "export const version = '4.2.0';\n" },
    });
    await installAdapterBundle({
      manifest: newManifest,
      stateDir,
      publicKeyPem: keys.publicKeyPem,
      desktopVersion: TEST_DESKTOP_VERSION,
    });

    assert.equal(await staleLoad, null);
    assert.equal((await currentAdapterBundleMetadata(stateDir)).bundleVersion, "4.2.0");
    const trustedState = JSON.parse(await readFile(path.join(adapterBundleRoot(stateDir), "trusted-state.json"), "utf8"));
    assert.equal(trustedState.highestBundleVersion, "4.2.0");
  } finally {
    delete globalThis[startedKey];
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("runtime does not raise the trusted floor before current integrity succeeds", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-trusted-after-integrity-"));
  try {
    const oldManifest = signedManifest(keys.privateKeyPem, {
      bundleVersion: "4.3.0",
      files: { "adapters/penguin.mjs": "export const version = '4.3.0';\n" },
    });
    await installAdapterBundle({
      manifest: oldManifest,
      stateDir,
      publicKeyPem: keys.publicKeyPem,
      desktopVersion: TEST_DESKTOP_VERSION,
    });
    const oldTrustedState = await readFile(path.join(adapterBundleRoot(stateDir), "trusted-state.json"));

    const newManifest = signedManifest(keys.privateKeyPem, {
      bundleVersion: "4.4.0",
      files: { "adapters/penguin.mjs": "export const version = '4.4.0';\n" },
    });
    await installAdapterBundle({
      manifest: newManifest,
      stateDir,
      publicKeyPem: keys.publicKeyPem,
      desktopVersion: TEST_DESKTOP_VERSION,
    });
    await writeFile(path.join(adapterBundleRoot(stateDir), "trusted-state.json"), oldTrustedState);
    await writeFile(hotAdapterPath(stateDir, "penguin", "4.4.0"), "export const version = 'tampered';\n", "utf8");

    assert.equal(await loadHotAdapterModule({
      platform: "penguin",
      stateDir,
      publicKeyPem: keys.publicKeyPem,
    }), null);
    const trustedState = JSON.parse(await readFile(path.join(adapterBundleRoot(stateDir), "trusted-state.json"), "utf8"));
    assert.equal(trustedState.highestBundleVersion, "4.3.0");
    assert.deepEqual(trustedState.manifest, oldManifest);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("runtime clears legacy current metadata that cannot be reverified", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-runtime-legacy-"));
  try {
    const manifest = signedManifest(keys.privateKeyPem, { bundleVersion: "4.0.3" });
    await installAdapterBundle({
      manifest,
      stateDir,
      publicKeyPem: keys.publicKeyPem,
      desktopVersion: TEST_DESKTOP_VERSION,
    });
    await rm(path.join(adapterBundleRoot(stateDir), "trusted-state.json"), { force: true });
    const legacyMetadata = await currentAdapterBundleMetadata(stateDir);
    delete legacyMetadata.manifest;
    delete legacyMetadata.fileSha256;
    await writeFile(path.join(adapterBundleRoot(stateDir), "current.json"), JSON.stringify(legacyMetadata), "utf8");

    const loaded = await loadHotAdapterModule({
      platform: "penguin",
      stateDir,
      publicKeyPem: keys.publicKeyPem,
    });

    assert.equal(loaded, null);
    assert.equal(await currentAdapterBundleMetadata(stateDir), null);
    assert.equal(await readFile(hotAdapterPath(stateDir, "penguin", "4.0.3"), "utf8"), manifest.files["adapters/penguin.mjs"]);
    await assert.rejects(() => readFile(path.join(adapterBundleRoot(stateDir), "trusted-state.json"), "utf8"));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("rejects an older signed bundle after a bad current adapter is cleared", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-replay-after-clear-"));
  try {
    const highestManifest = signedManifest(keys.privateKeyPem, {
      bundleVersion: "5.0.0",
      files: { "adapters/penguin.mjs": "export const version = '5.0.0';\n" },
    });
    await installAdapterBundle({
      manifest: highestManifest,
      stateDir,
      publicKeyPem: keys.publicKeyPem,
      desktopVersion: TEST_DESKTOP_VERSION,
    });
    await writeFile(hotAdapterPath(stateDir, "penguin", "5.0.0"), "export const version = 'tampered';\n", "utf8");
    assert.equal(await loadHotAdapterModule({
      platform: "penguin",
      stateDir,
      publicKeyPem: keys.publicKeyPem,
    }), null);
    assert.equal(await currentAdapterBundleMetadata(stateDir), null);

    const olderManifest = signedManifest(keys.privateKeyPem, {
      bundleVersion: "4.9.0",
      files: { "adapters/penguin.mjs": "export const version = '4.9.0';\n" },
    });
    await assert.rejects(
      () => installAdapterBundle({
        manifest: olderManifest,
        stateDir,
        publicKeyPem: keys.publicKeyPem,
        desktopVersion: TEST_DESKTOP_VERSION,
      }),
      /ADAPTER_BUNDLE_VERSION_NOT_NEWER/
    );

    const trustedState = JSON.parse(await readFile(path.join(adapterBundleRoot(stateDir), "trusted-state.json"), "utf8"));
    assert.equal(trustedState.highestBundleVersion, "5.0.0");
    assert.deepEqual(trustedState.manifest, highestManifest);
    assert.equal(await currentAdapterBundleMetadata(stateDir), null);

    const intentionalRollback = signedManifest(keys.privateKeyPem, {
      bundleVersion: "5.0.1",
      files: { "adapters/penguin.mjs": "export const version = '4.9.0-source';\n" },
    });
    await installAdapterBundle({
      manifest: intentionalRollback,
      stateDir,
      publicKeyPem: keys.publicKeyPem,
      desktopVersion: TEST_DESKTOP_VERSION,
    });
    const advancedTrustedState = JSON.parse(await readFile(path.join(adapterBundleRoot(stateDir), "trusted-state.json"), "utf8"));
    assert.equal(advancedTrustedState.highestBundleVersion, "5.0.1");
    assert.equal((await currentAdapterBundleMetadata(stateDir)).bundleVersion, "5.0.1");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("rejects a signed older bundle without replacing the current adapter", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-bundle-downgrade-"));
  try {
    const current = signedManifest(keys.privateKeyPem, {
      bundleVersion: "2.10.0",
      files: { "adapters/penguin.mjs": "export const version = '2.10.0';\n" },
    });
    await installAdapterBundle({ manifest: current, stateDir, publicKeyPem: keys.publicKeyPem, desktopVersion: TEST_DESKTOP_VERSION });

    const replayedOlder = signedManifest(keys.privateKeyPem, {
      bundleVersion: "2.9.0",
      files: { "adapters/penguin.mjs": "export const version = '2.9.0';\n" },
    });

    await assert.rejects(
      () => installAdapterBundle({ manifest: replayedOlder, stateDir, publicKeyPem: keys.publicKeyPem, desktopVersion: TEST_DESKTOP_VERSION }),
      /ADAPTER_BUNDLE_VERSION_NOT_NEWER/
    );
    assert.equal((await currentAdapterBundleMetadata(stateDir)).bundleVersion, "2.10.0");
    assert.equal(await readFile(hotAdapterPath(stateDir, "penguin", "2.10.0"), "utf8"), current.files["adapters/penguin.mjs"]);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("serializes concurrent installs and rejects the older bundle inside the lock", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-concurrent-install-"));
  try {
    const newestManifest = signedManifest(keys.privateKeyPem, {
      bundleVersion: "11.0.0",
      files: {
        "adapters/penguin.mjs": "await new Promise((resolve) => setTimeout(resolve, 80));\nexport const version = '11.0.0';\n",
      },
    });
    const olderManifest = signedManifest(keys.privateKeyPem, {
      bundleVersion: "10.0.0",
      files: { "adapters/penguin.mjs": "export const version = '10.0.0';\n" },
    });

    const newestInstall = installAdapterBundle({
      manifest: newestManifest,
      stateDir,
      publicKeyPem: keys.publicKeyPem,
      desktopVersion: TEST_DESKTOP_VERSION,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const olderInstall = installAdapterBundle({
      manifest: olderManifest,
      stateDir,
      publicKeyPem: keys.publicKeyPem,
      desktopVersion: TEST_DESKTOP_VERSION,
    });
    const [newestResult, olderResult] = await Promise.allSettled([newestInstall, olderInstall]);

    assert.equal(newestResult.status, "fulfilled");
    assert.equal(olderResult.status, "rejected");
    assert.match(olderResult.reason.message, /ADAPTER_BUNDLE_VERSION_NOT_NEWER/);
    assert.equal((await currentAdapterBundleMetadata(stateDir)).bundleVersion, "11.0.0");
    const trustedState = JSON.parse(await readFile(path.join(adapterBundleRoot(stateDir), "trusted-state.json"), "utf8"));
    assert.equal(trustedState.highestBundleVersion, "11.0.0");
    await assert.rejects(() => access(path.join(adapterBundleRoot(stateDir), "install.lock")));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("recovers an install lock left by a dead process", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-stale-lock-"));
  const lockDir = path.join(adapterBundleRoot(stateDir), "install.lock");
  try {
    await mkdir(lockDir, { recursive: true });
    await writeFile(path.join(lockDir, "owner.json"), JSON.stringify({
      pid: 2147483647,
      token: "dead-owner",
      createdAt: "2000-01-01T00:00:00.000Z",
    }), "utf8");
    const manifest = signedManifest(keys.privateKeyPem, { bundleVersion: "12.0.0" });

    const installed = await installAdapterBundle({
      manifest,
      stateDir,
      publicKeyPem: keys.publicKeyPem,
      desktopVersion: TEST_DESKTOP_VERSION,
    });

    assert.equal(installed.bundleVersion, "12.0.0");
    await assert.rejects(() => access(lockDir));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("does not steal an old install lock from a live process", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-live-lock-"));
  const lockDir = path.join(adapterBundleRoot(stateDir), "install.lock");
  try {
    await mkdir(lockDir, { recursive: true });
    await writeFile(path.join(lockDir, "owner.json"), JSON.stringify({
      pid: process.pid,
      token: "live-owner",
      createdAt: "2000-01-01T00:00:00.000Z",
    }), "utf8");
    const pending = installAdapterBundle({
      manifest: signedManifest(keys.privateKeyPem, { bundleVersion: "12.1.0" }),
      stateDir,
      publicKeyPem: keys.publicKeyPem,
      desktopVersion: TEST_DESKTOP_VERSION,
    });
    const earlyResult = await Promise.race([
      pending.then(() => "settled", () => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 100)),
    ]);

    assert.equal(earlyResult, "waiting");
    await rm(lockDir, { recursive: true, force: true });
    assert.equal((await pending).bundleVersion, "12.1.0");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("recovers an immutable version directory orphaned before current commit", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-orphan-version-"));
  try {
    const manifest = signedManifest(keys.privateKeyPem, {
      bundleVersion: "12.2.0",
      files: { "adapters/penguin.mjs": "export const version = '12.2.0';\n" },
    });
    await installAdapterBundle({
      manifest,
      stateDir,
      publicKeyPem: keys.publicKeyPem,
      desktopVersion: TEST_DESKTOP_VERSION,
    });
    await rm(path.join(adapterBundleRoot(stateDir), "current.json"), { force: true });
    await rm(path.join(adapterBundleRoot(stateDir), "trusted-state.json"), { force: true });

    const recovered = await installAdapterBundle({
      manifest,
      stateDir,
      publicKeyPem: keys.publicKeyPem,
      desktopVersion: TEST_DESKTOP_VERSION,
    });

    assert.equal(recovered.bundleVersion, "12.2.0");
    assert.equal((await currentAdapterBundleMetadata(stateDir)).bundleVersion, "12.2.0");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("rejects a bundle requiring a newer desktop version without installing it", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-desktop-version-"));
  try {
    const manifest = signedManifest(keys.privateKeyPem, {
      bundleVersion: "3.0.0",
      minDesktopVersion: "1.10.0",
    });

    await assert.rejects(
      () => installAdapterBundle({
        manifest,
        stateDir,
        publicKeyPem: keys.publicKeyPem,
        desktopVersion: "1.9.0",
      }),
      /ADAPTER_BUNDLE_DESKTOP_VERSION_TOO_OLD/
    );
    assert.equal(await currentAdapterBundleMetadata(stateDir), null);
    await assert.rejects(() => readFile(hotAdapterPath(stateDir, "penguin", "3.0.0"), "utf8"));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("install uses the desktop package version when desktopVersion is omitted", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-package-version-install-"));
  try {
    const manifest = signedManifest(keys.privateKeyPem, {
      bundleVersion: "3.1.0",
      minDesktopVersion: "0.0.0",
    });

    const installed = await installAdapterBundle({
      manifest,
      stateDir,
      publicKeyPem: keys.publicKeyPem,
    });

    assert.equal(installed.bundleVersion, "3.1.0");
    assert.equal((await currentAdapterBundleMetadata(stateDir)).bundleVersion, "3.1.0");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("refresh uses the desktop package version when desktopVersion is omitted", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-package-version-refresh-"));
  const manifest = signedManifest(keys.privateKeyPem, {
    bundleVersion: "3.1.1",
    minDesktopVersion: "0.0.0",
  });
  const server = createServer((request, response) => {
    if (request.url === "/downloads/adapter-bundles/adapter-version.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(manifest));
      return;
    }
    response.writeHead(404).end();
  });

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const result = await refreshAdapterBundleIfAvailable({
      apiBaseUrl: `http://127.0.0.1:${server.address().port}`,
      stateDir,
      publicKeyPem: keys.publicKeyPem,
    });

    assert.equal(result.status, "installed");
    assert.equal(result.metadata.bundleVersion, "3.1.1");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("explicit desktopVersion overrides the desktop package version", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-explicit-version-"));
  try {
    const manifest = signedManifest(keys.privateKeyPem, {
      bundleVersion: "3.1.2",
      minDesktopVersion: "999.0.0",
    });

    const installed = await installAdapterBundle({
      manifest,
      stateDir,
      publicKeyPem: keys.publicKeyPem,
      desktopVersion: "999.0.0",
    });

    assert.equal(installed.bundleVersion, "3.1.2");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("does not switch current bundle when smoke import fails", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-bundle-bad-"));
  try {
    const good = signedManifest(keys.privateKeyPem, {
      bundleVersion: "2026.07.29.good",
      files: { "adapters/penguin.mjs": "export class PenguinAdapter { constructor(){ this.platform = 'penguin-good'; } }\n" },
    });
    await installAdapterBundle({ manifest: good, stateDir, publicKeyPem: keys.publicKeyPem, desktopVersion: TEST_DESKTOP_VERSION });

    const bad = signedManifest(keys.privateKeyPem, {
      bundleVersion: "2026.07.30.bad",
      files: { "adapters/penguin.mjs": "throw new Error('boom');\nexport class PenguinAdapter {}\n" },
    });

    await assert.rejects(() => installAdapterBundle({ manifest: bad, stateDir, publicKeyPem: keys.publicKeyPem, desktopVersion: TEST_DESKTOP_VERSION }), /ADAPTER_BUNDLE_SMOKE_IMPORT_FAILED/);
    assert.equal((await currentAdapterBundleMetadata(stateDir)).bundleVersion, "2026.07.29.good");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("rolls back the active adapter bundle to bundled fallback", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-bundle-rollback-"));
  try {
    const manifest = signedManifest(keys.privateKeyPem);
    await installAdapterBundle({ manifest, stateDir, publicKeyPem: keys.publicKeyPem, desktopVersion: TEST_DESKTOP_VERSION });

    const rollback = await rollbackAdapterBundle({ stateDir, reason: "import failed" });

    assert.equal(rollback.status, "rolled_back");
    assert.equal(rollback.previous.bundleVersion, "2026.07.29.1");
    assert.equal(await currentAdapterBundleMetadata(stateDir), null);
    assert.equal(await readFile(hotAdapterPath(stateDir, "penguin", "2026.07.29.1"), "utf8"), manifest.files["adapters/penguin.mjs"]);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
