import { readdir, rm, mkdir, readFile, writeFile, appendFile, open, unlink, stat, rename, utimes } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir, platform as osPlatform } from "node:os";
import path from "node:path";
import { getAdapter } from "./adapters/index.mjs";
import { currentAdapterBundleMetadata, refreshAdapterBundleIfAvailable } from "./adapter-update-manager.mjs";
import { bindContentBlocksToImages, composeRichArticleHtml, inspectArticleContentConsistency } from "./rich-content.mjs";
import { preparePlatformImageTasks } from "./platform-images.mjs";
import { profileLockPath, safeSegment, withProfileLock } from "./session-manager.mjs";
import { materializeVideoAssets, videoSafeId } from "./video-assets.mjs";
import { executeVideoPublication, readVideoSubmissionResult } from "./video-publication.mjs";

export const DESKTOP_CAPABILITIES = Object.freeze({ publish_video_v1: true, publish_video_schedule_v1: true, publish_article_v1: true });

export const DEFAULT_API_BASE_URL = process.env.ZHIXIN_API_BASE_URL || "http://127.0.0.1:3001";
export const DEFAULT_STATE_PATH = process.env.ZHIXIN_DESKTOP_STATE || path.join(homedir(), ".zhixin-ai", "desktop-agent.json");

let cachedAgentVersion = "";

// The version that matters for server-side gating is the one this running code
// actually ships, not the appVersion frozen into the device record at first
// registration. The packaged layout keeps a package.json one level above src/
// (resources/agent/package.json), and a dev checkout reads the workspace one,
// so the same lookup serves both.
export function agentVersion() {
  if (cachedAgentVersion) return cachedAgentVersion;
  let version = "";
  try {
    const parsed = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    version = String(parsed?.version || "").trim();
  } catch {
    version = "";
  }
  // An unknown version must never satisfy a server-side floor: cleanup deletes
  // local files, so the safe answer is "too old to be trusted".
  cachedAgentVersion = version || "0.0.0";
  return cachedAgentVersion;
}

export function currentPlatform() {
  const value = osPlatform();
  if (value === "win32") return "windows";
  if (value === "darwin") return "macos";
  return "linux";
}

const DEVICE_TOKEN_CREDENTIAL_KEY = "desktop-device-token";
const runtimeDeviceTokens = new Map();

function defaultCredentialPath(statePath) {
  const stateName = path.basename(statePath || DEFAULT_STATE_PATH).replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(path.dirname(statePath || DEFAULT_STATE_PATH), ".credentials", `${stateName}.${DEVICE_TOKEN_CREDENTIAL_KEY}`);
}

function helperCredentialStore(helperPath) {
  async function invoke(action, value = "") {
    return new Promise((resolve, reject) => {
      const child = spawn(helperPath, ["__credential", action, DEVICE_TOKEN_CREDENTIAL_KEY], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(stderr.trim() || `CREDENTIAL_HELPER_FAILED: ${action}`));
      });
      child.stdin.end(value);
    });
  }
  return {
    get: (key) => invoke("get", key),
    set: (_key, value) => invoke("set", value),
    delete: (key) => invoke("delete", key)
  };
}

function fileCredentialStore(statePath) {
  const tokenPath = defaultCredentialPath(statePath);
  return {
    async get() {
      const explicit = process.env.ZHIXIN_DEVICE_TOKEN || "";
      if (explicit) return explicit;
      return (await readFile(tokenPath, "utf8").catch(() => "")).trim();
    },
    async set(_key, value) {
      await mkdir(path.dirname(tokenPath), { recursive: true });
      await writeFile(tokenPath, String(value), { encoding: "utf8", mode: 0o600 });
    },
    async delete() {
      await unlink(tokenPath).catch(() => undefined);
    }
  };
}

function resolveCredentialStore(statePath, options = {}) {
  if (options.credentialStore) return options.credentialStore;
  const helperPath = options.credentialHelper || process.env.ZHIXIN_CREDENTIAL_HELPER;
  if (helperPath) return helperCredentialStore(helperPath);
  return fileCredentialStore(statePath);
}

export async function readState(statePath = DEFAULT_STATE_PATH, options = {}) {
  let persisted;
  try {
    persisted = JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    persisted = {};
  }

  const credentialStore = resolveCredentialStore(statePath, options);
  const legacyToken = typeof persisted.deviceToken === "string" ? persisted.deviceToken : "";
  let deviceToken = await credentialStore.get(DEVICE_TOKEN_CREDENTIAL_KEY).catch(() => "");
  if (!deviceToken && legacyToken) {
    await credentialStore.set(DEVICE_TOKEN_CREDENTIAL_KEY, legacyToken);
    deviceToken = legacyToken;
    const { deviceToken: _removed, ...sanitized } = persisted;
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify(sanitized, null, 2), "utf8");
    persisted = sanitized;
  }
  return deviceToken ? { ...persisted, deviceToken } : persisted;
}

export async function writeState(statePath, state, options = {}) {
  const credentialStore = resolveCredentialStore(statePath, options);
  const { deviceToken, ...persisted } = state || {};
  if (deviceToken) await credentialStore.set(DEVICE_TOKEN_CREDENTIAL_KEY, String(deviceToken));
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(persisted, null, 2), "utf8");
}

export async function readLog(options = {}) {
  const statePath = options.statePath || DEFAULT_STATE_PATH;
  const logPath = path.join(path.dirname(statePath), "desktop-agent.log");
  try {
    const text = await readFile(logPath, "utf8");
    return text.trim().split("\n").filter(Boolean).slice(-200).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

const AGENT_LOG_MAX_BYTES = 8 * 1024 * 1024;
const FAILURE_DETAIL_MAX_CHARS = 2000;

async function rotateAgentLog(logPath) {
  try {
    const stats = await stat(logPath);
    if (!stats.isFile() || stats.size < AGENT_LOG_MAX_BYTES) return;
    await rename(logPath, `${logPath}.1`);
  } catch {
    // A missing or unreadable log is never a reason to stop logging.
  }
}

export async function logLine(options, event, detail = {}) {
  const statePath = options.statePath || DEFAULT_STATE_PATH;
  const logPath = path.join(path.dirname(statePath), "desktop-agent.log");
  await mkdir(path.dirname(logPath), { recursive: true });
  // One append-only log grew to 32MB and buried the single failure line that mattered,
  // so keep a bounded pair of files instead of growing without a ceiling.
  await rotateAgentLog(logPath);
  await appendFile(logPath, JSON.stringify({ at: new Date().toISOString(), event, detail }) + "\n", "utf8");
}

function commandVisibilityPolicy(payload = {}, options = {}) {
  const allowForeground = payload.allowForeground === true || options.allowForeground === true;
  return {
    headless: options.headless === true || (!allowForeground && payload.headless !== false && options.headless !== false),
    keepBrowserOpen: payload.keepBrowserOpen === true || options.keepBrowserOpen === true,
    allowForeground
  };
}

export function processIsAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch {
    return false;
  }
}

// Exported so the staleness rules can be exercised directly; the watcher lock is
// the one place where a wrong guess either strands a watcher or double-runs it.
export async function acquireWatchLock(options = {}) {
  const statePath = options.statePath || DEFAULT_STATE_PATH;
  const lockPath = path.join(path.dirname(statePath), "desktop-agent.watch.lock");
  await mkdir(path.dirname(lockPath), { recursive: true });
  try {
    const existing = await readFile(lockPath, "utf8");
    if (watchLockIsCurrent(parseWatchLock(existing))) return null;
    await unlink(lockPath).catch(() => undefined);
  } catch {
    // No existing lock, or it is unreadable. Try to acquire below.
  }
  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(watchLockStamp(), "utf8");
    const release = async () => {
      await handle.close().catch(() => undefined);
      const current = await readFile(lockPath, "utf8").catch(() => "");
      if (Number(parseWatchLock(current)?.pid) === process.pid) await unlink(lockPath).catch(() => undefined);
    };
    return { lockPath, release };
  } catch {
    return null;
  }
}

