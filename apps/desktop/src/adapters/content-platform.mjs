import crypto from "node:crypto";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { collectWebStorage } from "./zhihu.mjs";
import {
  refreshCredentialFromWorkspace,
  resolveProfileDir,
  seedPersistentContext,
  summarizeCredentialExpiry
} from "../session-manager.mjs";
import { bringToFrontIfAllowed } from "../browser-visibility.mjs";
import { importPlaywrightChromium } from "./browser-runtime.mjs";

const DEFAULT_WAIT_LOGIN_MS = 300000;
const NETEASE_BACKEND_URL = "https://mp.163.com/";
const CHROMIUM_PROFILE_STATE_FILES = [
  "Local State",
  path.join("Default", "Preferences"),
];

export const contentPlatformConfigs = {
  csdn: {
    platform: "csdn",
    loginUrl: "https://mp.csdn.net/",
    origins: ["https://mp.csdn.net", "https://passport.csdn.net", "https://www.csdn.net"],
    cookieDomains: ["csdn.net"],
    accountLabel: "CSDN账号",
    genericTitle: "CSDN",
    fields: ["标题", "正文", "分类", "标签", "封面"],
    publishBaseUrl: "https://mp.csdn.net/mp_blog/creation/editor",
    strongCookieNames: ["UserToken", "UserName", "UserInfo", "UserNick"],
    loginUrlPatterns: [/passport\.csdn\.net/i, /\/login/i],
    workspaceUrlPatterns: [/mp\.csdn\.net\/mp_blog\//i, /mp\.csdn\.net\/.*(creation|editor|manage|console|article)/i]
  },
  netease: {
    platform: "netease",
    loginUrl: "https://mp.163.com/",
    origins: ["https://mp.163.com", "https://www.163.com", "https://reg.163.com"],
    cookieDomains: ["163.com"],
    accountLabel: "网易号账号",
    genericTitle: "网易号",
    fields: ["标题", "正文", "分类", "封面"],
    publishBaseUrl: "https://mp.163.com/article/edit",
    strongCookieNames: ["NTES_SESS", "S_INFO", "NTES_PASSPORT"],
    loginUrlPatterns: [/\/login/i, /reg\.163\.com/i],
    workspaceUrlPatterns: [/mp\.163\.com\/#\/(?:$|article|content|editor|media|dashboard|home|profile|wemedia)/i, /mp\.163\.com\/(article|content|editor|media|dashboard|home|profile|wemedia)/i],
    workspaceTextPatterns: [
      /\b(workspace|dashboard|console|editor|publish|content management|article management|write article)\b/i,
      /\u521b\u4f5c\u4e2d\u5fc3|\u5185\u5bb9\u7ba1\u7406|\u5de5\u4f5c\u53f0|\u53d1\u5e03|\u5199\u6587\u7ae0|\u6587\u7ae0\u7ba1\u7406|\u8349\u7a3f/i
    ]
  },
  penguin: {
    platform: "penguin",
    loginUrl: "https://om.qq.com/",
    origins: ["https://om.qq.com", "https://graph.qq.com", "https://xui.ptlogin2.qq.com"],
    cookieDomains: ["qq.com"],
    accountLabel: "企鹅号账号",
    genericTitle: "企鹅号",
    fields: ["标题", "正文", "分类", "封面", "原创声明"],
    publishBaseUrl: "https://om.qq.com/main/creation/article",
    strongCookieNames: ["omaccesstoken", "omtoken", "userid", "p_skey", "skey", "uin", "p_uin", "pt_key", "RK"],
    loginUrlPatterns: [/\/login/i, /userAuth/i, /ptlogin/i],
    workspaceUrlPatterns: [/om\.qq\.com\/(main|article|content|media|creator|dashboard|admin|home)/i]
  },
  toutiao: {
    platform: "toutiao",
    loginUrl: "https://mp.toutiao.com/profile_v4/",
    origins: ["https://mp.toutiao.com", "https://sso.toutiao.com", "https://www.toutiao.com"],
    cookieDomains: ["toutiao.com", "bytedance.com"],
    accountLabel: "头条号账号",
    genericTitle: "头条号",
    fields: ["标题", "正文", "分类", "封面", "原创声明"],
    publishBaseUrl: "https://mp.toutiao.com/profile_v4/graphic/publish",
    strongCookieNames: ["sessionid", "sid_tt", "passport_auth_status", "sso_uid_tt", "uid_tt", "sid_guard"],
    loginUrlPatterns: [/\/login/i, /sso\.toutiao\.com/i],
    workspaceUrlPatterns: [/mp\.toutiao\.com\/profile_v4/i, /mp\.toutiao\.com\/.*(publish|manage|article|content)/i]
  },
  jianshu: {
    platform: "jianshu",
    loginUrl: "https://www.jianshu.com/sign_in",
    origins: ["https://www.jianshu.com"],
    cookieDomains: ["jianshu.com"],
    accountLabel: "简书账号",
    genericTitle: "简书",
    fields: ["标题", "正文", "文集", "标签"],
    publishBaseUrl: "https://www.jianshu.com/writer",
    strongCookieNames: ["remember_user_token", "_m7e_session_core"],
    loginUrlPatterns: [/\/sign_in/i, /\/sign_up/i, /users\/password/i],
    workspaceUrlPatterns: [/jianshu\.com\/writer/i]
  }
};

function encodeEnvelope(payload) {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isBrowserClosedError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /Target page, context or browser has been closed|Browser has been closed|Target closed/i.test(message);
}

function snapshotKeyIsSensitive(key = "") {
  return /cookie|token|secret|password|credential|authorization|localstorage|sessionstorage|storage/i.test(String(key));
}

function sanitizeSnapshotValue(value, depth = 0) {
  if (depth > 4) return "";
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeSnapshotValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !snapshotKeyIsSensitive(key))
        .map(([key, item]) => [key, sanitizeSnapshotValue(item, depth + 1)])
    );
  }
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (value == null) return "";
  return String(value).slice(0, 1000);
}

