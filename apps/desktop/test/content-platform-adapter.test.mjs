import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";

import {
  ContentPlatformAdapter,
  NeteaseAdapter,
  buildContentPlatformAuthArtifact,
  buildContentPlatformConfigSnapshot,
  contentPlatformConfigs,
  hasConfiguredPlatformStrongLoginCookie,
  isConfiguredPlatformCookie,
  isConfiguredPlatformLoggedIn,
  isConfiguredPlatformLoggedInFromCookies,
  isConfiguredPlatformWorkspaceReady,
  normalizeConfiguredPlatformCookie,
  pickConfiguredPlatformAccountName
} from "../src/adapters/content-platform.mjs";
import { getAdapter } from "../src/adapters/index.mjs";

const expectedPlatforms = [
  ["csdn", "CSDN账号", "https://mp.csdn.net/", "csdn.net"],
  ["netease", "网易号账号", "https://mp.163.com/", "163.com"],
  ["penguin", "企鹅号账号", "https://om.qq.com/", "qq.com"],
  ["toutiao", "头条号账号", "https://mp.toutiao.com/profile_v4/", "toutiao.com"],
  ["jianshu", "简书账号", "https://www.jianshu.com/sign_in", "jianshu.com"]
];

const strongCookieByPlatform = {
  csdn: { name: "UserToken", value: "account-token", domain: ".csdn.net" },
  netease: { name: "NTES_SESS", value: "account-token", domain: ".163.com" },
  penguin: { name: "p_skey", value: "account-token", domain: ".qq.com" },
  toutiao: { name: "sessionid", value: "account-token", domain: ".toutiao.com" },
  jianshu: { name: "remember_user_token", value: "account-token", domain: ".jianshu.com" }
};

const workspaceStateByPlatform = {
  csdn: { url: "https://mp.csdn.net/mp_blog/creation/editor", title: "CSDN Creation Center", text: "content management publish" },
  netease: { url: "https://mp.163.com/article/edit", title: "Netease creator center", text: "content management publish" },
  penguin: { url: "https://om.qq.com/article/create", title: "Penguin creator center", text: "content management publish" },
  toutiao: { url: "https://mp.toutiao.com/profile_v4/graphic/publish", title: "Toutiao creator center", text: "content management publish" },
  jianshu: { url: "https://www.jianshu.com/writer", title: "Jianshu writer", text: "write article publish" }
};

test("configured content platforms expose real login URLs and account labels", () => {
  for (const [platform, accountLabel, loginUrl] of expectedPlatforms) {
    const config = contentPlatformConfigs[platform];
    assert.equal(config.platform, platform);
    assert.equal(config.accountLabel, accountLabel);
    assert.equal(config.loginUrl, loginUrl);
    assert.ok(config.fields.length >= 2);
  }
});

test("content platform browser launch disables Chromium session restore bubbles", async () => {
  let launchOptions = null;
  const adapter = new ContentPlatformAdapter(contentPlatformConfigs.jianshu, {
    browser: {
      async launchPersistentContext(_profileDir, options) {
        launchOptions = options;
        return {
          async addCookies() {},
          async addInitScript() {},
          pages() { return []; },
          async newPage() {
            return {
              async goto() {},
              async bringToFront() {},
            };
          },
        };
      },
    },
  });

  await adapter.openLoginPage({ loginUrl: "https://www.jianshu.com/writer" });

  assert.ok(launchOptions.args.includes("--disable-session-crashed-bubble"));
  assert.ok(launchOptions.args.includes("--hide-crash-restore-bubble"));
});

