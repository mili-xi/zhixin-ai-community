import crypto from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { readLocatorImages, readPublicPageBlockerFromPage, verifyPlatformImages, verifyPublicImageEvidence } from "../editor-image-upload.mjs";
import { buildImagePublicationEvidence, PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED, isPersistentPlatformImageUrl } from "../platform-images.mjs";
import { composeRichArticleHtml } from "../rich-content.mjs";
import { bringToFrontIfAllowed } from "../browser-visibility.mjs";

const ZHIHU_ORIGIN = "https://www.zhihu.com";
const ZHIHU_COLUMN_ORIGIN = "https://zhuanlan.zhihu.com";
const ZHIHU_API_ORIGIN = "https://api.zhihu.com";
const ZHIHU_LOGIN_URL = "https://www.zhihu.com/creator";
const ZHIHU_WRITE_URL = "https://zhuanlan.zhihu.com/write";
const ZHIHU_OSS_UPLOAD_ENDPOINT = "https://zhihu-pics-upload.zhimg.com";
const ZHIHU_OSS_BUCKET = "zhihu-pics";
const DEFAULT_WAIT_LOGIN_MS = 300000;
const ZHIHU_PUBLIC_IMAGE_SELECTOR = ".Post-RichText img, .RichText img, .ztext img, article img";

function isBrowserClosedError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /Target page, context or browser has been closed|Browser has been closed|Target closed/i.test(message);
}