// A wedged watcher holds a live pid forever, so pid liveness alone made every
// second watcher exit with already_running until somebody killed the first one
// by hand. The stamp is refreshed each loop turn, so silence for longer than the
// profile-lock staleness window means the owner is gone even though its pid
// still answers.
const WATCH_LOCK_STALE_MS = 10 * 60 * 1000;

function watchLockStamp() {
  return JSON.stringify({ pid: process.pid, heartbeatAt: new Date().toISOString() });
}

export function parseWatchLock(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
  }
  // Locks written before the stamp existed hold a bare pid, and a bare number is
  // itself valid JSON, so this branch is the only place that form is read.
  // Returning early on a non-object parse instead would make every legacy lock
  // look ownerless and hand it to a second watcher while the first still runs.
  const pid = Number(text);
  return Number.isInteger(pid) && pid > 0 ? { pid } : null;
}

export function watchLockIsCurrent(lock, now = Date.now()) {
  const pid = Number(lock?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (!processIsAlive(pid)) return false;
  const heartbeatAt = Date.parse(String(lock?.heartbeatAt || ""));
  // A bare-pid lock carries no stamp, so a live pid is the only signal.
  if (!Number.isFinite(heartbeatAt) || heartbeatAt <= 0) return true;
  return now - heartbeatAt <= WATCH_LOCK_STALE_MS;
}

// Returns false when another watcher has taken the lock over, which is the one
// case where two loops would otherwise run side by side.
export async function touchWatchLock(lock) {
  try {
    // Read first. A watcher that was judged silent and had its lock taken over
    // must notice before refreshing the new owner's stamp, otherwise the
    // takeover is silently undone and two loops run side by side again.
    const current = await readFile(lock.lockPath, "utf8").catch(() => "");
    const owner = parseWatchLock(current);
    if (owner && Number(owner.pid) !== process.pid) return false;
    await writeFile(lock.lockPath, watchLockStamp(), "utf8");
    const written = await readFile(lock.lockPath, "utf8").catch(() => "");
    return Number(parseWatchLock(written)?.pid) === process.pid;
  } catch {
    // A failed touch only shortens our own lease; it must not evict a healthy
    // watcher from its own loop.
    return true;
  }
}

// Contention used to be visible only in the local log, so a device stuck in
// already_running looked identical to one that was never started. Report it,
// but read state directly: ensureRegistered would re-register the device and
// overwrite credentials the running watcher still needs.
async function reportWatchLockContention(options = {}) {
  try {
    const state = await readState(options.statePath || DEFAULT_STATE_PATH, options);
    if (!state.device?.id || !state.deviceToken) return;
    await desktopApiRequest(options.apiBaseUrl || DEFAULT_API_BASE_URL, state, "/api/desktop-events", {
      method: "POST",
      body: JSON.stringify({
        deviceId: state.device.id,
        type: "watch_lock_contended",
        payload: { pid: process.pid, at: new Date().toISOString() }
      })
    });
  } catch {
    // Best effort only: never block the exit path on an observability call.
  }
}

function safeAssetUrl(apiBaseUrl, value) {
  if (!value) return null;
  const base = new URL(apiBaseUrl);
  const resolved = new URL(String(value), base);
  if (resolved.origin !== base.origin || !resolved.pathname.startsWith("/uploads/")) {
    throw new Error("DESKTOP_ASSET_URL_NOT_ALLOWED");
  }
  return resolved;
}

async function downloadCommandAsset(apiBaseUrl, directory, value, fallbackName) {
  const url = safeAssetUrl(apiBaseUrl, value);
  if (!url) return "";
  const response = await fetch(url);
  if (!response.ok) throw new Error(`DESKTOP_ASSET_DOWNLOAD_FAILED: HTTP ${response.status}`);
  const sourceName = path.basename(url.pathname) || fallbackName;
  const filename = sourceName.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const target = path.join(directory, filename || fallbackName);
  await writeFile(target, Buffer.from(await response.arrayBuffer()));
  return target;
}

async function materializePublishAssets(apiBaseUrl, statePath, command, payload) {
  const directory = path.join(path.dirname(statePath), "publication-assets", command.id);
  await mkdir(directory, { recursive: true });
  const coverImagePath = payload.coverImageUrl
    ? await downloadCommandAsset(apiBaseUrl, directory, payload.coverImageUrl, "cover.jpg")
    : payload.coverImagePath || "";
  const inlineImages = [];
  for (const [index, image] of (Array.isArray(payload.inlineImages) ? payload.inlineImages : []).entries()) {
    const localPath = image?.url
      ? await downloadCommandAsset(apiBaseUrl, directory, image.url, `inline-${index + 1}.jpg`)
      : image?.path || "";
    const extension = path.extname(localPath || image?.url || "").toLowerCase();
    const mimeType = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : extension === ".gif" ? "image/gif" : "image/jpeg";
    const dataUrl = localPath ? `data:${mimeType};base64,${(await readFile(localPath)).toString("base64")}` : "";
    inlineImages.push({ ...image, path: localPath, dataUrl });
  }
  const contentBlocks = bindContentBlocksToImages(payload.contentBlocks, inlineImages);
  const skippedImageBlocks = [];
  const platformImageTasks = await preparePlatformImageTasks(contentBlocks, inlineImages, (skipped) => {
    skippedImageBlocks.push(skipped);
  });
  return {
    ...payload,
    coverImagePath,
    inlineImages,
    contentBlocks,
    platformImageTasks,
    skippedImageBlocks,
    contentHtml: composeRichArticleHtml(contentBlocks),
    contentHtmlWithoutImages: composeRichArticleHtml(contentBlocks, { includeImages: false })
  };
}

export async function apiRequest(apiBaseUrl, url, init = {}) {
  const response = await fetch(`${apiBaseUrl}${url}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers || {})
    }
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const detail = payload?.detail || text || `HTTP_${response.status}`;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return payload;
}

export function desktopHeaders(state = {}) {
  const deviceId = String(state?.device?.id || "").trim();
  const deviceToken = String(state?.deviceToken || "").trim();
  if (!deviceId || !deviceToken) throw new Error("DESKTOP_DEVICE_AUTH_REQUIRED");
  return {
    "x-device-id": deviceId,
    "x-device-token": deviceToken
  };
}

async function desktopApiRequest(apiBaseUrl, state, url, init = {}) {
  return apiRequest(apiBaseUrl, url, {
    ...init,
    headers: {
      ...desktopHeaders(state),
      ...(init.headers || {})
    }
  });
}

function isDesktopDeviceAuthError(error) {
  const message = String(error?.message || error || "");
  return message.includes("DESKTOP_DEVICE_AUTH_REQUIRED") || message === "Not Found" || message.includes("HTTP_404");
}

export function openUrl(url) {
  const command = currentPlatform() === "windows" ? "cmd" : currentPlatform() === "macos" ? "open" : "xdg-open";
  const args = currentPlatform() === "windows" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

export function profileRoot(statePath = DEFAULT_STATE_PATH) {
  return path.join(path.dirname(statePath), "profiles");
}

function resolvedLoginUrl(sessionLoginUrl, adapterLoginUrl) {
  const value = String(sessionLoginUrl || "").trim();
  if (!value || value === "about:blank") return adapterLoginUrl;
  return value;
}

async function refreshCommandAdapterBundle(options = {}, apiBaseUrl = DEFAULT_API_BASE_URL) {
  const refresh = options.refreshAdapterBundleIfAvailable || refreshAdapterBundleIfAvailable;
  try {
    const result = await refresh({
      ...options,
      apiBaseUrl,
      statePath: options.statePath || DEFAULT_STATE_PATH,
    });
    if (result?.status === "failed") {
      await logLine(options, "adapter_bundle.refresh_failed", { error: result.errorMessage || "ADAPTER_BUNDLE_REFRESH_FAILED" });
    }
    // A rejected refresh is the quiet failure mode: the device keeps running the
    // adapter it already has, every command still succeeds, and nothing on the
    // server shows that a fix never landed. Log it with the same weight as a
    // hard failure so a stale bundle is visible instead of inferred.
    if (result?.status === "rejected") {
      await logLine(options, "adapter_bundle.refresh_rejected", {
        reason: result.reason || "",
        bundleVersion: result.metadata?.bundleVersion || "",
        installedAt: result.metadata?.installedAt || "",
      });
    }
    return result;
  } catch (error) {
    await logLine(options, "adapter_bundle.refresh_failed", { error: error instanceof Error ? error.message : String(error) });
    return { status: "failed", errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

async function adapterBundleVersionFor(adapter, statePath) {
  if (adapter?.adapterBundleVersion) return adapter.adapterBundleVersion;
  const metadata = await currentAdapterBundleMetadata(path.dirname(statePath || DEFAULT_STATE_PATH)).catch(() => null);
  const platform = String(adapter?.platform || "").toLowerCase();
  return metadata?.platforms?.[platform] || "";
}

function withAdapterBundleVersion(result = {}, version = "") {
  if (!version) return result;
  return { ...result, adapterBundleVersion: version };
}

function decodeArtifactEnvelope(artifact = {}, fields = [], prefix = "") {
  const envelope = String(fields.map((field) => artifact[field]).find(Boolean) || "");
  if (!envelope.startsWith(prefix)) return [];
  try {
    const payload = JSON.parse(Buffer.from(envelope.slice(prefix.length), "base64url").toString("utf8"));
    if (Array.isArray(payload.cookies)) return payload.cookies;
    if (payload.values && typeof payload.values === "object") return payload.values;
  } catch {
    return prefix.includes("storage") ? {} : [];
  }
  return [];
}

function decodeArtifactCookies(artifact = {}) {
  const decoded = decodeArtifactEnvelope(artifact, ["encryptedCookies", "cookies"], "encrypted-cookie-");
  return Array.isArray(decoded) ? decoded : [];
}

function decodeArtifactStorage(artifact = {}, type = "localStorage") {
  const fields = type === "sessionStorage"
    ? ["encryptedSessionStorage", "sessionStorage"]
    : ["encryptedLocalStorage", "localStorage"];
  const prefix = type === "sessionStorage" ? "encrypted-session-storage-" : "encrypted-local-storage-";
  const decoded = decodeArtifactEnvelope(artifact, fields, prefix);
  return decoded && !Array.isArray(decoded) && typeof decoded === "object" ? decoded : {};
}

async function readCommandAuthArtifact(apiBaseUrl, state, command = {}, account = {}) {
  const accountId = String(command.mediaAccountId || account.id || "");
  if (!accountId || !state?.device?.id || !state.deviceToken) {
    return { cookies: [], localStorage: {}, sessionStorage: {}, profileKey: "", platformConfig: {}, capabilities: {} };
  }
  const detail = await desktopApiRequest(
    apiBaseUrl,
    state,
    `/api/desktop-devices/${encodeURIComponent(state.device.id)}/media-accounts/${encodeURIComponent(accountId)}/artifact`,
    {
      method: "POST",
      body: JSON.stringify({ deviceToken: state.deviceToken })
    }
  );
  const artifact = detail?.artifact || {};
  return {
    cookies: decodeArtifactCookies(artifact),
    localStorage: decodeArtifactStorage(artifact, "localStorage"),
    sessionStorage: decodeArtifactStorage(artifact, "sessionStorage"),
    profileKey: String(detail?.profileKey || account.profileKey || command.payload?.profileKey || command.payload?.sessionId || ""),
    platformConfig: artifact.platformConfig && typeof artifact.platformConfig === "object" ? artifact.platformConfig : {},
    capabilities: artifact.capabilities && typeof artifact.capabilities === "object" ? artifact.capabilities : {}
  };
}

async function refreshCommandAuthArtifact(apiBaseUrl, state, command, account, profileKey, artifact) {
  const accountId = String(command.mediaAccountId || account?.id || "");
  if (!accountId || !artifact || !state?.device?.id || !state.deviceToken) return null;
  return desktopApiRequest(
    apiBaseUrl,
    state,
    `/api/desktop-devices/${encodeURIComponent(state.device.id)}/media-accounts/${encodeURIComponent(accountId)}/artifacts/refresh`,
    {
      method: "POST",
      body: JSON.stringify({
        deviceToken: state.deviceToken,
        profileKey,
        artifact
      })
    }
  );
}

export async function ensureRegistered(options = {}) {
  const apiBaseUrl = options.apiBaseUrl || DEFAULT_API_BASE_URL;
  const statePath = options.statePath || DEFAULT_STATE_PATH;
  const state = await readState(statePath, options);
  if (state.device?.id && state.deviceToken && !options.forceRegister) {
    try {
      const verified = await desktopApiRequest(apiBaseUrl, state, `/api/desktop-devices/${encodeURIComponent(state.device.id)}/verify`, {
        method: "POST",
        body: JSON.stringify({ deviceToken: state.deviceToken })
      });
      const nextState = {
        ...state,
        apiBaseUrl,
        device: verified.device || state.device,
        updatedAt: new Date().toISOString()
      };
      await writeState(statePath, nextState, options);
      return nextState;
    } catch (error) {
      if (!isDesktopDeviceAuthError(error)) throw error;
      await logLine({ ...options, statePath }, "device.stale", { deviceId: state.device.id, errorMessage: String(error?.message || error) });
    }
  }

  const result = await apiRequest(apiBaseUrl, "/api/desktop-devices/register", {
    method: "POST",
    body: JSON.stringify({
      deviceName: options.deviceName || "智心AI桌面授权端",
      platform: currentPlatform(),
      appVersion: options.appVersion || agentVersion(),
      capabilities: DESKTOP_CAPABILITIES,
      publicKey: options.publicKey || "desktop-mvp-public-key"
    })
  });
  const nextState = {
    ...state,
    apiBaseUrl,
    device: result.device,
    deviceToken: result.deviceToken,
    updatedAt: new Date().toISOString()
  };
  await writeState(statePath, nextState, options);
  await logLine({ ...options, statePath }, "device.register", { deviceId: result.device.id });
  return nextState;
}

export async function registerDevice(options = {}) {
  const state = await ensureRegistered(options);
  return { device: state.device, statePath: options.statePath || DEFAULT_STATE_PATH };
}

export async function bindOwner(options = {}) {
  if (!options.bindingId || !options.pairingCode) {
    throw new Error("DESKTOP_OWNER_BINDING_REQUIRED");
  }
  const apiBaseUrl = options.apiBaseUrl || DEFAULT_API_BASE_URL;
  const statePath = options.statePath || DEFAULT_STATE_PATH;
  const state = await ensureRegistered(options);
  const claimed = await desktopApiRequest(
    apiBaseUrl,
    state,
    `/api/desktop-devices/${encodeURIComponent(state.device.id)}/owner-bindings/${encodeURIComponent(options.bindingId)}/claim`,
    {
      method: "POST",
      body: JSON.stringify({ pairingCode: options.pairingCode })
    }
  );
  const nextState = {
    ...state,
    apiBaseUrl,
    device: claimed.device || state.device,
    updatedAt: new Date().toISOString()
  };
  await writeState(statePath, nextState, options);
  await logLine({ ...options, statePath }, "device.owner_bound", {
    deviceId: nextState.device.id,
    ownerId: nextState.device.boundOwnerId || ""
  });
  return {
    ...claimed,
    device: nextState.device,
    statePath
  };
}

export async function heartbeat(options = {}) {
  const apiBaseUrl = options.apiBaseUrl || DEFAULT_API_BASE_URL;
  const state = await ensureRegistered(options);
  const event = await desktopApiRequest(apiBaseUrl, state, "/api/desktop-events", {
    method: "POST",
    body: JSON.stringify({
      deviceId: state.device.id,
      type: "heartbeat",
      // Report the version this process actually runs. The stored value was
      // frozen at first registration and never followed agent updates, which is
      // how a device ends up permanently below a server-side version floor.
      payload: { appVersion: agentVersion(), platform: state.device.platform, capabilities: DESKTOP_CAPABILITIES }
    })
  });
  await logLine(options, "heartbeat", { deviceId: state.device.id });
  return event;
}

export async function runAuth(options = {}) {
  if (!options.sessionId || !options.pairingCode) {
    throw new Error("AUTH_SESSION_REQUIRED: pass --session-id and --pairing-code");
  }
  const apiBaseUrl = options.apiBaseUrl || DEFAULT_API_BASE_URL;
  const state = await ensureRegistered(options);
  const deviceId = state.device.id;

  const claimed = await desktopApiRequest(apiBaseUrl, state, `/api/desktop-devices/${deviceId}/media-auth-sessions/${options.sessionId}/claim`, {
    method: "POST",
    body: JSON.stringify({ pairingCode: options.pairingCode, deviceToken: state.deviceToken })
  });
  const session = claimed.session;
  let adapter;
  let bound;
  const keepBrowserOpen = options.keepBrowserOpen === true;
  try {
    // Foreground/deep-link authorization bypasses executeCommand's refresh.
    if (!options.adapter) await refreshCommandAdapterBundle(options, apiBaseUrl);
    adapter = options.adapter || await getAdapter(session.platform || options.platform, { statePath: options.statePath || DEFAULT_STATE_PATH });
    const loginUrl = resolvedLoginUrl(session.loginUrl, adapter.loginUrl);
    if (options.openBrowser && loginUrl && adapter.platform !== "zhihu") openUrl(loginUrl);

    await desktopApiRequest(apiBaseUrl, state, "/api/desktop-events", {
      method: "POST",
      body: JSON.stringify({
        deviceId,
        sessionId: session.id,
        type: "browser_opened",
        payload: { url: loginUrl }
      })
    });

    const loggedIn = await adapter.detectLoggedIn({
      sessionId: session.id,
      accountName: options.accountName,
      profileRoot: profileRoot(options.statePath),
      waitLoginMs: options.waitLoginMs,
      loginUrl,
      keepBrowserOpen,
      headless: options.headless
    });
    if (!loggedIn) throw new Error("LOGIN_NOT_DETECTED");

    await desktopApiRequest(apiBaseUrl, state, "/api/desktop-events", {
      method: "POST",
      body: JSON.stringify({
        deviceId,
        sessionId: session.id,
        type: "login_detected",
        payload: { platform: session.platform || adapter.platform }
      })
    });

    const profile = await adapter.readAccountProfile({
      accountName: options.accountName,
      profileRoot: profileRoot(options.statePath)
    });

    await desktopApiRequest(apiBaseUrl, state, "/api/desktop-events", {
      method: "POST",
      body: JSON.stringify({
        deviceId,
        sessionId: session.id,
        type: "capture_started",
        payload: { accountName: profile.accountName }
      })
    });

    const artifact = await adapter.collectAuthArtifact({
      sessionId: session.id,
      accountName: profile.accountName,
      profileRoot: profileRoot(options.statePath),
      keepBrowserOpen
    });

    await desktopApiRequest(apiBaseUrl, state, `/api/media-auth-sessions/${session.id}/artifacts`, {
      method: "POST",
      body: JSON.stringify({
        deviceId,
        accountName: profile.accountName,
        avatar: profile.avatar,
        artifact
      })
    });

    bound = await desktopApiRequest(apiBaseUrl, state, `/api/media-auth-sessions/${session.id}/bind`, {
      method: "POST",
      body: JSON.stringify({ name: profile.accountName })
    });

  } catch (error) {
    // Foreground authorization has no executeCommand failure handler. Close the
    // server session here too, without masking the original failure if offline.
    await desktopApiRequest(apiBaseUrl, state, "/api/desktop-events", {
      method: "POST",
      signal: AbortSignal.timeout(3000),
      body: JSON.stringify({
        deviceId,
        sessionId: session.id,
        type: "auth_failed",
        payload: { errorMessage: sanitizeCommandFailure(error) }
      })
    }).catch(() => undefined);
    throw error;
  } finally {
    if (!keepBrowserOpen && adapter?.context?.close) {
      try {
        await adapter.context.close();
      } catch {
        // Browser closure must not hide the authorization result.
      }
      adapter.context = null;
      adapter.page = null;
    }
  }

  await logLine(options, "auth.bound", {
    sessionId: session.id,
    mediaAccountId: bound.mediaAccount.id,
    platform: session.platform,
    browserClosed: !keepBrowserOpen
  });
  return {
    session: bound.session,
    mediaAccount: bound.mediaAccount,
    statePath: options.statePath || DEFAULT_STATE_PATH
  };
}

export async function authorizePlatform(options = {}) {
  const apiBaseUrl = options.apiBaseUrl || DEFAULT_API_BASE_URL;
  const state = await ensureRegistered(options);
  const platform = options.platform || "zhihu";
  const created = await desktopApiRequest(apiBaseUrl, state, "/api/media-auth-sessions", {
    method: "POST",
    body: JSON.stringify({
      platform,
      mediaAccountId: options.mediaAccountId || "",
      deviceId: state.device.id,
      queueDesktopCommand: false,
      keepBrowserOpen: options.keepBrowserOpen === true,
      waitLoginMs: options.waitLoginMs || 300000
    })
  });
  await logLine(options, "auth.session_created", { sessionId: created.session.id, platform });
  return runAuth({
    ...options,
    apiBaseUrl,
    sessionId: created.session.id,
    pairingCode: created.session.pairingCode,
    platform,
    keepBrowserOpen: options.keepBrowserOpen === true,
    waitLoginMs: options.waitLoginMs || 300000
  });
}

// Platform failure codes travel as opcodes inside free-form adapter messages, so
// one pattern both extracts them from a thrown error and proves one is absent
// from a returned result.
const PLATFORM_FAILURE_OPCODE_PATTERN = /\b(?:BAIJIAHAO|CSDN|PENGUIN|SOHU|TOUTIAO|NETEASE|ZHIHU|JIANSHU|AUTH|SESSION|PLATFORM|ADAPTER|DESKTOP|MEDIA|INLINE|UPLOAD|PUBLICATION)_[A-Z0-9_]+\b/;

export function sanitizeCommandFailure(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  const match = message.match(PLATFORM_FAILURE_OPCODE_PATTERN);
  return match ? match[0].slice(0, 240) : "DESKTOP_COMMAND_EXECUTION_FAILED";
}

// An adapter can also end without throwing and without publishing: a draft-only
// save, a blocked account, a platform that queued nothing. Those used to be sent
// as publish_succeeded, which the server turned into accepted media orders for
// articles nobody ever submitted. Report the same opcode-plus-raw-message pair
// the catch path uses, so a returned draft is visibly a failure.
function publicationFailureFields(result = {}, platform = "") {
  const raw = String(result?.message || "").trim();
  const opcode = raw.match(PLATFORM_FAILURE_OPCODE_PATTERN);
  const status = String(result?.platformStatus || "").trim().toUpperCase();
  const fallback = `${String(platform || "DESKTOP").toUpperCase()}_${[status, "NOT_PUBLISHED"].filter(Boolean).join("_")}`;
  return {
    errorMessage: opcode ? opcode[0].slice(0, 240) : fallback,
    errorDetail: raw || fallback
  };
}

// The stored failure code is reduced to a platform token on purpose, but that
// also erased the real cause once, so keep the raw message and stack beside it
// in the desktop log instead of leaving only the sanitized opcode behind.
export function commandFailureDetail(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : "";
  return {
    errorDetail: message.slice(0, FAILURE_DETAIL_MAX_CHARS),
    errorStack: stack.slice(0, FAILURE_DETAIL_MAX_CHARS)
  };
}

// A mid-flight observation from an adapter must never overwrite the sanitized
// failure code that the server stores.
const PUBLICATION_EVIDENCE_RESERVED_KEYS = new Set([
  "errorMessage",
  "errorDetail",
  "errorStack",
  "deviceId",
  "deviceToken",
  "type",
  "startedAt"
]);

// Adapters learn a platform article identity long before they finish, and they
// throw after that point often enough that one real CSDN article id was lost for
// good. Everything reported here is replayed alongside the failure.
function createPublicationEvidenceSink() {
  const evidence = {};
  return {
    evidence,
    report(patch = {}) {
      if (!patch || typeof patch !== "object") return;
      for (const [key, value] of Object.entries(patch)) {
        if (PUBLICATION_EVIDENCE_RESERVED_KEYS.has(key) || value === undefined || value === null) continue;
        evidence[key] = value;
      }
    }
  };
}

// Platform statuses that mean the article actually reached the platform. A
// draft-only save is not one of them, and treating it as success is what made a
// saved-but-never-submitted Toutiao draft look published.
const PUBLISHED_PLATFORM_STATUSES = new Set([
  "published",
  "submitted_for_review",
  "published_restricted"
]);

// A command only stays claimable while nobody has closed it. findQueuedCommand
// reads a list snapshot, so the status it saw can be stale by the time the
// adapter opens a browser, and re-running a closed command publishes the
// article a second time.
const CLAIMABLE_COMMAND_STATUSES = new Set(["queued", "running"]);

async function listDesktopCommands(apiBaseUrl, state) {
  const commands = await desktopApiRequest(apiBaseUrl, state, "/api/desktop-commands", {
    headers: {
      "x-device-id": state.device.id,
      "x-device-token": state.deviceToken
    }
  });
  return Array.isArray(commands) ? commands : [];
}

// Re-read the command from the same list endpoint the snapshot came from: one
// endpoint to trust instead of two, and an endpoint that cannot answer here
// could not have answered the snapshot either. A status that cannot be read
// stops the command rather than guessing, because guessing wrong is a second
// publish while stopping only costs one poll.
async function readCommandForExecution(apiBaseUrl, state, command) {
  const commandId = String(command?.id || "");
  if (!commandId) return { command: null, reason: "DESKTOP_COMMAND_ID_MISSING" };
  let commands;
  try {
    commands = await listDesktopCommands(apiBaseUrl, state);
  } catch (error) {
    return {
      command: null,
      reason: `command status unreadable: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  const fresh = commands.find((item) => String(item?.id || "") === commandId) || null;
  return { command: fresh, reason: fresh ? "" : "DESKTOP_COMMAND_NOT_FOUND" };
}

// The event endpoint answers a late write to an already-terminal command with
// 409 and this detail. That is the endpoint doing its job, not this command
// failing, so it must never be reported as one.
function commandAlreadyTerminal(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return message.includes("DESKTOP_COMMAND_ALREADY_TERMINAL");
}

export async function executeCommand(options = {}, command) {
  const apiBaseUrl = options.apiBaseUrl || DEFAULT_API_BASE_URL;
  const state = await ensureRegistered(options);
  // The snapshot in hand can be one poll old, so confirm the command is still
  // claimable before anything irreversible happens. Skipping is the cheap
  // outcome: the adapter, the browser profile and the platform stay untouched.
  const recheck = await readCommandForExecution(apiBaseUrl, state, command);
  if (!recheck.command || !CLAIMABLE_COMMAND_STATUSES.has(String(recheck.command.status || ""))) {
    const reason = recheck.reason || "DESKTOP_COMMAND_ALREADY_TERMINAL";
    await logLine(options, "command.skipped", {
      commandId: command.id,
      status: recheck.command?.status || "",
      reason
    });
    return { command: recheck.command || command, skipped: reason };
  }
  try {
    await desktopApiRequest(apiBaseUrl, state, `/api/desktop-commands/${command.id}/events`, {
      method: "POST",
      body: JSON.stringify({
        deviceId: state.device.id,
        deviceToken: state.deviceToken,
        type: ["publish_article", "publish_video"].includes(command.type) ? "publish_started" : "running",
        payload: { startedAt: new Date().toISOString(), ...(command.type==='publish_video' && command.payload?.publishMode==='scheduled' ? {executionCapabilities:DESKTOP_CAPABILITIES} : {}) }
      })
    });
  } catch (error) {
    // The re-check narrows the window but cannot close it: the command can go
    // terminal in the gap between the two reads. Falling through to the catch
    // below would file a failure against a command somebody else finished.
    if (!commandAlreadyTerminal(error)) throw error;
    await logLine(options, "command.skipped", {
      commandId: command.id,
      reason: "DESKTOP_COMMAND_ALREADY_TERMINAL"
    });
    return { command, skipped: "DESKTOP_COMMAND_ALREADY_TERMINAL" };
  }

  const publicationEvidence = createPublicationEvidenceSink();
  try {
    if (command.type === "cleanup_assets") {
      const payload = command.payload || {};
      const cleanupResult = await cleanupLocalAssets({
        ...options,
        apiBaseUrl,
        keepProfileKeys: payload.keepProfileKeys,
        assetsKeep: payload.assetsKeep,
        assetsMaxAgeDays: payload.assetsMaxAgeDays,
        profilesMaxAgeDays: payload.profilesMaxAgeDays
      });
      const completed = await desktopApiRequest(apiBaseUrl, state, `/api/desktop-commands/${command.id}/events`, {
        method: "POST",
        body: JSON.stringify({
          deviceId: state.device.id,
          deviceToken: state.deviceToken,
          type: "cleanup_succeeded",
          payload: cleanupResult
        })
      });
      await logLine(options, "assets.cleanup_succeeded", {
        commandId: command.id,
        dryRun: cleanupResult.dryRun,
        deleted: cleanupResult.deleted,
        freedBytes: cleanupResult.freedBytes,
        profilesDeleted: cleanupResult.profiles.deleted,
        profilesSkipped: cleanupResult.profiles.skipped
      });
      return completed;
    }

    const adapterRefresh = await refreshCommandAdapterBundle(options, apiBaseUrl);
    if (command.type === "open_auth") {
      const payload = command.payload || {};
      const authResult = await runAuth({
        ...options,
        apiBaseUrl,
        sessionId: payload.sessionId,
        pairingCode: payload.pairingCode,
        platform: payload.platform || options.platform,
        accountName: payload.accountName || options.accountName,
        waitLoginMs: payload.waitLoginMs || options.waitLoginMs,
        // Only keep browser when explicitly true (auth success closes Chrome by default).
        keepBrowserOpen: payload.keepBrowserOpen === true || options.keepBrowserOpen === true,
        headless: payload.headless ?? options.headless,
        allowForeground: true
      });
      const completed = await desktopApiRequest(apiBaseUrl, state, `/api/desktop-commands/${command.id}/events`, {
        method: "POST",
        body: JSON.stringify({
          deviceId: state.device.id,
          deviceToken: state.deviceToken,
          sessionId: authResult.session.id,
          type: "auth_succeeded",
          payload: {
            sessionId: authResult.session.id,
            mediaAccountId: authResult.mediaAccount.id,
            accountName: authResult.mediaAccount.name,
            platform: authResult.mediaAccount.platform,
            adapterBundleVersion: adapterRefresh?.metadata?.bundleVersion || ""
          }
        })
      });
      await logLine(options, "auth.command_succeeded", { commandId: command.id, sessionId: authResult.session.id, mediaAccountId: authResult.mediaAccount.id });
      return completed;
    }

    if (!["publish_article", "publish_video", "discover_publication", "validate_session"].includes(command.type)) throw new Error(`UNSUPPORTED_COMMAND: ${command.type}`);
    const account = command.mediaAccountId
      ? await desktopApiRequest(apiBaseUrl, state, `/api/media-accounts/${command.mediaAccountId}`).catch(() => null)
      : null;
    const adapter = options.adapter || await getAdapter(account?.platform || command.payload?.platform || options.platform, {
      statePath: options.statePath || DEFAULT_STATE_PATH,
      onHotAdapterError: (error) => logLine(options, "adapter_bundle.load_failed", {
        platform: account?.platform || command.payload?.platform || options.platform || "",
        error: error instanceof Error ? error.message : String(error)
      })
    });
    const adapterBundleVersion = await adapterBundleVersionFor(adapter, options.statePath || DEFAULT_STATE_PATH);
    const authArtifact = await readCommandAuthArtifact(apiBaseUrl, state, command, account || {});
    const root = profileRoot(options.statePath);
    const platform = account?.platform || command.payload?.platform || adapter.platform || options.platform || "other";
    const profileKey = authArtifact.profileKey
      || account?.profileKey
      || command.payload?.profileKey
      || command.payload?.sessionId
      || command.mediaAccountId
      || "default";
    const refreshCredential = async (artifact) => {
      await refreshCommandAuthArtifact(apiBaseUrl, state, command, account, profileKey, artifact)
        .catch((error) => logLine(options, "credential.refresh_failed", {
          commandId: command.id,
          mediaAccountId: command.mediaAccountId || "",
          error: error instanceof Error ? error.message : String(error)
        }));
    };
    if (command.type === "publish_article") {
      const contentWarning = inspectArticleContentConsistency(command.payload || {});
      if (contentWarning) {
        await logLine(options, "publish.content_warning", { commandId: command.id, ...contentWarning });
        await desktopApiRequest(apiBaseUrl, state, `/api/desktop-commands/${command.id}/events`, {
          method: "POST",
          body: JSON.stringify({ deviceId: state.device.id, deviceToken: state.deviceToken,
            type: "publish_progress", payload: { stage: "content_consistency_warning", ...contentWarning } })
        }).catch(() => undefined);
      }
    }
    const commandPayload = command.type === "publish_article"
      ? await materializePublishAssets(apiBaseUrl, options.statePath || DEFAULT_STATE_PATH, command, command.payload || {})
      : command.payload || {};
    for (const skipped of commandPayload.skippedImageBlocks || []) {
      await logLine(options, "publish.image_block_skipped", { commandId: command.id, ...skipped });
    }
    const visibilityPolicy = commandVisibilityPolicy(commandPayload, options);
    const sharedInput = {
      ...commandPayload,
      ...visibilityPolicy,
      mediaAccountId: command.mediaAccountId || account?.id || "",
      profileKey,
      profileRoot: root,
      cookies: authArtifact.cookies,
      localStorage: authArtifact.localStorage,
      sessionStorage: authArtifact.sessionStorage,
      expectedAccountId: account?.platformConfig?.accountId || authArtifact.platformConfig?.accountId || "",
      platformConfig: account?.platformConfig || authArtifact.platformConfig || {},
      capabilities: account?.capabilities || authArtifact.capabilities || {},
      evidenceSink: publicationEvidence.report,
      onCredentialRefresh: refreshCredential
    };

    return await withProfileLock({
      profileRoot: root,
      platform,
      profileKey,
      mediaAccountId: command.mediaAccountId || account?.id || ""
    }, async () => {
      if (command.type === "publish_video") {
        const directory = path.join(path.dirname(options.statePath || DEFAULT_STATE_PATH), "publication-assets", videoSafeId(command.id));
        await mkdir(directory, { recursive: true });
        const activeMarker = path.join(directory, ".video-active");
        await writeFile(activeMarker, String(process.pid), { mode: 0o600 });
        const reportProgress = async (event = {}) => {
          if (event.stage === "submitting" && options.watchLock && !await touchWatchLock(options.watchLock)) throw new Error("VIDEO_WATCH_OWNERSHIP_LOST");
          return desktopApiRequest(apiBaseUrl, state, `/api/desktop-commands/${command.id}/events`, {
          method: "POST",
          signal: AbortSignal.timeout(30000),
          body: JSON.stringify({ deviceId: state.device.id, deviceToken: state.deviceToken,
            type: event.type === "manual_verification_required" ? event.type : "publish_progress", payload: event })
          });
        };
        // Video uploads can outlast the ordinary watch polling interval. Keep
        // this device live while the single command is occupying the watcher.
        let heartbeatPending = false;
        const timer = setInterval(() => {
          const now = new Date();
          utimes(profileLockPath(root, platform, { profileKey, mediaAccountId: command.mediaAccountId }), now, now).catch(() => {});
          if (options.watchLock) touchWatchLock(options.watchLock).catch(() => {});
          if (heartbeatPending) return;
          heartbeatPending = true;
          desktopApiRequest(apiBaseUrl, state, "/api/desktop-events", { method: "POST", body: JSON.stringify({
            deviceId: state.device.id, type: "heartbeat", payload: { appVersion: agentVersion(), platform: state.device.platform, capabilities: DESKTOP_CAPABILITIES }
          }) }).catch(() => {}).finally(() => { heartbeatPending = false; });
        }, 20000);
        timer.unref();
        try {
          const result = withAdapterBundleVersion(await executeVideoPublication({
            statePath: options.statePath || DEFAULT_STATE_PATH, commandId: command.id, adapter,
            input: sharedInput, reportProgress,
            prepareInput: () => materializeVideoAssets({ apiBaseUrl, statePath: options.statePath || DEFAULT_STATE_PATH,
              command, headers: desktopHeaders(state), onProgress: reportProgress })
          }), adapterBundleVersion);
          publicationEvidence.report(result);
          const type = ["failed", "rejected"].includes(result.platformStatus) ? "publish_failed" : "publish_succeeded";
          return await desktopApiRequest(apiBaseUrl, state, `/api/desktop-commands/${command.id}/events`, {
            method: "POST", body: JSON.stringify({ deviceId: state.device.id, deviceToken: state.deviceToken, type, payload: result })
          });
        } finally {
          clearInterval(timer);
          await unlink(activeMarker).catch(() => {});
        }
      }
      if (command.type === "validate_session") {
        if (typeof adapter.validateSession !== "function") {
          throw new Error(`SESSION_VALIDATION_NOT_SUPPORTED: ${platform}`);
        }
        const result = withAdapterBundleVersion(await adapter.validateSession(sharedInput), adapterBundleVersion);
        if (result?.valid !== true) throw new Error(`${platform.toUpperCase()}_LOGIN_REQUIRED`);
        const completed = await desktopApiRequest(apiBaseUrl, state, `/api/desktop-commands/${command.id}/events`, {
          method: "POST",
          body: JSON.stringify({
            deviceId: state.device.id,
            deviceToken: state.deviceToken,
            type: "session_validation_succeeded",
            payload: result
          })
        });
        await logLine(options, "session.validation_succeeded", {
          commandId: command.id,
          mediaAccountId: command.mediaAccountId || "",
          platform
        });
        return completed;
      }

      if (command.type === "discover_publication") {
        if (typeof adapter.discoverPublication !== "function") {
          throw new Error(`PUBLICATION_DISCOVERY_NOT_SUPPORTED: ${platform}`);
        }
        const result = withAdapterBundleVersion(await adapter.discoverPublication(sharedInput), adapterBundleVersion);
        const completed = await desktopApiRequest(apiBaseUrl, state, `/api/desktop-commands/${command.id}/events`, {
          method: "POST",
          body: JSON.stringify({
            deviceId: state.device.id,
            deviceToken: state.deviceToken,
            type: "publication_discovery_succeeded",
            payload: result
          })
        });
        await logLine(options, "publication.discovery_succeeded", {
          commandId: command.id,
          found: Boolean(result.found),
          url: result.publicUrl || result.publishedUrl || ""
        });
        return completed;
      }

      let manualVerificationReported = false;
      const result = withAdapterBundleVersion(await adapter.publishArticle({
        ...sharedInput,
        onProgress: async (event = {}) => {
          if (!event.type) return;
          const eventType = ["publish_started", "publish_progress", "manual_verification_required"].includes(event.type)
            ? event.type
            : "publish_progress";
          if (eventType === "manual_verification_required") manualVerificationReported = true;
          const eventPayload = eventType === "publish_progress" && event.type !== "publish_progress"
            ? { ...event, type: undefined, stage: event.type }
            : { ...event, type: undefined };
          await desktopApiRequest(apiBaseUrl, state, `/api/desktop-commands/${command.id}/events`, {
            method: "POST",
            body: JSON.stringify({
              deviceId: state.device.id,
              deviceToken: state.deviceToken,
              sessionId: command.payload?.sessionId || "",
              type: eventType,
              payload: eventPayload
            })
          }).catch((error) => logLine(options, "command.progress_failed", {
            commandId: command.id,
            eventType: event.type,
            error: error instanceof Error ? error.message : String(error)
          }));
        }
      }), adapterBundleVersion);
      if (result?.platformStatus === "manual_verification_required") {
        let pending = null;
        if (!manualVerificationReported) {
          pending = await desktopApiRequest(apiBaseUrl, state, `/api/desktop-commands/${command.id}/events`, {
            method: "POST",
            body: JSON.stringify({
              deviceId: state.device.id,
              deviceToken: state.deviceToken,
              sessionId: command.payload?.sessionId || "",
              type: "manual_verification_required",
              payload: result
            })
          });
        }
        await logLine(options, "command.manual_verification_required", { commandId: command.id, platform });
        return pending || { command: { ...command, status: "running", result } };
      }
      const publishSucceeded = PUBLISHED_PLATFORM_STATUSES.has(
        String(result?.platformStatus || "").trim().toLowerCase()
      );
      const publishFailure = publishSucceeded ? null : publicationFailureFields(result, platform);
      const completed = await desktopApiRequest(apiBaseUrl, state, `/api/desktop-commands/${command.id}/events`, {
        method: "POST",
        body: JSON.stringify({
          deviceId: state.device.id,
          deviceToken: state.deviceToken,
          type: publishSucceeded ? "publish_succeeded" : "publish_failed",
          payload: publishSucceeded
            ? result
            : { ...publicationEvidence.evidence, ...result, ...publishFailure }
        })
      });
      if (publishSucceeded) {
        await logLine(options, "command.succeeded", { commandId: command.id, url: result?.publishedUrl });
      } else {
        await logLine(options, "command.failed", {
          commandId: command.id,
          url: result?.publishedUrl || "",
          error: publishFailure.errorMessage,
          errorDetail: publishFailure.errorDetail,
          ...publicationEvidence.evidence
        });
      }
      return completed;
    });
  } catch (error) {
    const errorMessage = sanitizeCommandFailure(error);
    const failureDetail = commandFailureDetail(error);
    const failureType = command.type === "open_auth"
      ? "auth_failed"
      : command.type === "validate_session"
        ? "session_validation_failed"
      : command.type === "discover_publication"
        ? "publication_discovery_failed"
      : command.type === "cleanup_assets"
        ? "cleanup_failed"
        : "publish_failed";
    let failed = null;
    let reportRejected = false;
    try {
      failed = await desktopApiRequest(apiBaseUrl, state, `/api/desktop-commands/${command.id}/events`, {
        method: "POST",
        body: JSON.stringify({
          deviceId: state.device.id,
          deviceToken: state.deviceToken,
          type: failureType,
          // The sanitized opcode alone erased the real platform response once, so
          // ship the raw message beside it instead of only into the desktop log.
          payload: { errorMessage, errorDetail: failureDetail.errorDetail, ...publicationEvidence.evidence }
        })
      });
    } catch (error) {
      // The command reached a terminal status while the adapter was running.
      // The work and its real cause are already known locally, so keep them
      // here instead of letting the rejection replace them and lose both.
      if (!commandAlreadyTerminal(error)) throw error;
      reportRejected = true;
    }
    await logLine(options, "command.failed", {
      commandId: command.id,
      error: errorMessage,
      ...failureDetail,
      ...publicationEvidence.evidence
    });
    return reportRejected
      ? { command, skipped: "DESKTOP_COMMAND_ALREADY_TERMINAL" }
      : failed;
  }
}

// Command stamps arrive from the API with an explicit UTC offset, so ordering
// the raw strings would silently misqueue rows written in different zones.
function commandRecency(command) {
  const parsed = Date.parse(String(command?.updatedAt || command?.createdAt || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function findQueuedCommand(options = {}) {
  const apiBaseUrl = options.apiBaseUrl || DEFAULT_API_BASE_URL;
  const state = await ensureRegistered(options);
  const commands = await listDesktopCommands(apiBaseUrl, state);
  await recoverVideoCallbacks(options, commands, state);
  const requestedPlatform = String(options.platform || "").trim().toLowerCase();
  const eligibleCommands = requestedPlatform
    ? commands.filter((item) => String(item?.payload?.platform || "").trim().toLowerCase() === requestedPlatform)
    : commands;
  const newestFirst = [...eligibleCommands].sort((left, right) => {
    return commandRecency(right) - commandRecency(left)
      || String(right.id || "").localeCompare(String(left.id || ""));
  });
  return newestFirst.find((item) => item.deviceId === state.device.id && item.status === "queued")
    || newestFirst.find((item) => !item.deviceId && item.status === "queued");
}

export async function runOnce(options = {}) {
  const command = await findQueuedCommand(options);
  if (!command) return { status: "idle", message: "No queued desktop command." };
  return executeCommand(options, command);
}

const WATCH_ERROR_LOG_INTERVAL_MS = 30000;
const watchErrorLastLogged = new Map();

// "The command list came back empty" and "fetching the command list threw" used to
// be indistinguishable in the log, because both failures were swallowed without a
// trace. Log them, but rate-limited: a long API outage would otherwise append a
// line every few seconds and bury everything else.
// The bucket is per log file, not just per event: the limit exists to keep one
// agent log readable, so two watchers writing to different state roots must not
// silence each other.
async function logWatchError(options, event, error) {
  const statePath = options.statePath || DEFAULT_STATE_PATH;
  const logPath = path.join(path.dirname(statePath), "desktop-agent.log");
  const now = Date.now();
  const key = `${event}\u0000${logPath}`;
  const previous = watchErrorLastLogged.get(key) || 0;
  if (now - previous < WATCH_ERROR_LOG_INTERVAL_MS) return;
  watchErrorLastLogged.set(key, now);
  await logLine(options, event, { error: String(error?.message || error) });
}

export async function recoverVideoCallbacks(options = {}, snapshot, registeredState) {
  const apiBaseUrl = options.apiBaseUrl || DEFAULT_API_BASE_URL;
  const state = registeredState || await ensureRegistered(options);
  const commands = snapshot || await listDesktopCommands(apiBaseUrl, state);
  for (const command of commands) {
    if (command.type !== "publish_video" || command.status !== "running" || command.deviceId !== state.device.id) continue;
    const marker = path.join(path.dirname(options.statePath || DEFAULT_STATE_PATH), "publication-assets", videoSafeId(command.id), ".video-active");
    const active = await readFile(marker, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
    if (active && (!Number.isInteger(Number(active)) || processIsAlive(Number(active)))) continue;
    const result = await readVideoSubmissionResult(options.statePath || DEFAULT_STATE_PATH, command.id);
    if (!result) continue;
    // Recovery only replays evidence. It never opens a browser or executes an
    // adapter; a crash after click therefore cannot become another upload.
    await desktopApiRequest(apiBaseUrl, state, `/api/desktop-commands/${command.id}/events`, {
      method: "POST", signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ deviceId: state.device.id, deviceToken: state.deviceToken,
        type: ["failed", "rejected"].includes(result.platformStatus) ? "publish_failed" : "publish_succeeded", payload: result })
    }).catch(error => { if (!commandAlreadyTerminal(error)) throw error; });
  }
}

export async function watchIteration(options = {}) {
  try {
    await heartbeat({ ...options, silent: true });
  } catch (error) {
    await logWatchError(options, "watch.heartbeat_error", error);
  }
  let command = null;
  try {
    command = await findQueuedCommand(options);
  } catch (error) {
    await logWatchError(options, "watch.command_list_error", error);
  }
  if (command) {
    await executeCommand(options, command).catch((error) =>
      logLine(options, "watch.command_error", { error: String(error) }));
  }
  return command;
}

export async function watch(options = {}) {
  const lock = await acquireWatchLock(options);
  if (!lock) {
    await logLine(options, "watch.already_running", { pid: process.pid });
    await reportWatchLockContention(options);
    return { status: "already_running", message: "Desktop watcher is already running." };
  }
  await ensureRegistered(options);
  await logLine(options, "watch.start", { intervalMs: options.intervalMs });
  try {
    while (true) {
      if (!(await touchWatchLock(lock))) {
        // Another watcher judged us silent and took over; two loops would run
        // the same commands twice, so this one stands down.
        await logLine(options, "watch.lock_lost", { pid: process.pid });
        break;
      }
      await watchIteration({ ...options, watchLock: lock });
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs || 5000));
    }
  } finally {
    await lock.release();
  }
}

export async function cleanupProfiles(options = {}) {
  const root = profileRoot(options.statePath || DEFAULT_STATE_PATH);
  const entries = await readdir(root, { recursive: true }).catch(() => []);
  if (options.all) {
    await rm(root, { recursive: true, force: true });
    await logLine(options, "profiles.cleanup_all", { root });
    return { deleted: "all", root };
  }
  return { root, entries, deleted: 0, hint: "Pass --all to remove profiles." };
}

const ASSET_CLEANUP_DEFAULTS = {
  assetsKeep: 50,
  assetsMaxAgeDays: 7,
  profilesMaxAgeDays: 14
};
const MS_PER_DAY = 24 * 60 * 60 * 1000;

async function pathExists(target) {
  return (await stat(target).catch(() => null)) !== null;
}

// One walk yields both numbers the cleanup reports: the bytes that would be
// freed, and the newest mtime anywhere in the tree. The directory entry's own
// mtime is a poor age signal for a browser profile, because Chrome rewrites
// files inside subdirectories and leaves the top-level entry untouched.
async function measureDirectory(target) {
  let bytes = 0;
  let newestMtimeMs = 0;
  const pending = [target];
  while (pending.length) {
    const current = pending.pop();
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const stats = await stat(full).catch(() => null);
      if (!stats) continue;
      bytes += Number(stats.size || 0);
      const mtimeMs = Number(stats.mtimeMs || 0);
      if (mtimeMs > newestMtimeMs) newestMtimeMs = mtimeMs;
    }
  }
  return { bytes, newestMtimeMs };
}

async function collectDirectories(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const directories = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    const stats = await stat(full).catch(() => null);
    directories.push({ path: full, name: entry.name, mtimeMs: Number(stats?.mtimeMs || 0) });
  }
  return directories;
}