test("content platform browser launch repairs crashed Chromium profile state", async () => {
  const profileRoot = await mkdtemp(path.join(tmpdir(), "zhixin-profile-"));
  const profileDir = path.join(profileRoot, "jianshu", "account-a");
  const preferencesPath = path.join(profileDir, "Default", "Preferences");
  await mkdir(path.dirname(preferencesPath), { recursive: true });
  await writeFile(preferencesPath, JSON.stringify({
    profile: {
      exit_type: "Crashed",
      exited_cleanly: false,
    },
  }), "utf8");

  const adapter = new ContentPlatformAdapter(contentPlatformConfigs.jianshu, {
    browser: {
      async launchPersistentContext() {
        return {
          async addCookies() {},
          async addInitScript() {},
          pages() { return []; },
          async newPage() {
            return {
              async goto() {},
              async bringToFront() {},
            };
          },
        };
      },
    },
  });

  await adapter.openLoginPage({
    loginUrl: "https://www.jianshu.com/writer",
    profileRoot,
    profileKey: "account-a",
  });

  const preferences = JSON.parse(await readFile(preferencesPath, "utf8"));
  assert.equal(preferences.profile.exit_type, "Normal");
  assert.equal(preferences.profile.exited_cleanly, true);
});

test("configured content platforms detect strong account cookies only", () => {
  for (const [platform, , , domain] of expectedPlatforms) {
    const config = contentPlatformConfigs[platform];
    assert.equal(isConfiguredPlatformCookie(config, { name: "sessionid", domain: `.${domain}` }), true);
    assert.equal(isConfiguredPlatformCookie(config, { name: "sessionid", domain: ".example.com" }), false);
    assert.equal(hasConfiguredPlatformStrongLoginCookie(config, [strongCookieByPlatform[platform]]), true);
    assert.equal(isConfiguredPlatformLoggedInFromCookies(config, [
      { name: "visitor_id", value: "device-only", domain: `.${domain}` },
      strongCookieByPlatform[platform]
    ]), true);
    assert.equal(isConfiguredPlatformLoggedInFromCookies(config, [
      { name: "visitor_id", value: "device-only", domain: `.${domain}` }
    ]), false);
  }
});

test("netease SPA hash routes count as creator workspace before page text hydrates", () => {
  const config = contentPlatformConfigs.netease;
  assert.equal(isConfiguredPlatformWorkspaceReady(config, {
    url: "https://mp.163.com/#/",
    title: "",
    text: ""
  }), true);
  assert.equal(isConfiguredPlatformWorkspaceReady(config, {
    url: "https://mp.163.com/#/content-manage",
    title: "",
    text: ""
  }), true);
});

test("configured content platforms require strong cookies and creator workspace", () => {
  assert.equal(isConfiguredPlatformLoggedIn(contentPlatformConfigs.netease, [
    { name: "_ntes_nuid", value: "visitor-only", domain: ".163.com" }
  ], {
    url: "https://mp.163.com/login.html",
    title: "Netease login",
    text: "login"
  }), false);

  assert.equal(isConfiguredPlatformLoggedIn(contentPlatformConfigs.netease, [
    { name: "P_INFO", value: "passport-only-token", domain: ".163.com" }
  ], {
    url: "https://mp.163.com/login.html?url=https%3A%2F%2Fmp.163.com%2F#/",
    title: "Netease media login",
    text: "login register creator guide"
  }), false);

  assert.equal(isConfiguredPlatformWorkspaceReady(contentPlatformConfigs.netease, {
    url: "https://mp.163.com/",
    title: "Netease media landing page",
    text: "creator guide login register"
  }), false);

  assert.equal(isConfiguredPlatformLoggedIn(contentPlatformConfigs.penguin, [
    { name: "ts_uid", value: "visitor-only", domain: ".qq.com" },
    { name: "csrfToken", value: "csrf", domain: ".qq.com" },
    { name: "TSID", value: "tracking", domain: ".qq.com" }
  ], {
    url: "https://om.qq.com/userAuth/index",
    title: "Tencent content platform login",
    text: "login"
  }), false);

  assert.equal(isConfiguredPlatformLoggedIn(contentPlatformConfigs.penguin, [
    { name: "ts_uid", value: "visitor-only", domain: ".om.qq.com" },
    { name: "csrfToken", value: "csrf", domain: "om.qq.com" },
    { name: "omaccesstoken", value: "penguin-access-token", domain: ".om.qq.com" },
    { name: "omtoken", value: "penguin-session-token", domain: ".om.qq.com" },
    { name: "userid", value: "penguin-user-id", domain: ".om.qq.com" }
  ], {
    url: "https://om.qq.com/main",
    title: "Tencent content platform",
    text: "content publish content management creator dashboard"
  }), true);

  assert.equal(isConfiguredPlatformLoggedIn(contentPlatformConfigs.jianshu, [
    { name: "_m7e_session_core", value: "account-token", domain: ".jianshu.com" }
  ], {
    url: "https://www.jianshu.com/users/password/edit",
    title: "Reset password",
    text: "reset password"
  }), false);

  assert.equal(isConfiguredPlatformLoggedIn(contentPlatformConfigs.csdn, [
    { name: "UserToken", value: "account-token", domain: ".csdn.net" },
    { name: "UserName", value: "writer", domain: ".csdn.net" }
  ], {
    url: "https://mp.csdn.net/mp_blog/creation/editor",
    title: "CSDN Creation Center",
    text: "article publish"
  }), true);

  assert.equal(isConfiguredPlatformLoggedIn(contentPlatformConfigs.jianshu, [
    { name: "remember_user_token", value: "account-token", domain: ".jianshu.com" }
  ], {
    url: "https://www.jianshu.com/writer",
    title: "Jianshu writer",
    text: "write article"
  }), true);

  assert.equal(isConfiguredPlatformWorkspaceReady(contentPlatformConfigs.csdn, {
    url: "https://passport.csdn.net/login",
    title: "CSDN login",
    text: "login"
  }), false);
});