function withZhihuTimeout(promise, timeoutMs, label) {
  let timer = null;
  const ms = Math.max(1000, Number(timeoutMs) || 60000);
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`ZHIHU_STEP_TIMEOUT:${label}:${ms}ms`)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function encodeEnvelope(payload) {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function fingerprintFor(snapshot) {
  const cookieShape = snapshot.cookies
    .map((cookie) => `${cookie.domain || ""}:${cookie.name}:${cookie.value || ""}`)
    .sort()
    .join("|");
  return crypto.createHash("sha256").update(cookieShape).digest("hex").slice(0, 16);
}

export function isZhihuCookie(cookie = {}) {
  const domain = String(cookie.domain || "").replace(/^\./, "");
  return domain === "zhihu.com" || domain.endsWith(".zhihu.com");
}

export function normalizeZhihuCookie(cookie = {}) {
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

export function isZhihuLoggedInFromCookies(cookies = []) {
  return hasZhihuStrongLoginCookie(cookies);
}

export function hasZhihuStrongLoginCookie(cookies = []) {
  return cookies.some((cookie) => (
    isZhihuCookie(cookie)
    && cookie.name === "z_c0"
    && typeof cookie.value === "string"
    && cookie.value.trim().length > 0
  ));
}

const ZHIHU_DRAFT_PUBLISHED_ERROR_NAMES = new Set(["draftalreadypublishedexception"]);
const ZHIHU_DRAFT_MISSING_ERROR_NAMES = new Set(["resourcenotfoundexception"]);
const ZHIHU_DRAFT_PUBLISHED_ERROR_CODES = new Set([4042]);
const ZHIHU_DRAFT_MISSING_ERROR_CODES = new Set([4041]);

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

// Keep platform error text short and never echo request payloads or credentials.
function describeZhihuPublishBody(result = {}) {
  const body = typeof result.text === "string" ? result.text : "";
  if (result.json && typeof result.json === "object") {
    const error = result.json.error && typeof result.json.error === "object" ? result.json.error : null;
    const source = error || result.json;
    const parts = [];
    if (source.code !== undefined) parts.push(`code=${cleanText(source.code)}`);
    if (source.name) parts.push(`name=${cleanText(source.name)}`);
    if (source.message) parts.push(`message=${cleanText(source.message).slice(0, 80)}`);
    if (parts.length) return parts.join("&");
    return `json:${body.length}b`;
  }
  const kind = body ? (body.slice(0, 200).trimStart().startsWith("<") ? "html" : "non-json") : "empty";
  return `${kind}:${body.length}b`;
}

function matchesAny(patterns = [], value = "") {
  const text = String(value || "");
  return patterns.some((pattern) => pattern.test(text));
}

const ZHIHU_LOGIN_PATTERNS = [/\/signin/i, /\/sign_up/i, /\/login/i];
const ZHIHU_WORKSPACE_URL_PATTERNS = [/zhihu\.com\/(creator|writer|draft|question\/waiting)/i, /zhuanlan\.zhihu\.com\/write/i];
const ZHIHU_WORKSPACE_TEXT_PATTERNS = [
  /\b(creator|writer|write article|draft|publish)\b/i,
  /\u521b\u4f5c\u4e2d\u5fc3|\u5199\u6587\u7ae0|\u8349\u7a3f|\u53d1\u5e03/i
];

export function isZhihuWorkspaceReady(pageState = {}) {
  const url = cleanText(pageState.url);
  const title = cleanText(pageState.title);
  const text = cleanText(pageState.text);
  const pageText = `${url} ${title} ${text}`;
  if (matchesAny(ZHIHU_LOGIN_PATTERNS, pageText)) return false;
  return matchesAny(ZHIHU_WORKSPACE_URL_PATTERNS, url)
    || matchesAny(ZHIHU_WORKSPACE_TEXT_PATTERNS, pageText);
}

export function isZhihuLoggedIn(cookies = [], pageState = {}) {
  return hasZhihuStrongLoginCookie(cookies) && isZhihuWorkspaceReady(pageState);
}

export async function readZhihuPageState(page) {
  if (!page) return { url: "", title: "", text: "" };
  const url = typeof page.url === "function" ? cleanText(page.url()) : "";
  const title = typeof page.title === "function" ? cleanText(await page.title().catch(() => "")) : "";
  const text = typeof page.evaluate === "function"
    ? cleanText(await page.evaluate(() => document.body?.innerText?.slice(0, 8000) || "").catch(() => ""))
    : "";
  return { url, title, text };
}

function isUsefulAccountName(value) {
  const name = cleanText(value);
  if (!name) return false;
  if (name.length > 48) return false;
  return !["知乎", "首页", "写文章", "创作中心", "消息", "私信", "通知", "知乎账号"].includes(name);
}

export async function readZhihuProfileFromApi(page) {
  if (!page?.request?.get) return null;
  const response = await page.request.get(`${ZHIHU_ORIGIN}/api/v4/me`).catch(() => null);
  if (!response?.ok?.()) return null;
  const profile = await response.json().catch(() => null);
  if (!profile || typeof profile !== "object") return null;
  const name = cleanText(profile.name || profile.fullname || profile.headline);
  const urlToken = cleanText(profile.url_token || profile.id);
  return {
    accountName: isUsefulAccountName(name) ? name : urlToken,
    avatar: cleanText(profile.avatar_url || profile.avatarUrl || profile.avatar || "")
  };
}

export async function readZhihuProfileFromDom(page) {
  if (!page?.evaluate) return null;
  const result = await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const selectors = [
      "a[href*='/people/'] img[alt]",
      "a[href*='/people/'][title]",
      "a[href*='/people/']",
      "a[href*='/org/'] img[alt]",
      "a[href*='/org/'][title]",
      "a[href*='/org/']"
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

export async function collectWebStorage(page) {
  return page.evaluate(() => {
    const readStorage = (storage) => {
      const values = {};
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key) values[key] = storage.getItem(key);
      }
      return values;
    };

    return {
      localStorage: readStorage(window.localStorage),
      sessionStorage: readStorage(window.sessionStorage)
    };
  });
}

function summarizeZhihuCredentialExpiry(cookies = []) {
  const relevant = (Array.isArray(cookies) ? cookies : []).filter((cookie) => (
    String(cookie?.name || "").toLowerCase() === "z_c0"
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
      : "",
  };
}

export function buildZhihuAuthArtifact(snapshot, options = {}) {
  const capturedAt = options.capturedAt || new Date().toISOString();
  const normalized = {
    platform: "zhihu",
    origin: ZHIHU_ORIGIN,
    cookies: (snapshot.cookies || []).filter(isZhihuCookie).map(normalizeZhihuCookie),
    localStorage: snapshot.localStorage || {},
    sessionStorage: snapshot.sessionStorage || {},
    capturedAt
  };
  const fingerprint = fingerprintFor(normalized);

  return {
    cookies: `encrypted-cookie-${encodeEnvelope({ platform: "zhihu", cookies: normalized.cookies, capturedAt })}`,
    localStorage: `encrypted-local-storage-${encodeEnvelope({ platform: "zhihu", values: normalized.localStorage, capturedAt })}`,
    sessionStorage: `encrypted-session-storage-${encodeEnvelope({ platform: "zhihu", values: normalized.sessionStorage, capturedAt })}`,
    fingerprint: `fp-zhihu-${fingerprint}`,
    storageVersion: 2,
    capturedAt,
    credentialMetadata: options.credentialMetadata || summarizeZhihuCredentialExpiry(normalized.cookies),
    authorizationEvidence: options.authorizationEvidence || null
  };
}

export async function pickZhihuAccountName(input = {}, page) {
  if (input.accountName?.trim()) return input.accountName.trim();
  const apiProfile = await readZhihuProfileFromApi(page);
  if (isUsefulAccountName(apiProfile?.accountName)) return apiProfile.accountName;
  const domProfile = await readZhihuProfileFromDom(page);
  if (isUsefulAccountName(domProfile?.accountName)) return domProfile.accountName;
  const title = page ? await page.title().catch(() => "") : "";
  const name = title
    .replace(/\s*-\s*知乎\s*$/, "")
    .replace(/\s*知乎\s*$/, "")
    .trim();
  return isUsefulAccountName(name) ? name : "知乎账号";
}

function normalizePublishInput(input = {}) {
  const title = cleanText(input.articleTitle || input.title);
  const content = cleanText(input.contentMarkdown || input.content || input.body || input.markdown);
  if (!title) throw new Error("ZHIHU_TITLE_REQUIRED");
  if (title.length > 100) throw new Error("ZHIHU_TITLE_TOO_LONG");
  if (!content) throw new Error("ZHIHU_CONTENT_REQUIRED");
  return {
    title,
    content,
    contentBlocks: Array.isArray(input.contentBlocks) ? input.contentBlocks : [],
    richHtml: cleanText(input.contentHtmlWithoutImages || input.contentHtml),
    richText: (Array.isArray(input.contentBlocks) ? input.contentBlocks : [])
      .filter((block) => block?.type === "section")
      .map((block) => [cleanText(block.title), cleanText(block.content)].filter(Boolean).join("\n"))
      .filter(Boolean)
      .join("\n\n") || content,
    platformImageTasks: Array.isArray(input.platformImageTasks) ? input.platformImageTasks : [],
    confirmPublish: input.confirmPublish === true || input.publishMode === "publish",
    draftTimeoutMs: Number(input.draftTimeoutMs || 30000),
    publishTimeoutMs: Number(input.publishTimeoutMs || 45000)
  };
}

export function zhihuDraftEditUrl(draftId) {
  const id = cleanText(draftId);
  if (!id) throw new Error("ZHIHU_DRAFT_ID_REQUIRED");
  return `${ZHIHU_COLUMN_ORIGIN}/p/${id}/edit`;
}

export function zhihuPublicUrl(articleId) {
  const id = cleanText(articleId);
  if (!id) return "";
  return `${ZHIHU_COLUMN_ORIGIN}/p/${id}`;
}

export function countImagesInHtml(html = "") {
  return (String(html || "").match(/<img\b/gi) || []).length;
}

export function extractImageUrlsFromHtml(html = "") {
  const urls = [];
  const re = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  let match = re.exec(String(html || ""));
  while (match) {
    const src = cleanText(match[1]);
    if (src) urls.push(src);
    match = re.exec(String(html || ""));
  }
  return urls;
}

export function transformZhihuContentHtml(content = "") {
  let result = String(content || "");
  result = result.replace(/<section\b([^>]*)>/gi, "<div$1>").replace(/<\/section>/gi, "</div>");
  result = result.replace(/\s*style="[^"]*"/gi, "");
  result = result.replace(/\s*data-zhixin-[a-z-]+="[^"]*"/gi, "");
  result = result.replace(/<pre><code class="language-(\w+)">/gi, '<pre lang="$1"><code>');
  // Wrap bare imgs in figure once (skip already-figured ones).
  result = result.replace(/<figure\b[^>]*>[\s\S]*?<\/figure>|<img\b[^>]*>/gi, (chunk) => {
    if (/^<figure\b/i.test(chunk)) return chunk;
    const srcMatch = chunk.match(/\bsrc=["']([^"']+)["']/i);
    if (!srcMatch) return chunk;
    const src = srcMatch[1];
    const altMatch = chunk.match(/\balt=["']([^"']*)["']/i);
    const alt = altMatch ? ` alt="${altMatch[1]}"` : "";
    return `<figure><img src="${src}"${alt}></figure>`;
  });
  return result;
}

export function buildZhihuPublishHtml(input = {}, uploadedImages = []) {
  const blocks = Array.isArray(input.contentBlocks) ? input.contentBlocks : [];
  const images = Array.isArray(uploadedImages) ? uploadedImages : [];
  const byAsset = new Map(images.filter((image) => image?.assetId).map((image) => [String(image.assetId), image]));
  const bySection = new Map(images.filter((image) => image?.sectionId).map((image) => [String(image.sectionId), image]));

  if (blocks.some((block) => block?.type === "section" || block?.type === "image")) {
    const hydrated = blocks.map((block) => {
      if (block?.type !== "image") return block;
      const image = byAsset.get(String(block.assetId || "")) || bySection.get(String(block.sectionId || ""));
      const platformUrl = cleanText(image?.platformImageUrl || image?.url || "");
      return platformUrl
        ? { ...block, url: platformUrl, dataUrl: "", path: undefined }
        : block;
    });
    return transformZhihuContentHtml(composeRichArticleHtml(hydrated, { includeImages: true }));
  }

  let html = cleanText(input.richHtml);
  if (!html) {
    html = String(input.content || "")
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
      .map((paragraph) => `<p>${paragraph
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\n/g, "<br>")}</p>`)
      .join("");
  }

  if (images.length) {
    const figures = images.map((image) => {
      const src = cleanText(image.platformImageUrl || image.url);
      if (!src) return "";
      const alt = cleanText(image.altText || "文章插图")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
      return `<figure><img src="${src}" alt="${alt}"></figure>`;
    }).filter(Boolean).join("");
    html = `${html}${figures}`;
  }

  return transformZhihuContentHtml(html);
}

function isStableZhihuImageUrl(value = "") {
  const url = cleanText(value);
  return isPersistentPlatformImageUrl(url)
    && !/pic-private\.zhihu\.com/i.test(url)
    && !/[?&](?:auth_key|expiration)=/i.test(url);
}

function zhihuImageIdentity(value = "") {
  try {
    const url = new URL(cleanText(value));
    const filename = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) || "");
    return filename.split("~", 1)[0].replace(/\.(?:avif|gif|jpe?g|png|webp)$/i, "");
  } catch {
    return "";
  }
}

export function mapDraftImagesToTasks(tasks = [], imageUrls = [], uploadedImages = []) {
  const urls = (Array.isArray(imageUrls) ? imageUrls : []).filter((url) => isPersistentPlatformImageUrl(url));
  const uploads = Array.isArray(uploadedImages) ? uploadedImages : [];
  return (Array.isArray(tasks) ? tasks : []).map((task, index) => {
    const draftUrl = String(urls[index] || "");
    const uploaded = uploads.find((image) => task?.assetId && image?.assetId === task.assetId)
      || uploads.find((image) => task?.sectionId && image?.sectionId === task.sectionId)
      || uploads[index]
      || {};
    const uploadedUrl = String(uploaded.platformImageUrl || uploaded.url || "");
    const matchedUploadedUrl = isStableZhihuImageUrl(uploadedUrl)
      && zhihuImageIdentity(draftUrl)
      && zhihuImageIdentity(draftUrl) === zhihuImageIdentity(uploadedUrl)
      ? uploadedUrl
      : "";
    const platformImageUrl = isStableZhihuImageUrl(draftUrl) ? draftUrl : matchedUploadedUrl;
    return {
      assetId: String(task?.assetId || ""),
      sectionId: String(task?.sectionId || ""),
      position: Number(task?.position ?? index),
      platformImageUrl,
      loaded: Boolean(platformImageUrl),
    };
  });
}

function guessImageContentType(filePath = "") {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".bmp") return "image/bmp";
  return "image/jpeg";
}