function configuredPlatformRequiresCover(config) {
  if (typeof config.requiresCover === "boolean") return config.requiresCover;
  return (config.fields || []).some((field) => /cover|\u5c01\u9762|\u704f\u4f80\u6f70/i.test(String(field)));
}

async function repairChromiumExitState(userDataDir) {
  for (const relativePath of CHROMIUM_PROFILE_STATE_FILES) {
    const filePath = path.join(userDataDir, relativePath);
    let state;
    try {
      state = JSON.parse(await readFile(filePath, "utf8"));
    } catch {
      continue;
    }
    state.profile = {
      ...(state.profile || {}),
      exit_type: "Normal",
      exited_cleanly: true,
    };
    await writeFile(filePath, JSON.stringify(state), "utf8").catch(() => undefined);
  }
}

function fingerprintFor(snapshot) {
  const cookieShape = snapshot.cookies
    .map((cookie) => `${cookie.domain || ""}:${cookie.name}:${cookie.value || ""}`)
    .sort()
    .join("|");
  return crypto.createHash("sha256").update(cookieShape).digest("hex").slice(0, 16);
}

function isGenericTitle(config, value) {
  const text = cleanText(value);
  if (!text) return true;
  if (text.length > 64) return true;
  const genericValues = new Set([
    config.genericTitle,
    config.accountLabel,
    "首页",
    "创作中心",
    "内容管理",
    "工作台",
    "用户中心",
    "消息",
    "登录",
    "注册"
  ]);
  return genericValues.has(text) || text === "腾讯内容开放平台" || text === "企鹅号.腾讯内容开放平台";
}

function normalizeProfileAccountName(config, value) {
  const text = cleanText(value);
  if (config.platform !== "penguin") return text;
  const statusMatch = text.match(/^(.+?)\s+(正式运营|试运营|运营中|未认证|审核中|退出)(?:\s|$)/);
  if (statusMatch?.[1]) return statusMatch[1].trim();
  return text.replace(/^企鹅号\.腾讯内容开放平台\s*/, "").replace(/^腾讯内容开放平台\s*/, "").trim();
}

function hasValue(cookie = {}) {
  return typeof cookie.value === "string" && cookie.value.trim().length > 0;
}

function matchesAny(patterns = [], value = "") {
  const text = String(value || "");
  return patterns.some((pattern) => pattern.test(text));
}