// Keep keys arrive from the server as raw record ids; profile directories are
// named through the same normalisation the lock names use, so compare both forms.
function normalizeKeepKeys(values) {
  const keys = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const raw = String(value || "").trim();
    if (!raw) continue;
    keys.add(raw);
    keys.add(safeSegment(raw));
  }
  return keys;
}

export async function cleanupLocalAssets(options = {}) {
  const statePath = options.statePath || DEFAULT_STATE_PATH;
  const root = path.dirname(statePath);
  const now = Date.now();
  const dryRun = options.dryRun === true;
  const allProfiles = options.allProfiles === true;
  const keepKeys = normalizeKeepKeys(options.keepProfileKeys);
  const assetsKeep = Math.max(0, Number(options.assetsKeep ?? ASSET_CLEANUP_DEFAULTS.assetsKeep));
  const assetsMaxAgeDays = Math.max(0, Number(options.assetsMaxAgeDays ?? ASSET_CLEANUP_DEFAULTS.assetsMaxAgeDays));
  const profilesMaxAgeDays = Math.max(0, Number(options.profilesMaxAgeDays ?? ASSET_CLEANUP_DEFAULTS.profilesMaxAgeDays));
  const result = {
    dryRun,
    deleted: 0,
    freedBytes: 0,
    assets: { scanned: 0, deleted: 0, keptNewest: 0, keptRecent: 0, freedBytes: 0 },
    profiles: {
      scanned: 0,
      deleted: 0,
      keptWhitelisted: 0,
      keptRecent: 0,
      locked: 0,
      skipped: false,
      skipReason: "",
      freedBytes: 0
    }
  };

  // Every publish leaves one directory behind and nothing ever removed them, so
  // the newest few are always kept and only genuinely old ones go.
  const assetDirectories = await collectDirectories(path.join(root, "publication-assets"));
  result.assets.scanned = assetDirectories.length;
  assetDirectories.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const newestAssets = new Set(assetDirectories.slice(0, assetsKeep).map((item) => item.path));
  for (const directory of assetDirectories) {
    // An old directory can still be actively downloading/retrying. Age alone
    // must never evict a file while the uploader holds it.
    if (await stat(path.join(directory.path, ".video-active")).catch(() => null)) {
      result.assets.keptRecent += 1;
      continue;
    }
    if (newestAssets.has(directory.path)) {
      result.assets.keptNewest += 1;
      continue;
    }
    if (now - directory.mtimeMs < assetsMaxAgeDays * MS_PER_DAY) {
      result.assets.keptRecent += 1;
      continue;
    }
    const measured = await measureDirectory(directory.path);
    if (!dryRun) await rm(directory.path, { recursive: true, force: true });
    result.assets.deleted += 1;
    result.assets.freedBytes += measured.bytes;
    result.deleted += 1;
    result.freedBytes += measured.bytes;
  }

  // An empty whitelist means the server could not derive one. Deleting every
  // login state on that guess is not a recoverable mistake, so stand down.
  if (!allProfiles && keepKeys.size === 0) {
    result.profiles.skipped = true;
    result.profiles.skipReason = "keep_profile_keys_empty";
    await logLine(options, "assets.cleanup_profiles_skipped", {
      reason: result.profiles.skipReason,
      dryRun
    });
    return result;
  }

  const profilesRoot = profileRoot(statePath);
  const platforms = await readdir(profilesRoot, { withFileTypes: true }).catch(() => []);
  for (const platformEntry of platforms) {
    // .locks lives beside the platform directories and is not a profile.
    if (!platformEntry.isDirectory() || platformEntry.name.startsWith(".")) continue;
    const platformDirectory = path.join(profilesRoot, platformEntry.name);
    const profiles = await readdir(platformDirectory, { withFileTypes: true }).catch(() => []);
    for (const profileEntry of profiles) {
      if (!profileEntry.isDirectory()) continue;
      const profileDirectory = path.join(platformDirectory, profileEntry.name);
      result.profiles.scanned += 1;
      if (await pathExists(profileLockPath(profilesRoot, platformEntry.name, { profileKey: profileEntry.name }))) {
        // A browser session holds this profile right now.
        result.profiles.locked += 1;
        continue;
      }
      if (!allProfiles) {
        if (keepKeys.has(profileEntry.name)) {
          result.profiles.keptWhitelisted += 1;
          continue;
        }
        const stats = await stat(profileDirectory).catch(() => null);
        if (now - Number(stats?.mtimeMs || 0) < profilesMaxAgeDays * MS_PER_DAY) {
          result.profiles.keptRecent += 1;
          continue;
        }
      }
      const measured = await measureDirectory(profileDirectory);
      if (!allProfiles && now - measured.newestMtimeMs < profilesMaxAgeDays * MS_PER_DAY) {
        // The directory entry looked idle while files inside were still moving.
        result.profiles.keptRecent += 1;
        continue;
      }
      if (!dryRun) await rm(profileDirectory, { recursive: true, force: true });
      result.profiles.deleted += 1;
      result.profiles.freedBytes += measured.bytes;
      result.deleted += 1;
      result.freedBytes += measured.bytes;
    }
  }
  return result;
}

