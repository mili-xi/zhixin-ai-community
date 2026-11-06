import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, beforeEach, test } from "node:test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import {
  acquireWatchLock,
  authorizePlatform,
  bindOwner,
  cleanupLocalAssets,
  ensureRegistered,
  fetchAssetCleanupKeepKeys,
  findQueuedCommand,
  heartbeat,
  parseWatchLock,
  profileRoot,
  readState,
  readStatus,
  recoverVideoCallbacks,
  runAuth,
  runOnce,
  sanitizeCommandFailure,
  touchWatchLock,
  watch,
  watchIteration,
  watchLockIsCurrent,
  writeState
} from "../src/agent-core.mjs";
import { commandFailureDetail } from "../src/agent-core.mjs";

const execFileAsync = promisify(execFile);

test("sanitizes SDK failures before desktop command writeback", () => {
  assert.equal(
    sanitizeCommandFailure(new Error("request failed\nCookie: session=private-value")),
    "DESKTOP_COMMAND_EXECUTION_FAILED"
  );
  assert.equal(
    sanitizeCommandFailure(new Error("BAIJIAHAO_API_DRAFT_CREATE_NOT_ACCEPTED_HTTP_200_CODE_10000013")),
    "BAIJIAHAO_API_DRAFT_CREATE_NOT_ACCEPTED_HTTP_200_CODE_10000013"
  );
});

test("commandFailureDetail keeps the raw cause beside the sanitized failure code", () => {
  const error = new Error("DRAFT_IMAGE_MISSING");
  error.stack = "DRAFT_IMAGE_MISSING\n    at waitForToutiaoEditorImages (toutiao.mjs:110:9)";
  const detail = commandFailureDetail(error);

  assert.equal(sanitizeCommandFailure(error), "DESKTOP_COMMAND_EXECUTION_FAILED");
  assert.equal(detail.errorDetail, "DRAFT_IMAGE_MISSING");
  assert.match(detail.errorStack, /waitForToutiaoEditorImages/);
});

test("commandFailureDetail truncates an oversized message and stack", () => {
  const error = new Error("X".repeat(5000));
  error.stack = "S".repeat(5000);
  const detail = commandFailureDetail(error);

  assert.equal(detail.errorDetail.length, 2000);
  assert.equal(detail.errorStack.length, 2000);
});

test("commandFailureDetail tolerates a thrown non-error value", () => {
  assert.deepEqual(commandFailureDetail("DRAFT_IMAGE_MISSING"), {
    errorDetail: "DRAFT_IMAGE_MISSING",
    errorStack: ""
  });
});

const fakeZhihuAdapter = {
  platform: "zhihu",
  loginUrl: "https://www.zhihu.com/signin",
  async detectLoggedIn() {
    return true;
  },
  async readAccountProfile(input = {}) {
    return { accountName: input.accountName || "知乎账号", avatar: "" };
  },
  async collectAuthArtifact() {
    return {
      cookies: "encrypted-cookie-test",
      localStorage: "encrypted-local-storage-test",
      sessionStorage: "encrypted-session-storage-test",
      fingerprint: "fp-zhihu-test",
      storageVersion: 2,
      capturedAt: "2026-07-04T00:00:00.000Z"
    };
  },
  async publishArticle(input = {}) {
    publishInputs.push(input);
    await input.onCredentialRefresh?.({
      cookies: "encrypted-cookie-refreshed",
      localStorage: "encrypted-local-storage-refreshed",
      sessionStorage: "encrypted-session-storage-refreshed",
      fingerprint: "fp-zhihu-refreshed",
      storageVersion: 2,
      credentialMetadata: {
        credentialExpiresAt: "2026-12-31T00:00:00.000Z",
        strongCookieCount: 1
      },
      authorizationEvidence: {
        strongCookiePresent: true,
        workspaceReady: true,
        currentUrl: "https://www.zhihu.com/creator",
        pageTitle: "Zhihu creator center"
      }
    });
    const title = input.articleTitle || input.title || "桌面端发布测试";
    return {
      publishedUrl: `https://zhihu.desktop-media.example.com/articles/${encodeURIComponent(title)}`,
      platformStatus: "published",
      title,
      imagePublicationEvidence: {
        status: "verified",
        expectedCount: input.platformImageTasks?.length || 0,
      },
    };
  }
};

const fakeProgressAdapter = {
  ...fakeZhihuAdapter,
  async publishArticle(input = {}) {
    await input.onProgress?.({
      type: "uploading_images",
      platform: "baijiahao",
      completed: 1,
      total: 1,
    });
    await input.onProgress?.({
      type: "manual_verification_required",
      platform: "baijiahao",
      message: "请在弹出的百家号窗口完成百度安全验证，验证通过后会继续发布。",
      currentUrl: "https://baijiahao.baidu.com/builder/rc/edit?type=news"
    });
    return { publishedUrl: "https://baijiahao.baidu.com/s?id=123", platformStatus: "published", title: input.articleTitle };
  }
};

const fakeDiscoveryAdapter = {
  ...fakeZhihuAdapter,
  platform: "netease",
  async discoverPublication(input = {}) {
    discoveryInputs.push(input);
    return {
      found: true,
      publicUrl: "https://www.163.com/dy/article/DISCOVERED001.html",
      publishedUrl: "https://www.163.com/dy/article/DISCOVERED001.html",
      platformStatus: "published",
      publiclyVisible: true,
      reviewStatus: "public",
      title: input.articleTitle
    };
  }
};

const fakeValidationAdapter = {
  ...fakeZhihuAdapter,
  async validateSession(input = {}) {
    validationInputs.push(input);
    await input.onCredentialRefresh?.({
      cookies: "encrypted-cookie-validated",
      localStorage: "encrypted-local-storage-validated",
      sessionStorage: "encrypted-session-storage-validated",
      fingerprint: "fp-zhihu-validated",
      storageVersion: 2,
      credentialMetadata: { strongCookieCount: 1, hasSessionCredentials: true },
      authorizationEvidence: {
        strongCookiePresent: true,
        workspaceReady: true,
        currentUrl: "https://www.zhihu.com/creator",
        pageTitle: "Zhihu creator center"
      }
    });
    return { valid: true, platform: "zhihu", currentUrl: "https://www.zhihu.com/creator" };
  }
};

const calls = [];
const publishInputs = [];
const discoveryInputs = [];
const validationInputs = [];
const records = {};

function resetRecords() {
  calls.length = 0;
  publishInputs.length = 0;
  discoveryInputs.length = 0;
  validationInputs.length = 0;
  records.device = null;
  records.deviceToken = "token-demo";
  records.session = {
    id: "media-auth-session-1",
    platform: "zhihu",
    pairingCode: "123456",
    status: "waiting_desktop",
    loginUrl: "https://www.zhihu.com/signin",
    artifactId: "media-auth-artifact-1"
  };
  records.artifact = {
    id: "media-auth-artifact-1",
    encryptedCookies: `encrypted-cookie-${Buffer.from(JSON.stringify({
      platform: "zhihu",
      cookies: [{ name: "z_c0", value: "cookie-token", domain: ".zhihu.com", path: "/" }]
    })).toString("base64url")}`,
    encryptedLocalStorage: `encrypted-local-storage-${Buffer.from(JSON.stringify({
      platform: "zhihu",
      values: { creatorAccountId: "local-account-1" }
    })).toString("base64url")}`,
    encryptedSessionStorage: `encrypted-session-storage-${Buffer.from(JSON.stringify({
      platform: "zhihu",
      values: { editorDraftKey: "session-draft-1" }
    })).toString("base64url")}`,
    fingerprint: "fp-zhihu-test"
  };
  records.account = {
    id: "media-account-1",
    platform: "zhihu",
    name: "知乎账号",
    status: "active",
    authArtifactId: "media-auth-artifact-1",
    profileKey: "media-auth-session-1",
    platformConfig: {
      platform: "zhihu",
      accountId: "creator-account-1",
      publishBaseUrl: "https://www.zhihu.com/creator"
    },
    capabilities: {
      canPublishArticle: true,
      canUploadImages: true
    }
  };
  records.command = {
    id: "desktop-command-1",
    deviceId: "",
    type: "publish_article",
    mediaAccountId: "media-account-1",
    status: "queued",
    payload: {
      articleTitle: "桌面端发布测试",
      platform: "zhihu",
      sessionId: "media-auth-session-1",
      authArtifactId: "media-auth-artifact-1",
      coverImagePath: "/app/uploads/cover.png",
      coverImageUrl: "/uploads/assets/cover.png",
      inlineImages: [{ assetId: "asset-inline", sectionId: "workflow", path: "/app/uploads/workflow.png", url: "/uploads/assets/workflow.png", altText: "流程图" }],
      contentBlocks: [
        { type: "title", text: "桌面端发布测试" },
        { type: "section", sectionId: "workflow", title: "实施流程", content: "第一段\n\n第二段" },
        { type: "image", assetId: "asset-inline", sectionId: "workflow", url: "/uploads/assets/workflow.png", altText: "流程图" },
      ]
    },
    result: {}
  };
  records.commands = null;
  records.failCommandList = false;
  records.failHeartbeat = false;
  records.hangAuthFailure = false;
  records.assetCleanupKeepKeys = ["media-auth-session-1"];
  records.failAssetCleanupKeepKeys = false;
  records.failCleanupSucceeded = false;
  // The command list is a snapshot, so a command can reach a terminal status
  // between the pick and the execution. These knobs let a test reproduce that
  // gap: one changes what a later list read sees, the other makes it fail, and
  // the third rejects a specific event write the way the real endpoint does.
  records.terminalStatusFromListCall = "";
  records.failCommandListFromCall = 0;
  records.terminalEventTypes = null;
  // The two knobs above count list reads, so the counter has to start from zero
  // for each test or "from the second call" would fire on the first read of the
  // next test and make the picker itself see a terminal command.
  records.commandListCalls = 0;
  records.assetCleanupKeepKeys = ["media-auth-session-1"];
  records.failAssetCleanupKeepKeys = false;
  records.failCleanupSucceeded = false;
}