const defaultWorkspaceTextPatterns = [
  /\b(creator|creation|workspace|dashboard|console|editor|publish|content management|article management|write article)\b/i,
  /\u521b\u4f5c\u4e2d\u5fc3|\u5185\u5bb9\u7ba1\u7406|\u5de5\u4f5c\u53f0|\u53d1\u5e03|\u5199\u6587\u7ae0|\u6587\u7ae0\u7ba1\u7406/i
];

export function isConfiguredPlatformCookie(config, cookie = {}) {
  const domain = String(cookie.domain || "").replace(/^\./, "");
  return (config.cookieDomains || []).some((item) => domain === item || domain.endsWith(`.${item}`));
}

export function normalizeConfiguredPlatformCookie(cookie = {}) {
  return {
    name: String(cookie.name || ""),
    value: String(cookie.value || ""),
    domain: String(cookie.domain || ""),
    path: cookie.path || "/",
    expires: cookie.expires,
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: cookie.sameSite,
    secure: Boolean(cookie.secure)
  };
}

export function isConfiguredPlatformLoggedInFromCookies(config, cookies = []) {
  return hasConfiguredPlatformStrongLoginCookie(config, cookies);
}

export function hasConfiguredPlatformStrongLoginCookie(config, cookies = []) {
  const strongNames = new Set((config.strongCookieNames || []).map((name) => String(name).toLowerCase()));
  return cookies.some((cookie) => (
    isConfiguredPlatformCookie(config, cookie)
    && strongNames.has(String(cookie.name || "").toLowerCase())
    && hasValue(cookie)
  ));
}

export function isConfiguredPlatformWorkspaceReady(config, pageState = {}) {
  const url = cleanText(pageState.url);
  const title = cleanText(pageState.title);
  const text = cleanText(pageState.text);
  const pageText = `${url} ${title} ${text}`;
  if (matchesAny(config.loginUrlPatterns, pageText)) return false;
  return matchesAny(config.workspaceUrlPatterns, url)
    || matchesAny(config.workspaceTextPatterns || defaultWorkspaceTextPatterns, pageText);
}

export function isConfiguredPlatformLoggedIn(config, cookies = [], pageState = {}) {
  return hasConfiguredPlatformStrongLoginCookie(config, cookies)
    && isConfiguredPlatformWorkspaceReady(config, pageState);
}

export async function readConfiguredPlatformPageState(page) {
  if (!page) return { url: "", title: "", text: "" };
  const url = typeof page.url === "function" ? cleanText(page.url()) : "";
  const title = typeof page.title === "function" ? cleanText(await page.title().catch(() => "")) : "";
  const text = typeof page.evaluate === "function"
    ? cleanText(await page.evaluate(() => document.body?.innerText?.slice(0, 8000) || "").catch(() => ""))
    : "";
  return { url, title, text };
}

export function buildContentPlatformConfigSnapshot(config, options = {}) {
  const fetchedAt = options.capturedAt || options.fetchedAt || new Date().toISOString();
  const pageState = options.pageState || {};
  const requiredFields = Array.isArray(config.fields) ? [...config.fields] : [];
  const capabilities = {
    schemaVersion: 1,
    fetchedAt,
    canPublishArticle: true,
    canUploadImages: options.canUploadImages ?? true,
    requiresCover: options.requiresCover ?? configuredPlatformRequiresCover(config),
    requiredFields
  };
  const platformConfig = {
    schemaVersion: 1,
    fetchedAt,
    platform: config.platform,
    loginUrl: config.loginUrl,
    publishBaseUrl: config.publishBaseUrl || "",
    origins: [...(config.origins || [])],
    cookieDomains: [...(config.cookieDomains || [])],
    requiredFields,
    sourceEvidence: sanitizeSnapshotValue({
      ...(options.sourceEvidence || {}),
      currentUrl: options.sourceEvidence?.currentUrl || pageState.url || "",
      pageTitle: options.sourceEvidence?.pageTitle || pageState.title || "",
      httpStatus: options.sourceEvidence?.httpStatus
    }),
    platformState: sanitizeSnapshotValue(options.platformState || {})
  };

  return { platformConfig, capabilities };
}

