import crypto from "node:crypto";
import path from "node:path";
import { access, mkdir, readFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { collectWebStorage } from "./zhihu.mjs";
import {
  refreshCredentialFromWorkspace,
  resolveProfileDir,
  seedPersistentContext,
  summarizeCredentialExpiry
} from "../session-manager.mjs";
import { buildImagePublicationEvidence, isPersistentPlatformImageUrl } from "../platform-images.mjs";
import { positionCursorAfterSection, readLocatorImages, uploadPlatformImages, verifyPlatformImages, verifyPublicImageEvidence } from "../editor-image-upload.mjs";
import { bringToFrontIfAllowed } from "../browser-visibility.mjs";
import { importPlaywrightChromium } from "./browser-runtime.mjs";
import { platformApiFetch, sanitizeApiEvidence } from "./platform-api.mjs";

// Hot-update compatibility floor. platform-images.mjs and editor-image-upload.mjs
// are bridged to the copies inside the installed MSI, and a device that has not
// taken an MSI update in a while can be running one from before this constant
// existed. Importing it here would make the bundle's smoke import fail on such a
// device, which silently keeps the old adapter instead of installing the fix. The
// value is only a stage label handed to buildImagePublicationEvidence as its
// publicBlocker argument, which older four-argument builds ignore, so defining it
// locally changes nothing about the evidence that gets produced.
const PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED = "PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED";

const BAIJIAHAO_ORIGIN = "https://baijiahao.baidu.com";
const BAIDU_ORIGIN = "https://www.baidu.com";

export function normalizeBaijiahaoImageUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    const hostname = url.hostname.toLowerCase();
    const trusted = hostname === "baidu.com"
      || hostname.endsWith(".baidu.com")
      || hostname === "bdstatic.com"
      || hostname.endsWith(".bdstatic.com");
    if (!trusted || !["http:", "https:"].includes(url.protocol)) return "";
    url.protocol = "https:";
    return url.toString();
  } catch {
    return "";
  }
}

export function baijiahaoDraftUrlFromArticleId(articleId) {
  const value = String(articleId || "").trim();
  return value ? `${BAIJIAHAO_EDITOR_URL}&article_id=${encodeURIComponent(value)}` : BAIJIAHAO_EDITOR_URL;
}
const BAIJIAHAO_LOGIN_URL = "https://baijiahao.baidu.com/";
const BAIJIAHAO_EDITOR_URL = "https://baijiahao.baidu.com/builder/rc/edit?type=news";
// The public article page renders inside a div keyed only by data-testid: its
// classes are build-scrambled (dpu8C, _18p7x) and there is no <article> element
// and no .article-content / .content class, so the legacy selectors below
// matched nothing and every public-page read came back empty.
const BAIJIAHAO_PUBLIC_ARTICLE_SELECTOR = "[data-testid='article'], article, .article-content, .content";
const BAIJIAHAO_PUBLIC_IMAGE_SELECTOR = "[data-testid='article'] img, article img, .article-content img, .content img";
const DEFAULT_WAIT_LOGIN_MS = 300000;
const DEFAULT_COVER_PATH = path.join(process.env.USERPROFILE || process.env.HOME || process.cwd(), ".zhixin-ai", "assets", "baijiahao-default-cover.png");

function encodeEnvelope(payload) {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function baijiahaoDiagnosticProxy(input = {}) {
  const value = cleanText(input.browserProxyServer || process.env.ZHIXIN_CAPTURE_PROXY_SERVER);
  if (!value) return null;
  try {
    const url = new URL(value);
    const isLoopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.protocol !== "http:" || !url.port || !isLoopback) return null;
    return { server: url.toString().replace(/\/$/, "") };
  } catch {
    return null;
  }
}

function isBrowserClosedError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /Target page, context or browser has been closed|Browser has been closed|Target closed/i.test(message);
}

function fingerprintFor(snapshot) {
  const cookieShape = snapshot.cookies
    .map((cookie) => `${cookie.domain || ""}:${cookie.name}:${cookie.value || ""}`)
    .sort()
    .join("|");
  return crypto.createHash("sha256").update(cookieShape).digest("hex").slice(0, 16);
}

function isUsefulAccountName(value) {
  const name = cleanText(value);
  if (!name) return false;
  if (name.length > 48) return false;
  return !["百家号", "首页", "内容管理", "创作中心", "工作台", "消息", "百家号账号"].includes(name);
}

function hasValue(cookie = {}) {
  return typeof cookie.value === "string" && cookie.value.trim().length > 0;
}

function matchesAny(patterns = [], value = "") {
  const text = String(value || "");
  return patterns.some((pattern) => pattern.test(text));
}

const BAIJIAHAO_LOGIN_PATTERNS = [/passport\.baidu\.com/i, /\/login/i, /wappass/i];
const BAIJIAHAO_WORKSPACE_URL_PATTERNS = [/baijiahao\.baidu\.com\/(builder|article|content|publish|manage|creation)/i];
const BAIJIAHAO_WORKSPACE_TEXT_PATTERNS = [
  /\b(creator|workspace|dashboard|content management|article management|publish)\b/i,
  /\u521b\u4f5c\u4e2d\u5fc3|\u5185\u5bb9\u7ba1\u7406|\u5de5\u4f5c\u53f0|\u53d1\u5e03|\u6587\u7ae0\u7ba1\u7406/i
];

export function isBaiduCookie(cookie = {}) {
  const domain = String(cookie.domain || "").replace(/^\./, "");
  return domain === "baidu.com" || domain.endsWith(".baidu.com");
}

