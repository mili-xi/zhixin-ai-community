import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export function safeSegment(value, fallback = "default") {
  const normalized = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return normalized || fallback;
}

export function resolveProfileKey(input = {}) {
  return safeSegment(
    input.profileKey
      || input.mediaAccountId
      || input.sessionId
      || input.accountName
      || "default"
  );
}

export function resolveProfileDir(profileRoot, platform, input = {}) {
  return path.join(
    profileRoot || path.join(process.cwd(), ".zhixin-ai", "profiles"),
    safeSegment(platform || input.platform || "other", "other"),
    resolveProfileKey(input)
  );
}

export function profileLockName(platform, input = {}) {
  return `${safeSegment(platform || input.platform || "other", "other")}-${resolveProfileKey(input)}.lock`;
}

export function profileLockPath(profileRoot, platform, input = {}) {
  return path.join(
    profileRoot || path.join(process.cwd(), ".zhixin-ai", "profiles"),
    ".locks",
    profileLockName(platform, input)
  );
}

export function summarizeCredentialExpiry(cookies = [], strongCookieNames = []) {
  const strongNames = new Set(strongCookieNames.map((name) => String(name).toLowerCase()));
  const relevant = (Array.isArray(cookies) ? cookies : []).filter((cookie) => (
    strongNames.size === 0 || strongNames.has(String(cookie?.name || "").toLowerCase())
  ));
  const persistentExpiries = relevant
    .map((cookie) => Number(cookie?.expires || 0))
    .filter((expires) => Number.isFinite(expires) && expires > 0)
    .sort((left, right) => left - right);
  const sessionCookieCount = relevant.filter((cookie) => Number(cookie?.expires || 0) <= 0).length;

  return {
    strongCookieCount: relevant.length,
    sessionCookieCount,
    persistentCookieCount: persistentExpiries.length,
    hasSessionCredentials: sessionCookieCount > 0,
    credentialExpiresAt: persistentExpiries.length
      ? new Date(persistentExpiries[0] * 1000).toISOString()
      : ""
  };
}

export async function seedPersistentContext(context, input = {}) {
  if (!context) return;
  const cookies = Array.isArray(input.cookies)
    ? input.cookies.filter((cookie) => cookie && cookie.name && typeof cookie.value === "string")
    : [];
  if (cookies.length && typeof context.addCookies === "function") {
    await context.addCookies(cookies);
  }

  const localStorage = input.localStorage && typeof input.localStorage === "object" ? input.localStorage : {};
  const sessionStorage = input.sessionStorage && typeof input.sessionStorage === "object" ? input.sessionStorage : {};
  if ((!Object.keys(localStorage).length && !Object.keys(sessionStorage).length) || typeof context.addInitScript !== "function") {
    return;
  }

  await context.addInitScript(({ localStorageValues, sessionStorageValues, origins }) => {
    if (origins.length && !origins.includes(window.location.origin)) return;
    try {
      for (const [key, value] of Object.entries(localStorageValues || {})) {
        window.localStorage.setItem(key, String(value));
      }
      for (const [key, value] of Object.entries(sessionStorageValues || {})) {
        window.sessionStorage.setItem(key, String(value));
      }
    } catch {
      // Storage can be unavailable on browser-internal pages before navigation.
    }
  }, {
    localStorageValues: localStorage,
    sessionStorageValues: sessionStorage,
    origins: Array.isArray(input.origins) ? input.origins : []
  });
}

function credentialRefreshTimeoutError() {
  return new Error("CREDENTIAL_REFRESH_TIMEOUT");
}

async function runCredentialRefreshStep(work, deadline) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw credentialRefreshTimeoutError();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(credentialRefreshTimeoutError()), remainingMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function refreshCredentialFromWorkspace(options = {}) {
  const { context, page, validationUrl, report, onError } = options;
  if (typeof report !== "function") return null;
  const timeoutMs = Math.max(1, Number(options.timeoutMs || 15000));
  const deadline = Date.now() + timeoutMs;

  try {
    return await runCredentialRefreshStep(() => report(context, page), deadline);
  } catch (currentPageError) {
    let fallbackPage;
    try {
      if (!validationUrl || typeof context?.newPage !== "function") throw currentPageError;
      fallbackPage = await runCredentialRefreshStep(() => context.newPage(), deadline);
      await runCredentialRefreshStep(
        () => fallbackPage.goto(validationUrl, { waitUntil: "domcontentloaded" }),
        deadline
      );
      await runCredentialRefreshStep(
        () => fallbackPage.waitForLoadState?.("networkidle", { timeout: Math.min(15000, Math.max(1, deadline - Date.now())) })
          .catch(() => undefined),
        deadline
      );
      return await runCredentialRefreshStep(() => report(context, fallbackPage), deadline);
    } catch (fallbackError) {
      if (typeof onError === "function") onError(fallbackError);
      return null;
    } finally {
      await fallbackPage?.close?.().catch(() => undefined);
    }
  }
}

async function profileLockOwnerIsAlive(lockPath) {
  try {
    const owner = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"));
    const pid = Number(owner?.pid || 0);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      return true;
    }
  } catch {
    return null;
  }
}
async function acquireProfileLock(lockPath, options = {}) {
  const startedAt = Date.now();
  const retryMs = Number(options.retryMs || 100);
  const timeoutMs = Number(options.timeoutMs || 30000);
  const staleMs = Number(options.staleMs || 10 * 60 * 1000);

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      await mkdir(lockPath);
      await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString()
      }), "utf8");
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const [lockStat, ownerAlive] = await Promise.all([
        stat(lockPath).catch(() => null),
        profileLockOwnerIsAlive(lockPath),
      ]);
      if (ownerAlive === false || (lockStat && Date.now() - lockStat.mtimeMs > staleMs)) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
  throw new Error("PROFILE_LOCK_TIMEOUT");
}

export async function withProfileLock(input = {}, work) {
  if (typeof work !== "function") throw new TypeError("PROFILE_LOCK_WORK_REQUIRED");
  const profileRoot = input.profileRoot || path.join(process.cwd(), ".zhixin-ai", "profiles");
  const lockRoot = path.join(profileRoot, ".locks");
  const lockPath = profileLockPath(profileRoot, input.platform, input);
  await mkdir(lockRoot, { recursive: true });
  await acquireProfileLock(lockPath, input);
  try {
    return await work();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}