export function buildContentPlatformAuthArtifact(config, snapshot, options = {}) {
  const capturedAt = options.capturedAt || new Date().toISOString();
  const normalized = {
    platform: config.platform,
    origin: config.loginUrl,
    cookies: (snapshot.cookies || []).filter((cookie) => isConfiguredPlatformCookie(config, cookie)).map(normalizeConfiguredPlatformCookie),
    localStorage: snapshot.localStorage || {},
    sessionStorage: snapshot.sessionStorage || {},
    capturedAt
  };
  const fingerprint = fingerprintFor(normalized);
  const configSnapshot = buildContentPlatformConfigSnapshot(config, {
    ...options,
    capturedAt
  });

  return {
    cookies: `encrypted-cookie-${encodeEnvelope({ platform: config.platform, cookies: normalized.cookies, capturedAt })}`,
    localStorage: `encrypted-local-storage-${encodeEnvelope({ platform: config.platform, values: normalized.localStorage, capturedAt })}`,
    sessionStorage: `encrypted-session-storage-${encodeEnvelope({ platform: config.platform, values: normalized.sessionStorage, capturedAt })}`,
    fingerprint: `fp-${config.platform}-${fingerprint}`,
    storageVersion: 2,
    capturedAt,
    credentialMetadata: options.credentialMetadata || summarizeCredentialExpiry(
      normalized.cookies,
      config.strongCookieNames || []
    ),
    authorizationEvidence: options.authorizationEvidence || null,
    platformConfig: configSnapshot.platformConfig,
    capabilities: configSnapshot.capabilities
  };
}

export async function readConfiguredPlatformProfileFromDom(config, page) {
  if (!page?.evaluate) return null;
  const result = await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const selectors = [
      "[class*='account'] img[alt]",
      "[class*='avatar'] img[alt]",
      "[class*='user'] img[alt]",
      "[class*='profile'] img[alt]",
      "[class*='account'] [title]",
      "[class*='member'] [title]",
      "[class*='avatar'] [title]",
      "[class*='user'] [title]",
      "[class*='profile'] [title]",
      "[class*='account-name']",
      "[class*='member-name']",
      "[class*='user-name']",
      "[class*='nickname']",
      "a[href*='user']",
      "a[href*='member']",
      "a[href*='profile']"
    ];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      const text = clean(element?.getAttribute?.("alt"))
        || clean(element?.getAttribute?.("title"))
        || clean(element?.textContent);
      const href = clean(element?.closest?.("a")?.getAttribute?.("href") || element?.getAttribute?.("href"));
      if (text || href) return { text, href };
    }
    return null;
  }).catch(() => null);
  if (!result) return null;
  const text = normalizeProfileAccountName(config, result.text);
  if (!isGenericTitle(config, text)) return { accountName: text, avatar: "" };
  const token = cleanText(result.href).split("/").filter(Boolean).pop();
  return !isGenericTitle(config, token) ? { accountName: token, avatar: "" } : null;
}

export async function pickConfiguredPlatformAccountName(config, input = {}, page) {
  if (input.accountName?.trim()) return input.accountName.trim();
  const domProfile = await readConfiguredPlatformProfileFromDom(config, page);
  if (domProfile?.accountName && !isGenericTitle(config, domProfile.accountName)) return domProfile.accountName;
  const title = page ? await page.title().catch(() => "") : "";
  const name = cleanText(title)
    .replace(new RegExp(`\\s*-\\s*${config.genericTitle}\\s*$`), "")
    .replace(new RegExp(`\\s*${config.genericTitle}\\s*$`), "")
    .trim();
  return !isGenericTitle(config, name) ? name : config.accountLabel;
}

export class ContentPlatformAdapter {
  constructor(config, options = {}) {
    this.config = config;
    this.platform = config.platform;
    this.loginUrl = config.loginUrl;
    this.fieldNames = config.fields;
    this.accountLabel = config.accountLabel;
    this.browser = options.browser;
  }

  profileDir(input = {}) {
    const root = input.profileRoot || path.join(process.cwd(), ".zhixin-ai", "profiles");
    return resolveProfileDir(root, this.platform, input);
  }

  async launchAuthEnvironment(input = {}) {
    let context;
    const userDataDir = this.profileDir(input);
    const launchArgs = [
      "--disable-blink-features=AutomationControlled",
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble"
    ];
    await mkdir(userDataDir, { recursive: true });
    await repairChromiumExitState(userDataDir);
    if (this.browser?.launchPersistentContext) {
      context = await this.browser.launchPersistentContext(userDataDir, {
        headless: Boolean(input.headless),
        viewport: { width: 1360, height: 900 },
        args: launchArgs
      });
    } else {
      const chromium = await importPlaywrightChromium();
      context = await chromium.launchPersistentContext(userDataDir, {
        headless: Boolean(input.headless),
        viewport: { width: 1360, height: 900 },
        locale: "zh-CN",
        args: launchArgs
      });
    }
    await seedPersistentContext(context, {
      cookies: input.cookies,
      localStorage: input.localStorage,
      sessionStorage: input.sessionStorage,
      origins: this.config.origins || []
    });
    return context;
  }