test("configured content platforms normalize cookies and build artifacts", () => {
  for (const [platform, , , domain] of expectedPlatforms) {
    const config = contentPlatformConfigs[platform];
    assert.deepEqual(normalizeConfiguredPlatformCookie({
      name: "auth_token",
      value: "account-token",
      domain: `.${domain}`,
      path: "/",
      expires: 1893456000,
      httpOnly: true,
      sameSite: "Lax",
      secure: true,
      size: 42
    }), {
      name: "auth_token",
      value: "account-token",
      domain: `.${domain}`,
      path: "/",
      expires: 1893456000,
      httpOnly: true,
      sameSite: "Lax",
      secure: true
    });

    const artifact = buildContentPlatformAuthArtifact(config, {
      cookies: [
        { name: "auth_token", value: "account-token", domain: `.${domain}`, path: "/" },
        { name: "skip", value: "skip", domain: ".example.com", path: "/" }
      ],
      localStorage: { platform },
      sessionStorage: { draft: "1" }
    }, { capturedAt: "2026-07-04T00:00:00.000Z" });

    assert.match(artifact.cookies, /^encrypted-cookie-/);
    assert.match(artifact.localStorage, /^encrypted-local-storage-/);
    assert.match(artifact.sessionStorage, /^encrypted-session-storage-/);
    assert.match(artifact.fingerprint, new RegExp(`^fp-${platform}-[a-f0-9]{16}$`));
    assert.equal(artifact.storageVersion, 2);
  }
});