export function md5Hex(buffer) {
  return crypto.createHash("md5").update(buffer).digest("hex");
}

export function hmacSha1Base64(key, message) {
  return crypto.createHmac("sha1", key).update(message).digest("base64");
}

export function buildZhihuOssAuthorization(token = {}, objectKey = "", contentType = "application/octet-stream", ossDate = "") {
  const date = ossDate || new Date().toUTCString();
  const ossUserAgent = "aliyun-sdk-js/6.8.0";
  const ossHeaders = {
    "x-oss-date": date,
    "x-oss-security-token": String(token.access_token || ""),
    "x-oss-user-agent": ossUserAgent,
  };
  const canonicalizedOSSHeaders = Object.keys(ossHeaders)
    .sort()
    .map((header) => `${header}:${ossHeaders[header]}`)
    .join("\n");
  const canonicalizedResource = `/${ZHIHU_OSS_BUCKET}/${objectKey}`;
  const stringToSign = `PUT\n\n${contentType}\n${date}\n${canonicalizedOSSHeaders}\n${canonicalizedResource}`;
  const signature = hmacSha1Base64(String(token.access_key || ""), stringToSign);
  return {
    authorization: `OSS ${token.access_id}:${signature}`,
    ossDate: date,
    ossUserAgent,
    stringToSign,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readZhihuXsrf(page) {
  if (!page?.context?.()?.cookies) return "";
  const cookies = await page.context().cookies([ZHIHU_ORIGIN, ZHIHU_COLUMN_ORIGIN, ZHIHU_API_ORIGIN]).catch(() => []);
  const xsrf = cookies.find((cookie) => cookie?.name === "_xsrf" && cookie.value);
  return cleanText(xsrf?.value);
}

export async function zhihuApiFetch(page, url, options = {}) {
  if (!page?.request?.fetch) throw new Error("ZHIHU_REQUEST_API_UNAVAILABLE");
  const method = String(options.method || "GET").toUpperCase();
  const xsrf = options.xsrf || await readZhihuXsrf(page);
  const headers = {
    "x-requested-with": "fetch",
    Referer: `${ZHIHU_COLUMN_ORIGIN}/write`,
    Origin: ZHIHU_COLUMN_ORIGIN,
    ...(xsrf ? { "x-xsrftoken": xsrf } : {}),
    ...(options.headers || {}),
  };
  const response = await page.request.fetch(url, {
    method,
    headers,
    data: options.data,
    form: options.form,
    multipart: options.multipart,
    failOnStatusCode: false,
    timeout: options.timeout || 60000,
  });
  const status = response.status();
  const text = await response.text().catch(() => "");
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { ok: status >= 200 && status < 300, status, text, json, response };
}

export async function createZhihuDraftViaApi(page, title) {
  const result = await zhihuApiFetch(page, `${ZHIHU_COLUMN_ORIGIN}/api/articles/drafts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    data: {
      title: cleanText(title),
      delta_time: 0,
      can_reward: false,
    },
  });
  if (!result.ok) throw new Error(`ZHIHU_CREATE_DRAFT_FAILED:${result.status}`);
  const draftId = cleanText(result.json?.id);
  if (!draftId) throw new Error("ZHIHU_CREATE_DRAFT_INVALID");
  return draftId;
}

export async function updateZhihuDraftViaApi(page, draftId, content) {
  const result = await zhihuApiFetch(page, `${ZHIHU_COLUMN_ORIGIN}/api/articles/${draftId}/draft`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    data: {
      content: String(content || ""),
      table_of_contents: false,
      delta_time: 0,
      can_reward: false,
    },
  });
  if (!result.ok) throw new Error(`ZHIHU_UPDATE_DRAFT_FAILED:${result.status}`);
  return result.json || { id: draftId };
}

export async function getZhihuDraftViaApi(page, draftId) {
  const result = await zhihuApiFetch(page, `${ZHIHU_COLUMN_ORIGIN}/api/articles/${draftId}/draft`, {
    method: "GET",
  });
  if (!result.ok) throw new Error(`ZHIHU_GET_DRAFT_FAILED:${result.status}`);
  return result.json || {};
}

/**
 * Ask Zhihu what happened to a draft. Zhihu deletes the draft row once it accepts a publish,
 * so the draft endpoint is the platform-side source of truth for "was this article published?".
 *   published -> the draft is gone and the article exists (DraftAlreadyPublishedException)
 *   draft     -> the draft box still holds it, so the publish never landed
 *   missing   -> neither draft nor article exists (ResourceNotFoundException)
 *   unknown   -> the probe itself could not tell us
 */
export async function inspectZhihuDraftPublishState(page, draftId, timeoutMs = 15000) {
  const normalizedDraftId = cleanText(draftId);
  if (!normalizedDraftId) return { state: "unknown", reason: "DRAFT_ID_MISSING" };
  let result = null;
  try {
    result = await zhihuApiFetch(page, `${ZHIHU_COLUMN_ORIGIN}/api/articles/${normalizedDraftId}/draft`, {
      method: "GET",
      timeout: Math.max(5000, Number(timeoutMs) || 15000),
    });
  } catch (error) {
    return {
      state: "unknown",
      reason: "DRAFT_PROBE_TRANSPORT_ERROR",
      message: cleanText(error instanceof Error ? error.message : String(error)).slice(0, 120),
    };
  }
  if (result.ok) {
    const draft = result.json && typeof result.json === "object" ? result.json : {};
    if (draft.id || draft.title || draft.content) {
      return { state: "draft", status: result.status, draftTitle: cleanText(draft.title) };
    }
    return { state: "unknown", status: result.status, reason: "DRAFT_BODY_EMPTY" };
  }
  const error = result.json?.error && typeof result.json.error === "object" ? result.json.error : null;
  const name = cleanText(error?.name).toLowerCase();
  const code = Number(error?.code);
  const message = cleanText(error?.message);
  if (result.status === 404 && (ZHIHU_DRAFT_PUBLISHED_ERROR_NAMES.has(name) || ZHIHU_DRAFT_PUBLISHED_ERROR_CODES.has(code))) {
    return { state: "published", status: result.status, code, name };
  }
  if (result.status === 404 && (ZHIHU_DRAFT_MISSING_ERROR_NAMES.has(name) || ZHIHU_DRAFT_MISSING_ERROR_CODES.has(code))) {
    return { state: "missing", status: result.status, code, name };
  }
  return { state: "unknown", status: result.status, code: Number.isFinite(code) ? code : undefined, name, message };
}

async function measureZhihuTextLength(page, html) {
  if (typeof page?.evaluate !== "function") throw new Error("ZHIHU_TEXT_LENGTH_UNAVAILABLE");
  return page.evaluate((value) => {
    const container = document.createElement("div");
    container.innerHTML = value;
    return (container.textContent || "").trim().length;
  }, String(html || ""));
}

function buildZhihuPublishPayload(draftId, title, content, textLength, traceId) {
  const businessParams = {
    commentPermission: "anyone",
    disclaimer_type: "none",
    disclaimer_status: "close",
    table_of_contents_enabled: false,
    content,
    title,
    commercial_report_info: { commercial_types: [] },
    commercial_zhitask_bind_info: null,
    canReward: false,
  };
  return {
    action: "article",
    data: {
      publish: { traceId },
      extra_info: {
        publisher: "pc",
        pc_business_params: JSON.stringify(businessParams),
      },
      draft: {
        disabled: 1,
        id: draftId,
        isPublished: false,
      },
      commentsPermission: { comment_permission: "anyone" },
      creationStatement: {
        disclaimer_type: "none",
        disclaimer_status: "close",
      },
      contentsTables: { table_of_contents_enabled: false },
      commercialReportInfo: { isReport: 0 },
      appreciate: { can_reward: false, tagline: "" },
      hybridInfo: {},
      hybrid: { html: content, textLength },
      title: { title },
    },
  };
}

export async function publishZhihuDraftViaApi(page, draftId, title, content, options = {}) {
  const normalizedDraftId = cleanText(draftId);
  const normalizedTitle = cleanText(title);
  const normalizedContent = String(content || "");
  const textLength = Number.isFinite(options.textLength)
    ? Number(options.textLength)
    : await measureZhihuTextLength(page, normalizedContent);
  const traceId = cleanText(options.traceId) || `${Date.now()},${crypto.randomUUID()}`;
  const payload = buildZhihuPublishPayload(
    normalizedDraftId,
    normalizedTitle,
    normalizedContent,
    textLength,
    traceId,
  );
  const result = await zhihuApiFetch(page, `${ZHIHU_ORIGIN}/api/v4/content/publish`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Referer: zhihuDraftEditUrl(normalizedDraftId),
    },
    data: payload,
  });
  const canonicalSuccess = result.ok
    && result.json?.code === 0
    && result.json?.message === "success";
  if (canonicalSuccess) {
    if (typeof result.json?.data?.result !== "string") {
      throw new Error("ZHIHU_PUBLISH_RESULT_INVALID");
    }
    let published = null;
    try {
      published = JSON.parse(result.json.data.result);
    } catch {
      throw new Error("ZHIHU_PUBLISH_RESULT_INVALID");
    }
    const publishedId = cleanText(published?.publish?.id);
    if (publishedId !== normalizedDraftId) {
      throw new Error(`ZHIHU_PUBLISH_ARTICLE_ID_MISMATCH:expected=${normalizedDraftId}:actual=${publishedId || "missing"}`);
    }
    return {
      publishedUrl: zhihuPublicUrl(publishedId),
      payload: result.json,
      published,
    };
  }

  // Zhihu answered outside the canonical success envelope. Its publish response shape is not
  // stable (empty bodies, CDN/WAF pages and business rejections all arrive through the same
  // branch), so a non-canonical body is not proof of a rejection. Declaring failure here
  // silently drops the callback URL for an article that is already live, and the only UI
  // recovery left afterwards is a republish. Ask Zhihu what happened to the draft first:
  // it deletes the draft row when it accepts a publish.
  const probeTimeoutMs = Math.max(5000, Number(options.draftProbeTimeoutMs) || 15000);
  let draftState = await inspectZhihuDraftPublishState(page, normalizedDraftId, probeTimeoutMs);
  if (draftState.state !== "published" && draftState.state !== "draft") {
    // Zhihu can lag between accepting the publish and dropping the draft row.
    await sleep(1000);
    draftState = await inspectZhihuDraftPublishState(page, normalizedDraftId, probeTimeoutMs);
  }
  if (draftState.state === "published") {
    return {
      publishedUrl: zhihuPublicUrl(normalizedDraftId),
      publishedId: normalizedDraftId,
      publishResponseAmbiguous: true,
      payload: result.json ?? { status: result.status, body: describeZhihuPublishBody(result) },
      publishDraftState: draftState,
    };
  }
  const draftMarker = `draft=${draftState.state}`;
  if (draftState.state === "unknown") {
    throw new Error(
      `ZHIHU_PUBLISH_OUTCOME_UNKNOWN:${describeZhihuPublishBody(result)}`
      + `:probe=${draftState.reason || "unknown"}:draftStatus=${draftState.status ?? 0}`,
    );
  }
  if (!result.ok) throw new Error(`ZHIHU_PUBLISH_API_FAILED:${result.status}:${describeZhihuPublishBody(result)}:${draftMarker}`);
  if (!result.json) throw new Error(`ZHIHU_PUBLISH_API_UNREADABLE:${result.status}:${describeZhihuPublishBody(result)}:${draftMarker}`);
  throw new Error(`ZHIHU_PUBLISH_API_REJECTED:${result.json?.code ?? "unknown"}:${cleanText(result.json?.message)}:${draftMarker}`);
}

export async function waitForZhihuApiDraftImages(page, draftId, expectedCount = 0, timeoutMs = 30000, pollMs = 500) {
  const deadline = Date.now() + Math.max(1, Number(timeoutMs || 30000));
  let lastCount = -1;
  let stableHits = 0;
  while (Date.now() < deadline) {
    const draft = await getZhihuDraftViaApi(page, draftId).catch(() => null);
    const content = String(draft?.content || "");
    const imageCount = countImagesInHtml(content);
    lastCount = imageCount;
    if (imageCount === Number(expectedCount || 0)) {
      stableHits += 1;
      if (stableHits >= 2) {
        return {
          draft,
          imageUrls: extractImageUrlsFromHtml(content).filter((url) => isPersistentPlatformImageUrl(url)),
          imageCount,
        };
      }
    } else {
      stableHits = 0;
    }
    await sleep(Math.max(50, Number(pollMs || 500)));
  }
  throw new Error(`DRAFT_IMAGE_MISSING:expected=${expectedCount}:actual=${lastCount}`);
}

async function waitForZhihuImageReady(page, imageId, timeoutMs = 30000, pollMs = 1000) {
  const deadline = Date.now() + Math.max(1, Number(timeoutMs || 30000));
  while (Date.now() < deadline) {
    const result = await zhihuApiFetch(page, `${ZHIHU_API_ORIGIN}/images/${imageId}`, { method: "GET" });
    if (result.ok) {
      const status = cleanText(result.json?.status);
      if (status === "success") {
        return result.json || {};
      }
    }
    await sleep(Math.max(1, Number(pollMs) || 1000));
  }
  throw new Error("ZHIHU_IMAGE_PROCESS_TIMEOUT");
}

export function resolveZhihuImageUrl(uploadFile = {}, imageDetail = {}) {
  const originalHash = cleanText(
    imageDetail.original_hash
    || imageDetail.hash
  );
  if (originalHash && !/^https?:\/\//i.test(originalHash)) {
    return `https://pic4.zhimg.com/${originalHash.replace(/^\//, "")}`;
  }
  if (isStableZhihuImageUrl(originalHash)) return originalHash;
  const direct = cleanText(
    imageDetail.original_src
    || imageDetail.src
    || imageDetail.url
    || imageDetail.full_url
    || imageDetail.image_url
  );
  if (isStableZhihuImageUrl(direct)) return direct;
  const objectKey = cleanText(uploadFile.object_key);
  if (!objectKey) return "";
  if (/^https?:\/\//i.test(objectKey)) return isStableZhihuImageUrl(objectKey) ? objectKey : "";
  return `https://pic4.zhimg.com/${objectKey.replace(/^\//, "")}`;
}

export async function uploadZhihuLocalImageViaApi(page, filePath, options = {}) {
  const localPath = cleanText(filePath);
  if (!localPath) throw new Error("ZHIHU_IMAGE_PATH_REQUIRED");
  const perImageTimeout = Math.max(20000, Number(options.timeoutMs) || 60000);
  const readyTimeout = Math.min(perImageTimeout, 25000);

  return withZhihuTimeout((async () => {
    const buffer = await readFile(localPath);
    const contentType = options.contentType || guessImageContentType(localPath);
    const imageHash = md5Hex(buffer);

    const tokenResult = await zhihuApiFetch(page, `${ZHIHU_API_ORIGIN}/images`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      data: {
        image_hash: imageHash,
        source: "article",
      },
      timeout: Math.min(perImageTimeout, 30000),
    });
    if (!tokenResult.ok) throw new Error(`ZHIHU_IMAGE_TOKEN_FAILED:${tokenResult.status}`);

    const uploadFile = tokenResult.json?.upload_file || {};
    const uploadToken = tokenResult.json?.upload_token || {};
    const imageId = cleanText(uploadFile.image_id);
    if (!imageId) throw new Error("ZHIHU_IMAGE_ID_MISSING");

    // state === 1 means already on CDN; still wait for final hash/url.
    if (Number(uploadFile.state) === 1) {
      const detail = await waitForZhihuImageReady(page, imageId, readyTimeout, options.pollMs);
      const url = resolveZhihuImageUrl(uploadFile, detail);
      if (!isStableZhihuImageUrl(url)) throw new Error("ZHIHU_IMAGE_URL_MISSING");
      return { imageId, platformImageUrl: url, reused: true };
    }

    const objectKey = cleanText(uploadFile.object_key);
    if (!objectKey) throw new Error("ZHIHU_IMAGE_OBJECT_KEY_MISSING");
    if (!uploadToken.access_id || !uploadToken.access_key || !uploadToken.access_token) {
      throw new Error("ZHIHU_IMAGE_UPLOAD_TOKEN_MISSING");
    }

    const ossAuth = buildZhihuOssAuthorization(uploadToken, objectKey, contentType);
    const body = buffer;
    const putResult = await zhihuApiFetch(page, `${ZHIHU_OSS_UPLOAD_ENDPOINT}/${objectKey}`, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        Authorization: ossAuth.authorization,
        "x-oss-date": ossAuth.ossDate,
        "x-oss-security-token": String(uploadToken.access_token || ""),
        "x-oss-user-agent": ossAuth.ossUserAgent,
      },
      data: body,
      timeout: Math.min(perImageTimeout, 45000),
    });
    if (!putResult.ok) throw new Error(`ZHIHU_OSS_UPLOAD_FAILED:${putResult.status}:${String(putResult.text || "").slice(0, 120)}`);

    const completionResult = await zhihuApiFetch(page, `${ZHIHU_API_ORIGIN}/images/${imageId}/uploading_status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      data: { upload_result: "success" },
      timeout: Math.min(perImageTimeout, 30000),
    });
    if (!completionResult.ok) {
      throw new Error(`ZHIHU_IMAGE_COMPLETION_FAILED:${completionResult.status}`);
    }

    const detail = await waitForZhihuImageReady(page, imageId, readyTimeout, options.pollMs);
    const platformImageUrl = resolveZhihuImageUrl(uploadFile, detail);
    if (!isStableZhihuImageUrl(platformImageUrl)) throw new Error("ZHIHU_IMAGE_URL_MISSING");
    return { imageId, platformImageUrl, reused: false };
  })(), perImageTimeout, `upload_image:${path.basename(localPath)}`);
}

export async function uploadZhihuImageTasksViaApi(page, tasks = [], options = {}) {
  const uploaded = [];
  const list = Array.isArray(tasks) ? tasks : [];
  for (const [index, task] of list.entries()) {
    await options.onProgress?.({
      type: "uploading_image_start",
      completed: index,
      total: list.length,
      assetId: task.assetId || "",
      sectionId: task.sectionId || "",
      transport: "api",
    });
    let result = null;
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        result = await uploadZhihuLocalImageViaApi(page, task.path, {
          timeoutMs: options.timeoutMs,
        });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await options.onProgress?.({
          type: "uploading_image_retry",
          completed: index,
          total: list.length,
          assetId: task.assetId || "",
          sectionId: task.sectionId || "",
          attempt,
          reason: error instanceof Error ? error.message : String(error),
          transport: "api",
        });
        if (isBrowserClosedError(error)) throw error;
      }
    }
    if (!result) {
      throw new Error(
        `ZHIHU_IMAGE_UPLOAD_FAILED:index=${index + 1}/${list.length}:asset=${task.assetId || ""}:${lastError instanceof Error ? lastError.message : String(lastError || "unknown")}`
      );
    }
    uploaded.push({
      assetId: String(task.assetId || ""),
      sectionId: String(task.sectionId || ""),
      position: Number(task.position ?? index),
      platformImageId: result.imageId,
      platformImageUrl: result.platformImageUrl,
      loaded: true,
      altText: cleanText(task.altText || "文章插图"),
    });
    await options.onProgress?.({
      type: "uploading_images",
      completed: index + 1,
      total: list.length,
      assetId: task.assetId || "",
      sectionId: task.sectionId || "",
      platformImageUrl: result.platformImageUrl,
      transport: "api",
    });
  }
  return uploaded;
}

function isPublishedUrl(url = "") {
  try {
    const parsed = new URL(String(url || ""));
    return /(^|\.)zhihu\.com$/i.test(parsed.hostname) && /^\/p\/[^/]+\/?$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function normalizedMatchText(value = "") {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

export async function inspectZhihuPublicArticle(page, input = {}) {
  const publicUrl = String(input.publicUrl || input.publishedUrl || input.reviewUrl || "").trim();
  if (!isPublishedUrl(publicUrl)) throw new Error("ZHIHU_PUBLIC_URL_INVALID");
  const existing = input.imagePublicationEvidence && typeof input.imagePublicationEvidence === "object"
    ? input.imagePublicationEvidence
    : {};
  const expected = Array.isArray(existing.expected) ? existing.expected : [];
  const verifyAttempts = Math.max(1, Number(input.publicVerifyAttempts) || 3);
  const verifyPollMs = Math.max(1, Number(input.publicVerifyPollMs) || 1000);
  let responseStatus = 0;
  for (let attempt = 1; attempt <= verifyAttempts; attempt += 1) {
    const response = await page.goto(publicUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    responseStatus = Number(response?.status?.() || 0);
    if (responseStatus !== 403) break;
    if (attempt < verifyAttempts) await sleep(verifyPollMs);
  }
  if (responseStatus === 403) throw new Error("ZHIHU_PUBLIC_VERIFY_FORBIDDEN");
  if (responseStatus >= 400) throw new Error(`ZHIHU_PUBLIC_VERIFY_HTTP_${responseStatus}`);
  await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
  if (expected.length) {
    await page.waitForFunction?.((payload) => {
      const images = [...document.querySelectorAll(payload.selector)];
      return images.filter((image) => (
        /^https:\/\//i.test(image.getAttribute("src") || "")
        && image.complete
        && image.naturalWidth > 0
      )).length >= payload.expectedCount;
    }, { selector: ZHIHU_PUBLIC_IMAGE_SELECTOR, expectedCount: expected.length }, { timeout: 30000 });
  }
  const publicEvidence = expected.length
    ? await verifyPublicImageEvidence({
        tasks: expected,
        readImages: () => readLocatorImages(page, ZHIHU_PUBLIC_IMAGE_SELECTOR),
        readBlocker: () => readPublicPageBlockerFromPage(page),
      })
    : { images: [], blocker: "" };
  const imagePublicationEvidence = expected.length
    ? buildImagePublicationEvidence(
        expected,
        existing.upload?.images || [],
        existing.draft?.images || [],
        publicEvidence.images,
        publicEvidence.blocker,
      )
    : undefined;
  const pageTitle = await page.title().catch(() => "");
  let headingTitle = "";
  try {
    headingTitle = await page.locator(".Post-Title, h1.Post-Title, article h1").first().innerText();
  } catch {
    headingTitle = "";
  }
  const bodyText = await page.locator(".Post-RichText").first().innerText().catch(() => "");
  const pageText = `${pageTitle}\n${bodyText}`.trim().slice(0, 12000);
  const articleTitle = normalizedMatchText(input.articleTitle || input.title);
  const titleFromDocument = pageTitle.replace(/\s*[-|_]\s*(?:知乎(?:专栏)?|Zhihu)\s*$/i, "").trim();
  const verifiedTitle = cleanText(headingTitle) || titleFromDocument;
  const found = Boolean(articleTitle && normalizedMatchText(verifiedTitle) === articleTitle);
  return {
    found,
    publicUrl,
    publishedUrl: publicUrl,
    pageText,
    pageTitle,
    verifiedTitle,
    ...(imagePublicationEvidence ? { imagePublicationEvidence } : {}),
  };
}

export class ZhihuAdapter {
  constructor(options = {}) {
    this.config = {
      platform: "zhihu",
      loginUrl: options.loginUrl || ZHIHU_LOGIN_URL,
      publishBaseUrl: ZHIHU_WRITE_URL,
      fields: [],
      accountLabel: "Zhihu account",
      origins: [ZHIHU_ORIGIN, ZHIHU_COLUMN_ORIGIN],
    };
    this.platform = "zhihu";
    this.loginUrl = options.loginUrl || ZHIHU_LOGIN_URL;
    this.fieldNames = ["标题", "正文", "话题"];
    this.accountLabel = "知乎账号";
    this.browser = options.browser;
  }

  profileDir(input = {}) {
    const root = input.profileRoot || path.join(process.cwd(), ".zhixin-ai", "profiles");
    const rawKey = input.profileKey
      || input.mediaAccountId
      || input.sessionId
      || input.accountName
      || "default";
    const profileKey = String(rawKey)
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "default";
    return path.join(root, "zhihu", profileKey);
  }

  async launchAuthEnvironment(input = {}) {
    const { ContentPlatformAdapter } = await import("./content-platform.mjs");
    return ContentPlatformAdapter.prototype.launchAuthEnvironment.call(this, input);
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
        cookies = await context.cookies([ZHIHU_ORIGIN]);
      } catch (error) {
        if (isBrowserClosedError(error)) throw error;
        cookies = [];
      }
      const pageState = await readZhihuPageState(page);
      if (isZhihuLoggedIn(cookies, pageState)) return cookies;
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
    const apiProfile = await readZhihuProfileFromApi(this.page);
    if (isUsefulAccountName(apiProfile?.accountName)) return apiProfile;
    const domProfile = await readZhihuProfileFromDom(this.page);
    if (isUsefulAccountName(domProfile?.accountName)) return domProfile;
    return {
      accountName: await pickZhihuAccountName(input, this.page),
      avatar: ""
    };
  }

  async collectAuthArtifact(input = {}) {
    const context = this.context || (await this.launchAuthEnvironment(input));
    const page = this.page || context.pages()[0] || await context.newPage();
    if (!page.url().startsWith(ZHIHU_ORIGIN)) {
      await page.goto(ZHIHU_ORIGIN, { waitUntil: "domcontentloaded" });
    }
    const cookies = this.cookies || await context.cookies([ZHIHU_ORIGIN]);
    const storage = await collectWebStorage(page);
    const pageState = await readZhihuPageState(page);
    const artifact = buildZhihuAuthArtifact({ cookies, ...storage }, {
      authorizationEvidence: {
        strongCookiePresent: hasZhihuStrongLoginCookie(cookies),
        workspaceReady: isZhihuWorkspaceReady(pageState),
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
    const cookies = await context.cookies([ZHIHU_ORIGIN, ZHIHU_WRITE_URL]);
    const pageState = await readZhihuPageState(page);
    if (!isZhihuLoggedIn(cookies, pageState)) throw new Error("ZHIHU_LOGIN_REQUIRED");
    const storage = await collectWebStorage(page);
    return buildZhihuAuthArtifact({ cookies, ...storage }, {
      authorizationEvidence: {
        strongCookiePresent: hasZhihuStrongLoginCookie(cookies),
        workspaceReady: isZhihuWorkspaceReady(pageState),
        currentUrl: pageState.url,
        pageTitle: pageState.title,
        checkedAt: new Date().toISOString()
      }
    });
  }

  async reportCredentialRefresh(input, context, page) {
    const artifact = await this.captureCredentialArtifactFromContext(context, page);
    if (typeof input?.onCredentialRefresh === "function") await input.onCredentialRefresh(artifact);
    return artifact;
  }

  async refreshCredentialAfterOperation(input, context, page, validationUrl = ZHIHU_LOGIN_URL) {
    const { ContentPlatformAdapter } = await import("./content-platform.mjs");
    return ContentPlatformAdapter.prototype.refreshCredentialAfterOperation.call(
      this,
      input,
      context,
      page,
      validationUrl,
    );
  }

  async validateSession(input = {}) {
    const context = await this.launchAuthEnvironment(input);
    const page = context.pages()[0] || await context.newPage();
    try {
      await page.goto(input.validationUrl || ZHIHU_LOGIN_URL, { waitUntil: "domcontentloaded" });
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
      if (!input.keepBrowserOpen) await context.close().catch(() => undefined);
    }
  }

  async discoverPublication(input = {}) {
    const context = await this.launchAuthEnvironment(input);
    const page = context.pages()[0] || await context.newPage();
    try {
      return await inspectZhihuPublicArticle(page, input);
    } finally {
      await this.refreshCredentialAfterOperation(input, context, page, ZHIHU_LOGIN_URL);
      if (!input.keepBrowserOpen) await context.close().catch(() => undefined);
    }
  }

  async ensurePublishSession(page, context, input = {}) {
    await page.goto(ZHIHU_WRITE_URL, { waitUntil: "domcontentloaded" });
    await bringToFrontIfAllowed(page, input);
    await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
    const cookies = await context.cookies([ZHIHU_ORIGIN, ZHIHU_COLUMN_ORIGIN, ZHIHU_WRITE_URL]);
    const pageState = await readZhihuPageState(page);
    const apiProfile = await readZhihuProfileFromApi(page);
    const strongCookie = hasZhihuStrongLoginCookie(cookies);
    // API-first only needs z_c0; workspace URL is best-effort after write page load.
    if (!strongCookie && !apiProfile) throw new Error("ZHIHU_LOGIN_REQUIRED");
    if (!strongCookie && !isZhihuWorkspaceReady(pageState) && !apiProfile) {
      throw new Error("ZHIHU_LOGIN_REQUIRED");
    }
    return { cookies, pageState, apiProfile };
  }

  async publishArticleViaApi(page, context, publishInput, input = {}) {
    await this.ensurePublishSession(page, context, input);
    await input.onProgress?.({ type: "publish_transport", transport: "api", platform: "zhihu" });

    // Create draft early so the browser leaves the blank /write skeleton and shows a real draft URL.
    await input.onProgress?.({ type: "creating_draft", transport: "api" });
    const draftId = await withZhihuTimeout(
      createZhihuDraftViaApi(page, publishInput.title),
      30000,
      "create_draft",
    );
    const draftUrl = zhihuDraftEditUrl(draftId);
    await page.goto(draftUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    await page.waitForLoadState?.("domcontentloaded", { timeout: 15000 }).catch(() => undefined);
    await input.onProgress?.({ type: "draft_opened", transport: "api", draftId, draftUrl });

    // Per-image hard timeout (avoid hanging forever on OSS PUT / image processing).
    const imageTimeoutMs = Math.max(45000, Number(publishInput.draftTimeoutMs) || 30000);
    const uploadedImages = publishInput.platformImageTasks.length
      ? await uploadZhihuImageTasksViaApi(page, publishInput.platformImageTasks, {
          onProgress: input.onProgress,
          timeoutMs: imageTimeoutMs,
        })
      : [];

    const html = buildZhihuPublishHtml(publishInput, uploadedImages);
    if (publishInput.platformImageTasks.length && countImagesInHtml(html) < publishInput.platformImageTasks.length) {
      throw new Error("ZHIHU_HTML_IMAGE_COUNT_MISMATCH");
    }

    await input.onProgress?.({ type: "updating_draft", transport: "api", draftId, imageCount: uploadedImages.length });
    await withZhihuTimeout(
      updateZhihuDraftViaApi(page, draftId, html),
      45000,
      "update_draft",
    );
    // Refresh draft editor so user can see title/body landed (API transport does not type into DOM live).
    await page.goto(draftUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);

    let draftImages = [];
    if (publishInput.platformImageTasks.length) {
      await input.onProgress?.({ type: "verifying_draft_images", total: publishInput.platformImageTasks.length, transport: "api" });
      const verified = await waitForZhihuApiDraftImages(
        page,
        draftId,
        publishInput.platformImageTasks.length,
        Math.min(Math.max(publishInput.draftTimeoutMs, 20000), 45000),
      );
      draftImages = mapDraftImagesToTasks(publishInput.platformImageTasks, verified.imageUrls, uploadedImages);
      if (draftImages.filter((image) => image.loaded && isPersistentPlatformImageUrl(image.platformImageUrl)).length
        < publishInput.platformImageTasks.length) {
        throw new Error("DRAFT_IMAGE_MISSING");
      }
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
        transport: "api",
        draftId,
        ...(draftImageEvidence ? { imagePublicationEvidence: draftImageEvidence } : {}),
      };
    }

    const published = await withZhihuTimeout(
      publishZhihuDraftViaApi(page, draftId, publishInput.title, html),
      Math.max(publishInput.publishTimeoutMs, 30000),
      "publish_api",
    );
    const publishedUrl = published.publishedUrl;
    await input.onProgress?.({
      type: "verifying_public_article",
      platform: "zhihu",
      publishedUrl,
      imageCount: publishInput.platformImageTasks.length,
      ...(published.publishResponseAmbiguous ? { publishResponseAmbiguous: true } : {}),
    });
    const publicInspection = await inspectZhihuPublicArticle(page, {
      publicUrl: publishedUrl,
      articleTitle: publishInput.title,
      imagePublicationEvidence: draftImageEvidence,
      publicVerifyAttempts: input.publicVerifyAttempts,
      publicVerifyPollMs: input.publicVerifyPollMs,
    });
    if (!publicInspection.found) throw new Error("ZHIHU_PUBLIC_ARTICLE_NOT_VERIFIED");
    const imagePublicationEvidence = publicInspection.imagePublicationEvidence;
    return {
      draftUrl,
      publishedUrl,
      platformStatus: "published",
      title: publishInput.title,
      transport: "api",
      draftId,
      publicVerified: true,
      ...(published.publishResponseAmbiguous ? { publishResponseAmbiguous: true } : {}),
      ...(imagePublicationEvidence ? { imagePublicationEvidence } : {}),
    };
  }

  async publishArticle(input = {}) {
    const publishInput = normalizePublishInput(input);
    const keepOpen = Boolean(input.keepBrowserOpen);
    const imageCount = Array.isArray(publishInput.platformImageTasks) ? publishInput.platformImageTasks.length : 0;
    // Overall hard ceiling: base 3min + ~50s per image, capped at 10min.
    const operationTimeoutMs = Math.min(
      600000,
      Math.max(180000, Number(input.operationTimeoutMs) || (180000 + imageCount * 50000)),
    );
    const context = await this.launchAuthEnvironment(input);
    const page = context.pages()[0] || await context.newPage();
    try {
      await input.onProgress?.({
        type: "publish_attempt",
        platform: "zhihu",
        attempt: 1,
        maxAttempts: 1,
        operationTimeoutMs,
        imageCount,
      });
      return await withZhihuTimeout(
        this.publishArticleViaApi(page, context, publishInput, input),
        operationTimeoutMs,
        "publish_article",
      );
    } finally {
      await this.refreshCredentialAfterOperation(input, context, page, ZHIHU_LOGIN_URL).catch(() => undefined);
      if (!keepOpen) await context.close().catch(() => undefined);
    }
  }
}
