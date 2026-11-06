import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  refreshCredentialFromWorkspace,
  resolveProfileDir,
  resolveProfileKey,
  seedPersistentContext,
  summarizeCredentialExpiry,
  withProfileLock
} from "../src/session-manager.mjs";

test("profile identity prefers the bound profile key over transient authorization fields", () => {
  assert.equal(resolveProfileKey({
    profileKey: "media-auth-session-stable",
    mediaAccountId: "media-account-1",
    sessionId: "media-auth-session-new",
    accountName: "Account Name"
  }), "media-auth-session-stable");

  assert.equal(resolveProfileKey({ mediaAccountId: "media-account-1" }), "media-account-1");
  assert.equal(resolveProfileKey({ sessionId: "media/auth/session/1" }), "media-auth-session-1");
  assert.equal(resolveProfileKey({ accountName: "Account Name" }), "Account-Name");
  assert.equal(resolveProfileKey({}), "default");

  assert.equal(
    resolveProfileDir("C:/profiles", "netease", { profileKey: "stable-profile" }),
    path.join("C:/profiles", "netease", "stable-profile")
  );
});

test("credential expiry summary uses strong credentials and preserves session-cookie semantics", () => {
  const summary = summarizeCredentialExpiry([
    { name: "tracking", expires: 1893456000 },
    { name: "S_INFO", expires: -1 },
    { name: "NTES_SESS", expires: 1783814400 },
    { name: "NTES_PASSPORT", expires: 1786406400 }
  ], ["S_INFO", "NTES_SESS", "NTES_PASSPORT"]);

  assert.equal(summary.strongCookieCount, 3);
  assert.equal(summary.sessionCookieCount, 1);
  assert.equal(summary.persistentCookieCount, 2);
  assert.equal(summary.hasSessionCredentials, true);
  assert.equal(summary.credentialExpiresAt, "2026-07-12T00:00:00.000Z");
});

test("persistent context bootstrap merges cookies and web storage before navigation", async () => {
  const calls = [];
  const context = {
    async addCookies(cookies) {
      calls.push({ type: "cookies", cookies });
    },
    async addInitScript(callback, payload) {
      calls.push({ type: "storage", callback, payload });
    }
  };

  await seedPersistentContext(context, {
    cookies: [{ name: "token", value: "secret", domain: ".example.com", path: "/" }],
    localStorage: { accessToken: "local-token" },
    sessionStorage: { csrf: "csrf-token" },
    origins: ["https://creator.example.com"]
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].cookies[0].name, "token");
  assert.deepEqual(calls[1].payload, {
    localStorageValues: { accessToken: "local-token" },
    sessionStorageValues: { csrf: "csrf-token" },
    origins: ["https://creator.example.com"]
  });
});

test("profile lock serializes concurrent work for one media account", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zhixin-session-lock-"));
  const events = [];
  try {
    const first = withProfileLock({
      profileRoot: root,
      platform: "netease",
      profileKey: "media-account-1",
      retryMs: 5,
      timeoutMs: 1000
    }, async () => {
      events.push("first:start");
      await new Promise((resolve) => setTimeout(resolve, 40));
      events.push("first:end");
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = withProfileLock({
      profileRoot: root,
      platform: "netease",
      profileKey: "media-account-1",
      retryMs: 5,
      timeoutMs: 1000
    }, async () => {
      events.push("second:start");
      events.push("second:end");
    });

    await Promise.all([first, second]);
    assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile lock recovers immediately when the owning process no longer exists", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zhixin-session-abandoned-lock-"));
  const lockPath = path.join(root, ".locks", "netease-media-account-1.lock");
  try {
    await mkdir(lockPath, { recursive: true });
    await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: 2147483647,
      acquiredAt: new Date().toISOString()
    }), "utf8");

    let executed = false;
    await withProfileLock({
      profileRoot: root,
      platform: "netease",
      profileKey: "media-account-1",
      retryMs: 5,
      timeoutMs: 100
    }, async () => {
      executed = true;
    });

    assert.equal(executed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("credential refresh falls back to a live workspace page after publish navigation", async () => {
  const calls = [];
  const fallbackPage = {
    goto: async (url) => calls.push(["goto", url]),
    waitForLoadState: async () => {},
    close: async () => calls.push(["close"])
  };
  const context = { newPage: async () => fallbackPage };
  const publicPage = { url: () => "https://example.com/public/article" };

  const artifact = await refreshCredentialFromWorkspace({
    context,
    page: publicPage,
    validationUrl: "https://example.com/creator",
    report: async (_context, page) => {
      if (page === publicPage) throw new Error("WORKSPACE_REQUIRED");
      return { fingerprint: "refreshed" };
    }
  });

  assert.deepEqual(artifact, { fingerprint: "refreshed" });
  assert.deepEqual(calls, [
    ["goto", "https://example.com/creator"],
    ["close"]
  ]);
});

test("credential refresh never masks an operation when workspace validation fails", async () => {
  const errors = [];
  const context = {
    newPage: async () => ({
      goto: async () => {},
      close: async () => {}
    })
  };

  const artifact = await refreshCredentialFromWorkspace({
    context,
    page: {},
    validationUrl: "https://example.com/creator",
    report: async () => { throw new Error("LOGIN_REQUIRED"); },
    onError: (error) => errors.push(error.message)
  });

  assert.equal(artifact, null);
  assert.deepEqual(errors, ["LOGIN_REQUIRED"]);
});

test("credential refresh times out instead of blocking a completed publication", async () => {
  const errors = [];
  const startedAt = Date.now();

  const artifact = await refreshCredentialFromWorkspace({
    context: {},
    page: {},
    timeoutMs: 20,
    report: async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { fingerprint: "too-late" };
    },
    onError: (error) => errors.push(error.message)
  });

  assert.equal(artifact, null);
  assert.ok(Date.now() - startedAt < 80);
  assert.deepEqual(errors, ["CREDENTIAL_REFRESH_TIMEOUT"]);
});