function json(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const bodyText = Buffer.concat(chunks).toString("utf8");
  const body = bodyText ? JSON.parse(bodyText) : {};
  calls.push({ method: request.method, url: request.url, body, headers: { ...request.headers } });

  if (request.method === "POST" && request.url === "/api/desktop-devices/register") {
    records.device = {
      id: "desktop-device-1",
      deviceName: body.deviceName,
      platform: body.platform,
      appVersion: body.appVersion,
      status: "active"
    };
    return json(response, 200, { device: records.device, deviceToken: records.deviceToken });
  }

  const ownerBindingMatch = request.url.match(/^\/api\/desktop-devices\/([^/]+)\/owner-bindings\/([^/]+)\/claim$/);
  if (request.method === "POST" && ownerBindingMatch) {
    if (
      ownerBindingMatch[1] !== records.device?.id
      || ownerBindingMatch[2] !== "desktop-owner-binding-1"
      || request.headers["x-device-id"] !== records.device?.id
      || request.headers["x-device-token"] !== records.deviceToken
    ) {
      return json(response, 403, { detail: "DESKTOP_DEVICE_AUTH_REQUIRED" });
    }
    if (body.pairingCode !== "654321") return json(response, 400, { detail: "PAIRING_CODE_INVALID" });
    records.device = { ...records.device, boundOwnerId: "member-a", ownerBoundAt: "2026-07-24T00:00:00Z" };
    return json(response, 200, {
      device: records.device,
      binding: { id: "desktop-owner-binding-1", deviceId: records.device.id, status: "claimed" }
    });
  }

  const verifyMatch = request.url.match(/^\/api\/desktop-devices\/([^/]+)\/verify$/);
  if (request.method === "POST" && verifyMatch) {
    if (verifyMatch[1] !== records.device?.id || body.deviceToken !== records.deviceToken) {
      return json(response, 403, { detail: "DESKTOP_DEVICE_AUTH_REQUIRED" });
    }
    return json(response, 200, { device: records.device });
  }

  if (request.method === "POST" && request.url === "/api/desktop-events") {
    if (records.hangAuthFailure && body.type === "auth_failed") return;
    if (records.failHeartbeat) {
      return json(response, 500, { detail: "HEARTBEAT_UNAVAILABLE" });
    }
    if (body.type === "heartbeat" && records.device) records.device.lastSeenAt = "now";
    return json(response, 200, { event: { id: `event-${calls.length}`, ...body }, session: records.session });
  }

  if (request.method === "POST" && request.url === "/api/media-auth-sessions") {
    records.session = {
      ...records.session,
      platform: body.platform || records.session.platform,
      mediaAccountId: body.mediaAccountId || "",
      deviceId: body.deviceId || "",
      status: "waiting_desktop"
    };
    return json(response, 200, { session: records.session, desktopLaunchUrl: `zhixin-ai://media-auth/${records.session.id}` });
  }

  if (request.method === "POST" && request.url === "/api/desktop-devices/desktop-device-1/media-auth-sessions/media-auth-session-1/claim") {
    records.session = { ...records.session, deviceId: "desktop-device-1", status: "desktop_ready" };
    return json(response, 200, { device: records.device, session: records.session });
  }

  if (request.method === "POST" && request.url === "/api/media-auth-sessions/media-auth-session-1/artifacts") {
    records.session = { ...records.session, status: "verified", artifactId: "media-auth-artifact-1", accountName: body.accountName };
    return json(response, 200, { session: records.session, artifact: { id: "media-auth-artifact-1", fingerprint: body.artifact.fingerprint } });
  }

  if (request.method === "POST" && request.url === "/api/media-auth-sessions/media-auth-session-1/bind") {
    records.session = { ...records.session, status: "bound", mediaAccountId: records.account.id };
    return json(response, 200, { session: records.session, mediaAccount: { ...records.account, name: body.name || records.account.name } });
  }

  if (request.method === "GET" && request.url === "/api/desktop-commands") {
    if (request.headers["x-device-id"] !== records.device?.id || request.headers["x-device-token"] !== records.deviceToken) {
      return json(response, 403, { detail: "DESKTOP_DEVICE_AUTH_REQUIRED" });
    }
    if (records.failCommandList) {
      return json(response, 500, { detail: "COMMAND_LIST_UNAVAILABLE" });
    }
    records.commandListCalls = (records.commandListCalls || 0) + 1;
    if (records.failCommandListFromCall && records.commandListCalls >= records.failCommandListFromCall) {
      return json(response, 500, { detail: "COMMAND_LIST_UNAVAILABLE" });
    }
    const listed = records.commands || [records.command];
    if (records.terminalStatusFromListCall && records.commandListCalls >= records.terminalStatusFromListCall) {
      return json(response, 200, listed.map((item) => ({ ...item, status: records.terminalStatusFromListCall })));
    }
    return json(response, 200, records.commands || [records.command]);
  }

  if (request.method === "GET" && request.url === "/uploads/assets/cover.png") {
    response.writeHead(200, { "content-type": "image/png" });
    return response.end(Buffer.from("cover-image"));
  }

  if (request.method === "GET" && request.url === "/api/video-assets/video-asset-test/content?commandId=desktop-command-1") {
    if (request.headers["x-device-token"] !== records.deviceToken) return json(response, 403, {});
    response.writeHead(200, { "content-type": "video/mp4" });
    return response.end(Buffer.from("video-test"));
  }

  if (request.method === "GET" && request.url === "/uploads/assets/workflow.png") {
    response.writeHead(200, { "content-type": "image/png" });
    return response.end(Buffer.from("workflow-image"));
  }

  if (request.method === "GET" && request.url === "/api/media-accounts/media-account-1") {
    return json(response, 200, records.account);
  }

  const keepKeysMatch = request.url.match(/^\/api\/desktop-devices\/([^/]+)\/asset-cleanup-keep-keys$/);
  if (request.method === "GET" && keepKeysMatch) {
    if (keepKeysMatch[1] !== records.device?.id || request.headers["x-device-token"] !== records.deviceToken) {
      return json(response, 403, { detail: "DESKTOP_DEVICE_AUTH_REQUIRED" });
    }
    if (records.failAssetCleanupKeepKeys) {
      return json(response, 500, { detail: "KEEP_KEYS_UNAVAILABLE" });
    }
    return json(response, 200, { keepProfileKeys: records.assetCleanupKeepKeys });
  }

  if (request.method === "POST" && request.url === "/api/desktop-devices/desktop-device-1/media-accounts/media-account-1/artifact") {
    if (body.deviceToken !== records.deviceToken) return json(response, 403, { detail: "DESKTOP_DEVICE_AUTH_REQUIRED" });
    return json(response, 200, {
      mediaAccountId: records.account.id,
      profileKey: records.account.profileKey,
      artifact: records.artifact
    });
  }

  if (request.method === "POST" && request.url === "/api/desktop-devices/desktop-device-1/media-accounts/media-account-1/artifacts/refresh") {
    if (body.deviceToken !== records.deviceToken) return json(response, 403, { detail: "DESKTOP_DEVICE_AUTH_REQUIRED" });
    records.account = {
      ...records.account,
      authArtifactId: "media-auth-artifact-2",
      credentialFingerprint: body.artifact.fingerprint,
      profileKey: body.profileKey
    };
    return json(response, 200, {
      artifact: { id: "media-auth-artifact-2", fingerprint: body.artifact.fingerprint },
      mediaAccount: records.account,
      supersededArtifactId: "media-auth-artifact-1"
    });
  }

  if (request.method === "GET" && request.url === "/api/media-auth-sessions/media-auth-session-1") {
    return json(response, 200, { session: records.session, artifact: records.artifact, events: [] });
  }

  if (request.method === "POST" && request.url === "/api/desktop-commands/desktop-command-1/events") {
    if (body.deviceToken !== records.deviceToken) return json(response, 403, { detail: "DESKTOP_DEVICE_AUTH_REQUIRED" });
    if (body.type === "cleanup_succeeded" && records.failCleanupSucceeded) {
      return json(response, 500, { detail: "CLEANUP_WRITEBACK_UNAVAILABLE" });
    }
    if (records.terminalEventTypes?.includes(body.type)) {
      return json(response, 409, { detail: "DESKTOP_COMMAND_ALREADY_TERMINAL" });
    }
    if (["accepted", "running", "publish_started"].includes(body.type)) records.command = { ...records.command, status: "running" };
    if (body.type === "manual_verification_required") records.command = {
      ...records.command,
      status: "running",
      result: { ...records.command.result, ...body.payload, platformStatus: "manual_verification_required" }
    };
    if (["publish_succeeded", "auth_succeeded", "publication_discovery_succeeded", "session_validation_succeeded", "cleanup_succeeded"].includes(body.type)) records.command = { ...records.command, status: "succeeded", result: body.payload };
    if (["publish_failed", "auth_failed", "publication_discovery_failed", "session_validation_failed", "cleanup_failed"].includes(body.type)) records.command = { ...records.command, status: "failed", errorMessage: body.payload?.errorMessage || "failed" };
    return json(response, 200, { command: records.command, event: { id: `event-${calls.length}`, ...body } });
  }

  return json(response, 404, { detail: `Unhandled ${request.method} ${request.url}` });
});

let apiBaseUrl;
let statePath;
let stateRoot;

beforeEach(async () => {
  resetRecords();
  stateRoot = await mkdtemp(path.join(tmpdir(), "zhixin-desktop-test-"));
  statePath = path.join(stateRoot, "desktop-agent.json");
});

afterEach(async () => {
  if (stateRoot) await rm(stateRoot, { recursive: true, force: true });
  stateRoot = undefined;
  statePath = undefined;
});

after(async () => {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
});

async function ensureServer() {
  if (!server.listening) {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    apiBaseUrl = `http://127.0.0.1:${server.address().port}`;
  }
}