export function normalizeBaiduCookie(cookie = {}) {
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

export function isBaijiahaoLoggedInFromCookies(cookies = []) {
  return hasBaijiahaoStrongLoginCookie(cookies);
}

export function hasBaijiahaoStrongLoginCookie(cookies = []) {
  return cookies.some((cookie) => (
    isBaiduCookie(cookie)
    && ["BDUSS", "BDUSS_BFESS", "STOKEN"].includes(cookie.name)
    && hasValue(cookie)
  ));
}

export function isBaijiahaoWorkspaceReady(pageState = {}) {
  const url = cleanText(pageState.url);
  const title = cleanText(pageState.title);
  const text = cleanText(pageState.text);
  const pageText = `${url} ${title} ${text}`;
  if (matchesAny(BAIJIAHAO_LOGIN_PATTERNS, pageText)) return false;
  return matchesAny(BAIJIAHAO_WORKSPACE_URL_PATTERNS, url)
    || matchesAny(BAIJIAHAO_WORKSPACE_TEXT_PATTERNS, pageText);
}

export function isBaijiahaoLoggedIn(cookies = [], pageState = {}) {
  return hasBaijiahaoStrongLoginCookie(cookies) && isBaijiahaoWorkspaceReady(pageState);
}

export async function readBaijiahaoPageState(page) {
  if (!page) return { url: "", title: "", text: "" };
  const url = typeof page.url === "function" ? cleanText(page.url()) : "";
  const title = typeof page.title === "function" ? cleanText(await page.title().catch(() => "")) : "";
  const text = typeof page.evaluate === "function"
    ? cleanText(await page.evaluate(() => document.body?.innerText?.slice(0, 8000) || "").catch(() => ""))
    : "";
  return { url, title, text };
}

export function buildBaijiahaoAuthArtifact(snapshot, options = {}) {
  const capturedAt = options.capturedAt || new Date().toISOString();
  const normalized = {
    platform: "baijiahao",
    origin: BAIJIAHAO_ORIGIN,
    cookies: (snapshot.cookies || []).filter(isBaiduCookie).map(normalizeBaiduCookie),
    localStorage: snapshot.localStorage || {},
    sessionStorage: snapshot.sessionStorage || {},
    capturedAt
  };
  const fingerprint = fingerprintFor(normalized);

  const credentialMetadata = mergeBaijiahaoEditorTokenExpiry(
    options.credentialMetadata || summarizeCredentialExpiry(
      normalized.cookies,
      ["BDUSS", "BDUSS_BFESS", "STOKEN"]
    ),
    normalized.localStorage
  );

  return {
    cookies: `encrypted-cookie-${encodeEnvelope({ platform: "baijiahao", cookies: normalized.cookies, capturedAt })}`,
    localStorage: `encrypted-local-storage-${encodeEnvelope({ platform: "baijiahao", values: normalized.localStorage, capturedAt })}`,
    sessionStorage: `encrypted-session-storage-${encodeEnvelope({ platform: "baijiahao", values: normalized.sessionStorage, capturedAt })}`,
    fingerprint: `fp-baijiahao-${fingerprint}`,
    storageVersion: 2,
    capturedAt,
    credentialMetadata,
    authorizationEvidence: options.authorizationEvidence || null
  };
}

// 发文能力的真实上限是 min(持久 cookie 过期时间, 编辑器 edit-token 过期时间)。
// 只取 cookie 会把 12 小时的发文窗口报成几百天（实测当前算出 2027-11-08，实际半天后即失效），
// 系统据此在 token 死后仍认为账号健康。credentialMetadata.credentialExpiresAt 是 API 侧
// mediaAccounts 的凭据过期时间与复查计划（nextCredentialCheckAt）的来源，必须反映真实上限。
export function mergeBaijiahaoEditorTokenExpiry(credentialMetadata = {}, localStorage = {}) {
  const decoded = decodeBaijiahaoRequestToken(localStorage?.[BAIJIAHAO_EDITOR_TOKEN_KEY]);
  if (!decoded.hasExpiry) return credentialMetadata;
  const merged = {
    ...credentialMetadata,
    editorTokenExpiresAt: decoded.expiresAt,
    editorTokenTtlSeconds: decoded.ttlSeconds,
  };
  const cookieExpiresAt = String(credentialMetadata.credentialExpiresAt || "");
  if (!cookieExpiresAt || Date.parse(decoded.expiresAt) < Date.parse(cookieExpiresAt)) {
    merged.credentialExpiresAt = decoded.expiresAt;
  }
  return merged;
}

export async function readBaijiahaoProfileFromDom(page) {
  if (!page?.evaluate) return null;
  const result = await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const selectors = [
      "[class*='account'] img[alt]",
      "[class*='avatar'] img[alt]",
      "[class*='user'] img[alt]",
      "[class*='account'] [title]",
      "[class*='avatar'] [title]",
      "[class*='user'] [title]",
      "[class*='account-name']",
      "[class*='user-name']",
      "[class*='name']"
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
  const text = cleanText(result.text);
  if (isUsefulAccountName(text)) return { accountName: text, avatar: "" };
  const token = cleanText(result.href).split("/").filter(Boolean).pop();
  return isUsefulAccountName(token) ? { accountName: token, avatar: "" } : null;
}

export async function pickBaijiahaoAccountName(input = {}, page) {
  if (input.accountName?.trim()) return input.accountName.trim();
  const domProfile = await readBaijiahaoProfileFromDom(page);
  if (isUsefulAccountName(domProfile?.accountName)) return domProfile.accountName;
  const title = page ? await page.title().catch(() => "") : "";
  const name = title
    .replace(/\s*-\s*百家号\s*$/, "")
    .replace(/\s*百家号\s*$/, "")
    .trim();
  return isUsefulAccountName(name) ? name : "百家号账号";
}

function normalizePublishInput(input = {}) {
  const title = cleanText(input.articleTitle || input.title);
  const content = cleanText(input.contentMarkdown || input.content || input.body || input.markdown);
  if (!title) throw new Error("BAIJIAHAO_TITLE_REQUIRED");
  if (title.length < 2) throw new Error("BAIJIAHAO_TITLE_TOO_SHORT");
  if (title.length > 64) throw new Error("BAIJIAHAO_TITLE_TOO_LONG");
  if (!content) throw new Error("BAIJIAHAO_CONTENT_REQUIRED");
  return {
    title,
    content,
    contentBlocks: Array.isArray(input.contentBlocks) ? input.contentBlocks : [],
    richHtml: String((input.platformImageTasks?.length ? input.contentHtmlWithoutImages : input.contentHtml) || "").trim(),
    platformImageTasks: Array.isArray(input.platformImageTasks) ? input.platformImageTasks : [],
    coverImagePath: cleanText(input.coverImagePath || input.coverPath || input.thumbnailPath || input.imagePath || DEFAULT_COVER_PATH),
    // 浏览器流程拿默认封面兜底，API 流程不能：为了一个兜底值去打上传接口，
    // 会在调用方压根没打算给封面时把整条发布链路打断。只有显式给了本地封面才上传。
    coverImageProvided: Boolean(cleanText(input.coverImagePath || input.coverPath || input.thumbnailPath || input.imagePath)),
    coverImageUrl: cleanText(input.coverImageUrl || input.coverUrl || input.thumbnailUrl || ""),
    confirmPublish: input.confirmPublish === true || input.publishMode === "publish",
    verifyPublication: input.verifyPublication === true,
    disposableTest: input.disposableTest === true,
    preserveDraftOnManualVerification: input.preserveDraftOnManualVerification === true,
    draftTimeoutMs: Number(input.draftTimeoutMs || 30000),
    publishTimeoutMs: Number(input.publishTimeoutMs || 45000),
    manualVerificationTimeoutMs: Number(input.manualVerificationTimeoutMs || input.securityVerificationTimeoutMs || 300000)
  };
}

function parseJsonLikePayload(text = "") {
  const value = String(text || "").trim();
  if (!value) return null;
  const jsonText = value.startsWith("{")
    ? value
    : value.replace(/^[^(]*\(/, "").replace(/\)\s*;?\s*$/, "");
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

function findArticleId(value) {
  if (!value || typeof value !== "object") return "";
  const direct = value.article_id || value.articleId || value.articleid || value.id || value.nid;
  if (direct) return String(direct);
  for (const item of Object.values(value)) {
    if (item && typeof item === "object") {
      const nested = findArticleId(item);
      if (nested) return nested;
    }
  }
  return "";
}

export function findBaijiahaoDraftArticleId(value) {
  if (!value || typeof value !== "object") return "";
  const direct = value.article_id || value.articleId || value.articleid;
  if (direct && /^\d{8,}$/.test(String(direct))) return String(direct);
  for (const item of Object.values(value)) {
    if (item && typeof item === "object") {
      const nested = findBaijiahaoDraftArticleId(item);
      if (nested) return nested;
    }
  }
  return "";
}

function publishedUrlFromApiPayload(payload) {
  const articleId = findArticleId(payload);
  return articleId ? `${BAIJIAHAO_ORIGIN}/s?id=${encodeURIComponent(articleId)}` : "";
}

function escapeBaijiahaoHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function baijiahaoStructuredBodyHtml(blocks = [], uploadedImages = []) {
  const newline = String.fromCharCode(10);
  // 内联图按块位置渲染。position 是块下标，先用它绑定；调用方没带 position 时
  // 退到 assetId / sectionId，三种都对不上就说明这张图没上传成功，只能丢掉。
  const uploaded = new Map();
  for (const image of Array.isArray(uploadedImages) ? uploadedImages : []) {
    if (!image?.platformImageUrl) continue;
    const keys = [
      `position:${Number(image.position ?? -1)}`,
      image.assetId ? `asset:${cleanText(image.assetId)}` : "",
      image.sectionId ? `section:${cleanText(image.sectionId)}` : "",
    ].filter(Boolean);
    for (const key of keys) if (!uploaded.has(key)) uploaded.set(key, image);
  }
  return (Array.isArray(blocks) ? blocks : []).map((block, index) => {
    if (block?.type === "image") {
      const image = uploaded.get(`position:${index}`)
        || (cleanText(block.assetId) ? uploaded.get(`asset:${cleanText(block.assetId)}`) : null)
        || (cleanText(block.sectionId) ? uploaded.get(`section:${cleanText(block.sectionId)}`) : null);
      return image ? baijiahaoInlineImageHtml(image) : "";
    }
    if (block?.type !== "section") return "";
    return String(block.content || "")
      .split(newline + newline)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
      .map((paragraph) => `<p style="margin: 0 0 12px; line-height: 1.8;">${escapeBaijiahaoHtml(paragraph).replace(new RegExp(newline, "g"), "<br>")}</p>`)
      .join("");
  }).join("");
}

function baijiahaoInlineImageHtml(image = {}) {
  const src = escapeBaijiahaoHtml(String(image?.platformImageUrl || ""));
  if (!src) return "";
  const alt = escapeBaijiahaoHtml(cleanText(image?.altText || "文章插图"));
  return `<p style="margin: 0 0 12px; line-height: 1.8; text-align: center;"><img src="${src}" alt="${alt}"></p>`;
}

function baijiahaoBodyHtml(publishInput = {}) {
  const uploadedImages = (Array.isArray(publishInput.uploadedImages) ? publishInput.uploadedImages : [])
    .filter((image) => image?.platformImageUrl);
  if (publishInput.contentBlocks?.length) {
    return baijiahaoStructuredBodyHtml(publishInput.contentBlocks, uploadedImages) || `<p>${escapeBaijiahaoHtml(publishInput.content)}</p>`;
  }
  const base = publishInput.richHtml || String(publishInput.content || "")
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeBaijiahaoHtml(paragraph)}</p>`)
    .join("") || "<p><br></p>";
  // 没有结构化块时内联图只能追加在正文后面，块序信息已经丢了，但至少不会整批丢失。
  return uploadedImages.length ? `${base}${uploadedImages.map(baijiahaoInlineImageHtml).join("")}` : base;
}

function baijiahaoApiConfig(input = {}) {
  const config = input.platformConfig && typeof input.platformConfig === "object" ? input.platformConfig : {};
  const configuredSaveApiUrl = cleanText(config.saveApiUrl || "");
  return {
    draftSaveApiUrl: cleanText(config.draftSaveApiUrl || configuredSaveApiUrl || `${BAIJIAHAO_ORIGIN}/pcui/article/save?callback=bjhdraft`),
    previewSaveApiUrl: cleanText(config.previewSaveApiUrl || configuredSaveApiUrl || `${BAIJIAHAO_ORIGIN}/pcui/article/save?callback=bjhpreview`),
    editApiUrl: cleanText(config.editApiUrl || `${BAIJIAHAO_ORIGIN}/pcui/article/edit`),
    publishApiUrl: cleanText(config.publishApiUrl || config.publishUrl || `${BAIJIAHAO_ORIGIN}/pcui/article/publish?type=news`),
    listApiUrl: cleanText(config.listApiUrl || `${BAIJIAHAO_ORIGIN}/pcui/article/lists?currentPage=1&pageSize=10&search=&type=&collection=&startDate=&endDate=&clearBeforeFetch=false&dynamic=1`),
    withdrawApiUrl: cleanText(config.withdrawApiUrl || `${BAIJIAHAO_ORIGIN}/pcui/article/withdraw`),
    removeApiUrl: cleanText(config.removeApiUrl || `${BAIJIAHAO_ORIGIN}/pcui/article/remove`),
    appInfoApiUrl: cleanText(config.appInfoApiUrl || `${BAIJIAHAO_ORIGIN}/builder/app/appinfo`),
    imageUploadApiUrl: cleanText(config.imageUploadApiUrl || `${BAIJIAHAO_ORIGIN}/materialui/picture/uploadProxy`),
    activityList: config.activityList || [
      { id: "ai_tts", is_checked: "1" },
      { id: "aigc_bjh_status", is_checked: "0" },
    ],
  };
}

// API 通道是默认路径。百家号编辑器页加载后会持续重导航主框架，fillTitle 里的裸
// locator.click() 会在导航发生的瞬间打空，紧接着的 fill 就抛
// BAIJIAHAO_TITLE_FIELD_NOT_FOUND，浏览器流程因此跑不通。API 流程只用页面内的
// BrowserContext 请求共享 cookie 且不依赖页面执行上下文。需要诊断或抓包时才用 apiFirst: false
// （或 platformConfig.apiFirst: false）显式退回浏览器流程。
function shouldPublishBaijiahaoViaApi(input = {}) {
  if (input.apiFirst === false) return false;
  const config = input.platformConfig && typeof input.platformConfig === "object" ? input.platformConfig : {};
  return config.apiFirst !== false;
}

function baijiahaoApiErrorIsTerminal(error) {
  const message = String(error?.message || error || "");
  return /LOGIN_REQUIRED|SECURITY_VERIFICATION_REQUIRED|MANUAL_ACTION_REQUIRED|AUTH|CAPTCHA|RISK|SECURITY|VERIFY/i.test(message);
}

// 百家号真实错误码（来自 2026-08-06 verify-10000013 抓包）：
// 10000013 = 登录已过期，请重新登录；10000008 = 您操作太频繁了，请稍后重试；10001001 = transform_id内容不能为空。
// 三者都不是安全验证，必须和风控验证区分开，否则会把登录失效误报成人工验证。
// 20040001 = 当前用户未登录。本机实测在 localStorage 的 edit-token 消失后由写接口返回，
// 与 10000013 同属凭据失效；此前它落到通用 NOT_ACCEPTED 分支，既不带恢复语义也不会触发重授权。
const BAIJIAHAO_LOGIN_EXPIRED_CODES = new Set(["10000013", "20040001"]);
// 抓包中未出现过任何"安全验证"错误码，这里只保留明确的风控码与验证话术，
// 不再用宽泛字段名匹配（见 publishApiHasSecurityVerification 注释）。
const BAIJIAHAO_SECURITY_VERIFICATION_CODES = new Set(["10000015"]);
const BAIJIAHAO_SECURITY_VERIFICATION_MESSAGE = /安全验证|完成验证|人机识别|滑块|图文验证|验证码|网络环境异常|操作环境异常|风险控制|security verification|captcha|robot verification/i;

function baijiahaoApiErrorCode(payload) {
  if (!payload || typeof payload !== "object") return "";
  const raw = payload.errno ?? payload.code ?? payload.status;
  const text = String(raw ?? "").trim();
  return /^\d{1,12}$/.test(text) ? text : "";
}

function baijiahaoApiErrorMessage(payload) {
  if (!payload || typeof payload !== "object") return "";
  return [payload.errmsg, payload.msg, payload.message, payload.error, payload.errorMsg, payload.reason]
    .filter((value) => typeof value === "string" && value.trim())
    .join(" ");
}

function baijiahaoPublishPayloadAccepted(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.success === false) return false;
  const code = payload.errno ?? payload.code ?? payload.status;
  if (code !== undefined && ![0, "0", 200, "200"].includes(code)) return false;
  const text = JSON.stringify(payload);
  return payload.success === true
    || [0, "0", 200, "200"].includes(code)
    || /"_action"\s*:\s*"publish"|success|publish/i.test(text);
}

function baijiahaoApiFailureCode(result = {}, stage = "") {
  const status = Number.isInteger(Number(result.status)) ? Number(result.status) : 0;
  const rawCode = result.payload?.errno ?? result.payload?.code ?? result.payload?.status;
  const code = /^[A-Za-z0-9_-]{1,32}$/.test(String(rawCode ?? "")) ? String(rawCode) : "UNKNOWN";
  return `BAIJIAHAO_API_${String(stage || "unknown").toUpperCase()}_NOT_ACCEPTED_HTTP_${status}_CODE_${code}`;
}

async function readBaijiahaoRuntimePublishFields(page) {
  if (typeof page?.evaluate !== "function") throw new Error("BAIJIAHAO_RUNTIME_FIELDS_REQUIRED");
  const fields = await page.evaluate(() => {
    const read = (name) => {
      const selector = `[name="${name}"], [data-name="${name}"], #${name}`;
      const element = document.querySelector(selector);
      return String(element?.value || element?.getAttribute("content") || "").trim();
    };
    return {
      nonce: read("BJH_FE_NOUNCE"),
      bjhmt: read("bjhmt"),
    };
  }).catch(() => null);
  // 读不到就留空，由调用方省略该字段。不编造 nonce：随机兜底发出去的值与真实表单不符，
  // 属于已被观测到的风控触发点（2026-08-06 12:04 BAIJIAHAO_SECURITY_VERIFICATION_REQUIRED）。
  return {
    nonce: cleanText(fields?.nonce),
    bjhmt: cleanText(fields?.bjhmt),
  };
}

// 百家号编辑器写进 localStorage 的 edit-token 是 JWT，实测寿命恒定 43200 秒（12 小时）：
// 生产库 44/44 张 artifact 解出 exp - iat 全等，横跨三代 profileKey 无例外。
// 持久 cookie（BDUSS 等）是另一个量级的时间尺度，只统计 cookie 会让系统把
// "半天后失去发文能力"误报成"还有一年多有效期"。
const BAIJIAHAO_EDITOR_TOKEN_KEY = "edit-token";
// 剩余寿命低于该值就不再发起写请求：封面上传 -> 草稿 -> publish 四阶段期间 token 可能过期，
// 提前判失效才能走重新授权，而不是把请求发出去让平台回 20040001。
const BAIJIAHAO_TOKEN_MIN_REMAINING_MS = 5 * 60 * 1000;

export function decodeBaijiahaoRequestToken(rawValue) {
  let token = String(rawValue ?? "").trim();
  try {
    const decoded = JSON.parse(token);
    if (typeof decoded === "string") token = decoded.trim();
  } catch {
    // 旧版编辑器可能直接存 token 字符串，不做 JSON 包装。
  }
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1]) return { token, hasExpiry: false };
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const exp = Number(payload?.exp);
    const iat = Number(payload?.iat);
    if (!Number.isFinite(exp) || exp <= 0) return { token, hasExpiry: false };
    const hasIssuedAt = Number.isFinite(iat) && iat > 0;
    return {
      token,
      hasExpiry: true,
      exp,
      iat: hasIssuedAt ? iat : 0,
      ttlSeconds: hasIssuedAt ? exp - iat : 0,
      expiresAt: new Date(exp * 1000).toISOString(),
      remainingMs: exp * 1000 - Date.now(),
    };
  } catch {
    return { token, hasExpiry: false };
  }
}

export async function readBaijiahaoRequestToken(page) {
  const context = typeof page?.context === "function" ? page.context() : null;
  let value;
  if (typeof context?.storageState === "function") {
    // Read browser-owned storage, independent of the document execution context.
    // Do not fall back to a stale credential snapshot or swallow browser failures.
    const state = await context.storageState();
    value = state.origins?.find((entry) => entry.origin === BAIJIAHAO_ORIGIN)
      ?.localStorage?.find((entry) => entry.name === "edit-token")?.value || "";
  } else {
    if (typeof page?.evaluate !== "function") throw new Error("BAIJIAHAO_RUNTIME_TOKEN_REQUIRED: NEEDS_REAUTH");
    value = await page.evaluate(() => window.localStorage?.getItem("edit-token") || "");
  }
  const decoded = decodeBaijiahaoRequestToken(value);
  if (!decoded.token) throw new Error("BAIJIAHAO_NEEDS_REAUTH: BAIJIAHAO_RUNTIME_TOKEN_REQUIRED; 请重新授权百家号以获取发布凭证");
  // API 侧只按 errorMessage 里的标记子串判断是否确认登出（main.py 的两个标记集合都含
  // TOKEN_EXPIRED），而且桌面端上报前会被 sanitizeCommandFailure 收敛成单个错误码，
  // 所以两种情形必须共用同一个码，区别只放在冒号后的说明里：换个后缀（如 _STALE）就
  // 匹配不到任何标记，账号只会被标成 stale 而不是 needs_reauth，守卫等于白做。
  if (decoded.hasExpiry && decoded.remainingMs < BAIJIAHAO_TOKEN_MIN_REMAINING_MS) {
    const remainingSeconds = Math.round(decoded.remainingMs / 1000);
    throw new Error(remainingSeconds > 0
      ? `BAIJIAHAO_RUNTIME_TOKEN_EXPIRED: edit-token expires in ${remainingSeconds}s, below the ${BAIJIAHAO_TOKEN_MIN_REMAINING_MS / 1000}s publish guard`
      : `BAIJIAHAO_RUNTIME_TOKEN_EXPIRED: edit-token expired at ${decoded.expiresAt}`);
  }
  return decoded.token;
}

