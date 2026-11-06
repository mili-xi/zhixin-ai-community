import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BaijiahaoAdapter,
  buildBaijiahaoAuthArtifact,
  hasBaijiahaoStrongLoginCookie,
  isBaiduCookie,
  isBaijiahaoLoggedIn,
  isBaijiahaoLoggedInFromCookies,
  isBaijiahaoWorkspaceReady,
  normalizeBaiduCookie,
  pickBaijiahaoAccountName
} from "../src/adapters/baijiahao.mjs";
import { getAdapter } from "../src/adapters/index.mjs";

test("detects Baijiahao login from Baidu auth cookies", () => {
  assert.equal(isBaijiahaoLoggedInFromCookies([
    { name: "BAIDUID", value: "device", domain: ".baidu.com" },
    { name: "BDUSS", value: "auth-token", domain: ".baidu.com" }
  ]), true);
  assert.equal(isBaijiahaoLoggedInFromCookies([
    { name: "BAIDUID", value: "device", domain: ".baidu.com" }
  ]), false);
});

test("Baijiahao profile path prefers the stable media account profile key", () => {
  const adapter = new BaijiahaoAdapter();

  assert.match(adapter.profileDir({
    profileRoot: "C:\\profiles",
    profileKey: "stable-account",
    sessionId: "legacy-session"
  }), /[\\/]baijiahao[\\/]stable-account$/);
});

test("routes a Baijiahao browser session through an explicit local diagnostic proxy", async () => {
  let launchOptions;
  const context = {
    addCookies: async () => {},
    addInitScript: async () => {},
    close: async () => {}
  };
  const adapter = new BaijiahaoAdapter({
    browser: {
      launchPersistentContext: async (_profileDir, options) => {
        launchOptions = options;
        return context;
      }
    }
  });

  await adapter.launchAuthEnvironment({
    profileKey: "stable-account",
    browserProxyServer: "http://127.0.0.1:8899"
  });

  assert.deepEqual(launchOptions.proxy, { server: "http://127.0.0.1:8899" });
  assert.equal(launchOptions.ignoreHTTPSErrors, true);
});

test("Baijiahao validates a persistent session and rotates captured credentials", async () => {
  const seededCookies = [];
  const initScripts = [];
  const refreshed = [];
  const page = {
    _url: "about:blank",
    goto: async (url) => { page._url = url; },
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    url: () => page._url,
    title: async () => "Baijiahao creator center",
    evaluate: async (fn) => String(fn).includes("readStorage")
      ? { localStorage: { editor: "ready" }, sessionStorage: {} }
      : "content management publish"
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    addCookies: async (cookies) => seededCookies.push(...cookies),
    addInitScript: async (...args) => initScripts.push(args),
    cookies: async () => [{ name: "BDUSS", value: "auth-token", domain: ".baidu.com", path: "/" }],
    close: async () => {}
  };
  const adapter = new BaijiahaoAdapter({
    browser: { launchPersistentContext: async () => context }
  });

  const result = await adapter.validateSession({
    cookies: [{ name: "BDUSS", value: "seed-token", domain: ".baidu.com", path: "/" }],
    localStorage: { editor: "ready" },
    profileKey: "stable-account",
    onCredentialRefresh: async (artifact) => refreshed.push(artifact)
  });

  assert.equal(result.valid, true);
  assert.equal(seededCookies[0].value, "seed-token");
  assert.equal(initScripts.length, 1);
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].credentialMetadata.hasSessionCredentials, true);
});