test("registers a clean Chinese desktop device and stores connection status", async () => {
  await ensureServer();
  const state = await ensureRegistered({ apiBaseUrl, statePath });
  const status = await readStatus({ apiBaseUrl, statePath });

  assert.equal(state.device.deviceName, "智心AI桌面授权端");
  assert.equal(status.registered, true);
  assert.equal(status.device.id, "desktop-device-1");
});

test("re-registers when the cached desktop device was removed from the backend", async () => {
  await ensureServer();
  await writeFile(statePath, JSON.stringify({
    apiBaseUrl,
    device: { id: "desktop-device-stale", deviceName: "stale", status: "active" },
    deviceToken: "stale-token"
  }), "utf8");

  const state = await ensureRegistered({ apiBaseUrl, statePath });

  assert.equal(state.device.id, "desktop-device-1");
  assert.equal(state.deviceToken, "token-demo");
  assert.ok(calls.some((call) => call.method === "POST" && call.url === "/api/desktop-devices/desktop-device-stale/verify"));
  assert.ok(calls.some((call) => call.method === "POST" && call.url === "/api/desktop-devices/register"));
});

test("auth flow claims a session, reports browser/login/capture events, and binds account", async () => {
  await ensureServer();
  const result = await runAuth({
    apiBaseUrl,
    statePath,
    sessionId: records.session.id,
    pairingCode: records.session.pairingCode,
    accountName: "知乎增长号",
    platform: "zhihu",
    adapter: fakeZhihuAdapter
  });

  const eventTypes = calls
    .filter((call) => call.method === "POST" && call.url === "/api/desktop-events")
    .map((call) => call.body.type);

  assert.deepEqual(eventTypes.slice(-3), ["browser_opened", "login_detected", "capture_started"]);
  assert.equal(result.session.status, "bound");
  assert.equal(result.mediaAccount.name, "知乎增长号");
});