test("configured content platform artifacts include sanitized config snapshots", () => {
  const config = contentPlatformConfigs.netease;
  const capturedAt = "2026-07-27T00:00:00.000Z";
  const snapshot = buildContentPlatformConfigSnapshot(config, {
    capturedAt,
    pageState: {
      url: "https://mp.163.com/#/content-manage",
      title: "Netease creator center",
      text: "content management publish article"
    },
    sourceEvidence: {
      endpoint: "https://mp.163.com/api/user/info",
      currentUrl: "https://mp.163.com/#/content-manage",
      httpStatus: 200,
      cookie: "NTES_SESS=secret",
      token: "secret-token"
    },
    platformState: {
      wemediaId: "wm-1001",
      accountId: "account-1001",
      cookie: "raw-cookie",
      localStorage: { token: "raw-storage-token" }
    }
  });

  assert.equal(snapshot.platformConfig.platform, "netease");
  assert.equal(snapshot.platformConfig.schemaVersion, 1);
  assert.equal(snapshot.platformConfig.fetchedAt, capturedAt);
  assert.equal(snapshot.platformConfig.sourceEvidence.endpoint, "https://mp.163.com/api/user/info");
  assert.equal(snapshot.platformConfig.sourceEvidence.httpStatus, 200);
  assert.equal(snapshot.platformConfig.sourceEvidence.cookie, undefined);
  assert.equal(snapshot.platformConfig.sourceEvidence.token, undefined);
  assert.deepEqual(snapshot.platformConfig.requiredFields, config.fields);
  assert.equal(snapshot.platformConfig.platformState.wemediaId, "wm-1001");
  assert.equal(snapshot.platformConfig.platformState.accountId, "account-1001");
  assert.equal(snapshot.platformConfig.platformState.cookie, undefined);
  assert.equal(snapshot.platformConfig.platformState.localStorage, undefined);
  assert.equal(snapshot.capabilities.canPublishArticle, true);
  assert.equal(snapshot.capabilities.canUploadImages, true);
  assert.equal(snapshot.capabilities.requiresCover, true);
  assert.deepEqual(snapshot.capabilities.requiredFields, config.fields);

  const artifact = buildContentPlatformAuthArtifact(config, {
    cookies: [strongCookieByPlatform.netease],
    localStorage: { creatorId: "account-1001" },
    sessionStorage: {}
  }, {
    capturedAt,
    pageState: {
      url: "https://mp.163.com/#/content-manage",
      title: "Netease creator center",
      text: "content management publish article"
    },
    sourceEvidence: {
      endpoint: "https://mp.163.com/api/user/info",
      httpStatus: 200,
      cookie: "NTES_SESS=secret"
    },
    platformState: {
      wemediaId: "wm-1001",
      cookie: "raw-cookie"
    }
  });

  assert.equal(artifact.platformConfig.platform, "netease");
  assert.equal(artifact.platformConfig.sourceEvidence.cookie, undefined);
  assert.equal(artifact.platformConfig.platformState.cookie, undefined);
  assert.equal(artifact.capabilities.canPublishArticle, true);
  assert.equal(artifact.capabilities.requiresCover, true);
});

test("configured content platforms pick account label from explicit input, DOM, or title", async () => {
  for (const [platform, accountLabel] of expectedPlatforms) {
    const config = contentPlatformConfigs[platform];
    assert.equal(await pickConfiguredPlatformAccountName(config, { accountName: `${accountLabel}-增长号` }, null), `${accountLabel}-增长号`);
    assert.equal(await pickConfiguredPlatformAccountName(config, {}, {
      evaluate: async () => ({ text: `${accountLabel}-运营号`, href: "" }),
      title: async () => `${accountLabel} 首页`
    }), `${accountLabel}-运营号`);
    assert.equal(await pickConfiguredPlatformAccountName(config, {}, {
      evaluate: async () => null,
      title: async () => config.genericTitle
    }), accountLabel);
  }
});

test("penguin profile name is extracted from creator header text", async () => {
  assert.equal(await pickConfiguredPlatformAccountName(contentPlatformConfigs.penguin, {}, {
    evaluate: async () => ({ text: "bai2bai 正式运营 退出", href: "" }),
    title: async () => "腾讯内容开放平台"
  }), "bai2bai");
});

test("configured content platform adapters wait for login cookies and are registered", async () => {
  for (const [platform, accountLabel, loginUrl, domain] of expectedPlatforms) {
    const adapter = new ContentPlatformAdapter(contentPlatformConfigs[platform], {
      browser: {
        launchPersistentContext: async () => ({
        pages: () => [{ goto: async () => {}, bringToFront: async () => {}, url: () => loginUrl }],
          cookies: async () => [strongCookieByPlatform[platform]],
          close: async () => {}
        })
      }
    });

    adapter.browser.launchPersistentContext = async () => ({
      pages: () => [{
        goto: async () => {},
        bringToFront: async () => {},
        url: () => workspaceStateByPlatform[platform].url,
        title: async () => workspaceStateByPlatform[platform].title,
        evaluate: async () => workspaceStateByPlatform[platform].text
      }],
      cookies: async () => [strongCookieByPlatform[platform]],
      close: async () => {}
    });

    assert.equal(await adapter.detectLoggedIn({ waitLoginMs: 10 }), true);
    assert.equal(getAdapter(platform).platform, platform);
    assert.equal(getAdapter(platform).accountLabel, accountLabel);
  }
});