test("Baijiahao requires creator workspace and Baidu auth cookies", () => {
  assert.equal(hasBaijiahaoStrongLoginCookie([
    { name: "BDUSS", value: "auth-token", domain: ".baidu.com" }
  ]), true);
  assert.equal(isBaijiahaoWorkspaceReady({
    url: "https://baijiahao.baidu.com/builder/rc/home",
    title: "Baijiahao creator center",
    text: "content management"
  }), true);
  assert.equal(isBaijiahaoLoggedIn([
    { name: "BAIDUID", value: "device-only", domain: ".baidu.com" }
  ], {
    url: "https://passport.baidu.com/v2/?login",
    title: "Baidu login",
    text: "login"
  }), false);
  assert.equal(isBaijiahaoLoggedIn([
    { name: "BDUSS", value: "auth-token", domain: ".baidu.com" }
  ], {
    url: "https://passport.baidu.com/v2/?login",
    title: "Baidu login",
    text: "login"
  }), false);
  assert.equal(isBaijiahaoLoggedIn([
    { name: "BDUSS", value: "auth-token", domain: ".baidu.com" }
  ], {
    url: "https://baijiahao.baidu.com/builder/rc/home",
    title: "Baijiahao creator center",
    text: "content management"
  }), true);
});

test("keeps Baidu and Baijiahao cookies before artifact creation", () => {
  assert.equal(isBaiduCookie({ name: "BDUSS", domain: ".baidu.com" }), true);
  assert.equal(isBaiduCookie({ name: "BJH", domain: "baijiahao.baidu.com" }), true);
  assert.equal(isBaiduCookie({ name: "BDUSS", domain: ".example.com" }), false);

  assert.deepEqual(normalizeBaiduCookie({
    name: "BDUSS",
    value: "auth-token",
    domain: ".baidu.com",
    path: "/",
    expires: 1893456000,
    httpOnly: true,
    sameSite: "Lax",
    secure: true,
    size: 42
  }), {
    name: "BDUSS",
    value: "auth-token",
    domain: ".baidu.com",
    path: "/",
    expires: 1893456000,
    httpOnly: true,
    sameSite: "Lax",
    secure: true
  });
});

test("builds a Baijiahao auth artifact with a stable fingerprint", () => {
  const artifact = buildBaijiahaoAuthArtifact({
    cookies: [
      { name: "BDUSS", value: "auth-token", domain: ".baidu.com", path: "/", httpOnly: true, secure: true },
      { name: "BAIDUID", value: "device", domain: ".baidu.com", path: "/", httpOnly: false, secure: false },
      { name: "other", value: "skip", domain: ".example.com", path: "/" }
    ],
    localStorage: { bjh: "1" },
    sessionStorage: { draft: "1" }
  }, { capturedAt: "2026-07-04T00:00:00.000Z" });

  assert.match(artifact.cookies, /^encrypted-cookie-/);
  assert.match(artifact.localStorage, /^encrypted-local-storage-/);
  assert.match(artifact.sessionStorage, /^encrypted-session-storage-/);
  assert.match(artifact.fingerprint, /^fp-baijiahao-[a-f0-9]{16}$/);
  assert.equal(artifact.storageVersion, 2);
});

test("picks Baijiahao account label from explicit input, DOM, or title", async () => {
  assert.equal(await pickBaijiahaoAccountName({ accountName: "百家号增长号" }, null), "百家号增长号");
  assert.equal(await pickBaijiahaoAccountName({}, {
    evaluate: async () => ({ text: "智心AI百家号", href: "" }),
    title: async () => "首页 - 百家号"
  }), "智心AI百家号");
  assert.equal(await pickBaijiahaoAccountName({}, {
    evaluate: async () => null,
    title: async () => "内容管理 - 百家号"
  }), "百家号账号");
});

test("Baijiahao adapter waits for login cookies and is registered", async () => {
  const adapter = new BaijiahaoAdapter({
    browser: {
      launchPersistentContext: async () => ({
        pages: () => [{
          goto: async () => {},
          bringToFront: async () => {},
          url: () => "https://baijiahao.baidu.com/builder/rc/home",
          title: async () => "Baijiahao creator center",
          evaluate: async () => "content management"
        }],
        cookies: async () => [{ name: "BDUSS_BFESS", value: "auth-token", domain: ".baidu.com" }],
        close: async () => {}
      })
    }
  });

  assert.equal(await adapter.detectLoggedIn({ waitLoginMs: 10 }), true);
  assert.equal(getAdapter("baijiahao").platform, "baijiahao");
  assert.equal(getAdapter("baijiahao").accountLabel, "百家号账号");
});
