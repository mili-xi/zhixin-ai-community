import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SohuAdapter,
  buildSohuAuthArtifact,
  createSohuCookieInjectedContext,
  hasSohuStrongLoginCookie,
  isSohuClientAuthPage,
  isSohuCookie,
  isSohuLoggedIn,
  isSohuLoggedInFromCookies,
  isSohuWorkspaceReady,
  normalizeSohuCookie,
  pickSohuAccountName
} from "../src/adapters/sohu.mjs";
import { getAdapter } from "../src/adapters/index.mjs";

test("detects Sohu login from Sohu passport cookies", () => {
  assert.equal(isSohuLoggedInFromCookies([
    { name: "SUV", value: "device-only", domain: ".sohu.com" },
    { name: "ppinf", value: "passport-token", domain: ".sohu.com" }
  ]), true);
  assert.equal(isSohuLoggedInFromCookies([
    { name: "SUV", value: "device-only", domain: ".sohu.com" }
  ]), false);
});

test("Sohu profile path prefers the stable media account profile key", () => {
  const adapter = new SohuAdapter();

  assert.match(adapter.profileDir({
    profileRoot: "C:\\profiles",
    profileKey: "stable-account",
    sessionId: "legacy-session"
  }), /[\\/]sohu[\\/]stable-account$/);
});

