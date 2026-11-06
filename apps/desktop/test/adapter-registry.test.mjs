import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { MediaPlatformAdapter } from "../src/adapters/base.mjs";
import { adapters, getAdapter } from "../src/adapters/index.mjs";
import { adapterBundleRoot, currentAdapterBundleMetadata, installAdapterBundle, hotAdapterPath } from "../src/adapter-update-manager.mjs";

const NOT_IMPLEMENTED = { code: "PLATFORM_ADAPTER_NOT_IMPLEMENTED" };

function canonicalManifest(manifest) {
  function sortValue(value) {
    if (Array.isArray(value)) return value.map(sortValue);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  const { signature: _signature, ...unsigned } = manifest;
  return JSON.stringify(sortValue(unsigned));
}

function keyPair() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }),
  };
}

function signedManifest(privateKeyPem, source) {
  const manifest = {
    schemaVersion: 1,
    bundleVersion: `registry-${Date.now()}`,
    files: { "adapters/penguin.mjs": source },
  };
  manifest.signature = sign(null, Buffer.from(canonicalManifest(manifest)), privateKeyPem).toString("base64");
  return manifest;
}

test("base adapter fails closed for login detection and credential collection", async () => {
  const adapter = new MediaPlatformAdapter("wechat", "https://mp.weixin.qq.com/", [], "WeChat");

  await assert.rejects(() => adapter.detectLoggedIn(), NOT_IMPLEMENTED);
  await assert.rejects(() => adapter.readAccountProfile(), NOT_IMPLEMENTED);
  await assert.rejects(() => adapter.collectAuthArtifact(), NOT_IMPLEMENTED);
});

test("base adapter cannot fabricate a publication result", async () => {
  const adapter = new MediaPlatformAdapter("wechat", "https://mp.weixin.qq.com/", [], "WeChat");

  await assert.rejects(() => adapter.publishArticle({ title: "Never fabricate" }), NOT_IMPLEMENTED);
});

test("adapter registry rejects empty and unknown platform keys", () => {
  assert.throws(() => getAdapter(""), NOT_IMPLEMENTED);
  assert.throws(() => getAdapter("unknown-platform"), NOT_IMPLEMENTED);
  assert.equal("other" in adapters, false);
});

test("wechat remains explicit but unsupported", async () => {
  const adapter = getAdapter("wechat");

  assert.equal(adapter.platform, "wechat");
  await assert.rejects(() => adapter.publishArticle({ title: "Unsupported" }), NOT_IMPLEMENTED);
});

test("adapter registry prefers a signed hot adapter when state path is provided", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-registry-"));
  try {
    await installAdapterBundle({
      stateDir,
      publicKeyPem: keys.publicKeyPem,
      manifest: signedManifest(keys.privateKeyPem, "export class PenguinAdapter { constructor(){ this.platform = 'penguin-hot-registry'; } }\n"),
    });

    const adapter = await getAdapter("penguin", {
      statePath: path.join(stateDir, "desktop-agent.json"),
      publicKeyPem: keys.publicKeyPem,
    });

    assert.equal(adapter.platform, "penguin-hot-registry");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("adapter registry reports only the signed manifest bundle version", async () => {
  const keys = keyPair();
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-registry-version-"));
  try {
    const manifest = signedManifest(
      keys.privateKeyPem,
      "export class PenguinAdapter { constructor(){ this.platform = 'penguin-hot-version'; } }\n",
    );
    await installAdapterBundle({
      stateDir,
      publicKeyPem: keys.publicKeyPem,
      manifest,
    });
    const metadata = await currentAdapterBundleMetadata(stateDir);
    metadata.platforms.penguin = "forged-audit-version";
    await writeFile(path.join(adapterBundleRoot(stateDir), "current.json"), JSON.stringify(metadata), "utf8");

    const adapter = await getAdapter("penguin", {
      statePath: path.join(stateDir, "desktop-agent.json"),
      publicKeyPem: keys.publicKeyPem,
    });

    assert.equal(adapter.platform, "penguin-hot-version");
    assert.equal(adapter.adapterBundleVersion, manifest.bundleVersion);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("adapter registry falls back to bundled adapter when the hot adapter import fails", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-registry-bad-"));
  try {
    const root = adapterBundleRoot(stateDir);
    await mkdir(path.dirname(hotAdapterPath(stateDir, "penguin")), { recursive: true });
    await writeFile(hotAdapterPath(stateDir, "penguin"), "throw new Error('broken hot adapter');\nexport class PenguinAdapter {}\n", "utf8");
    await writeFile(path.join(root, "current.json"), JSON.stringify({ bundleVersion: "bad-hot", platforms: { penguin: "bad-hot" } }), "utf8");

    const adapter = await getAdapter("penguin", { stateDir });

    assert.equal(adapter, adapters.penguin);
    assert.equal(await currentAdapterBundleMetadata(stateDir), null);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("adapter registry still rejects unknown platform keys with hot adapter options", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "zhixin-adapter-registry-unknown-"));
  try {
    await assert.rejects(() => getAdapter("unknown-platform", { stateDir }), NOT_IMPLEMENTED);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