for (const failureStage of ["detectLoggedIn", "readAccountProfile", "collectAuthArtifact"]) {
  test(`foreground auth reports ${failureStage} failure and closes its browser`, async () => {
    await ensureServer();
    let closed = false;
    const failure = new Error("AUTH_ADAPTER_FAILED");
    const adapter = {
      ...fakeZhihuAdapter,
      context: { async close() { closed = true; } },
      page: {},
      async [failureStage]() { throw failure; }
    };
    await assert.rejects(runAuth({
      apiBaseUrl, statePath, adapter,
      sessionId: records.session.id, pairingCode: records.session.pairingCode
    }), (error) => error === failure);
    const failed = calls.filter((call) => call.url === "/api/desktop-events" && call.body.type === "auth_failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].body.sessionId, records.session.id);
    assert.equal(failed[0].body.payload.errorMessage, "AUTH_ADAPTER_FAILED");
    assert.equal(closed, true);
    assert.equal(adapter.context, null);
    assert.equal(adapter.page, null);
    assert.equal(calls.some((call) => call.url.endsWith("/bind")), false);
  });
}

test("foreground auth reports a login timeout even if failure reporting is unavailable", async () => {
  await ensureServer();
  const adapter = { ...fakeZhihuAdapter, async detectLoggedIn() {
    records.failHeartbeat = true;
    return false;
  } };
  await assert.rejects(runAuth({
    apiBaseUrl, statePath, adapter,
    sessionId: records.session.id, pairingCode: records.session.pairingCode
  }), /LOGIN_NOT_DETECTED/);
  assert.equal(calls.some((call) => call.url === "/api/desktop-events" && call.body.type === "auth_failed"), true);
});

test("foreground auth bounds a stalled failure callback and still closes the browser", { timeout: 8000 }, async () => {
  await ensureServer();
  let closed = false;
  const adapter = { ...fakeZhihuAdapter,
    context: { async close() { closed = true; } },
    async detectLoggedIn() { records.hangAuthFailure = true; return false; }
  };
  await assert.rejects(runAuth({
    apiBaseUrl, statePath, adapter,
    sessionId: records.session.id, pairingCode: records.session.pairingCode
  }), /LOGIN_NOT_DETECTED/);
  assert.equal(closed, true);
});

test("run-once executes queued publish command and returns published URL", async () => {
  await ensureServer();
  await heartbeat({ apiBaseUrl, statePath, silent: true });
  const result = await runOnce({ apiBaseUrl, statePath, platform: "zhihu", adapter: fakeZhihuAdapter });

  assert.equal(result.command.status, "succeeded");
  assert.match(result.command.result.publishedUrl, /^https:\/\/zhihu\.desktop-media\.example\.com\/articles\//);
  assert.equal(publishInputs[0].profileRoot, path.join(path.dirname(statePath), "profiles"));
  assert.equal(publishInputs[0].profileKey, "media-auth-session-1");
  assert.deepEqual(publishInputs[0].cookies, [{ name: "z_c0", value: "cookie-token", domain: ".zhihu.com", path: "/" }]);
  assert.deepEqual(publishInputs[0].localStorage, { creatorAccountId: "local-account-1" });
  assert.deepEqual(publishInputs[0].sessionStorage, { editorDraftKey: "session-draft-1" });
  assert.deepEqual(publishInputs[0].platformConfig, records.account.platformConfig);
  assert.deepEqual(publishInputs[0].capabilities, records.account.capabilities);
  assert.equal(publishInputs[0].headless, true);
  assert.equal(publishInputs[0].keepBrowserOpen, false);
  assert.equal(publishInputs[0].allowForeground, false);
  assert.notEqual(publishInputs[0].coverImagePath, "/app/uploads/cover.png");
  assert.equal((await readFile(publishInputs[0].coverImagePath)).toString(), "cover-image");
  assert.equal(publishInputs[0].coverImageUrl, "/uploads/assets/cover.png");
  assert.equal((await readFile(publishInputs[0].inlineImages[0].path)).toString(), "workflow-image");
  assert.equal(publishInputs[0].platformImageTasks.length, 1);
  assert.equal(publishInputs[0].platformImageTasks[0].sectionId, "workflow");
  assert.equal(publishInputs[0].platformImageTasks[0].position, 2);
  assert.match(publishInputs[0].platformImageTasks[0].contentHash, /^[a-f0-9]{64}$/);
  assert.equal(publishInputs[0].contentBlocks[2].path, publishInputs[0].inlineImages[0].path);
  assert.match(publishInputs[0].contentBlocks[2].dataUrl, /^data:image\/png;base64,/);
  assert.match(publishInputs[0].contentHtml, /<h2[^>]*>实施流程<\/h2>/);
  // The materialized data URL is upload-handoff state, not article HTML. CSDN
  // rejected a 1.4 MB base64 body on 2026-10-11, so the composer may only emit
  // image URLs the platform can fetch, and this stage has none yet.
  assert.doesNotMatch(publishInputs[0].contentHtml, /<img|data:image/);
  assert.match(publishInputs[0].contentHtmlWithoutImages, /<h2[^>]*>实施流程<\/h2>/);
  assert.doesNotMatch(publishInputs[0].contentHtmlWithoutImages, /<img|data:image/);
  const secureRead = calls.find((call) => (
    call.method === "POST"
    && call.url === "/api/desktop-devices/desktop-device-1/media-accounts/media-account-1/artifact"
  ));
  assert.equal(secureRead.body.deviceToken, "token-demo");
  assert.equal(calls.some((call) => call.method === "GET" && call.url === "/api/media-auth-sessions/media-auth-session-1"), false);
  const refresh = calls.find((call) => (
    call.method === "POST"
    && call.url === "/api/desktop-devices/desktop-device-1/media-accounts/media-account-1/artifacts/refresh"
  ));
  assert.equal(refresh.body.profileKey, "media-auth-session-1");
  assert.equal(refresh.body.artifact.fingerprint, "fp-zhihu-refreshed");
  const eventCalls = calls.filter((call) => call.method === "POST" && call.url.endsWith("/events"));
  assert.ok(eventCalls.length >= 2);
  assert.ok(eventCalls.every((call) => call.body.deviceToken === "token-demo"));
  const succeededCall = eventCalls.find((call) => call.body.type === "publish_succeeded");
  assert.equal(succeededCall.body.payload.imagePublicationEvidence.status, "verified");
  assert.equal(succeededCall.body.payload.imagePublicationEvidence.expectedCount, 1);
  const pollCall = calls.find((call) => call.method === "GET" && call.url === "/api/desktop-commands");
  assert.equal(pollCall.headers["x-device-id"], "desktop-device-1");
  assert.equal(pollCall.headers["x-device-token"], "token-demo");
});

test("run-once keeps foreground visibility separate from browser persistence", async () => {
  await ensureServer();
  await heartbeat({ apiBaseUrl, statePath, silent: true });
  records.command = {
    ...records.command,
    payload: {
      ...records.command.payload,
      allowForeground: true,
      keepBrowserOpen: false
    }
  };

  await runOnce({ apiBaseUrl, statePath, platform: "zhihu", adapter: fakeZhihuAdapter });

  assert.equal(publishInputs[0].keepBrowserOpen, false);
  assert.equal(publishInputs[0].headless, false);
  assert.equal(publishInputs[0].allowForeground, true);
});

test("run-once gives the force-headless option priority over foreground payload", async () => {
  await ensureServer();
  await heartbeat({ apiBaseUrl, statePath, silent: true });
  records.command = {
    ...records.command,
    payload: {
      ...records.command.payload,
      allowForeground: true,
      keepBrowserOpen: false
    }
  };

  await runOnce({
    apiBaseUrl,
    statePath,
    platform: "zhihu",
    adapter: fakeZhihuAdapter,
    headless: true
  });

  assert.equal(publishInputs[0].headless, true);
  assert.equal(publishInputs[0].allowForeground, true);
  assert.equal(publishInputs[0].keepBrowserOpen, false);
});

test("run-once refreshes the adapter bundle before publishing", async () => {
  await ensureServer();
  await heartbeat({ apiBaseUrl, statePath, silent: true });
  const steps = [];
  const adapter = {
    ...fakeZhihuAdapter,
    async publishArticle(input = {}) {
      steps.push("publish");
      return fakeZhihuAdapter.publishArticle(input);
    }
  };

  await runOnce({
    apiBaseUrl,
    statePath,
    adapter,
    refreshAdapterBundleIfAvailable: async (input = {}) => {
      steps.push("refresh");
      assert.equal(input.apiBaseUrl, apiBaseUrl);
      assert.equal(input.statePath, statePath);
      return { status: "current", metadata: { bundleVersion: "2026.07.29.current" } };
    }
  });

  assert.deepEqual(steps, ["refresh", "publish"]);
});

test("run-once keeps publishing with bundled adapter when adapter bundle refresh fails", async () => {
  await ensureServer();
  await heartbeat({ apiBaseUrl, statePath, silent: true });

  const result = await runOnce({
    apiBaseUrl,
    statePath,
    adapter: fakeZhihuAdapter,
    refreshAdapterBundleIfAvailable: async () => {
      throw new Error("network unavailable");
    }
  });

  assert.equal(result.command.status, "succeeded");
  const warning = calls.find((call) => call.method === "POST" && call.url.endsWith("/events") && call.body.type === "publish_succeeded");
  assert.ok(warning);
});

test("run-once logs a rejected adapter bundle refresh instead of staying silent", async () => {
  await ensureServer();
  await heartbeat({ apiBaseUrl, statePath, silent: true });

  const result = await runOnce({
    apiBaseUrl,
    statePath,
    adapter: fakeZhihuAdapter,
    refreshAdapterBundleIfAvailable: async () => ({
      status: "rejected",
      reason: "bundle-version-not-newer",
      metadata: { bundleVersion: "20261018201000-netease-public-image-await" }
    })
  });

  // A rejected refresh must never block publishing: the device keeps the adapter it has.
  assert.equal(result.command.status, "succeeded");

  const logLines = (await readFile(path.join(stateRoot, "desktop-agent.log"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const rejected = logLines.find((entry) => entry.event === "adapter_bundle.refresh_rejected");
  assert.ok(rejected, "a rejected refresh has to leave a log line");
  assert.equal(rejected.detail.reason, "bundle-version-not-newer");
  assert.equal(rejected.detail.bundleVersion, "20261018201000-netease-public-image-await");
});

test("publish success payload includes the adapter bundle version when available", async () => {
  await ensureServer();
  await heartbeat({ apiBaseUrl, statePath, silent: true });
  const adapter = { ...fakeZhihuAdapter, adapterBundleVersion: "2026.07.29.hot" };

  await runOnce({ apiBaseUrl, statePath, adapter });

  const succeededCall = calls.find((call) => (
    call.method === "POST"
    && call.url === "/api/desktop-commands/desktop-command-1/events"
    && call.body.type === "publish_succeeded"
  ));
  assert.equal(succeededCall.body.payload.adapterBundleVersion, "2026.07.29.hot");
});

test("run-once reports manual verification progress while publish continues", async () => {
  await ensureServer();
  await heartbeat({ apiBaseUrl, statePath, silent: true });
  records.command = {
    ...records.command,
    payload: { ...records.command.payload, platform: "baijiahao" }
  };
  const result = await runOnce({ apiBaseUrl, statePath, platform: "baijiahao", adapter: fakeProgressAdapter });

  const progressCall = calls.find((call) => (
    call.method === "POST"
    && call.url === "/api/desktop-commands/desktop-command-1/events"
    && call.body.type === "manual_verification_required"
  ));

  assert.ok(progressCall);
  assert.equal(progressCall.body.payload.platform, "baijiahao");
  assert.match(progressCall.body.payload.message, /百家号窗口/);
  const imageProgressCall = calls.find((call) => (
    call.method === "POST"
    && call.url === "/api/desktop-commands/desktop-command-1/events"
    && call.body.type === "publish_progress"
    && call.body.payload.stage === "uploading_images"
  ));
  assert.ok(imageProgressCall);
  assert.equal(imageProgressCall.body.payload.completed, 1);
  assert.equal(result.command.status, "succeeded");
  assert.equal(result.command.result.publishedUrl, "https://baijiahao.baidu.com/s?id=123");
});

test("run-once leaves an API security verification command running instead of marking it published", async () => {
  await ensureServer();
  await heartbeat({ apiBaseUrl, statePath, silent: true });
  records.command = {
    ...records.command,
    payload: { ...records.command.payload, platform: "baijiahao" }
  };
  const adapter = {
    ...fakeZhihuAdapter,
    platform: "baijiahao",
    async publishArticle() {
      return {
        platformStatus: "manual_verification_required",
        reviewStatus: "security_verification_required",
        message: "Complete Baijiahao security verification in the foreground browser.",
        currentUrl: "https://baijiahao.baidu.com/builder/rc/edit?type=news",
      };
    }
  };

  const result = await runOnce({ apiBaseUrl, statePath, platform: "baijiahao", adapter });

  assert.equal(result.command.status, "running");
  assert.equal(result.command.result.platformStatus, "manual_verification_required");
  assert.ok(calls.some((call) => call.body.type === "manual_verification_required"));
  assert.equal(calls.some((call) => call.body.type === "publish_succeeded"), false);
});

test("run-once discovers a reviewed publication URL with the bound account artifact", async () => {
  await ensureServer();
  await heartbeat({ apiBaseUrl, statePath, silent: true });
  records.account = { ...records.account, platform: "netease", name: "网易号账号" };
  records.command = {
    ...records.command,
    type: "discover_publication",
    payload: {
      articleTitle: "智心AI网易号审核后公开测试",
      platform: "netease",
      mediaOrderId: "media-order-review-1",
      sessionId: "media-auth-session-1"
    }
  };

  const result = await runOnce({ apiBaseUrl, statePath, adapter: fakeDiscoveryAdapter });

  const completion = calls.find((call) => (
    call.method === "POST"
    && call.url === "/api/desktop-commands/desktop-command-1/events"
    && call.body.type === "publication_discovery_succeeded"
  ));
  assert.ok(completion);
  assert.equal(result.command.status, "succeeded");
  assert.equal(result.command.result.publicUrl, "https://www.163.com/dy/article/DISCOVERED001.html");
  assert.equal(discoveryInputs[0].articleTitle, "智心AI网易号审核后公开测试");
  assert.deepEqual(discoveryInputs[0].cookies, [{ name: "z_c0", value: "cookie-token", domain: ".zhihu.com", path: "/" }]);
  assert.deepEqual(discoveryInputs[0].localStorage, { creatorAccountId: "local-account-1" });
});

test("run-once validates a bound account session and reports the validation event", async () => {
  await ensureServer();
  await heartbeat({ apiBaseUrl, statePath, silent: true });
  records.command = {
    ...records.command,
    type: "validate_session",
    payload: { platform: "zhihu", profileKey: "media-auth-session-1" }
  };

  const result = await runOnce({ apiBaseUrl, statePath, adapter: fakeValidationAdapter });

  const completion = calls.find((call) => (
    call.method === "POST"
    && call.url === "/api/desktop-commands/desktop-command-1/events"
    && call.body.type === "session_validation_succeeded"
  ));
  assert.ok(completion);
  assert.equal(result.command.status, "succeeded");
  assert.equal(result.command.result.valid, true);
  assert.equal(validationInputs.length, 1);
  assert.equal(validationInputs[0].profileKey, "media-auth-session-1");
});

test("run-once reports session validation failures instead of leaving the command running", async () => {
  await ensureServer();
  await heartbeat({ apiBaseUrl, statePath, silent: true });
  records.account = { ...records.account, platform: "netease" };
  records.command = {
    ...records.command,
    type: "validate_session",
    payload: { platform: "netease", profileKey: "media-auth-session-1" }
  };
  const failingAdapter = {
    ...fakeValidationAdapter,
    platform: "netease",
    async validateSession() {
      throw new Error("NETEASE_LOGIN_REQUIRED");
    }
  };

  const result = await runOnce({ apiBaseUrl, statePath, adapter: failingAdapter });

  const failure = calls.find((call) => (
    call.method === "POST"
    && call.url === "/api/desktop-commands/desktop-command-1/events"
    && call.body.type === "session_validation_failed"
  ));
  assert.ok(failure);
  assert.equal(failure.body.payload.errorMessage, "NETEASE_LOGIN_REQUIRED");
  assert.equal(result.command.status, "failed");
  assert.equal(result.command.errorMessage, "NETEASE_LOGIN_REQUIRED");
});

const fakeEvidenceReportingAdapter = {
  ...fakeZhihuAdapter,
  async publishArticle(input = {}) {
    input.evidenceSink?.({
      externalIds: { articleId: "167131744" },
      draftUrl: "https://editor.csdn.net/md/?articleId=167131744",
      platformStatus: "submitted_for_review"
    });
    throw new Error("CSDN_API_PUBLICATION_NOT_VERIFIED");
  }
};

test("run-once replays adapter evidence with a failed publish instead of dropping it", async () => {
  await ensureServer();
  await heartbeat({ apiBaseUrl, statePath, silent: true });

  const result = await runOnce({ apiBaseUrl, statePath, platform: "zhihu", adapter: fakeEvidenceReportingAdapter });

  const failure = calls.find((call) => (
    call.method === "POST"
    && call.url === "/api/desktop-commands/desktop-command-1/events"
    && call.body.type === "publish_failed"
  ));
  assert.ok(failure);
  assert.equal(failure.body.payload.errorMessage, "CSDN_API_PUBLICATION_NOT_VERIFIED");
  assert.deepEqual(failure.body.payload.externalIds, { articleId: "167131744" });
  assert.equal(failure.body.payload.draftUrl, "https://editor.csdn.net/md/?articleId=167131744");
  assert.equal(failure.body.payload.platformStatus, "submitted_for_review");
  assert.equal(result.command.status, "failed");

  const logLines = (await readFile(path.join(stateRoot, "desktop-agent.log"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const failureLog = logLines.find((entry) => entry.event === "command.failed");
  assert.ok(failureLog);
  assert.equal(failureLog.detail.error, "CSDN_API_PUBLICATION_NOT_VERIFIED");
  assert.equal(failureLog.detail.errorDetail, "CSDN_API_PUBLICATION_NOT_VERIFIED");
  assert.match(failureLog.detail.errorStack, /CSDN_API_PUBLICATION_NOT_VERIFIED/);
  assert.equal(failureLog.detail.platformStatus, "submitted_for_review");
});

test("adapter evidence cannot overwrite the sanitized failure code", async () => {
  await ensureServer();
  await heartbeat({ apiBaseUrl, statePath, silent: true });

  await runOnce({ apiBaseUrl, statePath, platform: "zhihu", adapter: {
    ...fakeZhihuAdapter,
    async publishArticle(input = {}) {
      input.evidenceSink?.({
        errorMessage: "CSDN_API_PUBLICATION_NOT_VERIFIED",
        deviceId: "spoofed-device",
        platformStatus: "submitted_for_review"
      });
      throw new Error("DRAFT_IMAGE_MISSING");
    }
  } });

  const failure = calls.find((call) => (
    call.method === "POST"
    && call.url === "/api/desktop-commands/desktop-command-1/events"
    && call.body.type === "publish_failed"
  ));
  assert.ok(failure);
  assert.equal(failure.body.payload.errorMessage, "DESKTOP_COMMAND_EXECUTION_FAILED");
  assert.equal(failure.body.payload.deviceId, undefined);
  assert.equal(failure.body.payload.platformStatus, "submitted_for_review");
});

const readFailureLog = async () => {
  const logLines = (await readFile(path.join(stateRoot, "desktop-agent.log"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return logLines.find((entry) => entry.event === "command.failed");
};

const publishEventCalls = (type) => calls.filter((call) => (
  call.method === "POST"
  && call.url === "/api/desktop-commands/desktop-command-1/events"
  && call.body.type === type
));

test("run-once reports a returned draft-only result as a failed publish, not a success", async () => {
  await ensureServer();
  await heartbeat({ apiBaseUrl, statePath, silent: true });

  const draftOnlyAdapter = {
    ...fakeZhihuAdapter,
    async publishArticle(input = {}) {
      input.evidenceSink?.({
        draftUrl: "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=7667000000000000001",
        platformStatus: "draft_saved",
      });
      return {
        draftUrl: "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=7667000000000000001",
        publishedUrl: "",
        platformStatus: "draft_saved",
        title: input.articleTitle,
        message: "TOUTIAO_DRAFT_EDITOR_LOST",
      };
    }
  };

  const result = await runOnce({ apiBaseUrl, statePath, platform: "zhihu", adapter: draftOnlyAdapter });

  // The old code hardcoded publish_succeeded here, so a draft that was never
  // submitted still counted as a published article on the service side.
  assert.equal(publishEventCalls("publish_succeeded").length, 0);
  const failure = publishEventCalls("publish_failed")[0];
  assert.ok(failure);
  assert.equal(failure.body.payload.errorMessage, "TOUTIAO_DRAFT_EDITOR_LOST");
  assert.equal(failure.body.payload.errorDetail, "TOUTIAO_DRAFT_EDITOR_LOST");
  assert.equal(failure.body.payload.platformStatus, "draft_saved");
  assert.equal(
    failure.body.payload.draftUrl,
    "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=7667000000000000001"
  );
  assert.equal(result.command.status, "failed");

  const failureLog = await readFailureLog();
  assert.ok(failureLog);
  assert.equal(failureLog.detail.error, "TOUTIAO_DRAFT_EDITOR_LOST");
  assert.equal(failureLog.detail.platformStatus, "draft_saved");
});

test("run-once derives a platform opcode when a returned draft carries no message", async () => {
  await ensureServer();
  await heartbeat({ apiBaseUrl, statePath, silent: true });

  const result = await runOnce({ apiBaseUrl, statePath, platform: "zhihu", adapter: {
    ...fakeZhihuAdapter,
    async publishArticle() {
      return { publishedUrl: "", platformStatus: "draft_saved", title: "draft only" };
    }
  } });

  assert.equal(publishEventCalls("publish_succeeded").length, 0);
  const failure = publishEventCalls("publish_failed")[0];
  assert.ok(failure);
  assert.equal(failure.body.payload.errorMessage, "ZHIHU_DRAFT_SAVED_NOT_PUBLISHED");
  assert.equal(result.command.status, "failed");
});

test("findQueuedCommand prefers the newest queued command for the current desktop", async () => {
  await ensureServer();
  await heartbeat({ apiBaseUrl, statePath, silent: true });
  records.commands = [
    {
      ...records.command,
      id: "desktop-command-old",
      deviceId: "desktop-device-1",
      status: "queued",
      createdAt: "07/05 10:10",
      payload: { articleTitle: "old queued", platform: "zhihu" }
    },
    {
      ...records.command,
      id: "desktop-command-new",
      deviceId: "desktop-device-1",
      status: "queued",
      createdAt: "07/05 10:58",
      payload: { articleTitle: "new queued", platform: "zhihu" }
    }
  ];

  const command = await findQueuedCommand({ apiBaseUrl, statePath });

  assert.equal(command.id, "desktop-command-new");
});

test("findQueuedCommand only selects queued commands for the requested platform", async () => {
  await ensureServer();
  await heartbeat({ apiBaseUrl, statePath, silent: true });
  records.commands = [
    {
      ...records.command,
      id: "desktop-command-zhihu",
      deviceId: "desktop-device-1",
      status: "queued",
      createdAt: "07/05 10:10",
      payload: { articleTitle: "zhihu queued", platform: "zhihu" }
    },
    {
      ...records.command,
      id: "desktop-command-csdn",
      deviceId: "desktop-device-1",
      status: "queued",
      createdAt: "07/05 10:58",
      payload: { articleTitle: "csdn queued", platform: "csdn" }
    }
  ];

  const command = await findQueuedCommand({ apiBaseUrl, statePath, platform: "zhihu" });

  assert.equal(command.id, "desktop-command-zhihu");
});

// findQueuedCommand picks from a list snapshot, so the status it saw can be
// stale by the time the adapter opens a browser. Executing anyway is what threw
// DESKTOP_COMMAND_ALREADY_TERMINAL on 2026-10-24 and, worse, what can publish an
// article a second time for a command somebody else already closed.
test("executeCommand re-reads the command status before launching the adapter", async () => {
  await ensureServer();
  await heartbeat({ apiBaseUrl, statePath, silent: true });
  records.commands = [{
    ...records.command,
    id: "desktop-command-1",
    deviceId: "desktop-device-1",
    status: "queued"
  }];
  // The picker's snapshot said queued; every later read sees a finished command.
  records.terminalStatusFromListCall = 2;

  const result = await runOnce({ apiBaseUrl, statePath });

  assert.equal(result.skipped, "DESKTOP_COMMAND_ALREADY_TERMINAL");
  assert.equal(publishInputs.length, 0);
  assert.equal(
    calls.some((call) => call.method === "POST" && call.url.endsWith("/events")),
    false,
    "no event may be written for a command that is already terminal"
  );
  const skipped = (await readAgentLogLines()).find((entry) => entry.event === "command.skipped");
  assert.ok(skipped, "the skip must be visible in the desktop log");
  assert.equal(skipped.detail.reason, "DESKTOP_COMMAND_ALREADY_TERMINAL");
});

test("executeCommand stands down when the command status cannot be re-read", async () => {
  await ensureServer();
  await heartbeat({ apiBaseUrl, statePath, silent: true });
  records.commands = [{
    ...records.command,
    id: "desktop-command-1",
    deviceId: "desktop-device-1",
    status: "queued"
  }];
  // Guessing here costs a second publish, so an unreadable status must stop the
  // command rather than let it through on the strength of a stale snapshot.
  records.failCommandListFromCall = 2;

  const result = await runOnce({ apiBaseUrl, statePath });

  assert.equal(result.skipped, "command status unreadable: COMMAND_LIST_UNAVAILABLE");
  assert.equal(publishInputs.length, 0);
  assert.equal(calls.some((call) => call.method === "POST" && call.url.endsWith("/events")), false);
});

test("executeCommand tolerates a command that closes inside the re-check gap", async () => {
  await ensureServer();
  await heartbeat({ apiBaseUrl, statePath, silent: true });
  records.commands = [{
    ...records.command,
    id: "desktop-command-1",
    deviceId: "desktop-device-1",
    status: "queued"
  }];
  // The re-check still sees queued, but the first event write is rejected: the
  // command went terminal between the two reads. That is the endpoint doing its
  // job, so it must not be filed as a failure of this command.
  records.terminalEventTypes = ["publish_started", "running"];

  const result = await runOnce({ apiBaseUrl, statePath });

  assert.equal(result.skipped, "DESKTOP_COMMAND_ALREADY_TERMINAL");
  assert.equal(publishInputs.length, 0);
  assert.deepEqual(
    calls.filter((call) => call.method === "POST" && call.url.endsWith("/events")).map((call) => call.body.type),
    ["publish_started"]
  );
});

test("a failure report rejected as already terminal keeps the real cause in the log", async () => {
  await ensureServer();
  await heartbeat({ apiBaseUrl, statePath, silent: true });
  // The adapter fails for a real reason, and by the time the failure is reported
  // the command has already been closed. The rejection used to replace the real
  // cause and stop the log line from ever being written.
  records.terminalEventTypes = ["publish_failed"];

  const result = await runOnce({ apiBaseUrl, statePath, platform: "zhihu", adapter: {
    ...fakeZhihuAdapter,
    async publishArticle() {
      throw new Error("CSDN_API_PUBLICATION_NOT_VERIFIED");
    }
  } });

  assert.equal(result.skipped, "DESKTOP_COMMAND_ALREADY_TERMINAL");
  const failureLog = await readFailureLog();
  assert.ok(failureLog, "the real cause must survive a rejected writeback");
  assert.equal(failureLog.detail.error, "CSDN_API_PUBLICATION_NOT_VERIFIED");
});

test("CLI leaves queued command selection unfiltered when --platform is omitted", async () => {
  const source = await readFile(new URL("../src/agent.mjs", import.meta.url), "utf8");

  assert.match(source, /platform:\s*args\.platform[,\n]/);
  assert.doesNotMatch(source, /platform:\s*args\.platform\s*\|\|\s*["']zhihu["']/);
});

test("desktop owner binding uses device credentials and persists the member owner", async () => {
  await ensureServer();
  const result = await bindOwner({
    apiBaseUrl,
    statePath,
    bindingId: "desktop-owner-binding-1",
    pairingCode: "654321"
  });

  assert.equal(result.device.boundOwnerId, "member-a");
  const claimCall = calls.find((call) => call.url.includes("/owner-bindings/"));
  assert.equal(claimCall.headers["x-device-id"], "desktop-device-1");
  assert.equal(claimCall.headers["x-device-token"], "token-demo");
  assert.equal(claimCall.body.pairingCode, "654321");

  const state = await readState(statePath);
  assert.equal(state.device.boundOwnerId, "member-a");
});

test("run-once automatically handles queued open_auth command without copying pairing code", async () => {
  await ensureServer();
  records.command = {
    id: "desktop-command-1",
    deviceId: "",
    type: "open_auth",
    mediaAccountId: "",
    status: "queued",
    payload: {
      sessionId: records.session.id,
      pairingCode: records.session.pairingCode,
      platform: "zhihu",
      waitLoginMs: 60000,
      keepBrowserOpen: true
    },
    result: {}
  };

  const result = await runOnce({ apiBaseUrl, statePath, adapter: fakeZhihuAdapter });

  assert.equal(result.command.status, "succeeded");
  assert.equal(result.command.result.sessionId, records.session.id);
  assert.equal(result.command.result.mediaAccountId, records.account.id);
  assert.equal(records.session.status, "bound");

  const desktopEventTypes = calls
    .filter((call) => call.method === "POST" && call.url === "/api/desktop-events")
    .map((call) => call.body.type);
  assert.deepEqual(desktopEventTypes.slice(-3), ["browser_opened", "login_detected", "capture_started"]);
});

test("desktop can authorize a platform directly without a web-created session", async () => {
  await ensureServer();

  const result = await authorizePlatform({
    apiBaseUrl,
    statePath,
    platform: "zhihu",
    accountName: "知乎增长号",
    adapter: fakeZhihuAdapter,
    keepBrowserOpen: true
  });

  assert.equal(result.session.status, "bound");
  assert.equal(result.mediaAccount.name, "知乎增长号");
  assert.equal(records.session.deviceId, "desktop-device-1");

  const createdSession = calls.find((call) => call.method === "POST" && call.url === "/api/media-auth-sessions");
  assert.equal(createdSession.body.platform, "zhihu");
  assert.equal(createdSession.body.queueDesktopCommand, false);
});

test("auth flow falls back to adapter login URL when API session returns about:blank", async () => {
  await ensureServer();
  records.session = {
    ...records.session,
    platform: "sohu",
    loginUrl: "about:blank"
  };
  let loginUrlSeen = "";
  const fakeSohuAdapter = {
    ...fakeZhihuAdapter,
    platform: "sohu",
    loginUrl: "https://mp.sohu.com/",
    async detectLoggedIn(input = {}) {
      loginUrlSeen = input.loginUrl;
      return true;
    }
  };

  await runAuth({
    apiBaseUrl,
    statePath,
    sessionId: records.session.id,
    pairingCode: records.session.pairingCode,
    platform: "sohu",
    adapter: fakeSohuAdapter
  });

  assert.equal(loginUrlSeen, "https://mp.sohu.com/");
  const openedEvent = calls.find((call) => call.method === "POST" && call.url === "/api/desktop-events" && call.body.type === "browser_opened");
  assert.equal(openedEvent.body.payload.url, "https://mp.sohu.com/");
});

test("watch mode treats a lock held by the current process as active", async () => {
  const agentCore = await import("../src/agent-core.mjs");

  assert.equal(typeof agentCore.processIsAlive, "function");
  assert.equal(agentCore.processIsAlive(process.pid), true);
});

test("device token is stored through the credential store and never serialized to JSON", async () => {
  const secureStatePath = path.join(stateRoot, "secure-state.json");
  const secrets = new Map();
  const credentialStore = {
    async get(key) { return secrets.get(key) || ""; },
    async set(key, value) { secrets.set(key, value); },
    async delete(key) { secrets.delete(key); }
  };

  await writeState(secureStatePath, {
    apiBaseUrl,
    device: { id: "desktop-device-secure", deviceName: "智心AI桌面端" },
    deviceToken: "secret-device-token"
  }, { credentialStore });

  const persisted = JSON.parse(await readFile(secureStatePath, "utf8"));
  assert.equal(Object.hasOwn(persisted, "deviceToken"), false);
  assert.equal(secrets.get("desktop-device-token"), "secret-device-token");

  const hydrated = await readState(secureStatePath, { credentialStore });
  assert.equal(hydrated.deviceToken, "secret-device-token");
});

test("default credential storage keeps the device token across CLI processes", async () => {
  const durableStatePath = path.join(stateRoot, "durable-state.json");

  await writeState(durableStatePath, {
    apiBaseUrl,
    device: { id: "desktop-device-durable", deviceName: "durable runner" },
    deviceToken: "durable-device-token"
  });

  const persisted = JSON.parse(await readFile(durableStatePath, "utf8"));
  assert.equal(Object.hasOwn(persisted, "deviceToken"), false);

  const script = `
    import { readState } from ${JSON.stringify(new URL("../src/agent-core.mjs", import.meta.url).href)};
    const state = await readState(${JSON.stringify(durableStatePath)});
    console.log(JSON.stringify({ deviceToken: state.deviceToken || "" }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, ZHIXIN_DEVICE_TOKEN: "" }
  });

  assert.equal(JSON.parse(stdout).deviceToken, "durable-device-token");
});

test("legacy plaintext device token migrates only after secure storage succeeds", async () => {
  const legacyStatePath = path.join(stateRoot, "legacy-state.json");
  await writeFile(legacyStatePath, JSON.stringify({
    apiBaseUrl,
    device: { id: "desktop-device-legacy" },
    deviceToken: "legacy-token"
  }), "utf8");
  const secrets = new Map();
  const credentialStore = {
    async get(key) { return secrets.get(key) || ""; },
    async set(key, value) { secrets.set(key, value); },
    async delete(key) { secrets.delete(key); }
  };

  const state = await readState(legacyStatePath, { credentialStore });

  assert.equal(state.deviceToken, "legacy-token");
  assert.equal(secrets.get("desktop-device-token"), "legacy-token");
  const migrated = JSON.parse(await readFile(legacyStatePath, "utf8"));
  assert.equal(Object.hasOwn(migrated, "deviceToken"), false);
});

function readAgentLogLines() {
  return readFile(path.join(stateRoot, "desktop-agent.log"), "utf8")
    .then((text) => text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)));
}

test("watch iteration logs a failing command-list fetch instead of swallowing it", async () => {
  await ensureServer();
  await ensureRegistered({ apiBaseUrl, statePath });
  records.failCommandList = true;

  const command = await watchIteration({ apiBaseUrl, statePath });

  // The loop keeps going with no command rather than dying, but the failure is
  // now visible in the log instead of looking exactly like an empty queue.
  assert.equal(command, null);
  const logLines = await readAgentLogLines();
  const errorLog = logLines.find((entry) => entry.event === "watch.command_list_error");
  assert.ok(errorLog);
  assert.match(errorLog.detail.error, /COMMAND_LIST_UNAVAILABLE/);
  assert.equal(logLines.some((entry) => entry.event === "watch.heartbeat_error"), false);
  assert.equal(calls.filter((call) => call.method === "GET" && call.url === "/api/desktop-commands").length, 1);
});

test("watch iteration logs a failing heartbeat and still polls for commands", async () => {
  await ensureServer();
  await ensureRegistered({ apiBaseUrl, statePath });
  records.failHeartbeat = true;
  records.commands = [];

  const command = await watchIteration({ apiBaseUrl, statePath });

  assert.equal(command, undefined);
  const logLines = await readAgentLogLines();
  const heartbeatError = logLines.find((entry) => entry.event === "watch.heartbeat_error");
  assert.ok(heartbeatError);
  assert.match(heartbeatError.detail.error, /HEARTBEAT_UNAVAILABLE/);
  assert.equal(logLines.some((entry) => entry.event === "watch.command_list_error"), false);
  assert.equal(calls.filter((call) => call.method === "GET" && call.url === "/api/desktop-commands").length, 1);
});

test("watch iteration rate-limits a repeating command-list failure", async () => {
  await ensureServer();
  await ensureRegistered({ apiBaseUrl, statePath });
  records.failCommandList = true;

  await watchIteration({ apiBaseUrl, statePath });
  await watchIteration({ apiBaseUrl, statePath });
  await watchIteration({ apiBaseUrl, statePath });

  // Three failed polls, one log line: a long outage must not bury everything else.
  const logLines = await readAgentLogLines();
  assert.equal(logLines.filter((entry) => entry.event === "watch.command_list_error").length, 1);
  assert.equal(calls.filter((call) => call.method === "GET" && call.url === "/api/desktop-commands").length, 3);
});

const MS_PER_DAY = 24 * 60 * 60 * 1000;

async function pathExists(target) {
  return (await stat(target).catch(() => null)) !== null;
}

// A pid that has definitely exited is the only reliable "dead owner" signal: a
// hardcoded large number is not portable and could name a live process.
async function exitedPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  await new Promise((resolve) => child.on("exit", resolve));
  return pid;
}

async function seedLocalAssets({ assetAges = [], profiles = [] } = {}) {
  const assetsRoot = path.join(stateRoot, "publication-assets");
  await mkdir(assetsRoot, { recursive: true });
  for (const [index, ageDays] of assetAges.entries()) {
    const directory = path.join(assetsRoot, `publish-${index}`);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "cover.png"), "x".repeat(1024), "utf8");
    const stamp = new Date(Date.now() - ageDays * MS_PER_DAY);
    await utimes(directory, stamp, stamp);
  }
  const profilesRoot = profileRoot(statePath);
  for (const profile of profiles) {
    const directory = path.join(profilesRoot, profile.platform, profile.key);
    await mkdir(directory, { recursive: true });
    const payload = path.join(directory, "Cookies");
    await writeFile(payload, "y".repeat(2048), "utf8");
    if (profile.locked) {
      await mkdir(path.join(profilesRoot, ".locks"), { recursive: true });
      await writeFile(path.join(profilesRoot, ".locks", `${profile.platform}-${profile.key}.lock`), String(process.pid), "utf8");
    }
    const stamp = new Date(Date.now() - profile.ageDays * MS_PER_DAY);
    await utimes(directory, stamp, stamp);
    await utimes(payload, stamp, stamp);
  }
  return { assetsRoot, profilesRoot };
}

test("cleanup-assets keeps the newest asset directories and only removes genuinely old ones", async () => {
  const seeded = await seedLocalAssets({ assetAges: [0, 1, 3, 30] });

  const result = await cleanupLocalAssets({ statePath, assetsKeep: 2, assetsMaxAgeDays: 7, keepProfileKeys: [] });

  assert.equal(result.assets.scanned, 4);
  assert.equal(result.assets.keptNewest, 2);
  assert.equal(result.assets.keptRecent, 1);
  assert.equal(result.assets.deleted, 1);
  assert.equal(result.assets.freedBytes, 1024);
  // An empty keep list is not a licence to delete every login on the machine.
  assert.equal(result.profiles.skipped, true);
  assert.equal(await pathExists(path.join(seeded.assetsRoot, "publish-0")), true);
  assert.equal(await pathExists(path.join(seeded.assetsRoot, "publish-2")), true);
  assert.equal(await pathExists(path.join(seeded.assetsRoot, "publish-3")), false);
});

test("cleanup-assets stands down on profiles when the server cannot supply a keep list", async () => {
  const seeded = await seedLocalAssets({
    profiles: [
      { platform: "zhihu", key: "media-auth-session-1", ageDays: 400 },
      { platform: "zhihu", key: "media-account-1", ageDays: 400 }
    ]
  });

  const result = await cleanupLocalAssets({ statePath, keepProfileKeys: [] });

  assert.equal(result.profiles.skipped, true);
  assert.equal(result.profiles.skipReason, "keep_profile_keys_empty");
  assert.equal(result.profiles.deleted, 0);
  assert.equal(await pathExists(path.join(seeded.profilesRoot, "zhihu", "media-auth-session-1")), true);
  const logLines = await readAgentLogLines();
  assert.ok(logLines.find((entry) => entry.event === "assets.cleanup_profiles_skipped"));
});

test("cleanup-assets protects whitelisted, recently used, and locked profiles", async () => {
  const seeded = await seedLocalAssets({
    profiles: [
      { platform: "zhihu", key: "media-auth-session-1", ageDays: 400 },
      { platform: "zhihu", key: "media-account-1", ageDays: 400 },
      { platform: "zhihu", key: "media-account-2", ageDays: 1 },
      { platform: "netease", key: "media-account-3", ageDays: 400, locked: true }
    ]
  });

  const result = await cleanupLocalAssets({
    statePath,
    keepProfileKeys: ["media-auth-session-1"],
    profilesMaxAgeDays: 14
  });

  assert.equal(result.profiles.scanned, 4);
  assert.equal(result.profiles.keptWhitelisted, 1);
  assert.equal(result.profiles.keptRecent, 1);
  assert.equal(result.profiles.locked, 1);
  assert.equal(result.profiles.deleted, 1);
  assert.equal(result.profiles.freedBytes, 2048);
  assert.equal(await pathExists(path.join(seeded.profilesRoot, "zhihu", "media-auth-session-1")), true);
  assert.equal(await pathExists(path.join(seeded.profilesRoot, "zhihu", "media-account-2")), true);
  assert.equal(await pathExists(path.join(seeded.profilesRoot, "netease", "media-account-3")), true);
  assert.equal(await pathExists(path.join(seeded.profilesRoot, "zhihu", "media-account-1")), false);
});

test("cleanup-assets --all-profiles still respects a held profile lock", async () => {
  const seeded = await seedLocalAssets({
    profiles: [
      { platform: "zhihu", key: "media-auth-session-1", ageDays: 1, locked: true },
      { platform: "zhihu", key: "media-account-1", ageDays: 1 }
    ]
  });

  const result = await cleanupLocalAssets({ statePath, allProfiles: true, keepProfileKeys: [] });

  assert.equal(result.profiles.locked, 1);
  assert.equal(result.profiles.deleted, 1);
  assert.equal(await pathExists(path.join(seeded.profilesRoot, "zhihu", "media-auth-session-1")), true);
  assert.equal(await pathExists(path.join(seeded.profilesRoot, "zhihu", "media-account-1")), false);
});

test("cleanup-assets dry run reports the sweep without removing anything", async () => {
  const seeded = await seedLocalAssets({
    assetAges: [0, 30],
    profiles: [{ platform: "zhihu", key: "media-account-1", ageDays: 400 }]
  });

  const result = await cleanupLocalAssets({ statePath, dryRun: true, keepProfileKeys: [], assetsKeep: 1, assetsMaxAgeDays: 7 });

  assert.equal(result.dryRun, true);
  assert.equal(result.assets.deleted, 1);
  assert.equal(await pathExists(path.join(seeded.assetsRoot, "publish-1")), true);
  assert.equal(await pathExists(path.join(seeded.profilesRoot, "zhihu", "media-account-1")), true);
});

test("fetchAssetCleanupKeepKeys asks the server with device credentials", async () => {
  await ensureServer();
  await ensureRegistered({ apiBaseUrl, statePath });

  const keys = await fetchAssetCleanupKeepKeys({ apiBaseUrl, statePath });

  assert.deepEqual(keys, ["media-auth-session-1"]);
  const keepKeysCall = calls.find((call) => call.url === "/api/desktop-devices/desktop-device-1/asset-cleanup-keep-keys");
  assert.ok(keepKeysCall);
  assert.equal(keepKeysCall.headers["x-device-token"], records.deviceToken);
});

test("fetchAssetCleanupKeepKeys surfaces a server failure instead of inventing an empty list", async () => {
  await ensureServer();
  await ensureRegistered({ apiBaseUrl, statePath });
  records.failAssetCleanupKeepKeys = true;

  await assert.rejects(() => fetchAssetCleanupKeepKeys({ apiBaseUrl, statePath }), /KEEP_KEYS_UNAVAILABLE/);
});

test("run-once executes a queued cleanup_assets command and reports cleanup_succeeded", async () => {
  await ensureServer();
  await ensureRegistered({ apiBaseUrl, statePath });
  const seeded = await seedLocalAssets({
    assetAges: [0, 30, 60],
    profiles: [{ platform: "zhihu", key: "media-auth-session-1", ageDays: 400 }]
  });
  records.command = {
    id: "desktop-command-1",
    deviceId: "desktop-device-1",
    type: "cleanup_assets",
    mediaAccountId: "",
    status: "queued",
    payload: {
      assetsKeep: 1,
      assetsMaxAgeDays: 7,
      profilesMaxAgeDays: 14,
      keepProfileKeys: ["media-auth-session-1"]
    },
    result: {}
  };

  const result = await runOnce({ apiBaseUrl, statePath });

  assert.equal(result.command.status, "succeeded");
  const succeeded = calls.find((call) => call.method === "POST"
    && call.url === "/api/desktop-commands/desktop-command-1/events"
    && call.body.type === "cleanup_succeeded");
  assert.ok(succeeded);
  assert.equal(succeeded.body.payload.assets.deleted, 2);
  assert.equal(succeeded.body.payload.profiles.keptWhitelisted, 1);
  // A maintenance command must not pull an adapter bundle down on its way past.
  assert.equal(calls.some((call) => call.url.startsWith("/api/adapter-bundles")), false);
  assert.equal(await pathExists(path.join(seeded.profilesRoot, "zhihu", "media-auth-session-1")), true);
  assert.equal(await pathExists(path.join(seeded.assetsRoot, "publish-1")), false);
});

test("a failed cleanup writeback is reported as cleanup_failed, not a publish failure", async () => {
  await ensureServer();
  await ensureRegistered({ apiBaseUrl, statePath });
  await seedLocalAssets({ assetAges: [0, 30] });
  records.command = {
    id: "desktop-command-1",
    deviceId: "desktop-device-1",
    type: "cleanup_assets",
    mediaAccountId: "",
    status: "queued",
    payload: { keepProfileKeys: ["media-auth-session-1"] },
    result: {}
  };
  records.failCleanupSucceeded = true;

  const result = await runOnce({ apiBaseUrl, statePath });

  // The command has to end terminal either way; what matters is that the
  // operator reads "cleanup failed" instead of a publish failure for a sweep.
  assert.equal(result.command.status, "failed");
  const failed = calls.find((call) => call.method === "POST"
    && call.url === "/api/desktop-commands/desktop-command-1/events"
    && call.body.type === "cleanup_failed");
  assert.ok(failed);
  assert.equal(calls.some((call) => call.body.type === "publish_failed"), false);
});

test("watch lock staleness rules separate a live watcher from an abandoned one", async () => {
  const now = Date.now();
  const gone = await exitedPid();

  assert.equal(watchLockIsCurrent(parseWatchLock(JSON.stringify({ pid: gone, heartbeatAt: new Date(now).toISOString() })), now), false);
  assert.equal(watchLockIsCurrent(parseWatchLock(String(gone)), now), false);
  assert.equal(watchLockIsCurrent(parseWatchLock(JSON.stringify({ pid: process.pid, heartbeatAt: new Date(now - 11 * 60 * 1000).toISOString() })), now), false);
  assert.equal(watchLockIsCurrent(parseWatchLock(JSON.stringify({ pid: process.pid, heartbeatAt: new Date(now).toISOString() })), now), true);
  // A lock written before the stamp existed carries only a pid.
  assert.equal(watchLockIsCurrent(parseWatchLock(String(process.pid)), now), true);
  assert.equal(watchLockIsCurrent(parseWatchLock("not-a-lock"), now), false);
  assert.equal(watchLockIsCurrent(parseWatchLock(""), now), false);
  assert.equal(watchLockIsCurrent(null, now), false);
});

test("a second watcher exits with already_running and reports the contention", async () => {
  await ensureServer();
  await ensureRegistered({ apiBaseUrl, statePath });
  const lockPath = path.join(stateRoot, "desktop-agent.watch.lock");
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, heartbeatAt: new Date().toISOString() }), "utf8");

  const result = await watch({ apiBaseUrl, statePath, intervalMs: 1 });

  assert.equal(result.status, "already_running");
  assert.ok(calls.some((call) => call.method === "POST"
    && call.url === "/api/desktop-events"
    && call.body.type === "watch_lock_contended"));
  const logLines = await readAgentLogLines();
  assert.ok(logLines.find((entry) => entry.event === "watch.already_running"));
});

test("a stale watcher lock is taken over instead of blocking the new watcher", async () => {
  const lockPath = path.join(stateRoot, "desktop-agent.watch.lock");
  await writeFile(lockPath, JSON.stringify({ pid: 999999, heartbeatAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() }), "utf8");

  const lock = await acquireWatchLock({ statePath });

  assert.ok(lock);
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, process.pid);
  await lock.release();
  assert.equal(await readFile(lockPath, "utf8").catch(() => ""), "");
});

test("touchWatchLock stands down once another watcher has taken the lock over", async () => {
  const lock = await acquireWatchLock({ statePath });
  assert.ok(lock);

  assert.equal(await touchWatchLock(lock), true);
  await writeFile(lock.lockPath, JSON.stringify({ pid: 4321, heartbeatAt: new Date().toISOString() }), "utf8");
  assert.equal(await touchWatchLock(lock), false);

  await lock.release();
});

const agentScript = fileURLToPath(new URL("../src/agent.mjs", import.meta.url));

async function runCleanupAssetsCli(extraArgs) {
  // assets-keep defaults to 50, so a one-directory fixture would always land in
  // the protected newest slice and never exercise the delete path.
  const args = ["--assets-keep", "0"];
  return execFileAsync(process.execPath, [
    agentScript,
    "cleanup-assets",
    "--dry-run",
    "--api",
    apiBaseUrl,
    "--state",
    statePath,
    ...args,
    ...extraArgs
  ], { encoding: "utf8", timeout: 60000 });
}

test("cleanup-assets --all-profiles never asks the server for a keep list", async () => {
  await ensureServer();
  await ensureRegistered({ apiBaseUrl, statePath });
  await seedLocalAssets({
    assetAges: [30],
    profiles: [{ platform: "zhihu", key: "media-account-1", ageDays: 400 }]
  });

  const { stdout } = await runCleanupAssetsCli(["--all-profiles"]);
  const result = JSON.parse(stdout);

  // The flag ignores the keep list, so an unreachable API must not be able to
  // turn an explicit destructive run into an error, or log a misleading one.
  assert.equal(calls.some((call) => call.url.endsWith("/asset-cleanup-keep-keys")), false);
  assert.equal(result.profiles.skipped, false);
  assert.equal(result.profiles.scanned, 1);
  assert.equal(result.profiles.deleted, 1);
  assert.equal(result.assets.deleted, 1);
});

test("cleanup-assets stands down on profiles when the keep list cannot be fetched", async () => {
  await ensureServer();
  await ensureRegistered({ apiBaseUrl, statePath });
  await seedLocalAssets({
    assetAges: [30],
    profiles: [{ platform: "zhihu", key: "media-account-1", ageDays: 400 }]
  });
  records.failAssetCleanupKeepKeys = true;

  const { stdout } = await runCleanupAssetsCli([]);
  const result = JSON.parse(stdout);

  assert.equal(calls.some((call) => call.url.endsWith("/asset-cleanup-keep-keys")), true);
  assert.equal(result.profiles.skipped, true);
  assert.equal(result.profiles.skipReason, "keep_profile_keys_empty");
  assert.equal(result.profiles.deleted, 0);
  // The asset half is independent of the server and still runs.
  assert.equal(result.assets.deleted, 1);
});

test('video command streams private material and reports review without article evidence', async () => {
  await ensureServer();
  await heartbeat({apiBaseUrl,statePath,silent:true});
  const heart = calls.find(c=>c.body.type==='heartbeat');
  assert.equal(heart.body.payload.capabilities?.publish_video_v1,true);
  assert.equal(heart.body.payload.capabilities?.publish_video_schedule_v1,true);
  records.account.platform='douyin';
  records.command.type='publish_video';
  records.command.payload={platform:'douyin',caption:'测试视频',expectedAccountId:'creator-account-1',videoPublicationId:'vp-one',videoAsset:{id:'video-asset-test',downloadPath:'/api/video-assets/video-asset-test/content',sizeBytes:10,sha256:createHash('sha256').update('video-test').digest('hex')}};
  let published=0;
  const result=await runOnce({apiBaseUrl,statePath,adapter:{platform:'douyin',async publishVideo(input){
    published++; assert.equal(await readFile(input.videoPath,'utf8'),'video-test');assert.equal(input.contentHtml,undefined);
    await input.onProgress({type:'publish_progress',stage:'submitting'});
    return {itemId:'123456789123456789',platformStatus:'submitted_for_review',submissionAccepted:true};
  }}});
  assert.equal(published,1); assert.equal(result.command.status,'succeeded');
  assert.equal(result.command.result.platformStatus,'submitted_for_review');
  assert.ok(calls.some(c=>c.body.payload?.stage==='submitting'));
});

test('asset maintenance retains an active video download even with zero retention',async()=>{
  const active=path.join(stateRoot,'publication-assets','active-video');
  await mkdir(active,{recursive:true});await writeFile(path.join(active,'.video-active'),'active');await writeFile(path.join(active,'video.mp4'),'data');
  await utimes(active,new Date('2020-01-01'),new Date('2020-01-01'));
  await cleanupLocalAssets({statePath,assetsKeep:0,assetsMaxAgeDays:0});
  assert.equal(await readFile(path.join(active,'video.mp4'),'utf8'),'data');
});

test('scheduled video proves current executor capability before invoking its adapter',async()=>{
  await ensureServer();await heartbeat({apiBaseUrl,statePath,silent:true});
  records.account.platform='douyin';records.command.type='publish_video';
  records.command.payload={platform:'douyin',title:'独立标题',caption:'简介',publishMode:'scheduled',scheduledAt:'2026-10-30T12:00:00+08:00',scheduledTimestamp:1793332800,expectedAccountId:'creator-account-1',videoPublicationId:'vp-one',videoAsset:{id:'video-asset-test',downloadPath:'/api/video-assets/video-asset-test/content',sizeBytes:10,sha256:createHash('sha256').update('video-test').digest('hex')}};
  const result=await runOnce({apiBaseUrl,statePath,adapter:{platform:'douyin',async publishVideo(input){
    const claim=calls.find(c=>c.body.type==='publish_started');
    assert.equal(claim.body.payload.executionCapabilities.publish_video_schedule_v1,true);
    assert.equal(input.title,'独立标题');assert.equal(input.caption,'简介');
    await input.onProgress({stage:'submitting'});
    return {itemId:'123456789123456789',platformStatus:'scheduled',submissionAccepted:true,scheduledTimestamp:input.scheduledTimestamp};
  }}});
  assert.equal(result.command.result.platformStatus,'scheduled');
});

test('watch recovery replays a persisted accepted video result without downloading or publishing',async()=>{
  await ensureServer(); await heartbeat({apiBaseUrl,statePath,silent:true});
  records.command.type='publish_video'; records.command.status='running'; records.command.deviceId=records.device.id;
  await mkdir(path.join(stateRoot,'video-submissions'),{recursive:true});
  await writeFile(path.join(stateRoot,'video-submissions','desktop-command-1.json'),JSON.stringify({stage:'complete',result:{platformStatus:'submitted_for_review',itemId:'123456789123456789',submissionAccepted:true}}));
  await recoverVideoCallbacks({apiBaseUrl,statePath});
  assert.equal(records.command.status,'succeeded');
  assert.equal(records.command.result.itemId,'123456789123456789');
  assert.equal(calls.filter(c=>c.url.includes('/api/video-assets/')).length,0);
});

test('video callback recovery cannot finalize a command still owned by a live publisher',async()=>{
  await ensureServer(); await heartbeat({apiBaseUrl,statePath,silent:true});
  records.command.type='publish_video';records.command.status='running';records.command.deviceId=records.device.id;
  await mkdir(path.join(stateRoot,'video-submissions'),{recursive:true});
  await writeFile(path.join(stateRoot,'video-submissions','desktop-command-1.json'),JSON.stringify({stage:'submitting'}));
  const directory=path.join(stateRoot,'publication-assets','desktop-command-1');await mkdir(directory,{recursive:true});
  await writeFile(path.join(directory,'.video-active'),String(process.pid));
  await recoverVideoCallbacks({apiBaseUrl,statePath});
  assert.equal(records.command.status,'running');
});


test("publish reports divergent representations without changing submitted content", async () => {
  await ensureServer();
  await heartbeat({ apiBaseUrl, statePath, silent: true });
  records.command.payload.contentMarkdown = "## 实施流程\n第一段\n\n第二段\n\n遗漏的末段";
  const result = await runOnce({ apiBaseUrl, statePath, platform: "zhihu", adapter: fakeZhihuAdapter });
  assert.equal(result.command.status, "succeeded");
  const warning = calls.find((call) => call.body?.payload?.code === "ARTICLE_CONTENT_REPRESENTATION_MISMATCH");
  assert.equal(warning?.body.type, "publish_progress");
  assert.equal(warning?.body.payload.stage, "content_consistency_warning");
  assert.equal(publishInputs[0].contentMarkdown, records.command.payload.contentMarkdown);
  assert.equal(publishInputs[0].contentBlocks[1].content, "第一段\n\n第二段");
  assert.equal(JSON.stringify(warning.body.payload).includes("遗漏的末段"), false);
});