test("Sohu validates a persistent session and rotates captured credentials", async () => {
  const seededCookies = [];
  const initScripts = [];
  const refreshed = [];
  const page = {
    _url: "about:blank",
    goto: async (url) => { page._url = url; },
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    url: () => page._url,
    title: async () => "Sohu creator center",
    evaluate: async (fn) => String(fn).includes("readStorage")
      ? { localStorage: { editor: "ready" }, sessionStorage: {} }
      : "content management publish"
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    addCookies: async (cookies) => seededCookies.push(...cookies),
    addInitScript: async (...args) => initScripts.push(args),
    cookies: async () => [{ name: "ppinf", value: "auth-token", domain: ".sohu.com", path: "/" }],
    close: async () => {}
  };
  const adapter = new SohuAdapter({
    browser: { launchPersistentContext: async () => context }
  });

  const result = await adapter.validateSession({
    cookies: [{ name: "ppinf", value: "seed-token", domain: ".sohu.com", path: "/" }],
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

test("Sohu requires creator workspace and passport cookies", () => {
  assert.equal(hasSohuStrongLoginCookie([
    { name: "ppinf", value: "passport-token", domain: ".sohu.com" }
  ]), true);
  assert.equal(isSohuWorkspaceReady({
    url: "https://mp.sohu.com/mpfe/v4/main",
    title: "Sohu creator center",
    text: "content management"
  }), true);
  assert.equal(isSohuLoggedIn([
    { name: "SUV", value: "device-only", domain: ".sohu.com" }
  ], {
    url: "https://mp.sohu.com/mpfe/v4/login",
    title: "Sohu login",
    text: "login"
  }), false);
  assert.equal(isSohuLoggedIn([
    { name: "ppinf", value: "passport-token", domain: ".sohu.com" }
  ], {
    url: "https://mp.sohu.com/mpfe/v4/login",
    title: "Sohu login",
    text: "login"
  }), false);
  assert.equal(isSohuLoggedIn([
    { name: "ppinf", value: "passport-token", domain: ".sohu.com" }
  ], {
    url: "https://mp.sohu.com/mpfe/v4/main",
    title: "Sohu creator center",
    text: "content management"
  }), true);
  assert.equal(isSohuWorkspaceReady({
    url: "https://mp.sohu.com/mpfe/v4/main#/contentManagement/news/addarticle?contentStatus=1",
    title: "搜狐号",
    text: "账号登录 手机登录 我已阅读并同意《用户协议》和《隐私政策》 登录 下次自动登录"
  }), false);
});

test("Sohu clientAuth SMS gate never reads as the creator workspace", () => {
  const clientAuth = {
    url: "https://mp.sohu.com/mpfe/v4/clientAuth?bizType=2&redirect=%2Fmpfe%2Fv4%2FcontentManagement%2Fnews%2Faddarticle",
    title: "搜狐号",
    // The gate page also carries workspace-looking copy.
    text: "安全验证 短信验证码 获取验证码 工作台 发布 文章管理"
  };

  assert.equal(isSohuClientAuthPage(clientAuth), true);
  assert.equal(isSohuClientAuthPage({ url: "https://mp.sohu.com/mpfe/v4/main" }), false);
  assert.equal(isSohuClientAuthPage({}), false);
  assert.equal(isSohuWorkspaceReady(clientAuth), false);
  // Passport cookies alone must not report a healthy session on the SMS gate.
  assert.equal(isSohuLoggedIn([
    { name: "ppinf", value: "passport-token", domain: ".sohu.com" }
  ], clientAuth), false);
});

test("keeps Sohu cookies before artifact creation", () => {
  assert.equal(isSohuCookie({ name: "ppinf", domain: ".sohu.com" }), true);
  assert.equal(isSohuCookie({ name: "mp_session", domain: "mp.sohu.com" }), true);
  assert.equal(isSohuCookie({ name: "ppinf", domain: ".example.com" }), false);

  assert.deepEqual(normalizeSohuCookie({
    name: "ppinf",
    value: "passport-token",
    domain: ".sohu.com",
    path: "/",
    expires: 1893456000,
    httpOnly: true,
    sameSite: "Lax",
    secure: true,
    size: 42
  }), {
    name: "ppinf",
    value: "passport-token",
    domain: ".sohu.com",
    path: "/",
    expires: 1893456000,
    httpOnly: true,
    sameSite: "Lax",
    secure: true
  });
});

test("builds a Sohu auth artifact with a stable fingerprint", () => {
  const artifact = buildSohuAuthArtifact({
    cookies: [
      { name: "ppinf", value: "passport-token", domain: ".sohu.com", path: "/", httpOnly: true, secure: true },
      { name: "pprdig", value: "digest-token", domain: ".sohu.com", path: "/", httpOnly: false, secure: false },
      { name: "other", value: "skip", domain: ".example.com", path: "/" }
    ],
    localStorage: { sohu: "1" },
    sessionStorage: { draft: "1" }
  }, { capturedAt: "2026-07-04T00:00:00.000Z" });

  assert.match(artifact.cookies, /^encrypted-cookie-/);
  assert.match(artifact.localStorage, /^encrypted-local-storage-/);
  assert.match(artifact.sessionStorage, /^encrypted-session-storage-/);
  assert.match(artifact.fingerprint, /^fp-sohu-[a-f0-9]{16}$/);
  assert.equal(artifact.storageVersion, 2);
});

test("picks Sohu account label from explicit input, DOM, or title", async () => {
  assert.equal(await pickSohuAccountName({ accountName: "搜狐增长号" }, null), "搜狐增长号");
  assert.equal(await pickSohuAccountName({}, {
    evaluate: async () => ({ text: "智心AI搜狐号", href: "" }),
    title: async () => "首页 - 搜狐号"
  }), "智心AI搜狐号");
  assert.equal(await pickSohuAccountName({}, {
    evaluate: async () => null,
    title: async () => "内容管理 - 搜狐号"
  }), "搜狐号账号");
});

test("Sohu adapter waits for login cookies and is registered", async () => {
  const adapter = new SohuAdapter({
    browser: {
      launchPersistentContext: async () => ({
        pages: () => [{
          goto: async () => {},
          bringToFront: async () => {},
          url: () => "https://mp.sohu.com/mpfe/v4/main",
          title: async () => "Sohu creator center",
          evaluate: async () => "content management"
        }],
        cookies: async () => [{ name: "ppinf", value: "passport-token", domain: ".sohu.com" }],
        close: async () => {}
      })
    }
  });

  assert.equal(await adapter.detectLoggedIn({ waitLoginMs: 10 }), true);
  assert.equal(getAdapter("sohu").platform, "sohu");
  assert.equal(getAdapter("sohu").accountLabel, "搜狐号账号");
});

test("Sohu can open a clean browser context by injecting captured cookies", async () => {
  const injectedCookies = [];
  const navigations = [];
  const result = await createSohuCookieInjectedContext({
    browser: {
      launch: async () => ({
        newContext: async () => ({
          addCookies: async (cookies) => injectedCookies.push(...cookies),
          newPage: async () => ({
            goto: async (url) => navigations.push(url),
            bringToFront: async () => {}
          })
        })
      })
    },
    cookies: [
      { name: "ppinf", value: "passport-token", domain: ".sohu.com", path: "/" },
      { name: "pprdig", value: "digest-token", domain: ".sohu.com", path: "/" },
      { name: "skip", value: "skip", domain: ".example.com", path: "/" }
    ]
  });

  assert.equal(result.cookies.length, 2);
  assert.equal(injectedCookies.length, 2);
  assert.equal(navigations[0], "https://mp.sohu.com/mpfe/v4/main");
});

test("Sohu login detection follows the popup tab that reaches the workspace", async () => {
  const trackedPage = {
    url: () => "https://mp.sohu.com/",
    title: async () => "搜狐号",
    evaluate: async () => "账号登录 手机登录 我已阅读并同意《用户协议》和《隐私政策》 登录 下次自动登录"
  };
  const workspacePage = {
    url: () => "https://mp.sohu.com/mpfe/v4/contentManagement/first/page",
    title: async () => "搜狐号",
    evaluate: async () => "内容管理 发布内容 工作台"
  };
  const context = {
    pages: () => [trackedPage, workspacePage],
    cookies: async () => [
      { name: "SUV", value: "device-only", domain: ".sohu.com" },
      { name: "ppinf", value: "passport-token", domain: ".sohu.com" }
    ]
  };
  const adapter = new SohuAdapter();

  const login = await adapter.waitForLogin(context, trackedPage, 2000, 100);

  assert.equal(login.cookies.some((cookie) => cookie.name === "ppinf"), true);
  assert.equal(login.page, workspacePage);
});

test("Sohu authorize detection re-points to the tab that reached the workspace", async () => {
  const gatewayPage = {
    _url: "https://mp.sohu.com/",
    goto: async (url) => { gatewayPage._url = url; },
    bringToFront: async () => {},
    url: () => gatewayPage._url,
    title: async () => "搜狐号",
    evaluate: async () => "账号登录 手机登录 登录 下次自动登录"
  };
  const workspacePage = {
    url: () => "https://mp.sohu.com/home?accountId=122929277&from=gate",
    title: async () => "搜狐号",
    evaluate: async () => "工作台 内容管理 发布内容"
  };
  const context = {
    pages: () => [gatewayPage, workspacePage],
    newPage: async () => gatewayPage,
    cookies: async () => [{ name: "ppinf", value: "passport-token", domain: ".sohu.com" }],
    close: async () => {}
  };
  const adapter = new SohuAdapter({
    browser: { launchPersistentContext: async () => context }
  });

  const detected = await adapter.detectLoggedIn({ waitLoginMs: 3000 });

  assert.equal(detected, true);
  assert.equal(adapter.page, workspacePage);
  assert.equal(adapter.cookies.some((cookie) => cookie.name === "ppinf"), true);
});