// The scheduler ships this set inside the cleanup command, but a manual run has
// to ask for it: profile directory names come from server-side record ids and
// cannot be reconstructed from anything on disk. An empty answer is not a
// licence to delete every login, so callers treat it as "assets only".
export async function fetchAssetCleanupKeepKeys(options = {}) {
  const apiBaseUrl = options.apiBaseUrl || DEFAULT_API_BASE_URL;
  const state = await ensureRegistered(options);
  const response = await desktopApiRequest(
    apiBaseUrl,
    state,
    `/api/desktop-devices/${encodeURIComponent(state.device.id)}/asset-cleanup-keep-keys`
  );
  return Array.isArray(response?.keepProfileKeys) ? response.keepProfileKeys.map((value) => String(value || "")) : [];
}

export async function readStatus(options = {}) {
  const statePath = options.statePath || DEFAULT_STATE_PATH;
  const state = await readState(statePath, options);
  return {
    apiBaseUrl: state.apiBaseUrl || options.apiBaseUrl || DEFAULT_API_BASE_URL,
    device: state.device || null,
    registered: Boolean(state.device?.id && state.deviceToken),
    profileRoot: profileRoot(statePath),
    logPath: path.join(path.dirname(statePath), "desktop-agent.log"),
    statePath
  };
}