// edit-token 过期后会从 localStorage 消失，此时从页面捕获的 artifact 只剩 cookie 语义：
// BJH_EXPIRATION_<key> 伴生键这套写法本身是实测存在的——2026-10-05 抓到 upsms-pcApi /
// XLAB_CS 与各自的 BJH_EXPIRATION_* 成对 set+remove。但 edit-token 是否也走这条清理
// 路径目前只是推断：依据是生产库里 token 已经死掉的 artifact，其注入存储里都没有
// edit-token，而没有直接抓到过 BJH_EXPIRATION_edit-token 的现场。credentialMetadata 的
// credentialExpiresAt 退回持久 cookie 的过期时间（当前算出 2027-11-08 量级）。
// API 的 /artifacts/refresh 是整体替换：新建 artifact、旧记录标 superseded，
// 同时把 mediaAccount 重置为 credentialStatus=active、consecutiveAuthFailures=0、
// nextCredentialCheckAt 按推送的 expiresAt 重排；session_validation_succeeded 事件
// 也会用桌面端返回的 credentialMetadata 重设账号。一次 token 死掉后的失败运行若照常
// 推送/上报，12 小时发文窗口的诚实信号就被全部抹掉，重新回到"还有一年有效期"。
// 对账规则：命令开始时的 storage（线上 artifact 解码而来，也是注入编辑器的那份）
// 里有 edit-token，而本次页面捕获没有时判定为降级：不上传、不用降级后的 metadata
// 上报，让命令行失败路径（BAIJIAHAO_RUNTIME_TOKEN_EXPIRED → needs_reauth）说话。
export function baijiahaoCaptureLosesEditorToken(artifact = {}, storedLocalStorage = {}) {
  const storedToken = String(storedLocalStorage?.[BAIJIAHAO_EDITOR_TOKEN_KEY] || "");
  if (!storedToken) return false;
  return !artifact?.credentialMetadata?.editorTokenExpiresAt;
}

export async function baijiahaoPageApiFetch(page, url, options = {}) {
  if (typeof page?.evaluate !== "function") throw new Error("BAIJIAHAO_BROWSER_API_CONTEXT_REQUIRED");
  const method = String(options.method || "GET").toUpperCase();
  const data = options.form ? new URLSearchParams(options.form).toString() : "";
  const headers = {
    ...(options.form ? { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" } : {}),
    ...(options.headers || {}),
  };
  const request = page.context?.()?.request;
  // BrowserContext requests share cookies but outlive document navigation.
  // Never retry or fall back after sending: a publish may already be accepted.
  const response = typeof request?.fetch === "function"
    ? await (async () => {
      const result = await request.fetch(url, {
        method, headers, ...(data ? { data } : {}),
        timeout: 25000, maxRetries: 0, maxRedirects: 0,
      });
      try {
        return { status: result.status(), url: result.url(), text: await result.text() };
      } finally {
        await result.dispose();
      }
    })()
    : await withBaijiahaoPageTimeout(
    page.evaluate(async ({ requestUrl, requestMethod, requestData, requestHeaders }) => {
      // Keep browser-origin cookies without invoking page-patched fetch.
      const requestOptions = { credentials: "include" };
      return await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(requestMethod, requestUrl, true);
        xhr.withCredentials = requestOptions.credentials === "include";
        xhr.timeout = 25000;
        for (const [name, value] of Object.entries(requestHeaders)) {
          // The browser supplies Referer; scripts cannot set this header.
          if (name.toLowerCase() !== "referer") xhr.setRequestHeader(name, String(value));
        }
        xhr.onload = () => resolve({ status: xhr.status, url: xhr.responseURL || requestUrl, text: xhr.responseText });
        xhr.onerror = () => reject(new Error("BAIJIAHAO_API_NETWORK_ERROR"));
        xhr.ontimeout = () => reject(new Error("BAIJIAHAO_API_NETWORK_TIMEOUT"));
        xhr.onabort = () => reject(new Error("BAIJIAHAO_API_NETWORK_ABORTED"));
        xhr.send(requestData || null);
      });
    }, {
    requestUrl: url,
    requestMethod: method,
    requestData: data,
    requestHeaders: headers,
    }),
    30000
  );
  const status = Number(response?.status || 0);
  const text = String(response?.text || "");
  const payload = parseJsonLikePayload(text);
  const evidence = sanitizeApiEvidence({
    request: { method, url, headers, data: data ? "REDACTED" : "" },
    response: { status, url: String(response?.url || url), payload },
  });
  return { ok: status >= 200 && status < 300, status, url: String(response?.url || url), payload, text, evidence };
}

function baijiahaoActivityFields(activityList = []) {
  const form = {};
  for (const [index, item] of (Array.isArray(activityList) ? activityList : []).entries()) {
    const id = cleanText(item?.id);
    if (!id) continue;
    form[`activity_list[${index}][id]`] = id;
    form[`activity_list[${index}][is_checked]`] = String(item?.is_checked ?? "1");
  }
  return form;
}

function baijiahaoArticleForm(publishInput = {}, config = {}, articleId = "") {
  const content = baijiahaoBodyHtml(publishInput);
  const form = {
    type: "news",
    title: publishInput.title,
    content,
    len: String(content.length),
    source: cleanText(publishInput.source || config.source || "upload"),
    source_reprinted_allow: "0",
    abstract_from: "1",
    isBeautify: "false",
    usingImgFilter: "false",
    first_exclusive_publish_v2: "3",
    subtitle: "",
    bjhtopic_id: "",
    bjhtopic_info: "",
    ...baijiahaoActivityFields(config.activityList),
  };
  if (articleId) form.article_id = articleId;
  if (publishInput.coverImageUrl) {
    const coverSourceTag = cleanText(publishInput.coverSourceTag || config.coverSourceTag || "text");
    form.cover_images = JSON.stringify([{
      src: publishInput.coverImageUrl,
      cover_source_tag: coverSourceTag,
      cropData: {},
      isLegal: 0,
      machine_chooseimg: 0,
    }]);
    form._cover_images_map = JSON.stringify([{
      origin_src: publishInput.coverImageUrl,
      src: publishInput.coverImageUrl,
    }]);
    form["cover_image_source[wide_cover_image_source]"] = cleanText(
      publishInput.coverImageSourceWide
      || config.coverImageSourceWide
      || coverSourceTag
    );
    form.cover_source = cleanText(publishInput.coverSource || config.coverSource || "upload");
    form.cover_layout = cleanText(publishInput.coverLayout || config.coverLayout || "one");
  }
  return form;
}

async function callBaijiahaoApi(page, url, form, stage, requestToken = "") {
  const result = await baijiahaoPageApiFetch(page, url, {
    method: "POST",
    form,
    headers: {
      ...(requestToken ? { token: requestToken } : {}),
    },
  });
  if ([401, 403].includes(result.status)) throw new Error("BAIJIAHAO_LOGIN_REQUIRED");
  if (BAIJIAHAO_LOGIN_EXPIRED_CODES.has(baijiahaoApiErrorCode(result.payload))) throw new Error("BAIJIAHAO_LOGIN_REQUIRED");
  if (publishApiHasSecurityVerification(result.payload)) {
    writeBaijiahaoBlockerDiagnostic(stage, url, result);
    throw new Error("BAIJIAHAO_SECURITY_VERIFICATION_REQUIRED");
  }
  if (!result.ok || !baijiahaoPublishPayloadAccepted(result.payload)) {
    throw new Error(baijiahaoApiFailureCode(result, stage));
  }
  return result;
}

function writeBaijiahaoBlockerDiagnostic(stage, url, result) {
  try {
    const logPath = path.join(process.env.USERPROFILE || process.env.HOME || ".", ".zhixin-ai", "baijiahao-publish-block.log");
    const line = JSON.stringify({
      at: new Date().toISOString(),
      stage,
      status: result.status,
      blockedResponse: sanitizeApiEvidence({ stage, url, payload: result.payload }),
    });
    appendFileSync(logPath, `${line}\n`, "utf8");
  } catch {
    // diagnostics must never break publishing
  }
}

async function reloadBaijiahaoArticle(page, config, articleId, requestToken = "") {
  const editUrl = new URL(config.editApiUrl || `${BAIJIAHAO_ORIGIN}/pcui/article/edit`);
  editUrl.searchParams.set("article_id", articleId);
  editUrl.searchParams.set("type", "news");
  const result = await baijiahaoPageApiFetch(page, editUrl.toString(), {
    method: "GET",
    headers: {
      Referer: BAIJIAHAO_EDITOR_URL,
      ...(requestToken ? { token: requestToken } : {}),
    },
  });
  if ([401, 403].includes(result.status)) throw new Error("BAIJIAHAO_LOGIN_REQUIRED");
  if (!result.ok || !baijiahaoPublishPayloadAccepted(result.payload)) {
    throw new Error("BAIJIAHAO_API_EDIT_NOT_ACCEPTED");
  }
  return result;
}

function baijiahaoListItems(payload) {
  const list = payload?.data?.list;
  return Array.isArray(list) ? list : [];
}

function baijiahaoCoverImageCount(item = {}) {
  const images = item.cover_images ?? item.coverImages ?? item.new_cover_images ?? [];
  if (Array.isArray(images)) return images.filter(Boolean).length;
  if (typeof images === "string") return images.split(/[,;|]/).map((value) => value.trim()).filter(Boolean).length;
  return images && typeof images === "object" ? Object.values(images).filter(Boolean).length : 0;
}

export async function readBaijiahaoArticleList(page, input = {}) {
  const articleId = cleanText(input.articleId || input.article_id);
  if (!/^\d{8,}$/.test(articleId)) throw new Error("BAIJIAHAO_ARTICLE_ID_REQUIRED");
  const config = baijiahaoApiConfig(input);
  const result = await platformApiFetch(page, config.listApiUrl, {
    method: "GET",
    headers: {
      Referer: BAIJIAHAO_EDITOR_URL,
      ...(input.requestToken ? { token: input.requestToken } : {}),
    },
  });
  if ([401, 403].includes(result.status)) throw new Error("BAIJIAHAO_LOGIN_REQUIRED");
  if (!result.ok || !baijiahaoPublishPayloadAccepted(result.payload)) {
    throw new Error("BAIJIAHAO_API_LIST_NOT_ACCEPTED");
  }
  const item = baijiahaoListItems(result.payload).find((candidate) => (
    String(candidate?.article_id || candidate?.articleId || candidate?.id || "") === articleId
  ));
  // A list item only counts as a public backlink when the platform itself says
  // the article is published and served a public URL for it. Deriving the URL
  // from whatever the item happens to carry reported a draft's editor address as
  // a published article.
  const publiclyVisible = baijiahaoListItemPubliclyVisible(item || {});
  return {
    found: Boolean(item),
    articleId,
    title: cleanText(item?.title),
    status: item?.status ?? "",
    isPublished: item?.is_published,
    publicUrl: publiclyVisible.publicUrl,
    publiclyVisible,
    coverImageCount: baijiahaoCoverImageCount(item),
    evidence: result.evidence,
  };
}

export async function cleanupBaijiahaoArticle(page, input = {}) {
  const articleId = cleanText(input.articleId || input.article_id);
  if (!/^\d{8,}$/.test(articleId)) throw new Error("BAIJIAHAO_ARTICLE_ID_REQUIRED");
  const config = baijiahaoApiConfig(input);
  let withdraw = null;
  let withdrawalNotRequired = false;
  let withdrawalRateLimited = false;
  try {
    withdraw = await callBaijiahaoApi(page, config.withdrawApiUrl, { article_id: articleId }, "withdraw", input.requestToken);
  } catch (error) {
    const message = String(error?.message || error);
    if (/BAIJIAHAO_API_WITHDRAW_NOT_ACCEPTED_HTTP_200_CODE_10000008/.test(message)) {
      // 已发布稿撤回撞上频控（10000008 操作太频繁）不等于清理失败：撤回只是状态回落，
      // remove 仍然可以把稿子删掉。2026-10-04 07:29 那一单就是在这里抛错，
      // 结果已经成功发布的测试稿没被清掉。记录后继续走 remove。
      withdrawalRateLimited = true;
    } else if (!/BAIJIAHAO_API_WITHDRAW_NOT_ACCEPTED_HTTP_200_CODE_20040028/.test(message)) {
      throw error;
    } else {
      withdrawalNotRequired = true;
    }
  }
  const remove = await callBaijiahaoApi(page, config.removeApiUrl, { article_id: articleId }, "remove", input.requestToken);
  return {
    articleId,
    withdrawn: Boolean(withdraw),
    ...(withdrawalNotRequired ? { withdrawalNotRequired: true } : {}),
    ...(withdrawalRateLimited ? { withdrawalRateLimited: true } : {}),
    removed: true,
    evidence: {
      source: "api",
      stages: [
        ...(withdraw
          ? [{ stage: "withdraw", httpStatus: withdraw.status, response: withdraw.evidence.response.payload }]
          : [{ stage: withdrawalRateLimited ? "withdraw_rate_limited" : "withdraw_not_required" }]),
        { stage: "remove", httpStatus: remove.status, response: remove.evidence.response.payload },
      ],
    },
  };
}