test("configured platform profile path prefers the stable account profile key", () => {
  const adapter = new ContentPlatformAdapter(contentPlatformConfigs.netease);
  assert.equal(
    adapter.profileDir({
      profileRoot: "C:/profiles",
      profileKey: "stable-account-profile",
      sessionId: "transient-auth-session"
    }),
    path.join("C:/profiles", "netease", "stable-account-profile")
  );
});

test("configured platform validates a persistent session and reports refreshed credentials", async () => {
  const seededCookies = [];
  const refreshedArtifacts = [];
  const page = {
    _url: "about:blank",
    async goto(url) {
      this._url = url;
    },
    async bringToFront() {},
    url() {
      return "https://mp.163.com/article/edit";
    },
    async title() {
      return "Netease creator center";
    },
    async evaluate(callback) {
      if (typeof callback === "function") return "content management publish article";
      return "content management publish article";
    }
  };
  const context = {
    pages: () => [page],
    async newPage() {
      return page;
    },
    async addCookies(cookies) {
      seededCookies.push(...cookies);
    },
    async addInitScript() {},
    async cookies() {
      return [{
        name: "S_INFO",
        value: "creator-session",
        domain: ".163.com",
        path: "/",
        expires: -1
      }];
    },
    async close() {}
  };
  const adapter = new ContentPlatformAdapter(contentPlatformConfigs.netease, {
    browser: {
      async launchPersistentContext() {
        return context;
      }
    }
  });

  const result = await adapter.validateSession({
    profileKey: "stable-account-profile",
    cookies: [{ name: "S_INFO", value: "backup-session", domain: ".163.com", path: "/" }],
    localStorage: { creatorId: "account-1" },
    onCredentialRefresh: async (artifact) => refreshedArtifacts.push(artifact),
    keepBrowserOpen: false
  });

  assert.equal(result.valid, true);
  assert.equal(result.platform, "netease");
  assert.equal(seededCookies.length, 1);
  assert.equal(refreshedArtifacts.length, 1);
  assert.equal(refreshedArtifacts[0].authorizationEvidence.workspaceReady, true);
  assert.equal(refreshedArtifacts[0].credentialMetadata.hasSessionCredentials, true);
});

test("netease session validation opens the stable creator backend home", async () => {
  const navigations = [];
  const page = {
    async goto(url) {
      navigations.push(url);
    },
    async bringToFront() {},
    url: () => "https://mp.163.com/#/",
    title: async () => "Netease creator backend",
    evaluate: async () => "creator center content management publish article"
  };
  const context = {
    pages: () => [page],
    async newPage() {
      return page;
    },
    async addCookies() {},
    async addInitScript() {},
    async cookies() {
      return [{ name: "S_INFO", value: "creator-session", domain: ".163.com", path: "/" }];
    },
    async close() {}
  };
  const adapter = new NeteaseAdapter({
    browser: {
      async launchPersistentContext() {
        return context;
      }
    }
  });

  const result = await adapter.validateSession({
    profileKey: "stable-netease-account",
    cookies: [{ name: "S_INFO", value: "creator-session", domain: ".163.com", path: "/" }]
  });

  assert.equal(result.valid, true);
  assert.equal(navigations[0], "https://mp.163.com/");
});