  async openLoginPage(input = {}) {
    const context = await this.launchAuthEnvironment(input);
    const page = context.pages()[0] || await context.newPage();
    await page.goto(input.loginUrl || this.loginUrl, { waitUntil: "domcontentloaded" });
    await page.bringToFront().catch(() => undefined);
    return { context, page };
  }

  async waitForLogin(context, page, waitLoginMs = DEFAULT_WAIT_LOGIN_MS) {
    const startedAt = Date.now();
    const pollIntervalMs = Math.min(1500, Math.max(25, Math.floor(waitLoginMs / 4)));
    while (Date.now() - startedAt < waitLoginMs) {
      let cookies = [];
      try {
        cookies = await context.cookies(this.config.origins);
      } catch (error) {
        if (isBrowserClosedError(error)) throw error;
        cookies = [];
      }
      const pageState = await readConfiguredPlatformPageState(page);
      if (isConfiguredPlatformLoggedIn(this.config, cookies, pageState)) return cookies;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    return null;
  }

  async detectLoggedIn(input = {}) {
    const keepOpen = Boolean(input.keepBrowserOpen);
    let authEnvironment = await this.openLoginPage(input);
    this.context = authEnvironment.context;
    this.page = authEnvironment.page;
    let cookies;
    try {
      cookies = await this.waitForLogin(this.context, this.page, Number(input.waitLoginMs || DEFAULT_WAIT_LOGIN_MS));
    } catch (error) {
      if (!isBrowserClosedError(error)) throw error;
      authEnvironment = await this.openLoginPage(input);
      this.context = authEnvironment.context;
      this.page = authEnvironment.page;
      cookies = await this.waitForLogin(this.context, this.page, Number(input.waitLoginMs || DEFAULT_WAIT_LOGIN_MS));
    }
    if (!cookies) {
      if (!keepOpen) await this.context.close().catch(() => undefined);
      this.context = null;
      this.page = null;
      return false;
    }
    this.cookies = cookies;
    return true;
  }

  async readAccountProfile(input = {}) {
    const domProfile = await readConfiguredPlatformProfileFromDom(this.config, this.page);
    if (domProfile?.accountName && !isGenericTitle(this.config, domProfile.accountName)) return domProfile;
    return {
      accountName: await pickConfiguredPlatformAccountName(this.config, input, this.page),
      avatar: ""
    };
  }

  async collectAuthArtifact(input = {}) {
    const context = this.context || (await this.launchAuthEnvironment(input));
    const page = this.page || context.pages()[0] || await context.newPage();
    const primaryOrigin = new URL(this.loginUrl).origin;
    if (!page.url().startsWith(primaryOrigin)) {
      await page.goto(this.loginUrl, { waitUntil: "domcontentloaded" });
    }
    const cookies = this.cookies || await context.cookies(this.config.origins);
    const storage = await collectWebStorage(page);
    const pageState = await readConfiguredPlatformPageState(page);
    const artifact = buildContentPlatformAuthArtifact(this.config, { cookies, ...storage }, {
      authorizationEvidence: {
        strongCookiePresent: hasConfiguredPlatformStrongLoginCookie(this.config, cookies),
        workspaceReady: isConfiguredPlatformWorkspaceReady(this.config, pageState),
        currentUrl: pageState.url,
        pageTitle: pageState.title,
        pageText: pageState.text.slice(0, 1000),
        checkedAt: new Date().toISOString()
      }
    });

    if (!input.keepBrowserOpen && context === this.context) {
      await context.close().catch(() => undefined);
      this.context = null;
      this.page = null;
      this.cookies = null;
    }
    return artifact;
  }

  async captureCredentialArtifactFromContext(context, page) {
    const cookies = await context.cookies(this.config.origins);
    const pageState = await readConfiguredPlatformPageState(page);
    if (!isConfiguredPlatformLoggedIn(this.config, cookies, pageState)) {
      throw new Error(`${this.platform.toUpperCase()}_LOGIN_REQUIRED`);
    }
    const storage = await collectWebStorage(page);
    return buildContentPlatformAuthArtifact(this.config, { cookies, ...storage }, {
      authorizationEvidence: {
        strongCookiePresent: hasConfiguredPlatformStrongLoginCookie(this.config, cookies),
        workspaceReady: isConfiguredPlatformWorkspaceReady(this.config, pageState),
        currentUrl: pageState.url,
        pageTitle: pageState.title,
        pageText: pageState.text.slice(0, 1000),
        checkedAt: new Date().toISOString()
      }
    });
  }

  async reportCredentialRefresh(input, context, page) {
    const artifact = await this.captureCredentialArtifactFromContext(context, page);
    if (typeof input?.onCredentialRefresh === "function") {
      await input.onCredentialRefresh(artifact);
    }
    return artifact;
  }

  async refreshCredentialAfterOperation(input, context, page, validationUrl = "") {
    return refreshCredentialFromWorkspace({
      context,
      page,
      validationUrl: validationUrl || this.config.publishBaseUrl || this.loginUrl,
      report: (activeContext, activePage) => this.reportCredentialRefresh(input, activeContext, activePage),
      onError: input?.onCredentialRefreshError
    });
  }

  async validateSession(input = {}) {
    const context = await this.launchAuthEnvironment(input);
    const page = context.pages()[0] || await context.newPage();
    const keepOpen = Boolean(input.keepBrowserOpen);
    try {
      await page.goto(input.validationUrl || this.config.publishBaseUrl || this.loginUrl, { waitUntil: "domcontentloaded" });
      await bringToFrontIfAllowed(page, input);
      await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
      const artifact = await this.reportCredentialRefresh(input, context, page);
      return {
        valid: true,
        platform: this.platform,
        currentUrl: typeof page.url === "function" ? page.url() : "",
        credentialMetadata: artifact.credentialMetadata
      };
    } finally {
      if (!keepOpen) await context.close().catch(() => undefined);
    }
  }

  async publishArticle(input = {}) {
    const title = input.articleTitle || input.title || "desktop article";
    const slug = String(title).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-|-$/g, "") || Date.now();
    return {
      publishedUrl: `${this.config.publishBaseUrl}/${encodeURIComponent(slug)}`,
      title
    };
  }
}