function baijiahaoImageMimeType(imagePath = "") {
  const extension = path.extname(imagePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  return "image/jpeg";
}

export async function uploadBaijiahaoImage(page, input = {}) {
  const imagePath = cleanText(input.imagePath || input.coverImagePath || input.path);
  if (!imagePath) throw new Error("BAIJIAHAO_IMAGE_PATH_REQUIRED");
  const config = baijiahaoApiConfig(input);
  const appInfo = await platformApiFetch(page, config.appInfoApiUrl, {
    method: "GET",
    headers: {
      Referer: BAIJIAHAO_EDITOR_URL,
      ...(input.requestToken ? { token: input.requestToken } : {}),
    },
  });
  const appId = cleanText(appInfo.payload?.data?.user?.app_id || appInfo.payload?.data?.app_id);
  if (!appInfo.ok || !baijiahaoPublishPayloadAccepted(appInfo.payload) || !/^\d{8,}$/.test(appId)) {
    throw new Error("BAIJIAHAO_RUNTIME_APP_ID_REQUIRED");
  }
  const filename = path.basename(imagePath);
  const media = await readFile(imagePath).catch(() => null);
  if (!media?.length) throw new Error("BAIJIAHAO_IMAGE_READ_FAILED");
  const upload = await platformApiFetch(page, config.imageUploadApiUrl, {
    method: "POST",
    multipart: {
      org_file_name: filename,
      type: "image",
      app_id: appId,
      is_waterlog: "1",
      save_material: "1",
      no_compress: "0",
      is_events: "",
      article_type: "news",
      media: { name: filename, mimeType: baijiahaoImageMimeType(filename), buffer: media },
    },
    headers: {
      Referer: BAIJIAHAO_EDITOR_URL,
      ...(input.requestToken ? { token: input.requestToken } : {}),
    },
  });
  if ([401, 403].includes(upload.status)) throw new Error("BAIJIAHAO_LOGIN_REQUIRED");
  const platformImageUrl = normalizeBaijiahaoImageUrl(upload.payload?.ret?.https_url || upload.payload?.data?.https_url || "");
  if (!upload.ok || !baijiahaoPublishPayloadAccepted(upload.payload) || !platformImageUrl) {
    throw new Error("BAIJIAHAO_API_IMAGE_UPLOAD_NOT_ACCEPTED");
  }
  return { platformImageUrl, evidence: upload.evidence };
}

async function publishBaijiahaoViaApi(page, input = {}, publishInput = {}) {
  const config = baijiahaoApiConfig(input);
  await page.goto(BAIJIAHAO_EDITOR_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
  let requestToken = await readBaijiahaoRequestToken(page);
  let apiInput = { ...input, requestToken };
  let coverImageEvidence = null;
  const providedCoverImageUrl = normalizeBaijiahaoImageUrl(publishInput.coverImageUrl);
  // 封面上传不再依赖 verifyPublication/disposableTest：正式发布同样要带平台封面，
  // 否则请求里一个封面字段都没有。本地文件缺失时给出和浏览器流程一致的错误码。
  if (!providedCoverImageUrl && publishInput.coverImageProvided) {
    if (!(await fileExists(publishInput.coverImagePath))) throw new Error("BAIJIAHAO_COVER_REQUIRED");
    const uploadedCover = await uploadBaijiahaoImage(page, { ...apiInput, imagePath: publishInput.coverImagePath });
    publishInput = { ...publishInput, coverImageUrl: uploadedCover.platformImageUrl };
    coverImageEvidence = {
      status: "verified",
      platformImageUrl: uploadedCover.platformImageUrl,
      upload: uploadedCover.evidence,
    };
    requestToken = await readBaijiahaoRequestToken(page);
    apiInput = { ...apiInput, requestToken };
  } else if (providedCoverImageUrl) {
    publishInput = { ...publishInput, coverImageUrl: providedCoverImageUrl };
  }
  // 正文内联图此前只有浏览器流程的 ueditor 上传路径，API 流程会整批丢掉，发出
  // 一篇没有插图的文章。这里走同一个 materialui 上传接口补回来。上传失败直接抛出，
  // 和浏览器流程的 PLATFORM_IMAGE_UPLOAD_TIMEOUT 一样终止发布，不静默缺图。
  const uploadedInlineImages = [];
  for (const task of publishInput.platformImageTasks) {
    if (!task?.path) continue;
    const uploaded = await uploadBaijiahaoImage(page, { ...apiInput, imagePath: task.path });
    uploadedInlineImages.push({ ...task, platformImageUrl: uploaded.platformImageUrl, evidence: uploaded.evidence });
  }
  if (uploadedInlineImages.length) {
    requestToken = await readBaijiahaoRequestToken(page).catch(() => requestToken);
    apiInput = { ...apiInput, requestToken };
    publishInput = { ...publishInput, uploadedImages: uploadedInlineImages };
  }
  const draftCreateInput = publishInput;
  const firstSave = await callBaijiahaoApi(page, config.draftSaveApiUrl, baijiahaoArticleForm(draftCreateInput, config), "draft_create", requestToken);
  const articleId = findBaijiahaoDraftArticleId(firstSave.payload) || findArticleId(firstSave.payload);
  if (!articleId) throw new Error("BAIJIAHAO_API_DRAFT_ID_REQUIRED");
  // Hand the article id over before preview/publish verification can fail on a
  // submission that the platform already holds.
  input.evidenceSink?.({ externalIds: { articleId }, platformStatus: "draft_saved" });
  const draftReload = await reloadBaijiahaoArticle(page, config, articleId, requestToken);
  const secondSave = await callBaijiahaoApi(page, config.previewSaveApiUrl, baijiahaoArticleForm(publishInput, config, articleId), "draft_update", requestToken);
  const reviewUrl = baijiahaoDraftUrlFromArticleId(articleId);
  const imagePublicationEvidence = uploadedInlineImages.length
    ? buildImagePublicationEvidence(publishInput.platformImageTasks, uploadedInlineImages, [], [], PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED)
    : undefined;
  // 只存草稿时预览保存就是终点：不需要读运行时的 nonce/bjhmt，也不该发起发布。
  // 上传阶段的内联图只证明"传上去了"，草稿回读没做过，所以 draft 阶段留空。
  if (!publishInput.confirmPublish) {
    return {
      draftUrl: reviewUrl,
      publishedUrl: "",
      reviewUrl,
      platformStatus: "draft_saved",
      title: publishInput.title,
      externalIds: { articleId },
      publicationEvidence: {
        source: "api",
        accepted: true,
        stages: [
          { stage: "draft_create", httpStatus: firstSave.status },
          { stage: "draft_reload", httpStatus: draftReload.status },
          { stage: "draft_update", httpStatus: secondSave.status },
        ],
        cover: coverImageEvidence,
      },
      ...(coverImageEvidence ? { coverImageEvidence } : {}),
      ...(imagePublicationEvidence ? { imagePublicationEvidence } : {}),
    };
  }
  let runtime = await readBaijiahaoRuntimePublishFields(page);
  let publish = null;
  let securityVerificationRequired = false;
  let publishRetried = false;
  for (let publishAttempt = 1; publishAttempt <= 2 && !publish; publishAttempt += 1) {
    try {
      publish = await callBaijiahaoApi(page, config.publishApiUrl, {
        ...baijiahaoArticleForm(publishInput, config, articleId),
        // 编辑器没给出的字段就不提交，不发空值也不编造值。真实抓不到时宁可缺字段，
        // 让平台给出可读的错误，而不是送一个与真实表单不符的随机字符串。
        ...(runtime.nonce ? { BJH_FE_NOUNCE: runtime.nonce } : {}),
        ...(runtime.bjhmt ? { bjhmt: runtime.bjhmt } : {}),
      }, "publish", requestToken);
      securityVerificationRequired = false;
    } catch (error) {
      if (!/BAIJIAHAO_SECURITY_VERIFICATION_REQUIRED/.test(String(error?.message || error))) throw error;
      securityVerificationRequired = true;
      if (publishRetried) break;
      publishRetried = true;
      const clearance = await waitForBaijiahaoSecurityClearance(page, publishInput.manualVerificationTimeoutMs, input, {
        stage: "publish",
        verificationUrl: reviewUrl,
      });
      if (clearance !== "cleared") break;
      requestToken = await readBaijiahaoRequestToken(page).catch(() => requestToken);
      apiInput = { ...apiInput, requestToken };
      runtime = await readBaijiahaoRuntimePublishFields(page).catch(() => runtime);
    }
  }

  if (securityVerificationRequired) {
    let listEvidence = null;
    let cleanup = null;
    const preserveDraft = publishInput.disposableTest && publishInput.preserveDraftOnManualVerification;
    if (publishInput.verifyPublication || publishInput.disposableTest) {
      listEvidence = await readBaijiahaoArticleList(page, { ...apiInput, articleId });
    }
    if (publishInput.disposableTest && !preserveDraft) {
      try {
        cleanup = await cleanupBaijiahaoArticle(page, { ...apiInput, articleId });
      } catch (cleanupError) {
        if (!/BAIJIAHAO_SECURITY_VERIFICATION_REQUIRED/.test(String(cleanupError?.message || cleanupError))) throw cleanupError;
        cleanup = {
          articleId,
          withdrawn: false,
          removed: false,
          evidence: { source: "api", securityVerificationRequired: true },
        };
      }
    }
    if (preserveDraft) {
      await page.goto(reviewUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
      await bringToFrontIfAllowed(page, input);
    }
    const manualVerification = {
      type: "manual_verification_required",
      platform: "baijiahao",
      message: preserveDraft
        ? "Complete Baijiahao security verification in the foreground browser, then retry publication from the retained draft."
        : "Complete Baijiahao security verification in the foreground browser, then retry publication.",
      currentUrl: preserveDraft ? reviewUrl : BAIJIAHAO_EDITOR_URL,
    };
    notifyPublishProgress(input, manualVerification);
    return {
      draftUrl: reviewUrl,
      publishedUrl: "",
      reviewUrl,
      platformStatus: "manual_verification_required",
      publiclyVisible: false,
      reviewStatus: "security_verification_required",
      title: publishInput.title,
      externalIds: { articleId },
      publicationEvidence: {
        source: "api",
        accepted: false,
        manualVerificationRequired: true,
        stages: [
          { stage: "draft_create", httpStatus: firstSave.status },
          { stage: "draft_reload", httpStatus: draftReload.status },
          { stage: "draft_update", httpStatus: secondSave.status },
          { stage: "publish", securityVerificationRequired: true },
        ],
        draft: listEvidence,
        cleanup,
        cover: coverImageEvidence,
      },
      ...(listEvidence ? { draftEvidence: listEvidence } : {}),
      ...(cleanup ? { testCleanup: cleanup } : {}),
      ...(coverImageEvidence ? { coverImageEvidence } : {}),
      ...(imagePublicationEvidence ? { imagePublicationEvidence } : {}),
      ...manualVerification,
    };
  }
  const accepted = true;
  let listEvidence = null;
  let publicEvidence = null;
  let cleanup = null;
  let cleanupSecurityVerificationRequired = false;
  let platformStatus = "submitted_for_review";
  let reviewStatus = "pending_public_visibility";
  let publishedUrl = "";
  if (publishInput.verifyPublication || publishInput.disposableTest) {
    listEvidence = await readBaijiahaoArticleList(page, { ...apiInput, articleId });
    // Only the platform's own published verdict releases a backlink here. A
    // draft also carries a URL, and reading it as public claimed an article the
    // platform had not published yet.
    if (listEvidence.found && listEvidence.publiclyVisible?.visible) {
      publishedUrl = listEvidence.publiclyVisible.publicUrl;
      publicEvidence = await inspectBaijiahaoPublicArticle(page, {
        ...publishInput,
        publicUrl: publishedUrl,
        articleTitle: publishInput.title,
        contentMarkdown: publishInput.content,
      });
      if (publicEvidence.found) {
        platformStatus = "published";
        reviewStatus = "public";
      }
    }
    if (publishInput.disposableTest) {
      let cleanupRetried = false;
      for (let cleanupAttempt = 1; cleanupAttempt <= 2 && !cleanup; cleanupAttempt += 1) {
        try {
          await page.goto(reviewUrl, { waitUntil: "domcontentloaded" });
          cleanup = await cleanupBaijiahaoArticle(page, { ...apiInput, articleId });
          cleanupSecurityVerificationRequired = false;
        } catch (error) {
          if (!/BAIJIAHAO_SECURITY_VERIFICATION_REQUIRED/.test(String(error?.message || error))) throw error;
          cleanupSecurityVerificationRequired = true;
          if (cleanupRetried) break;
          cleanupRetried = true;
          const clearance = await waitForBaijiahaoSecurityClearance(page, publishInput.manualVerificationTimeoutMs, input, {
            stage: "cleanup",
            verificationUrl: reviewUrl,
            message: "Complete Baijiahao security verification in the foreground browser; the disposable test article is removed automatically once verification clears.",
          });
          if (clearance !== "cleared") break;
          requestToken = await readBaijiahaoRequestToken(page).catch(() => requestToken);
          apiInput = { ...apiInput, requestToken };
        }
      }
    }
  }
  if (cleanupSecurityVerificationRequired) {
    await page.goto(reviewUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    await bringToFrontIfAllowed(page, input);
    const manualVerification = {
      type: "manual_verification_required",
      platform: "baijiahao",
      message: "Complete Baijiahao security verification in the foreground browser, then remove the disposable test article.",
      currentUrl: reviewUrl,
    };
    notifyPublishProgress(input, manualVerification);
    return {
      draftUrl: reviewUrl,
      publishedUrl,
      reviewUrl,
      platformStatus: "manual_verification_required",
      publiclyVisible: Boolean(publicEvidence?.found),
      reviewStatus: "cleanup_security_verification_required",
      title: publishInput.title,
      externalIds: { articleId },
      manualVerificationStage: "cleanup",
      publicationEvidence: {
        source: "api",
        accepted,
        httpStatus: publish.status,
        endpoint: publish.evidence.request.url,
        response: publish.evidence.response.payload,
        stages: [
          { stage: "draft_create", httpStatus: firstSave.status },
          { stage: "draft_reload", httpStatus: draftReload.status },
          { stage: "draft_update", httpStatus: secondSave.status },
          { stage: "publish", httpStatus: publish.status },
        ],
        draft: listEvidence,
        public: publicEvidence,
        cleanupSecurityVerificationRequired: true,
        cover: coverImageEvidence,
      },
      ...(listEvidence ? { draftEvidence: listEvidence } : {}),
      ...(publicEvidence ? { publicEvidence } : {}),
      ...(coverImageEvidence ? { coverImageEvidence } : {}),
      ...(imagePublicationEvidence ? { imagePublicationEvidence } : {}),
      ...manualVerification,
    };
  }
  return {
    draftUrl: reviewUrl,
    publishedUrl,
    reviewUrl,
    platformStatus,
    publiclyVisible: Boolean(publicEvidence?.found),
    reviewStatus,
    title: publishInput.title,
    externalIds: { articleId },
    publicationEvidence: {
      source: "api",
      accepted,
      httpStatus: publish.status,
      endpoint: publish.evidence.request.url,
      response: publish.evidence.response.payload,
      stages: [
        { stage: "draft_create", httpStatus: firstSave.status },
        { stage: "draft_reload", httpStatus: draftReload.status },
        { stage: "draft_update", httpStatus: secondSave.status },
        { stage: "publish", httpStatus: publish.status },
      ],
      draft: listEvidence,
      public: publicEvidence,
      cleanup,
      cover: coverImageEvidence,
    },
    ...(listEvidence ? { draftEvidence: listEvidence } : {}),
    ...(publicEvidence ? { publicEvidence } : {}),
    ...(cleanup ? { testCleanup: cleanup } : {}),
    ...(coverImageEvidence ? { coverImageEvidence } : {}),
    ...(imagePublicationEvidence ? { imagePublicationEvidence } : {}),
    message: "Baijiahao accepted the API publish request; public URL still requires review/public-page verification.",
  };
}

// 只有当百家号返回**显式错误**（errno/code 非 0）且是已知风控码、或 errmsg
// 明确要求人工验证时，才算触发安全验证。
// 历史问题：旧实现把整个 payload JSON 字符串化后用
// /bjh_risk|risk_|安全验证|.../ 匹配，而百家号任何成功响应（withdraw / remove /
// publish / 列表回读）都内嵌完整文章元数据，其中必然含 bjh_risk_profile、
// risk_group、leader_content_model_v2.norisk 等模型字段名，于是"撤回成功"
// 也被判成需要安全验证，进而进入 5 分钟人工等待并把命令永久卡在 manual 态。
function publishApiHasSecurityVerification(payload) {
  if (!payload || typeof payload !== "object") return false;
  const code = baijiahaoApiErrorCode(payload);
  if (!code || code === "0" || code === "200") return false;
  return BAIJIAHAO_SECURITY_VERIFICATION_CODES.has(code)
    || BAIJIAHAO_SECURITY_VERIFICATION_MESSAGE.test(baijiahaoApiErrorMessage(payload));
}

function watchPublishApiResponses(page) {
  const state = { draftUrl: "", publishedUrl: "", blocker: "" };
  const handler = async (response) => {
    const url = typeof response.url === "function" ? response.url() : "";
    if (/\/pcui\/article\/(save|draft)/i.test(url)) {
      const draftPayload = parseJsonLikePayload(await response.text().catch(() => ""));
      const draftId = findBaijiahaoDraftArticleId(draftPayload);
      if (draftId) state.draftUrl = baijiahaoDraftUrlFromArticleId(draftId);
      return;
    }
    if (!/\/pcui\/article\/publish/i.test(url)) return;
    const text = await response.text().catch(() => "");
    const payload = parseJsonLikePayload(text);
    const publishedUrl = publishedUrlFromApiPayload(payload);
    if (publishedUrl) state.publishedUrl = publishedUrl;
    if (publishApiHasSecurityVerification(payload)) {
      writeBaijiahaoBlockerDiagnostic("publish_response_watch", url, {
        status: typeof response.status === "function" ? response.status() : 0,
        payload,
      });
      state.blocker = "BAIJIAHAO_SECURITY_VERIFICATION_REQUIRED";
    }
  };
  if (typeof page.on === "function") page.on("response", handler);
  return {
    state,
    dispose() {
      if (typeof page.off === "function") page.off("response", handler);
    }
  };
}

async function readBaijiahaoEditorImages(page) {
  const images = await readLocatorImages(page.frameLocator("iframe#ueditor_0"), "body img");
  return images.map((image) => ({
    ...image,
    platformImageUrl: normalizeBaijiahaoImageUrl(image.platformImageUrl),
  })).filter((image) => image.platformImageUrl);
}

export async function waitForBaijiahaoDraftUrl(state, page, timeoutMs = 30000, pollMs = 250) {
  const deadline = Date.now() + Math.max(1, Number(timeoutMs || 30000));
  do {
    if (state?.draftUrl) return state.draftUrl;
    const currentUrl = typeof page?.url === "function" ? String(page.url() || "") : "";
    if (/[?&]article_id=\d+/i.test(currentUrl)) return currentUrl;
    if (typeof page?.waitForTimeout === "function") await page.waitForTimeout(pollMs);
    else await new Promise((resolve) => setTimeout(resolve, pollMs));
  } while (Date.now() < deadline);
  throw new Error("BAIJIAHAO_DRAFT_URL_NOT_FOUND");
}

export async function waitForBaijiahaoEditorImages(page, expectedCount, timeoutMs = 30000, pollMs = 250) {
  const expected = Math.max(0, Number(expectedCount || 0));
  const deadline = Date.now() + Math.max(1, Number(timeoutMs || 30000));
  let images = [];
  do {
    images = await readBaijiahaoEditorImages(page);
    const persistent = images.filter((image) => (
      isPersistentPlatformImageUrl(image.platformImageUrl) && image.loaded !== false
    ));
    if (persistent.length >= expected) return persistent;
    if (typeof page?.waitForTimeout === "function") await page.waitForTimeout(pollMs);
    else await new Promise((resolve) => setTimeout(resolve, pollMs));
  } while (Date.now() < deadline);
  throw new Error("DRAFT_IMAGE_MISSING");
}

async function focusBaijiahaoImageToolbar(page, task = {}) {
  await page.evaluate((payload) => {
    const editor = window.UE_V2?.instants?.ueditorInstant0
      || (window.UE_V2?.instants ? Object.values(window.UE_V2.instants)[0] : null);
    editor?.focus?.();
    if (editor?.body && editor?.selection?.getRange) {
      const sectionId = String(payload.sectionId || "");
      const section = sectionId
        ? editor.body.querySelector(`[data-zhixin-section="${CSS.escape(sectionId)}"]`)
        : null;
      const target = section?.querySelector("p:last-of-type")
        || section
        || editor.body.querySelector("p:last-of-type")
        || editor.body;
      editor.selection.getRange().selectNodeContents(target).collapse(false).select();
    }
    editor?.fireEvent?.("selectionchange");
    return Boolean(editor);
  }, { sectionId: String(task.sectionId || "") }).catch(() => false);
  await page.waitForFunction?.(() => {
    const state = document.querySelector(".edui-for-insertimage [id$='_state']");
    return state && !state.classList.contains("edui-state-disabled");
  }, null, { timeout: 5000 }).catch(() => undefined);
}

export async function uploadBaijiahaoInlineImages(page, tasks = [], options = {}) {
  if (!tasks.length) return [];
  const frame = page.frameLocator("iframe#ueditor_0");
  const editorBody = frame.locator("body").first();
  return uploadPlatformImages({
    tasks,
    readImages: () => readBaijiahaoEditorImages(page),
    positionForTask: async (task) => {
      await editorBody.click?.();
      await positionCursorAfterSection(editorBody, task);
      await focusBaijiahaoImageToolbar(page, task);
    },
    selectFile: async (task) => {
      const upload = page.locator("input[type='file'][name='media'][accept*='image']").first();
      let opened = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await editorBody.click?.();
        await focusBaijiahaoImageToolbar(page, task);
        await page.locator(".edui-for-insertimage > [id$='_state']").first().click();
        try {
          await upload.waitFor?.({ state: "attached", timeout: 3000 });
          opened = true;
          break;
        } catch {
          await page.waitForTimeout?.(300).catch(() => undefined);
        }
      }
      if (!opened && typeof upload.waitFor === "function") throw new Error("BAIJIAHAO_IMAGE_DIALOG_NOT_OPEN");
      await upload.setInputFiles(task.path);
      const confirm = page.locator(".cheetah-modal button:has-text('确认'), .cheetah-modal button:has-text('确定')").first();
      if (await confirm.isVisible?.().catch(() => false)) await confirm.click();
    },
    onProgress: options.onProgress,
    timeoutMs: options.timeoutMs || 60000,
  });
}

async function verifyBaijiahaoPublicImages(context, publishedUrl, tasks) {
  const publicPage = await context.newPage();
  try {
    await publicPage.goto(publishedUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await publicPage.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
    return verifyPlatformImages({
      tasks,
      readImages: () => readLocatorImages(publicPage, BAIJIAHAO_PUBLIC_IMAGE_SELECTOR),
      stage: "public",
    });
  } finally {
    await publicPage.close?.().catch(() => undefined);
  }
}

async function fileExists(filePath) {
  if (!filePath) return false;
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function fillFirstLocator(page, selector, value, errorCode) {
  const locator = page.locator(selector).first();
  const fillOnce = async () => {
    // 百家号编辑器页加载后会持续重导航主框架，聚焦点击经常在导航发生的瞬间打空。
    // 这一击只为聚焦，失败不致命；元素真被 detachment 时下面的 fill 会抛出带错误码的异常。
    await locator.click?.().catch(() => undefined);
    await locator.fill(value);
    await locator.dispatchEvent?.("input").catch(() => undefined);
    await locator.dispatchEvent?.("change").catch(() => undefined);
    return locator;
  };
  try {
    return await fillOnce();
  } catch (error) {
    // 主框架重导航可能在 fill 的瞬间把字段 detachment；等一次导航落地后按同一选择器重取再试一次。
    // 只重试一次，避免在持续导航风暴里空转；再次失败仍按原错误码抛出，行为与改前一致。
    try {
      await page.waitForLoadState?.("domcontentloaded", { timeout: 5000 }).catch(() => undefined);
    } catch {
      // 等待本身失败不阻断重试
    }
    try {
      return await fillOnce();
    } catch {
      throw new Error(`${errorCode}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function dismissKnownPopups(page) {
  if (typeof page.getByRole !== "function") return;
  const buttons = [
    page.getByRole("button", { name: /^(\u6211\u77e5\u9053\u4e86|got it|ok)$/i }).first(),
    page.getByRole("button", { name: /^(\u786e\u8ba4|confirm)$/i }).first()
  ];
  for (const button of buttons) {
    const visible = await button.isVisible?.().catch(() => false);
    if (visible) await button.click?.().catch(() => undefined);
  }
}

async function fillTitle(page, title) {
  return fillFirstLocator(
    page,
    "#newsTextArea [contenteditable='true'][data-lexical-editor='true'], #newsTextArea [contenteditable='true']",
    title,
    "BAIJIAHAO_TITLE_FIELD_NOT_FOUND"
  );
}

async function syncUeditorContent(page, content, richHtml = "") {
  if (typeof page.evaluate !== "function") return false;
  return page.evaluate((payload) => {
    const text = typeof payload === "string" ? payload : payload.text;
    const suppliedHtml = typeof payload === "string" ? "" : payload.richHtml;
    const escapeHtml = (value) => String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const html = suppliedHtml || String(text || "")
      .split(/\n{2,}/)
      .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
      .join("");
    const editor = window.UE_V2?.instants?.ueditorInstant0 || window.UE?.getEditor?.("ueditor_0");
    if (editor?.setContent) {
      editor.setContent(html || "<p><br></p>");
      editor.fireEvent?.("contentchange");
      return true;
    }
    const frame = document.querySelector("iframe#ueditor_0");
    const body = frame?.contentDocument?.body;
    if (body) {
      body.innerHTML = html || "<p><br></p>";
      body.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      body.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    return false;
  }, richHtml ? { text: content, richHtml } : content).catch(() => false);
}

async function fillBody(page, content, richHtml = "") {
  if (typeof page.frameLocator === "function") {
    const body = page.frameLocator("iframe#ueditor_0").locator("body[contenteditable='true'], body.view").first();
    await body.click?.().catch(() => undefined);
    await body.press?.("Control+A").catch(() => undefined);
    await body.fill(content);
    await syncUeditorContent(page, content, richHtml);
    return body;
  }
  await syncUeditorContent(page, content, richHtml);
  return fillFirstLocator(
    page,
    "[contenteditable='true']:not(#newsTextArea [contenteditable='true'])",
    content,
    "BAIJIAHAO_BODY_FIELD_NOT_FOUND"
  );
}

async function waitForDraftSaved(page, timeoutMs) {
  if (typeof page.waitForFunction !== "function") return;
  await page.waitForFunction(() => {
    const text = document.body?.innerText || "";
    return /\u5df2\u4fdd\u5b58|\u5b58\u8349\u7a3f|\u8349\u7a3f|saved|draft/i.test(text);
  }, null, { timeout: timeoutMs }).catch(() => undefined);
}

async function clickDraftSave(page, timeoutMs) {
  if (typeof page.getByRole === "function") {
    const saveButton = page.getByRole("button", { name: /^(\u5b58\u8349\u7a3f|save draft)$/i }).first();
    const visible = await saveButton.isVisible?.().catch(() => true);
    const disabled = await saveButton.isDisabled?.().catch(() => false);
    if (visible && !disabled) await saveButton.click?.().catch(() => undefined);
  }
  await waitForDraftSaved(page, timeoutMs);
}

async function coverLooksSelected(page) {
  if (typeof page.evaluate !== "function") return false;
  return page.evaluate(() => {
    const text = document.querySelector("#bjhNewsCover")?.innerText || "";
    return /\u7f16\u8f91|\u66f4\u6362/.test(text) && !/\u9009\u62e9\u5c01\u9762/.test(text);
  }).catch(() => false);
}

async function ensureCoverSelected(page, coverImagePath) {
  if (await coverLooksSelected(page)) return;
  if (!(await fileExists(coverImagePath))) throw new Error("BAIJIAHAO_COVER_REQUIRED");
  const coverPanel = page.locator("#bjhNewsCover").first();
  await coverPanel.scrollIntoViewIfNeeded?.().catch(() => undefined);
  await page.locator("#bjhNewsCover").getByText?.("\u9009\u62e9\u5c01\u9762").first().click().catch(async () => {
    await page.locator("#bjhNewsCover .FeEditorApp-_73a3a52aab7e3a36-default, #bjhNewsCover").first().click();
  });
  await page.waitForTimeout?.(1000).catch(() => undefined);
  const upload = page.locator("input[type='file'][name='media'][accept*='image'], .cheetah-modal input[type='file'][accept*='image']").last();
  await upload.setInputFiles(coverImagePath);
  await page.waitForLoadState?.("networkidle", { timeout: 30000 }).catch(() => undefined);
  await page.waitForTimeout?.(3000).catch(() => undefined);
  const confirmButton = page.locator(".cheetah-modal button:has-text('\u786e\u5b9a'), button:has-text('\u786e\u5b9a')").last();
  await confirmButton.click();
  await page.waitForTimeout?.(3000).catch(() => undefined);
  if (!(await coverLooksSelected(page))) throw new Error("BAIJIAHAO_COVER_UPLOAD_FAILED");
}

async function waitForLocatorEnabled(locator, page, timeoutMs = 30000) {
  const budget = Number.isFinite(Number(timeoutMs)) ? Math.min(60000, Math.max(1, Number(timeoutMs))) : 30000;
  const deadline = Date.now() + budget;
  do {
    const visible = await locator.isVisible?.().catch(() => false);
    const disabled = await locator.isDisabled?.().catch(() => true);
    if (visible === true && disabled === false) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, remaining)));
  } while (Date.now() < deadline);
  return false;
}

async function confirmPostPublishDialogs(page) {
  if (typeof page.locator !== "function") return;
  const selectors = [
    ".cheetah-modal button.cheetah-btn-primary:has-text('\u786e\u5b9a')",
    ".cheetah-modal button:has-text('\u786e\u5b9a')",
    ".ueditor-responese-modal:visible button.bjh-btn-primary",
    ".modal.show button.bjh-btn-primary",
    ".ueditor-responese-modal button.bjh-btn-primary",
    "button.bjh-btn-primary:has-text('\u786e\u8ba4')"
  ];
  for (let round = 0; round < 3; round += 1) {
    let clicked = false;
    for (const selector of selectors) {
      const button = page.locator(selector).first();
      const visible = await button.isVisible?.().catch(() => false);
      const disabled = await button.isDisabled?.().catch(() => false);
      if (visible && !disabled) {
        await button.click?.().catch(() => undefined);
        clicked = true;
        if (typeof page.waitForTimeout === "function") await page.waitForTimeout(1000).catch(() => undefined);
        break;
      }
    }
    if (!clicked) break;
  }
}

function normalizeBaijiahaoPublishedUrl(url = "") {
  try {
    const parsed = new URL(String(url || ""), BAIJIAHAO_ORIGIN);
    if (!/(^|\.)baijiahao\.baidu\.com$/i.test(parsed.hostname)) return "";
    if (parsed.pathname === "/builder/preview/s" && parsed.searchParams.has("id")) {
      return `${BAIJIAHAO_ORIGIN}/s?id=${encodeURIComponent(parsed.searchParams.get("id") || "")}`;
    }
    if (parsed.pathname === "/s" && parsed.searchParams.has("id")) return parsed.toString().replace(/^http:/, "https:");
    if (/\/(article|item|content)\//i.test(parsed.pathname)) return parsed.toString().replace(/^http:/, "https:");
  } catch {
    return "";
  }
  return "";
}

function isBaijiahaoPublishedUrl(url = "") {
  return Boolean(normalizeBaijiahaoPublishedUrl(url));
}

// The content-management list API is where the platform states its own publish
// status, and it is what turns "the publish call returned 200" into "this
// article is published". Reading it has to stay fail-closed on the two things
// the platform actually states there: the status word, and whether the URL it
// served for the article is the public /s?id= address or an editor address.
//
// Measured against the live list API 2026-10-18, corrected 2026-10-23. A
// genuinely public article reports status "publish" and its own /s?id= URL. A
// draft, an analyse job and a withdrawn article all report a
// /builder/preview/s?id= URL, which is an editor address and not a public one.
//
// The 2026-10-18 reading went on to claim that a quality refusal still reports
// status "publish" and a /s?id= URL, and that the refusal therefore had to be
// read from quality_status / secure_status / audit_status_info. That inference
// was wrong. Article 1879623218377447665 was refused on exactly those fields
// (BAIJIAHAO_LIST_QUALITY_STATUS_REJECTED, three orders stranded on
// 2026-10-23) while an anonymous visitor holding no cookies could still read
// its title, its whole body and its images at the /s?id= address. That field
// family reports the platform's content-quality verdict, not its publication
// verdict, so it is now reported as a diagnostic and never decides visibility.
// What decides visibility is the status word plus the address the platform
// served, and then whether an anonymous visitor can actually read the article
// at that address.
//
// The URL is read exactly as the platform returned it. normalizeBaijiahaoPublishedUrl
// rewrites /builder/preview/s?id= into /s?id=, which is the right thing to do
// when the publish flow just handed us a preview link, but as a gate it would
// mint a public address for an article the platform never published.
const BAIJIAHAO_REJECTED_VERDICT_VALUES = new Set([
  "rejected",
  "reject",
  "not_pass",
  "notpass",
  "fail",
  "failed",
  "ban",
  "banned",
]);

function baijiahaoNativePublicUrl(url = "") {
  try {
    const parsed = new URL(String(url || ""), BAIJIAHAO_ORIGIN);
    if (!/(^|\.)baijiahao\.baidu\.com$/i.test(parsed.hostname)) return "";
    if (parsed.pathname !== "/s") return "";
    const articleId = String(parsed.searchParams.get("id") || "").trim();
    if (!articleId) return "";
    return `${BAIJIAHAO_ORIGIN}/s?id=${encodeURIComponent(articleId)}`;
  } catch {
    return "";
  }
}

// "0" is the platform's refusal for a review stage and a handful of words say
// the same thing. An absent stage carries no verdict at all, and a value this
// build has never seen is not guessed at: the status word and the native public
// URL already gate the item, and inventing verdict vocabulary would strand a
// published article instead of publishing it.
function baijiahaoVerdictIsRefusal(value) {
  const verdict = String(value ?? "").trim().toLowerCase();
  if (!verdict) return false;
  return verdict === "0" || verdict === "false" || BAIJIAHAO_REJECTED_VERDICT_VALUES.has(verdict);
}

export function baijiahaoListItemPubliclyVisible(item = {}) {
  const publicUrl = baijiahaoNativePublicUrl(item?.url || item?.smp_url || item?.share_url || "");
  if (!publicUrl) {
    return { visible: false, reason: "BAIJIAHAO_LIST_URL_NOT_PUBLIC", publicUrl: "" };
  }
  const status = String(item?.status ?? "").trim().toLowerCase();
  if (status !== "publish") {
    return { visible: false, reason: `BAIJIAHAO_LIST_STATUS_${(status || "empty").toUpperCase()}`, publicUrl: "" };
  }
  // The status word and the address are the platform's publication statement.
  // The content-quality fields are not, and vetoing on them stranded real
  // published articles on BAIJIAHAO_LIST_QUALITY_STATUS_REJECTED. They are
  // still read and returned so an operator can see what the platform said.
  const reviewRefusals = baijiahaoListItemReviewRefusals(item);
  return { visible: true, reason: "", publicUrl, ...(reviewRefusals.length ? { reviewRefusals } : {}) };
}

function baijiahaoListItemReviewRefusals(item = {}) {
  const audit = item?.audit_status_info && typeof item.audit_status_info === "object" ? item.audit_status_info : {};
  const refusals = [];
  for (const field of ["quality_status", "secure_status"]) {
    if (baijiahaoVerdictIsRefusal(item?.[field])) refusals.push(field);
  }
  if (baijiahaoVerdictIsRefusal(audit?.quality_status)) refusals.push("audit_status_info.quality_status");
  for (const stage of ["qm_info", "qf_info", "qr_info"]) {
    if (baijiahaoVerdictIsRefusal(audit?.[stage]?.status)) refusals.push(`audit_status_info.${stage}.status`);
  }
  if (String(item?.quality_not_pass_reason ?? "").trim()) refusals.push("quality_not_pass_reason");
  return refusals;
}


async function readPublishedUrl(page) {
  const current = typeof page.url === "function" ? page.url() : "";
  const normalizedCurrent = normalizeBaijiahaoPublishedUrl(current);
  if (normalizedCurrent) return normalizedCurrent;
  if (typeof page.locator === "function") {
    const href = await withBaijiahaoPageTimeout(
      () => page.locator("a[href*='baijiahao.baidu.com/s?id='], a[href^='/s?id='], a[href*='builder/preview/s?id='], a[href*='/article/'], a[href*='/item/']").first().getAttribute("href")
    ).catch(() => "");
    if (href) {
      return normalizeBaijiahaoPublishedUrl(href) || href;
    }
  }
  return "";
}

function normalizedMatchText(value = "") {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

// The public page renders every markdown block as its own element inside the
// article container and wraps inline images in extra container paragraphs, so
// a markdown fragment that merges a heading with its paragraph never appears
// verbatim in the rendered text, and markdown syntax itself ("###", blank
// lines, image syntax) has no counterpart on the page at all. Requiring the
// whole normalized markdown to appear verbatim therefore failed bodyMatched
// for every article, published or not. Match each fragment as ordered pieces
// instead: platform text sitting between two pieces of our own article is
// allowed, while a page that is missing a piece still fails.
//
// Blocks split on a single newline, not a blank line, and a pure heading block
// is dropped. Measured on the live platform 2026-10-22, an article published
// through the API renders its section heading and the paragraph below it as
// adjacent blocks and leaves the heading line out of the article body entirely,
// while the browser editor flow keeps it. Splitting on blank lines fused the two
// into one fragment whose first piece was that heading, a piece that is on no
// published page, so a fully public article was reported as "body not found".
// The paragraph under the heading is the article's own text and is what proves
// the page is ours; the heading itself proves nothing the paragraph does not.
function baijiahaoMarkdownEvidenceFragments(value = "", articleTitle = "") {
  const normalizedTitle = normalizedMatchText(articleTitle);
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\n+/)
    .filter((block) => !/^\s{0,3}#{1,6}\s+\S/.test(block))
    .map((fragment) => fragment
      .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/<[^>]+>/g, " ")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s*(?:[-*+]|\d+[.)]|>)\s+/gm, "")
      .replace(/[*_~`]/g, " ")
      .replace(/\s+/g, " ")
      .trim())
    .filter(Boolean)
    .filter((fragment) => normalizedMatchText(fragment) !== normalizedTitle);
}

function baijiahaoEvidencePieces(fragment) {
  const normalized = normalizedMatchText(fragment);
  if (!normalized) return [];
  const pieces = String(fragment || "")
    .split(/\s+/)
    .map((piece) => normalizedMatchText(piece))
    .filter((piece) => piece.length >= 4);
  // Content too short to split (a caption, a two-character line) keeps the
  // whole fragment as its single probe instead of dropping the article's only
  // evidence on the floor.
  return pieces.length ? pieces : [normalized];
}

function baijiahaoEvidencePiecesAppear(pieces, normalizedPageBody) {
  let from = 0;
  for (const piece of pieces) {
    const index = normalizedPageBody.indexOf(piece, from);
    if (index < 0) return false;
    from = index + piece.length;
  }
  return true;
}

function baijiahaoRenderedBodyMatches(contentMarkdown = "", bodyText = "", articleTitle = "") {
  if (!String(contentMarkdown || "").trim()) return true;
  const normalizedPageBody = normalizedMatchText(bodyText);
  if (!normalizedPageBody) return false;

  const fragments = baijiahaoMarkdownEvidenceFragments(contentMarkdown, articleTitle)
    .map((fragment) => baijiahaoEvidencePieces(fragment))
    .filter((pieces) => pieces.length > 0);
  if (!fragments.length) return false;

  const substantial = fragments.filter((pieces) => pieces.join("").length >= 24);
  const probes = (substantial.length ? substantial : fragments).slice(0, 3);
  const matched = probes.filter((pieces) => baijiahaoEvidencePiecesAppear(pieces, normalizedPageBody)).length;
  return matched >= (probes.length >= 2 ? 2 : 1);
}

export async function inspectBaijiahaoPublicArticle(page, input = {}) {
  const publicUrl = normalizeBaijiahaoPublishedUrl(
    input.publicUrl || input.publishedUrl || input.reviewUrl || ""
  );
  if (!publicUrl) throw new Error("BAIJIAHAO_PUBLIC_URL_INVALID");

  const existing = input.imagePublicationEvidence && typeof input.imagePublicationEvidence === "object"
    ? input.imagePublicationEvidence
    : {};
  const expected = Array.isArray(existing.expected) ? existing.expected : [];
  // Measured 2026-10-22: the platform serves an article's inline images from
  // pics0.baidu.com / pics5.baidu.com as often as from pic.rmb.bdstatic.com, so
  // the host-specific selector counted zero images on a healthy page and the
  // public stage reported a defect that was not there. The broad selector the
  // publish and og:image paths already use finds both hosts.
  const imageSelector = BAIJIAHAO_PUBLIC_IMAGE_SELECTOR;

  await page.goto(publicUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
  if (expected.length) {
    // The wait is an optimisation for lazy-loaded images, not a verdict: a page
    // that never reaches the expected count must still fall through to the
    // evidence read, which is what separates "missing" from "unverifiable".
    await page.waitForFunction?.((payload) => {
      const images = [...document.querySelectorAll(payload.selector)];
      return images.filter((image) => (
        /^https:\/\//i.test(image.getAttribute("src") || "")
        && image.complete
        && image.naturalWidth > 0
      )).length >= payload.expectedCount;
    }, { selector: imageSelector, expectedCount: expected.length }, { timeout: 30000 }).catch(() => undefined);
  }

  const publicImages = expected.length
    ? await verifyPublicImageEvidence({
        tasks: expected,
        readImages: () => readLocatorImages(page, imageSelector),
        // verifyPlatformImages throws PUBLIC_IMAGE_MISSING, which aborted the
        // whole discovery and left the order holding one adapter error code with
        // no retry path. A public page the platform did let us read has to keep
        // reporting a missing image as a defect, and only a page it walled off
        // may report "unverifiable".
        readBlocker: () => readPlatformBlocker(page),
      })
    : { images: [], blocker: "" };
  const imagePublicationEvidence = expected.length
    ? buildImagePublicationEvidence(
        expected,
        existing.upload?.images || [],
        existing.draft?.images || [],
        publicImages.images,
        publicImages.blocker,
      )
    : undefined;

  const pageTitle = await page.title().catch(() => "");
  const bodyText = await page.locator(BAIJIAHAO_PUBLIC_ARTICLE_SELECTOR).first().innerText().catch(() => "");
  // Baidu answers an anonymous read with its security verification page often
  // enough that "the body did not render" and "the platform walled the page
  // off" have to be told apart: the first is a statement about the article, the
  // second says nothing about it at all.
  const blocker = await readPlatformBlocker(page).catch(() => "");
  const imageLocator = page.locator(`meta[property='og:image'], meta[name='og:image'], ${BAIJIAHAO_PUBLIC_IMAGE_SELECTOR}`).first();
  let rawImageUrl = await imageLocator?.getAttribute?.("content").catch(() => "");
  if (!rawImageUrl) rawImageUrl = await imageLocator?.getAttribute?.("src").catch(() => "");
  const publicImageUrl = normalizeBaijiahaoImageUrl(rawImageUrl);
  const pageText = `${pageTitle}\n${bodyText}`.trim().slice(0, 12000);
  const expectedTitle = normalizedMatchText(input.articleTitle || input.title);
  const normalizedPageTitle = normalizedMatchText(`${pageTitle}\n${bodyText}`);
  const titleMatched = Boolean(expectedTitle && normalizedPageTitle.includes(expectedTitle));
  const bodyMatched = baijiahaoRenderedBodyMatches(
    input.contentMarkdown || input.content || input.richText,
    bodyText,
    input.articleTitle || input.title,
  );

  return {
    found: titleMatched && bodyMatched,
    publicUrl,
    publishedUrl: publicUrl,
    pageText,
    pageTitle,
    titleMatched,
    bodyMatched,
    ...(blocker ? { blocker } : {}),
    publicImageUrl,
    publicImageFound: Boolean(publicImageUrl),
    ...(imagePublicationEvidence ? { imagePublicationEvidence } : {}),
  };
}

async function readPlatformBlocker(page) {
  if (typeof page.evaluate !== "function") return "";
  let text = "";
  try {
    text = await withBaijiahaoPageTimeout(page.evaluate(() => document.body?.innerText || ""));
  } catch (error) {
    // A closed browser/page throws here; never treat that as "verification cleared".
    if (String(error?.message || "").includes("BAIJIAHAO_PAGE_UNRESPONSIVE")) {
      return "BAIJIAHAO_PAGE_UNRESPONSIVE";
    }
    return "BAIJIAHAO_BROWSER_CLOSED";
  }
  if (/\u767e\u5ea6\u5b89\u5168\u9a8c\u8bc1|\u8bf7\u5b8c\u6210\u4e0b\u65b9\u9a8c\u8bc1|\u62d6\u52a8\u5de6\u4fa7\u6ed1\u5757|\u626b\u7801\u9a8c\u8bc1/.test(text)) {
    return "BAIJIAHAO_SECURITY_VERIFICATION_REQUIRED";
  }
  if (/\u7f51\u7edc\u73af\u5883\u5f02\u5e38|\u8bf7\u5b8c\u6210\u9a8c\u8bc1/.test(text)) {
    return "BAIJIAHAO_SECURITY_VERIFICATION_REQUIRED";
  }
  return "";
}

async function withBaijiahaoPageTimeout(promiseOrFactory, timeoutMs = 10000) {
  const pending = typeof promiseOrFactory === "function" ? promiseOrFactory() : promiseOrFactory;
  let timer;
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("BAIJIAHAO_PAGE_UNRESPONSIVE")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForManualVerification(page, timeoutMs, input = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isBaijiahaoPageAlive(page)) throw new Error("BAIJIAHAO_BROWSER_CLOSED");
    const blocker = await readPlatformBlocker(page);
    if (blocker === "BAIJIAHAO_BROWSER_CLOSED") throw new Error("BAIJIAHAO_BROWSER_CLOSED");
    if (blocker === "BAIJIAHAO_PAGE_UNRESPONSIVE") throw new Error("BAIJIAHAO_PAGE_UNRESPONSIVE");
    const publishedUrl = await readPublishedUrl(page);
    if (publishedUrl) return publishedUrl;
    if (!blocker) return "";
    await bringToFrontIfAllowed(page, input);
    if (typeof page.waitForTimeout === "function") await page.waitForTimeout(3000).catch(() => undefined);
    else await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error("BAIJIAHAO_SECURITY_VERIFICATION_REQUIRED");
}

function isBaijiahaoPageAlive(page) {
  if (typeof page?.isClosed === "function") {
    try {
      if (page.isClosed()) return false;
    } catch {
      return false;
    }
  }
  const browser = typeof page?.context === "function" ? page.context()?.browser?.() : null;
  if (browser && typeof browser.isConnected === "function") {
    try {
      if (!browser.isConnected()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function waitForBaijiahaoSecurityClearance(page, timeoutMs, input = {}, options = {}) {
  const verificationUrl = String(options.verificationUrl || "");
  const stage = String(options.stage || "");
  const budgetMs = Math.max(1, Number(timeoutMs || 300000));
  if (verificationUrl) {
    await page.goto(verificationUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  if (!isBaijiahaoPageAlive(page)) return "browser_closed";
  await bringToFrontIfAllowed(page, input);
  notifyPublishProgress(input, {
    type: "manual_verification_required",
    platform: "baijiahao",
    ...(stage ? { stage } : {}),
    message: String(options.message || "Complete Baijiahao security verification in the foreground browser; the operation resumes automatically once verification clears."),
    currentUrl: typeof page.url === "function" ? page.url() : "",
  });
  const startedAt = Date.now();
  while (true) {
    if (!isBaijiahaoPageAlive(page)) return "browser_closed";
    const blocker = await readPlatformBlocker(page);
    if (blocker === "BAIJIAHAO_BROWSER_CLOSED") return "browser_closed";
    if (blocker === "BAIJIAHAO_PAGE_UNRESPONSIVE") return "browser_closed";
    if (!blocker) return "cleared";
    const currentUrl = typeof page.url === "function" ? page.url() : "";
    if (/bjh\/login|passport\.baidu\.com/i.test(currentUrl)) return "logged_out";
    if (Date.now() - startedAt >= budgetMs) return "timeout";
    await bringToFrontIfAllowed(page, input);
    if (typeof page.waitForTimeout === "function") await page.waitForTimeout(3000).catch(() => undefined);
    else await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

function notifyPublishProgress(input = {}, event = {}) {
  if (typeof input.onProgress !== "function") return;
  input.onProgress(event);
}

function baijiahaoDiscoveryErrorCode(error) {
  return String(error?.message || error || "").trim().split(":")[0].slice(0, 80) || "UNKNOWN";
}

// The order's candidate URL is whatever the publish step last handed back, and
// on the API publish path that is the editor's review URL
// (/builder/rc/edit?type=news&article_id=...), which is not a public address at
// all. Inspecting it threw BAIJIAHAO_PUBLIC_URL_INVALID, the whole discovery
// failed, and the order was left holding that single error code with no way to
// retry. The content-management list API reports the platform's own review
// verdict together with the article's public URL, and it is keyed by the
// article id the review URL carries, so it is the fallback that turns "still
// under review" into either a real public backlink or a readable reason.
function baijiahaoReviewArticleId(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const matched = /[?&]article_id=(\d+)/i.exec(raw) || /[?&]id=(\d+)/i.exec(raw);
  const articleId = matched ? matched[1] : "";
  return /^\d{8,}$/.test(articleId) ? articleId : "";
}

// A refused discovery has to come back as "not found" with a readable reason
// rather than as a thrown error. The API turns a thrown discovery error into
// publication_discovery_failed, which leaves the order holding one adapter error
// code and no retry path; found:false takes the candidate-URL branch instead, so
// the next recheck gets another chance and the operator sees why.
function baijiahaoDiscoveryNotFound(input = {}, reason = "") {
  return {
    found: false,
    publicUrl: "",
    publishedUrl: "",
    pageText: "",
    pageTitle: "",
    titleMatched: false,
    bodyMatched: false,
    publicImageFound: false,
    message: `百家号内容管理未确认该文章已审核通过并公开（${reason}）。平台审核通过后会自动生成公开地址，请稍后重试。`,
  };
}

// The public article page has to be read the way a visitor reads it. The
// discovery page comes from launchAuthEnvironment, a persistent profile that
// holds the account's cookies, and the platform serves an author their own
// article from that page whether or not the article ever went public. An
// authenticated read therefore proves "the author can open this link" and
// nothing more, which is exactly the claim that let an editor address stand in
// for a published one. An incognito context opened from the same browser
// carries no cookies at all, so "the article rendered" there means "an
// anonymous visitor can read it".
//
// A stubbed browser in the tests, and any browser that cannot open a second
// context, has no incognito context to give. The authenticated page is then the
// only read available, and the result records which mode decided it.
async function baijiahaoAnonymousPage(context) {
  const browser = typeof context?.browser === "function" ? context.browser() : null;
  if (!browser || typeof browser.newContext !== "function") return null;
  try {
    const anonymousContext = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 1360, height: 900 }
    });
    return { context: anonymousContext, page: await anonymousContext.newPage() };
  } catch {
    return null;
  }
}

async function verifyBaijiahaoPublicPage(context, page, input = {}) {
  const publicUrl = normalizeBaijiahaoPublishedUrl(
    input.publicUrl || input.publishedUrl || input.reviewUrl || ""
  );
  if (!publicUrl) throw new Error("BAIJIAHAO_PUBLIC_URL_INVALID");
  const readAs = { ...input, publicUrl };
  const anonymous = await baijiahaoAnonymousPage(context);
  if (!anonymous) {
    return {
      ...(await inspectBaijiahaoPublicArticle(page, readAs)),
      publicPageReadMode: "authenticated"
    };
  }
  try {
    let inspected = null;
    try {
      inspected = await inspectBaijiahaoPublicArticle(anonymous.page, readAs);
    } catch (error) {
      // A read that could not be performed says nothing about the article, so it
      // takes the same fallback as a verification wall below.
      inspected = { found: false, blocker: baijiahaoDiscoveryErrorCode(error) || "BAIJIAHAO_PUBLIC_PAGE_UNREADABLE" };
    }
    if (inspected.found || !inspected.blocker) {
      return { ...inspected, publicPageReadMode: "anonymous" };
    }
    // Baidu answered the anonymous read with its security verification page, so
    // that read carries no verdict. Re-read on the authenticated page rather
    // than reporting "still under review" for an article the platform already
    // published, and record that the public claim rests on the weaker read.
    return {
      ...(await inspectBaijiahaoPublicArticle(page, readAs)),
      publicPageReadMode: "authenticated",
      anonymousBlocker: inspected.blocker
    };
  } finally {
    await anonymous.context.close?.().catch(() => undefined);
  }
}

async function discoverBaijiahaoPublicArticle(context, page, input = {}) {
  let inspected = null;
  let inspectError = "";
  try {
    inspected = await verifyBaijiahaoPublicPage(context, page, input);
  } catch (error) {
    if (!/BAIJIAHAO_PUBLIC_URL_INVALID/.test(String(error?.message || error))) throw error;
    inspectError = "BAIJIAHAO_PUBLIC_URL_INVALID";
  }
  if (inspected?.found) return inspected;

  const articleId = baijiahaoReviewArticleId(input.reviewUrl || input.publicUrl || input.publishedUrl || "");
  if (!articleId) {
    return baijiahaoDiscoveryNotFound(input, inspectError || "BAIJIAHAO_PUBLIC_PAGE_NOT_FOUND");
  }
  let listEvidence = null;
  try {
    // The editor token is written by the builder app, and the public article
    // page shares its origin, so it is usually still in localStorage after the
    // inspect above. It is a best-effort header: without it the list API still
    // answers on cookies alone.
    const requestToken = await readBaijiahaoRequestToken(page).catch(() => "");
    listEvidence = await readBaijiahaoArticleList(page, { ...input, articleId, requestToken });
  } catch (error) {
    const code = baijiahaoDiscoveryErrorCode(error);
    // An auth failure has to keep propagating: the API reads it off the failed
    // command and moves the media account to needs_reauth. Swallowing it here
    // would report "still under review" for a credential that is gone.
    if (/LOGIN_REQUIRED|NEEDS_REAUTH|AUTH_EXPIRED|TOKEN_EXPIRED/.test(code)) throw error;
    return baijiahaoDiscoveryNotFound(input, `BAIJIAHAO_LIST_UNREADABLE:${code}`);
  }
  if (!listEvidence?.found) {
    return baijiahaoDiscoveryNotFound(input, "BAIJIAHAO_ARTICLE_NOT_IN_LIST");
  }
  if (!listEvidence.publiclyVisible?.visible) {
    return baijiahaoDiscoveryNotFound(input, listEvidence.publiclyVisible.reason || "BAIJIAHAO_NOT_PUBLICLY_VISIBLE");
  }
  try {
    const published = await verifyBaijiahaoPublicPage(context, page, {
      ...input,
      publicUrl: listEvidence.publiclyVisible.publicUrl,
    });
    if (published?.found) return published;
    // The platform published the article and served its public address, but no
    // anonymous read of that address rendered the article. Keep the order on
    // its retry path and say which mode was tried, instead of handing back a
    // URL nobody but the author can open.
    return {
      ...published,
      publicUrl: "",
      publishedUrl: "",
      message: `百家号已发布并给出公开地址，但公开页未读到文章正文（${published.blocker || published.anonymousBlocker || "BAIJIAHAO_PUBLIC_PAGE_NOT_MATCHED"}，读取方式 ${published.publicPageReadMode || "unknown"}）。平台审核通过后会自动生成公开地址，请稍后重试。`
    };
  } catch (error) {
    return baijiahaoDiscoveryNotFound(input, `BAIJIAHAO_PUBLIC_PAGE_UNREADABLE:${baijiahaoDiscoveryErrorCode(error)}`);
  }
}


export class BaijiahaoAdapter {
  constructor(options = {}) {
    this.platform = "baijiahao";
    this.loginUrl = options.loginUrl || BAIJIAHAO_LOGIN_URL;
    this.fieldNames = ["标题", "封面", "正文", "原创声明"];
    this.accountLabel = "百家号账号";
    this.browser = options.browser;
  }

  profileDir(input = {}) {
    const root = input.profileRoot || path.join(process.cwd(), ".zhixin-ai", "profiles");
    return resolveProfileDir(root, this.platform, input);
  }

  async launchAuthEnvironment(input = {}) {
    let context;
    const proxy = baijiahaoDiagnosticProxy(input);
    const launchOptions = {
      headless: Boolean(input.headless),
      viewport: { width: 1360, height: 900 },
      ...(proxy ? { proxy, ignoreHTTPSErrors: true } : {})
    };
    if (this.browser?.launchPersistentContext) {
      context = await this.browser.launchPersistentContext(this.profileDir(input), launchOptions);
    } else {
      const chromium = await importPlaywrightChromium();
      const userDataDir = this.profileDir(input);
      await mkdir(userDataDir, { recursive: true });
      context = await chromium.launchPersistentContext(userDataDir, {
        ...launchOptions,
        locale: "zh-CN",
        args: ["--disable-blink-features=AutomationControlled"]
      });
    }
    await seedPersistentContext(context, {
      cookies: input.cookies,
      localStorage: input.localStorage,
      sessionStorage: input.sessionStorage,
      origins: [BAIJIAHAO_ORIGIN, BAIDU_ORIGIN]
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
    while (Date.now() - startedAt < waitLoginMs) {
      let cookies = [];
      try {
        cookies = await context.cookies([BAIJIAHAO_ORIGIN, BAIDU_ORIGIN]);
      } catch (error) {
        if (isBrowserClosedError(error)) throw error;
        cookies = [];
      }
      const pageState = await readBaijiahaoPageState(page);
      if (isBaijiahaoLoggedIn(cookies, pageState)) return cookies;
      await new Promise((resolve) => setTimeout(resolve, 1500));
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
    const domProfile = await readBaijiahaoProfileFromDom(this.page);
    if (isUsefulAccountName(domProfile?.accountName)) return domProfile;
    return {
      accountName: await pickBaijiahaoAccountName(input, this.page),
      avatar: ""
    };
  }

  async collectAuthArtifact(input = {}) {
    const context = this.context || (await this.launchAuthEnvironment(input));
    const page = this.page || context.pages()[0] || await context.newPage();
    if (!page.url().startsWith(BAIJIAHAO_ORIGIN)) {
      await page.goto(BAIJIAHAO_ORIGIN, { waitUntil: "domcontentloaded" });
    }
    const cookies = this.cookies || await context.cookies([BAIJIAHAO_ORIGIN, BAIDU_ORIGIN]);
    const storage = await collectWebStorage(page);
    const pageState = await readBaijiahaoPageState(page);
    const artifact = buildBaijiahaoAuthArtifact({ cookies, ...storage }, {
      authorizationEvidence: {
        strongCookiePresent: hasBaijiahaoStrongLoginCookie(cookies),
        workspaceReady: isBaijiahaoWorkspaceReady(pageState),
        currentUrl: pageState.url,
        pageTitle: pageState.title,
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
    const cookies = await context.cookies([BAIJIAHAO_ORIGIN, BAIDU_ORIGIN]);
    const pageState = await readBaijiahaoPageState(page);
    if (!isBaijiahaoLoggedIn(cookies, pageState)) throw new Error("BAIJIAHAO_LOGIN_REQUIRED");
    const storage = await collectWebStorage(page);
    return buildBaijiahaoAuthArtifact({ cookies, ...storage }, {
      authorizationEvidence: {
        strongCookiePresent: hasBaijiahaoStrongLoginCookie(cookies),
        workspaceReady: isBaijiahaoWorkspaceReady(pageState),
        currentUrl: pageState.url,
        pageTitle: pageState.title,
        checkedAt: new Date().toISOString()
      }
    });
  }

  async reportCredentialRefresh(input, context, page) {
    const artifact = await this.captureCredentialArtifactFromContext(context, page);
    if (baijiahaoCaptureLosesEditorToken(artifact, input?.localStorage)) return artifact;
    if (typeof input?.onCredentialRefresh === "function") await input.onCredentialRefresh(artifact);
    return artifact;
  }

  async refreshCredentialAfterOperation(input, context, page, validationUrl = BAIJIAHAO_EDITOR_URL) {
    return refreshCredentialFromWorkspace({
      context,
      page,
      validationUrl,
      report: (activeContext, activePage) => this.reportCredentialRefresh(input, activeContext, activePage),
      onError: input?.onCredentialRefreshError
    });
  }

  async validateSession(input = {}) {
    const context = await this.launchAuthEnvironment(input);
    const page = context.pages()[0] || await context.newPage();
    try {
      await page.goto(input.validationUrl || BAIJIAHAO_EDITOR_URL, { waitUntil: "domcontentloaded" });
      await bringToFrontIfAllowed(page, input);
      await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
      await readBaijiahaoRequestToken(page);
      const artifact = await this.reportCredentialRefresh(input, context, page);
      return {
        valid: true,
        platform: this.platform,
        currentUrl: typeof page.url === "function" ? page.url() : "",
        // session_validation_succeeded 事件会用这份 credentialMetadata 重设账号的
        // 过期时间与复查计划。token 丢失时用注入存储里残留的 editor-token 证据重算，
        // 别把"只剩 cookie 的 2027 年到期时间"报给 API。
        credentialMetadata: baijiahaoCaptureLosesEditorToken(artifact, input?.localStorage)
          ? mergeBaijiahaoEditorTokenExpiry(artifact.credentialMetadata, input?.localStorage)
          : artifact.credentialMetadata
      };
    } finally {
      if (!input.keepBrowserOpen) await context.close().catch(() => undefined);
    }
  }

  async discoverPublication(input = {}) {
    const context = await this.launchAuthEnvironment(input);
    const page = context.pages()[0] || await context.newPage();
    try {
      return await discoverBaijiahaoPublicArticle(context, page, input);
    } finally {
      await this.refreshCredentialAfterOperation(input, context, page, BAIJIAHAO_EDITOR_URL);
      if (!input.keepBrowserOpen) await context.close().catch(() => undefined);
    }
  }

  async publishArticle(input = {}) {
    const publishInput = normalizePublishInput(input);
    const context = await this.launchAuthEnvironment(input);
    const page = context.pages()[0] || await context.newPage();
    const keepOpen = Boolean(input.keepBrowserOpen);
      const publishWatcher = watchPublishApiResponses(page);
    try {
      if (shouldPublishBaijiahaoViaApi(input)) {
        return await publishBaijiahaoViaApi(page, input, publishInput);
      }
      await page.goto(BAIJIAHAO_EDITOR_URL, { waitUntil: "domcontentloaded" });
      await bringToFrontIfAllowed(page, input);
      await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
      await dismissKnownPopups(page);

      const cookies = await context.cookies([BAIJIAHAO_ORIGIN, BAIDU_ORIGIN]);
      const pageState = await readBaijiahaoPageState(page);
      if (!isBaijiahaoLoggedIn(cookies, pageState)) throw new Error("BAIJIAHAO_LOGIN_REQUIRED");

      await fillTitle(page, publishInput.title);
      await fillBody(page, publishInput.content, publishInput.richHtml);
      const uploadedImages = publishInput.platformImageTasks.length
        ? await uploadBaijiahaoInlineImages(page, publishInput.platformImageTasks, { onProgress: input.onProgress })
        : [];
      await ensureCoverSelected(page, publishInput.coverImagePath);
      await clickDraftSave(page, publishInput.draftTimeoutMs);
      let draftUrl = publishWatcher.state.draftUrl;
      if (publishInput.platformImageTasks.length || !publishInput.confirmPublish) {
        draftUrl = await waitForBaijiahaoDraftUrl(
          publishWatcher.state,
          page,
          publishInput.draftTimeoutMs
        );
      } else if (!draftUrl) {
        const currentUrl = typeof page.url === "function" ? String(page.url() || "") : "";
        draftUrl = /[?&]article_id=\d+/i.test(currentUrl) ? currentUrl : "";
      }
      // The platform already holds a saved article at this point, so report it
      // before draft image or publish verification gets a chance to throw.
      const draftArticleId = (/[?&]article_id=(\d+)/i.exec(String(draftUrl || "")) || [])[1] || "";
      input.evidenceSink?.({
        ...(draftUrl ? { draftUrl } : {}),
        ...(draftArticleId ? { externalIds: { articleId: draftArticleId } } : {}),
        platformStatus: "draft_saved"
      });
      let draftImages = [];
      if (publishInput.platformImageTasks.length) {
        await input.onProgress?.({ type: "verifying_draft_images", total: publishInput.platformImageTasks.length });
        await page.goto(draftUrl, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
        const reloadedImages = await waitForBaijiahaoEditorImages(
          page,
          publishInput.platformImageTasks.length,
          publishInput.draftTimeoutMs
        );
        draftImages = await verifyPlatformImages({
          tasks: publishInput.platformImageTasks,
          readImages: async () => reloadedImages,
          stage: "draft",
        });
      }
      const draftImageEvidence = publishInput.platformImageTasks.length
        ? buildImagePublicationEvidence(publishInput.platformImageTasks, uploadedImages, draftImages, [], PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED)
        : undefined;

      if (!publishInput.confirmPublish) {
        return {
          draftUrl,
          publishedUrl: "",
          platformStatus: "draft_saved",
          title: publishInput.title,
          ...(draftImageEvidence ? { imagePublicationEvidence: draftImageEvidence } : {}),
        };
      }

      const publishButton = page.getByRole("button", { name: /^(\u53d1\u5e03|publish)$/i }).first();
      if (!(await waitForLocatorEnabled(publishButton, page, publishInput.publishTimeoutMs))) {
        const count = await publishButton.count?.().catch(() => undefined);
        const visible = await publishButton.isVisible?.().catch(() => undefined);
        const disabled = await publishButton.isDisabled?.().catch(() => undefined);
        const state = count === 0 ? "missing" : visible === true && disabled === true ? "disabled" : visible === false && count > 0 ? "hidden" : "unknown";
        await input.onProgress?.({ type: "publish_button_timeout", platform: "baijiahao", state });
        throw new Error(`BAIJIAHAO_PUBLISH_BUTTON_${state.toUpperCase()}`);
      }
      await publishButton.click({ timeout: 5000 });
      await page.waitForLoadState?.("networkidle", { timeout: publishInput.publishTimeoutMs }).catch(() => undefined);
      await page.waitForTimeout?.(3000).catch(() => undefined);
      await confirmPostPublishDialogs(page);
      await page.waitForLoadState?.("networkidle", { timeout: publishInput.publishTimeoutMs }).catch(() => undefined);
      await page.waitForTimeout?.(3000).catch(() => undefined);

      let publishedUrl = publishWatcher.state.publishedUrl || await readPublishedUrl(page);
      const blocker = await readPlatformBlocker(page);
      if (blocker || publishWatcher.state.blocker) {
        notifyPublishProgress(input, {
          type: "manual_verification_required",
          platform: "baijiahao",
          message: "请在弹出的百家号窗口完成百度安全验证，验证通过后会继续发布。",
          currentUrl: typeof page.url === "function" ? page.url() : "",
        });
        publishedUrl = publishWatcher.state.publishedUrl || await waitForManualVerification(page, publishInput.manualVerificationTimeoutMs, input);
      }
      publishedUrl = publishedUrl || publishWatcher.state.publishedUrl || await readPublishedUrl(page);
      if (!publishedUrl) throw new Error("BAIJIAHAO_PUBLISHED_URL_NOT_FOUND");
      let publicImages = [];
      if (publishInput.platformImageTasks.length) {
        await input.onProgress?.({ type: "verifying_public_images", total: publishInput.platformImageTasks.length });
        // Draft URLs are not public URLs. Copying them into the public stage would
        // claim public evidence the platform never gave us, so a blocked or
        // unreachable public page has to stay "unverifiable" instead.
        publicImages = await verifyBaijiahaoPublicImages(context, publishedUrl, publishInput.platformImageTasks).catch(() => []);
      }
      const imagePublicationEvidence = publishInput.platformImageTasks.length
        ? buildImagePublicationEvidence(publishInput.platformImageTasks, uploadedImages, draftImages, publicImages, PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED)
        : undefined;
      return {
        draftUrl,
        publishedUrl,
        platformStatus: "published",
        title: publishInput.title,
        ...(imagePublicationEvidence ? { imagePublicationEvidence } : {}),
      };
    } finally {
      publishWatcher.dispose();
      await this.refreshCredentialAfterOperation(input, context, page, BAIJIAHAO_EDITOR_URL);
      if (!keepOpen) await context.close().catch(() => undefined);
    }
  }
}