test("netease session validation rejects a login page even when stale strong cookies remain", async () => {
  const page = {
    async goto() {},
    async bringToFront() {},
    url: () => "https://mp.163.com/login.html?url=https%3A%2F%2Fmp.163.com%2F#/",
    title: async () => "Netease login",
    evaluate: async () => "login register"
  };
  const context = {
    pages: () => [page],
    async newPage() { return page; },
    async addCookies() {},
    async addInitScript() {},
    async cookies() {
      return [{ name: "S_INFO", value: "stale-session", domain: ".163.com", path: "/" }];
    },
    async close() {}
  };
  const adapter = new NeteaseAdapter({
    browser: {
      async launchPersistentContext() { return context; }
    }
  });

  await assert.rejects(
    adapter.validateSession({
      profileKey: "stale-netease-account",
      cookies: [{ name: "S_INFO", value: "stale-session", domain: ".163.com", path: "/" }]
    }),
    /NETEASE_LOGIN_REQUIRED/
  );
});

test("netease reauth flow returns to mp backend before marking login active", async () => {
  const navigations = [];
  let pollCount = 0;
  const page = {
    async goto(url) {
      navigations.push(url);
    },
    async bringToFront() {},
    url() {
      if (pollCount < 2) return "https://mp.163.com/login.html?url=https%3A%2F%2Fmp.163.com%2F";
      return "https://mp.163.com/article/edit";
    },
    async title() {
      return pollCount < 2 ? "Netease login" : "Netease creator center";
    },
    async evaluate() {
      pollCount += 1;
      return pollCount < 2 ? "login register" : "content management publish article";
    }
  };
  const context = {
    pages: () => [page],
    async newPage() {
      return page;
    },
    async cookies() {
      if (pollCount < 1) return [{ name: "P_INFO", value: "passport-only", domain: ".163.com" }];
      return [
        { name: "P_INFO", value: "passport-only", domain: ".163.com" },
        { name: "NTES_SESS", value: "creator-session", domain: ".163.com" }
      ];
    },
    async close() {}
  };
  const adapter = new NeteaseAdapter({
    browser: {
      async launchPersistentContext() {
        return context;
      }
    }
  });

  assert.equal(await adapter.detectLoggedIn({ waitLoginMs: 200 }), true);
  assert.equal(navigations[0], "https://mp.163.com/");
  assert.ok(navigations.includes("https://mp.163.com/"));
  assert.equal(adapter.cookies.some((cookie) => cookie.name === "NTES_SESS"), true);
});

test("netease reauth flow rejects passport-only state without backend business entry", async () => {
  const page = {
    async goto() {},
    async bringToFront() {},
    url: () => "https://mp.163.com/login.html",
    title: async () => "Netease login",
    evaluate: async () => "login register"
  };
  const adapter = new NeteaseAdapter({
    browser: {
      async launchPersistentContext() {
        return {
          pages: () => [page],
          async cookies() {
            return [{ name: "P_INFO", value: "passport-only", domain: ".163.com" }];
          },
          async close() {}
        };
      }
    }
  });

  assert.equal(await adapter.detectLoggedIn({ waitLoginMs: 10 }), false);
});

test("netease auth artifact carries backend business text for api verification", async () => {
  const page = {
    async goto() {},
    async bringToFront() {},
    url: () => "https://mp.163.com/",
    title: async () => "NetEase creator backend",
    evaluate: async () => "content management publish article draft"
  };
  const context = {
    pages: () => [page],
    async newPage() {
      return page;
    },
    async cookies() {
      return [
        { name: "P_INFO", value: "passport-token", domain: ".163.com" },
        { name: "NTES_SESS", value: "creator-session", domain: ".163.com" }
      ];
    },
    async close() {}
  };
  const adapter = new NeteaseAdapter({
    browser: {
      async launchPersistentContext() {
        return context;
      }
    }
  });
  adapter.context = context;
  adapter.page = page;
  adapter.cookies = await context.cookies();

  const artifact = await adapter.collectAuthArtifact({ keepBrowserOpen: true });

  assert.equal(artifact.authorizationEvidence.strongCookiePresent, true);
  assert.equal(artifact.authorizationEvidence.workspaceReady, true);
  assert.match(artifact.authorizationEvidence.pageText, /content management publish article draft/);
});