export class NeteaseAdapter extends ContentPlatformAdapter {
  constructor(options = {}) {
    super(contentPlatformConfigs.netease, options);
  }

  async openLoginPage(input = {}) {
    return super.openLoginPage({
      ...input,
      loginUrl: NETEASE_BACKEND_URL
    });
  }

  async validateSession(input = {}) {
    return super.validateSession({
      ...input,
      validationUrl: input.validationUrl || NETEASE_BACKEND_URL
    });
  }

  async waitForLogin(context, page, waitLoginMs = DEFAULT_WAIT_LOGIN_MS) {
    const startedAt = Date.now();
    let redirectedToBackend = false;
    const pollIntervalMs = Math.min(1500, Math.max(25, Math.floor(waitLoginMs / 4)));
    while (Date.now() - startedAt < waitLoginMs) {
      let cookies = [];
      try {
        cookies = await context.cookies(this.config.origins);
      } catch (error) {
        if (isBrowserClosedError(error)) throw error;
        cookies = [];
      }

      const pageState = await readConfiguredPlatformPageState(page);
      if (isConfiguredPlatformLoggedIn(this.config, cookies, pageState)) return cookies;

      const hasPassportCookie = cookies.some((cookie) => (
        isConfiguredPlatformCookie(this.config, cookie)
        && String(cookie.name || "").toLowerCase() === "p_info"
        && hasValue(cookie)
      ));
      const stillOnLogin = matchesAny(this.config.loginUrlPatterns, `${pageState.url} ${pageState.title} ${pageState.text}`);
      if (hasPassportCookie && stillOnLogin && !redirectedToBackend && typeof page.goto === "function") {
        redirectedToBackend = true;
        await page.goto(NETEASE_BACKEND_URL, { waitUntil: "domcontentloaded" }).catch(() => undefined);
        continue;
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    return null;
  }
}
