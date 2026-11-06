import { ContentPlatformAdapter, contentPlatformConfigs, isConfiguredPlatformLoggedIn, readConfiguredPlatformPageState } from "./content-platform.mjs";
import { pasteImageFile, positionCursorAfterSection, readLocatorImages, readPublicPageBlockerFromPage, uploadPlatformImages, verifyPlatformImages, verifyPublicImageEvidence } from "../editor-image-upload.mjs";
import { buildImagePublicationEvidence, PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED, isPersistentPlatformImageUrl } from "../platform-images.mjs";
import { bringToFrontIfAllowed } from "../browser-visibility.mjs";
import { platformApiFetch, sanitizeApiEvidence } from "./platform-api.mjs";
import { importPlaywrightChromium } from "./browser-runtime.mjs";

const PENGUIN_ORIGIN = "https://om.qq.com";
const PENGUIN_EDITOR_URL = "https://om.qq.com/main/creation/article";
const PENGUIN_OM_SAVE_API_URL = "https://om.qq.com/marticlepublish/omSave";
const PENGUIN_OM_PUBLISH_API_URL = "https://om.qq.com/marticlepublish/omPublish";
const PENGUIN_ARTICLE_LIST_API_URL = "https://om.qq.com/marticle/article/list?category=&search=&source=&startDate=&endDate=&num=10&ftype=&readChannel=all&dstChannel=&isPartDst=0&isQBQA=false&refreshField=&relogin=1";
const PENGUIN_DELETE_API_URL = "https://om.qq.com/marticlepublish/deleteV2";
const PENGUIN_ACCOUNT_ID_API_URL = "https://om.qq.com/maccountsetting/account/getEcUserId?relogin=1";
const PENGUIN_EDITOR_URL_FALLBACKS = [
  "https://om.qq.com/main/creation/article",
  "https://om.qq.com/article/create",
];
export const PENGUIN_BODY_SELECTOR = ".ql-editor[contenteditable='true'], .ProseMirror.ExEditor-basic, .ProseMirror";
const PENGUIN_PUBLIC_IMAGE_SELECTOR = [
  "article img",
  ".article-content img",
  ".content img",
  "img[src*='inews.gtimg.com']",
  "img[src*='image.om.qq.com']",
  "img[src*='p.qpic.cn']",
  "img[src*='gtimg.com']",
].join(", ");

const PENGUIN_EDITOR_IMAGE_SELECTOR = [
  ".ProseMirror img.index_module_img__cffb2914",
  ".ProseMirror .index_module_imageBox__cffb2914 img",
  ".ProseMirror img[src*='inews.gtimg.com']",
  ".ProseMirror img[src*='gtimg.com']",
  ".ProseMirror img",
].join(", ");

function isPenguinCdnImageUrl(value = "") {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:"
      && /(^|\.)(gtimg\.com|qpic\.cn|qq\.com)$/i.test(url.hostname)
      && !/helper-icon|emoji|avatar|logo/i.test(url.pathname);
  } catch {
    return false;
  }
}

export async function openPenguinImagePicker(page) {
  // The current editor exposes the image tool as a custom toolbar element.
  // Legacy class selectors remain as fallbacks for older editor builds.
  const explicit = page.locator(
    "exeditor-toolbar-button[data-toolbar-item-of='imagePlugin'], "
      + "exeditor-toolbar-button[label*='\u56fe\u7247'], "
      + "button.exeditor-menu-basic-image, .exeditor-menu-basic-image, button[aria-label*='\u56fe\u7247'], button[title*='\u56fe\u7247']"
  ).first();
  if (await explicit.isVisible?.().catch(() => false)) {
    await explicit.click({ timeout: 3000 }).catch(() => undefined);
  } else {
    const video = page.locator("button.exeditor-menu-basic-video").first();
    const box = await video.boundingBox?.().catch(() => null);
    if (box) {
      await page.mouse.click(box.x - 36, box.y + box.height / 2);
    } else {
      await page.locator(".exeditor-toolbar button, .exeditor-toolbar [class*='menu-basic']").first().click().catch(() => undefined);
    }
  }

  const imageInput = page.locator(
    "input[type='file'][accept*='image/png'], input[type='file'][accept*='image/'], input[type='file'][accept*='image']"
  ).first();
  await imageInput.waitFor?.({ state: "attached", timeout: 8000 }).catch(() => undefined);
  const attached = await imageInput.count?.().catch(() => 0);
  if (!attached) throw new Error("PENGUIN_IMAGE_PICKER_NOT_OPEN");
  return imageInput;
}

async function penguinHasNewCdnImage(page, knownUrls, timeoutMs = 12000, pollMs = 400) {
  const deadline = Date.now() + Math.max(1, Number(timeoutMs || 12000));
  do {
    const images = await readPenguinEditorImages(page);
    const fresh = images.find((image) => (
      isPenguinCdnImageUrl(image.platformImageUrl)
      && image.loaded !== false
      && !knownUrls.has(image.platformImageUrl)
    ));
    if (fresh) return fresh;
    if (typeof page.waitForTimeout === "function") await page.waitForTimeout(pollMs);
    else await new Promise((resolve) => setTimeout(resolve, pollMs));
  } while (Date.now() < deadline);
  return null;
}
async function clickFirstVisibleEnabled(page, selectors, options = {}) {
  if (typeof page?.locator !== "function") return false;
  for (const selector of selectors) {
    const matches = page.locator(selector);
    const count = await matches.count?.().catch(() => 0);
    if (count <= 0) continue;
    const candidates = Array.from({ length: count }, (_, index) => matches.nth(index));
    for (const candidate of candidates) {
      const visible = await candidate?.isVisible?.().catch(() => false);
      const disabled = await candidate?.isDisabled?.().catch(() => false);
      if (!visible || disabled) continue;
      await candidate.scrollIntoViewIfNeeded?.().catch(() => undefined);
      let clicked = false;
      try {
        await candidate.click?.({ timeout: options.timeoutMs || 3000 });
        clicked = true;
      } catch {
        throw new Error("PENGUIN_BUTTON_CLICK_UNCERTAIN");
      }
      if (clicked) return true;
    }
  }
  return false;
}

export async function confirmPenguinImageSelection(page, options = {}) {
  const selectors = [
    ".omui-dialog-wrapper button:has-text('\u786e\u8ba4')",
    ".omui-dialog-wrapper button:has-text('\u786e\u5b9a')",
    ".omui-dialog-wrapper button:has-text('\u63d2\u5165')",
    ".omui-dialog-wrapper button:has-text('\u5b8c\u6210')",
    "[role='dialog'] button:has-text('\u786e\u8ba4')",
    "[role='dialog'] button:has-text('\u786e\u5b9a')",
    "[role='dialog'] button:has-text('\u63d2\u5165')",
    "[role='dialog'] button:has-text('\u5b8c\u6210')",
    ".omui-modal button:has-text('\u786e\u8ba4')",
    ".omui-modal button:has-text('\u786e\u5b9a')",
    ".ant-modal button:has-text('\u786e\u8ba4')",
    ".ant-modal button:has-text('\u786e\u5b9a')",
    "button:has-text('\u786e\u8ba4')",
    "button:has-text('\u786e\u5b9a')",
    "button:has-text('\u63d2\u5165')",
    "button:has-text('\u5b8c\u6210')",
  ];
  const timeoutMs = Math.max(0, Number(options.timeoutMs ?? 15000));
  const pollMs = Math.max(1, Number(options.pollMs || 250));
  const deadline = Date.now() + timeoutMs;
  do {
    const surfaces = [page, ...(typeof page?.frames === "function" ? page.frames() : [])]
      .filter((surface, index, all) => surface?.locator && all.indexOf(surface) === index);
    for (const surface of surfaces) {
      const confirmed = await clickFirstVisibleEnabled(surface, selectors, {
        timeoutMs: Math.min(3000, Math.max(500, timeoutMs || 3000)),
      });
      if (confirmed) {
        await page.waitForTimeout?.(350).catch(() => undefined);
        return true;
      }
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout?.(pollMs).catch(() => undefined);
  } while (Date.now() <= deadline);
  return false;
}


async function dismissPenguinImageModal(page) {
  await page.keyboard?.press?.("Escape").catch(() => undefined);
  const close = page.locator(
    ".omui-dialog-wrapper.open button:has-text('取消'), .omui-dialog-wrapper.open [aria-label='Close'], .omui-dialog-wrapper.open .omui-dialog-close, .omui-modal button:has-text('取消'), .ant-modal button:has-text('取消'), .ant-modal-close"
  ).first();
  if (await close.isVisible?.().catch(() => false)) await close.click({ force: true }).catch(() => undefined);
  await page.waitForTimeout?.(300).catch(() => undefined);
}

export async function uploadPenguinInlineImages(page, tasks = [], options = {}) {
  if (!tasks.length) return [];
  const editor = page.locator(".ProseMirror.ExEditor-basic, .ProseMirror").first();
  return uploadPlatformImages({
    tasks,
    readImages: () => readPenguinEditorImages(page),
    positionForTask: async (task) => {
      await editor.click?.().catch(() => undefined);
      await positionCursorAfterSection(editor, task);
    },
    selectFile: async (task) => {
      const before = await readPenguinEditorImages(page);
      const knownUrls = new Set(before.map((image) => String(image.platformImageUrl || "")));
      let inserted = false;

      // 1) Native image toolbar -> file input -> optional insert confirmation.
      try {
        const imageInput = await openPenguinImagePicker(page);
        await imageInput.setInputFiles(task.path);
        // The current editor can insert immediately after upload. Confirming again duplicates it.
        inserted = Boolean(await penguinHasNewCdnImage(page, knownUrls, 4000));
        if (!inserted) {
          const mediaTile = page.locator(
            ".omui-upload-image-item img[src*='gtimg'], .omui-modal img[src*='gtimg'], "
              + ".ant-modal img[src*='gtimg'], [class*='image'] img[src*='inews.gtimg.com']"
          ).first();
          if (await mediaTile.isVisible?.().catch(() => false)) {
            await mediaTile.click().catch(() => undefined);
          }
          const confirmed = await confirmPenguinImageSelection(page);
          if (!confirmed) throw new Error("PENGUIN_IMAGE_CONFIRM_NOT_AVAILABLE");
          inserted = Boolean(await penguinHasNewCdnImage(page, knownUrls, 15000));
        }
        if (inserted) await dismissPenguinImageModal(page);
      } catch {
        inserted = false;
      }

      // 2) ProseMirror paste/drop fallback. Probe confirmed this path hits ArchacaleUploadViaFile
      // and rewrites to https://inews.gtimg.com/...
      if (!inserted) {
        await dismissPenguinImageModal(page);
        await editor.click?.().catch(() => undefined);
        await positionCursorAfterSection(editor, task);
        await pasteImageFile(editor, task.path);
        inserted = Boolean(await penguinHasNewCdnImage(page, knownUrls, 30000));
      }

      if (!inserted) throw new Error("PLATFORM_IMAGE_UPLOAD_TIMEOUT");
    },
    onProgress: options.onProgress,
    timeoutMs: options.timeoutMs || 120000,
    pollMs: 400,
  });
}

export async function readPenguinEditorImages(page) {
  const images = await readLocatorImages(page, PENGUIN_EDITOR_IMAGE_SELECTOR);
  return images
    .map((image) => ({
      ...image,
      platformImageUrl: String(image.platformImageUrl || "").replace(/^http:/, "https:"),
    }))
    .filter((image) => isPenguinCdnImageUrl(image.platformImageUrl) || isPersistentPlatformImageUrl(image.platformImageUrl));
}

export function penguinDraftUrlFromArticleId(articleId) {
  const value = String(articleId || "").trim();
  return value ? `${PENGUIN_EDITOR_URL}?articleId=${encodeURIComponent(value)}` : PENGUIN_EDITOR_URL;
}

export function isPenguinDraftEditorUrl(url = "") {
  try {
    const parsed = new URL(String(url || ""), PENGUIN_ORIGIN);
    return /om\.qq\.com$/i.test(parsed.hostname)
      && (/\/main\/creation\/article/i.test(parsed.pathname) || /\/article\/(create|edit)/i.test(parsed.pathname));
  } catch {
    return false;
  }
}

export function penguinDraftUrlHasArticleId(url = "") {
  return /[?&](id|articleId|article_id)=[^&#]+/i.test(String(url || ""))
    || /\/article\/(edit|create)\/[^/?#]+/i.test(String(url || ""));
}

export async function waitForPenguinDraftUrl(state, page, timeoutMs = 30000, pollMs = 250) {
  const deadline = Date.now() + Math.max(1, Number(timeoutMs || 30000));
  do {
    if (state?.draftUrl) return state.draftUrl;
    const currentUrl = typeof page?.url === "function" ? String(page.url() || "") : "";
    if (penguinDraftUrlHasArticleId(currentUrl)) return currentUrl;
    if (typeof page?.waitForTimeout === "function") await page.waitForTimeout(pollMs);
    else await new Promise((resolve) => setTimeout(resolve, pollMs));
  } while (Date.now() < deadline);
  // Saving can succeed without rewriting the URL. Keep the live editor URL so callers can
  // verify draft images in-place instead of navigating to a blank create page.
  const fallback = typeof page?.url === "function" ? String(page.url() || "") : "";
  if (isPenguinDraftEditorUrl(fallback)) return fallback;
  throw new Error("PENGUIN_DRAFT_URL_NOT_FOUND");
}

export async function waitForPenguinEditorImages(page, expectedCount, timeoutMs = 30000, pollMs = 250) {
  const expected = Math.max(0, Number(expectedCount || 0));
  const deadline = Date.now() + Math.max(1, Number(timeoutMs || 30000));
  let images = [];
  do {
    images = await readPenguinEditorImages(page);
    const persistent = images.filter((image) => (
      isPenguinCdnImageUrl(image.platformImageUrl)
      && image.loaded !== false
    ));
    if (persistent.length >= expected) return persistent.slice(0, Math.max(expected, persistent.length));
    if (typeof page?.waitForTimeout === "function") await page.waitForTimeout(pollMs);
    else await new Promise((resolve) => setTimeout(resolve, pollMs));
  } while (Date.now() < deadline);
  throw new Error("DRAFT_IMAGE_MISSING");
}

export function penguinDraftImagesFromUploadedFallback(tasks = [], uploadedImages = []) {
  const expected = Array.isArray(tasks) ? tasks : [];
  const uploaded = Array.isArray(uploadedImages) ? uploadedImages : [];
  if (!expected.length || uploaded.length < expected.length) return [];
  const usable = uploaded.filter((image) => (
    image
    && isPenguinCdnImageUrl(image.platformImageUrl)
    && image.loaded !== false
  ));
  return usable.length >= expected.length ? usable.slice(0, Math.max(expected.length, usable.length)) : [];
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function hasValue(cookie = {}) {
  return typeof cookie.value === "string" && cookie.value.trim().length > 0;
}

export function isPenguinCookie(cookie = {}) {
  const domain = String(cookie.domain || "").replace(/^\./, "");
  return domain === "qq.com" || domain.endsWith(".qq.com");
}

export function normalizePenguinCookie(cookie = {}) {
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

function hasPenguinStrongCookie(cookies = []) {
  const strongNames = new Set(["omaccesstoken", "omtoken", "userid", "p_skey", "skey", "uin", "p_uin", "pt_key", "rk"]);
  return cookies.some((cookie) => isPenguinCookie(cookie) && strongNames.has(String(cookie.name || "").toLowerCase()) && hasValue(cookie));
}

export async function createPenguinCookieInjectedContext(options = {}) {
  const rawCookies = Array.isArray(options.cookies) ? options.cookies : [];
  const cookies = rawCookies.filter(isPenguinCookie).map(normalizePenguinCookie);
  const browserFactory = options.browser || await importPlaywrightChromium();
  const browser = await browserFactory.launch({
    headless: Boolean(options.headless),
    args: ["--disable-blink-features=AutomationControlled"]
  });
  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: options.viewport || { width: 1360, height: 900 }
  });
  if (cookies.length) await context.addCookies(cookies);
  await addPenguinStorageInit(context, {
    localStorage: options.localStorage,
    sessionStorage: options.sessionStorage
  });
  return { browser, context, cookies };
}

async function addPenguinStorageInit(context, storage = {}) {
  const localStorage = storage.localStorage && typeof storage.localStorage === "object" ? storage.localStorage : {};
  const sessionStorage = storage.sessionStorage && typeof storage.sessionStorage === "object" ? storage.sessionStorage : {};
  if (!Object.keys(localStorage).length && !Object.keys(sessionStorage).length) return;
  await context.addInitScript?.(({ localStorageValues, sessionStorageValues, origin }) => {
    if (window.location.origin !== origin) return;
    try {
      for (const [key, value] of Object.entries(localStorageValues || {})) {
        window.localStorage.setItem(key, String(value));
      }
      for (const [key, value] of Object.entries(sessionStorageValues || {})) {
        window.sessionStorage.setItem(key, String(value));
      }
    } catch {
      // Storage can be unavailable in restricted browser contexts; cookies still remain the primary auth signal.
    }
  }, {
    origin: PENGUIN_ORIGIN,
    localStorageValues: localStorage,
    sessionStorageValues: sessionStorage
  }).catch(() => undefined);
}

function normalizePublishInput(input = {}) {
  let title = cleanText(input.articleTitle || input.title);
  const content = cleanText(input.contentMarkdown || input.content || input.body || input.markdown);
  if (!title) throw new Error("PENGUIN_TITLE_REQUIRED");
  // Live editor requires 5-64 characters.
  if (title.length > 64) title = title.slice(0, 64);
  if (title.length < 5) throw new Error("PENGUIN_TITLE_TOO_SHORT");
  if (!content || content.length < 20) throw new Error("PENGUIN_CONTENT_REQUIRED");
  return {
    title,
    content,
    richHtml: String((input.platformImageTasks?.length ? input.contentHtmlWithoutImages : input.contentHtml) || "").trim(),
    platformImageTasks: Array.isArray(input.platformImageTasks) ? input.platformImageTasks : [],
    category: cleanText(input.category || input.categoryName || "\u79d1\u6280"),
    coverMode: cleanText(input.coverMode || input.imageStrategy || "auto"),
    articleType: cleanText(input.articleType || input.creationStatement || "none"),
    confirmPublish: input.confirmPublish === true || input.publishMode === "publish",
    draftTimeoutMs: Number(input.draftTimeoutMs || 30000),
    publishTimeoutMs: Number(input.publishTimeoutMs || 60000)
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

function findNestedValue(value, keys = []) {
  if (!value || typeof value !== "object") return "";
  for (const key of keys) {
    const direct = value[key];
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    if (typeof direct === "number") return String(direct);
  }
  for (const item of Object.values(value)) {
    if (item && typeof item === "object") {
      const nested = findNestedValue(item, keys);
      if (nested) return nested;
    }
  }
  return "";
}

export function penguinApiPayloadSucceeded(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;

  const code = findNestedValue(payload, ["code", "ret", "errCode", "errno"]);
  if (code) {
    return ["0", "200", "ok", "suc", "success"].includes(String(code).toLowerCase());
  }

  const explicitSuccess = (value) => {
    if (!value || typeof value !== "object") return false;
    for (const [key, item] of Object.entries(value)) {
      if (["success", "succeeded", "ok"].includes(key) && item === true) return true;
      if (["status", "state", "result"].includes(key) && ["ok", "suc", "success", "succeeded"].includes(String(item).toLowerCase())) {
        return true;
      }
      if (item && typeof item === "object" && explicitSuccess(item)) return true;
    }
    return false;
  };
  if (explicitSuccess(payload)) return true;

  return Boolean(
    findNestedValue(payload, ["articleId", "article_id", "contentId", "cid"])
    || penguinPublishedUrlFromPayload(payload)
  );
}

export function normalizePenguinPublishedUrl(url = "") {
  try {
    const parsed = new URL(String(url || ""), PENGUIN_ORIGIN);
    const hostname = parsed.hostname.toLowerCase();
    if (!/(^|\.)qq\.com$/i.test(hostname)) return "";
    const pathAndSearch = `${parsed.pathname}${parsed.search}`;
    // Creator-console review links use a backend article id. They are navigation
    // candidates only and must never be persisted as the public backlink.
    if (hostname === "om.qq.com" && /^\/s\/article\/[^/?#]+/i.test(parsed.pathname)) return "";
    if (/\/main\/creation\//i.test(pathAndSearch) || /\/article\/create/i.test(pathAndSearch) || /\/management\//i.test(pathAndSearch)) {
      return "";
    }
    if (hostname === "page.om.qq.com" && /^\/page\/[^/?#]+\/?$/i.test(parsed.pathname)) {
      return parsed.toString().replace(/^http:/, "https:");
    }
    if (/\/(a\/|content\/|detail\/)/i.test(pathAndSearch) || /\/page\/.*article/i.test(pathAndSearch)) {
      return parsed.toString().replace(/^http:/, "https:");
    }
    // Public news/content host patterns used by Tencent distribution.
    if (/(^|\.)(news\.qq\.com|new\.qq\.com|view\.inews\.qq\.com)$/i.test(hostname)) {
      return parsed.toString().replace(/^http:/, "https:");
    }
  } catch {
    return "";
  }
  return "";
}

export function findPenguinPublicUrlInValue(value, depth = 0, seen = new Set()) {
  if (depth > 8 || value == null) return "";
  if (typeof value === "string") {
    const candidates = [value, value.replace(/\\\//g, "/")];
    try {
      candidates.push(decodeURIComponent(value));
    } catch {
      // The source string is not URI encoded.
    }
    for (const candidate of candidates) {
      const direct = normalizePenguinPublishedUrl(candidate);
      if (direct) return direct;
      const match = candidate.match(/https?:\/\/page\.om\.qq\.com\/page\/[A-Za-z0-9_-]+/i);
      if (match) return normalizePenguinPublishedUrl(match[0]);
    }
    return "";
  }
  if (typeof value !== "object" || seen.has(value)) return "";
  seen.add(value);
  const items = Array.isArray(value) ? value : Object.values(value);
  for (const item of items) {
    const found = findPenguinPublicUrlInValue(item, depth + 1, seen);
    if (found) return found;
  }
  return "";
}

function normalizePenguinReviewCandidateUrl(url = "") {
  const publicUrl = normalizePenguinPublishedUrl(url);
  if (publicUrl) return publicUrl;
  try {
    const parsed = new URL(String(url || ""), PENGUIN_ORIGIN);
    if (parsed.hostname.toLowerCase() !== "om.qq.com") return "";
    if (!/^\/s\/article\/[^/?#]+/i.test(parsed.pathname)) return "";
    return parsed.toString().replace(/^http:/, "https:");
  } catch {
    return "";
  }
}

function penguinPublishedUrlFromPayload(payload) {
  if (!payload || typeof payload !== "object") return "";
  const direct = findNestedValue(payload, ["url", "href", "link", "articleUrl", "shareUrl", "publishUrl", "targetUrl"]);
  return normalizePenguinPublishedUrl(direct);
}

function collectPenguinErrorMessages(value, depth = 0) {
  if (depth > 5 || value == null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectPenguinErrorMessages(item, depth + 1));
  if (typeof value !== "object") return [];
  const messageKeys = /^(message|msg|error|errorMessage|error_message|reason|detail|description|tips?)$/i;
  const messages = [];
  for (const [key, nested] of Object.entries(value)) {
    if (messageKeys.test(key)) {
      messages.push(...collectPenguinErrorMessages(nested, depth + 1));
      continue;
    }
    if (nested && typeof nested === "object") {
      messages.push(...collectPenguinErrorMessages(nested, depth + 1));
    }
  }
  return messages;
}

export function publishApiHasManualBlocker(payload) {
  if (!payload || typeof payload !== "object") return false;
  const text = collectPenguinErrorMessages(payload).join(" ");
  return /captcha|security verification|verify (?:your|the) (?:account|identity)|risk control|manual action required|forbidden|sensitive content|publish quota|\u9a8c\u8bc1\u7801|\u5b89\u5168\u9a8c\u8bc1|\u98ce\u63a7|\u4eba\u5de5\u9a8c\u8bc1|\u654f\u611f\u8bcd|\u53d1\u5e03\u4e0a\u9650|\u9891\u7e41/i.test(text);
}

function penguinApiEndpoint(url = "") {
  try {
    return new URL(String(url || ""), PENGUIN_ORIGIN).pathname || "/";
  } catch {
    return "/unknown";
  }
}

function penguinApiNotAcceptedError(result, options = {}) {
  const stage = cleanText(options.stage || "unknown").replace(/[^a-z0-9-]/gi, "").slice(0, 40) || "unknown";
  const endpoint = penguinApiEndpoint(options.url || result?.url || result?.evidence?.response?.url || "");
  const apiCode = findNestedValue(result?.payload, ["code", "ret", "errCode", "errno"]) || "missing";
  const errorName = apiCode === "-5002"
    ? "PENGUIN_DAILY_PUBLISH_QUOTA_EXHAUSTED"
    : "PENGUIN_API_PUBLISH_NOT_ACCEPTED";
  const error = new Error(`${errorName}:stage=${stage}:endpoint=${endpoint}:http=${result?.status || 0}:code=${apiCode}`);
  error.httpStatus = result?.status || 0;
  error.responseUrl = result?.url || result?.evidence?.response?.url || "";
  error.apiStage = stage;
  error.apiEndpoint = endpoint;
  error.apiCode = apiCode;
  error.apiResponse = sanitizeApiEvidence(result?.payload);
  return error;
}


function penguinArticleIdFromPayload(payload) {
  return findNestedValue(payload, ["articleId", "article_id", "contentId", "cid", "id"]);
}

function penguinHtmlFromText(text = "") {
  return String(text || "")
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

function firstPenguinImageUrlFromHtml(html = "") {
  const pattern = /<img\b[^>]*\bsrc=(["'])(.*?)\1/gi;
  for (const match of String(html || "").matchAll(pattern)) {
    const url = String(match[2] || "").replace(/^http:/i, "https:");
    if (isPenguinCdnImageUrl(url) || isPersistentPlatformImageUrl(url)) return url;
  }
  return "";
}

function penguinCoverExtFromUrl(imageUrl = "") {
  const src = String(imageUrl || "").replace(/^http:/i, "https:").trim();
  if (!src) return [];
  const base = src
    .replace(/\/(?:641|0)(?:[?#].*)?$/i, "")
    .replace(/\/$/g, "");
  return [{
    "1": `${base}/0`,
    "150120": `${base}_150120/0`,
    "196130": `${base}_196130/0`,
    "240180": `${base}_240180/0`,
    "294195": `${base}_294195/0`,
    "580300": `${base}_580300/0`,
    src,
  }];
}

function penguinPersistentImageUrls(images = []) {
  return [...new Set((Array.isArray(images) ? images : [])
    .map((image) => cleanText(image?.platformImageUrl || image?.url || image?.src || "").replace(/^http:/i, "https:"))
    .filter((url) => isPenguinCdnImageUrl(url) || isPersistentPlatformImageUrl(url)))];
}

function penguinImageUrlsFromHtml(html = "") {
  const urls = [];
  const pattern = /<img\b[^>]*\bsrc=(["'])(.*?)\1/gi;
  for (const match of String(html || "").matchAll(pattern)) {
    const url = String(match[2] || "").replace(/^http:/i, "https:").trim();
    if (isPenguinCdnImageUrl(url) || isPersistentPlatformImageUrl(url)) urls.push(url);
  }
  return urls;
}

export function buildPenguinArticlePayload(input = {}) {
  const imageUrls = penguinPersistentImageUrls([
    ...(Array.isArray(input.uploadedImages) ? input.uploadedImages : []),
    ...penguinImageUrlsFromHtml(input.richHtml).map((url) => ({ url })),
  ]);
  const cover = penguinCoverExtFromUrl(input.coverUrl || imageUrls[0] || "");
  const resourceAigcMarkInfo = Object.fromEntries(imageUrls.map((url) => [url, {
    id: url,
    resource_type: "image",
    can_modify: 1,
    aigc_user_statement: 2,
  }]));
  const selfDeclare = input.selfDeclare === false
    ? ""
    : (typeof input.selfDeclare === "string" && input.selfDeclare.trim()
        ? input.selfDeclare.trim()
        : JSON.stringify(input.selfDeclare && typeof input.selfDeclare === "object"
          ? input.selfDeclare
          : { id: 7, desc: "作者声明：该文章由AI辅助创作" }));
  const mediaId = /^\d+$/.test(String(input.mediaId || "")) ? Number(input.mediaId) : cleanText(input.mediaId || "");
  const payload = {
    title: cleanText(input.title),
    title2: "",
    tag: "",
    video: "",
    cover_type: cover.length ? "1" : "3",
    imgurl_ext: JSON.stringify(cover),
    category_id: cleanText(input.categoryId || ""),
    content: String(input.richHtml || input.content || "").trim(),
    orignal: 0,
    user_original: 0,
    music: "",
    activity: "",
    apply_olympic_flag: 0,
    apply_push_flag: 0,
    apply_reward_flag: 0,
    reward_flag: 0,
    survey_id: "",
    survey_name: "",
    imgurlsrc: cover.length ? "custom" : "system",
    om_activity_id: "",
    om_activity_name: "",
    activityInfo: "",
    commercialization_source: "",
    caimaiInfo: "",
    isHowto: "0",
    howtoInfo: "",
    daihuoInfo: "",
    novel: "",
    needpub: 1,
    event_id: "",
    event_name: "",
    activity_scene_id: 0,
    hotBreak: "",
    self_declare: selfDeclare,
    resource_aigc_mark_info: JSON.stringify(resourceAigcMarkInfo),
    parent_article_id: "",
    failedImage: [],
    adContentImgs: imageUrls.map((url) => ({ url })),
    mediaId,
    type: 0,
    relogin: 1,
  };
  if (cleanText(input.articleId || "")) payload.articleId = cleanText(input.articleId);
  return payload;
}

async function callPenguinJsonApi(page, url, payload, referer = PENGUIN_EDITOR_URL, csrfToken = "", stage = "publish") {
  const result = await platformApiFetch(page, url, {
    method: "POST",
    json: payload,
    headers: {
      Referer: referer,
      ...(cleanText(csrfToken) ? { "x-csrf-token": cleanText(csrfToken) } : {}),
    },
  });
  if ([401, 403].includes(result.status)) throw new Error("PENGUIN_LOGIN_REQUIRED");
  if (publishApiHasManualBlocker(result.payload)) throw new Error("PENGUIN_MANUAL_ACTION_REQUIRED");
  if (!result.ok || !penguinApiPayloadSucceeded(result.payload)) throw penguinApiNotAcceptedError(result, { stage, url });
  return result;
}

export async function publishPenguinViaCapturedApi(page, _context, input = {}) {
  const payload = buildPenguinArticlePayload(input);
  const saveApiUrl = input.saveApiUrl || PENGUIN_OM_SAVE_API_URL;
  const publishApiUrl = input.publishApiUrl || PENGUIN_OM_PUBLISH_API_URL;
  const create = await callPenguinJsonApi(page, saveApiUrl, payload, PENGUIN_EDITOR_URL, input.csrfToken, "draft-create");
  const articleId = penguinArticleIdFromPayload(create.payload);
  if (!articleId) throw penguinApiNotAcceptedError(create, { stage: "draft-create", url: saveApiUrl });

  const articlePayload = { ...payload, articleId };
  const update = await callPenguinJsonApi(page, saveApiUrl, articlePayload, PENGUIN_EDITOR_URL, input.csrfToken, "draft-update");
  const publish = await callPenguinJsonApi(page, publishApiUrl, articlePayload, PENGUIN_EDITOR_URL, input.csrfToken, "publish");
  for (const result of [update, publish]) {
    const responseArticleId = penguinArticleIdFromPayload(result.payload);
    if (responseArticleId && responseArticleId !== articleId) throw new Error("PENGUIN_ARTICLE_ID_MISMATCH");
  }

  return {
    draftUrl: penguinDraftUrlFromArticleId(articleId),
    publishedUrl: "",
    reviewUrl: `${PENGUIN_ORIGIN}/s/article/${encodeURIComponent(articleId)}`,
    platformStatus: "submitted_for_review",
    publiclyVisible: false,
    reviewStatus: "pending_public_visibility",
    title: payload.title,
    externalIds: { articleId },
    publicationEvidence: sanitizeApiEvidence({
      source: "api",
      accepted: true,
      articleId,
      endpoint: publish.evidence?.request?.url || publishApiUrl,
      response: publish.payload,
      calls: [create, update, publish].map((result) => ({
        request: {
          method: result.evidence?.request?.method || "POST",
          url: result.evidence?.request?.url || "",
        },
        response: result.evidence?.response || {},
      })),
    }),
  };
}

function penguinArticleRecords(payload) {
  const candidates = [payload?.data?.articles, payload?.articles, payload?.data?.list, payload?.list];
  return candidates.find(Array.isArray) || [];
}

function penguinRecordArticleId(record = {}) {
  return cleanText(record.article_id || record.articleId || record.id || "");
}

function penguinRecordRejected(record = {}) {
  const reason = cleanText(record.reject_reason || record.reject_reason_msg || record.standard_reject_reason || "");
  return Boolean(reason) || ["4", "5", "6", "8", "9", "-1"].includes(String(record.status || ""));
}

export async function pollPenguinArticleStatus(page, articleId, options = {}) {
  const wantedId = cleanText(articleId);
  if (!wantedId) throw new Error("PENGUIN_ARTICLE_ID_REQUIRED");
  const timeoutMs = Math.max(0, Number(options.timeoutMs ?? 15000));
  const pollIntervalMs = Math.max(0, Number(options.pollIntervalMs ?? 2500));
  const deadline = Date.now() + timeoutMs;
  const statuses = [];
  let lastRecord = null;

  do {
    const result = await platformApiFetch(page, options.listApiUrl || PENGUIN_ARTICLE_LIST_API_URL, {
      method: "GET",
      headers: { Referer: options.referer || PENGUIN_MANAGE_URL },
    });
    if ([401, 403].includes(result.status)) throw new Error("PENGUIN_LOGIN_REQUIRED");
    if (!result.ok || !penguinApiPayloadSucceeded(result.payload)) {
      throw penguinApiNotAcceptedError(result, { stage: "article-status", url: options.listApiUrl || PENGUIN_ARTICLE_LIST_API_URL });
    }
    const record = penguinArticleRecords(result.payload).find((item) => penguinRecordArticleId(item) === wantedId) || null;
    if (record) {
      lastRecord = record;
      const status = String(record.status ?? "");
      statuses.push(status);
      if (penguinRecordRejected(record)) {
        return { status, rejected: true, record: sanitizeApiEvidence(record), previousStatuses: statuses.slice(0, -1), publicCandidateUrl: "" };
      }
      if (status === "1") {
        return {
          status,
          rejected: false,
          record: sanitizeApiEvidence(record),
          previousStatuses: statuses.slice(0, -1),
          publicCandidateUrl: normalizePenguinPublishedUrl(record.url || record.shareUrl || ""),
        };
      }
    }
    if (Date.now() >= deadline) break;
    if (typeof page?.waitForTimeout === "function") await page.waitForTimeout(pollIntervalMs);
    else if (pollIntervalMs > 0) await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  } while (Date.now() <= deadline);

  return {
    status: String(lastRecord?.status ?? ""),
    rejected: false,
    pending: true,
    record: sanitizeApiEvidence(lastRecord),
    previousStatuses: statuses,
    publicCandidateUrl: "",
  };
}

export async function deletePenguinArticle(page, articleId, options = {}) {
  const wantedId = cleanText(articleId);
  if (!wantedId) throw new Error("PENGUIN_ARTICLE_ID_REQUIRED");
  const deleteApiUrl = options.deleteApiUrl || PENGUIN_DELETE_API_URL;
  const result = await callPenguinJsonApi(page, deleteApiUrl, {
    articleId: wantedId,
    operation: "user_self_deleted",
    reason: options.reason || "全平台分发文章删除",
    source: 0,
    subSource: 0,
    relogin: 1,
  }, options.referer || PENGUIN_MANAGE_URL, "", "delete");
  if (result.payload?.data?.result !== true) throw penguinApiNotAcceptedError(result, { stage: "delete", url: deleteApiUrl });
  return { deleted: true, articleId: wantedId, publicationEvidence: result.evidence };
}

export async function resolvePenguinMediaId(page, options = {}) {
  const direct = cleanText(options.mediaId || "");
  if (direct) return direct;
  const result = await platformApiFetch(page, options.accountApiUrl || PENGUIN_ACCOUNT_ID_API_URL, {
    method: "GET",
    headers: {
      Referer: options.referer || PENGUIN_EDITOR_URL,
      ...(cleanText(options.csrfToken) ? { "x-csrf-token": cleanText(options.csrfToken) } : {}),
    },
  });
  if ([401, 403].includes(result.status)) throw new Error("PENGUIN_LOGIN_REQUIRED");
  if (!result.ok || !penguinApiPayloadSucceeded(result.payload)) {
    throw penguinApiNotAcceptedError(result, { stage: "media-id", url: options.accountApiUrl || PENGUIN_ACCOUNT_ID_API_URL });
  }
  const mediaId = findNestedValue(result.payload?.data || result.payload, ["userId", "mediaId", "media_id"]);
  if (!mediaId) throw new Error("PENGUIN_MEDIA_ID_NOT_FOUND");
  return mediaId;
}

async function readPenguinPreparedEditorHtml(page) {
  if (typeof page?.evaluate !== "function") return "";
  const html = await page.evaluate((payload) => {
    const candidates = String(payload.selector || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    for (const selector of candidates) {
      const element = document.querySelector(selector);
      if (element && element.innerHTML) return element.innerHTML;
    }
    return "";
  }, { mode: "read-penguin-editor-html", selector: PENGUIN_BODY_SELECTOR }).catch(() => "");
  return typeof html === "string" ? html.trim() : "";
}

async function readPenguinCsrfToken(page) {
  if (typeof page?.evaluate !== "function") return "";
  const value = await page.evaluate(() => {
    const meta = document.querySelector('meta[name="csrf-token"], meta[name="x-csrf-token"]')?.getAttribute("content") || "";
    if (meta) return meta;
    for (const key of ["csrfToken", "csrf_token", "x-csrf-token"]) {
      const local = window.localStorage?.getItem?.(key) || window.sessionStorage?.getItem?.(key) || "";
      if (local) return local;
    }
    return "";
  }, { mode: "read-penguin-csrf-token" }).catch(() => "");
  return typeof value === "string" ? value.trim() : "";
}

const PENGUIN_SAFE_PUBLISH_REQUEST_FIELDS = [
  "type",
  "category_id",
  "cover_type",
  "orignal",
  "user_original",
  "apply_push_flag",
  "apply_reward_flag",
  "imgurlsrc",
];
const PENGUIN_SAFE_PUBLISH_REQUEST_FIELD_SET = new Set(PENGUIN_SAFE_PUBLISH_REQUEST_FIELDS);
const PENGUIN_SENSITIVE_REQUEST_FIELD = /cookie|token|secret|authorization|credential|csrf/i;

function penguinSafeRequestValue(value) {
  if (["string", "number", "boolean"].includes(typeof value)) return String(value).slice(0, 80);
  return "";
}

function collectPenguinSafeRequestFields(value, result, path = [], depth = 0) {
  if (depth > 5 || value == null) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectPenguinSafeRequestFields(item, result, [...path, String(index)], depth + 1));
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (PENGUIN_SENSITIVE_REQUEST_FIELD.test(key)) continue;
    const nextPath = [...path, key];
    if (PENGUIN_SAFE_PUBLISH_REQUEST_FIELD_SET.has(key)) {
      const safeValue = penguinSafeRequestValue(nested);
      if (safeValue) {
        if (!(key in result.fields)) result.fields[key] = safeValue;
        result.safeFieldPaths[nextPath.join(".")] = safeValue;
      }
    }
    if (nested && typeof nested === "object") {
      collectPenguinSafeRequestFields(nested, result, nextPath, depth + 1);
      continue;
    }
    if (typeof nested === "string" && /^[\s]*[\[{]/.test(nested)) {
      try {
        collectPenguinSafeRequestFields(JSON.parse(nested), result, nextPath, depth + 1);
      } catch {
        // Non-JSON strings are intentionally ignored; their values may contain article content.
      }
    }
  }
}

function buildPenguinSafePublicationRequest(request = {}, structuredBody = {}) {
  const collected = { fields: {}, safeFieldPaths: {} };
  collectPenguinSafeRequestFields(structuredBody, collected);
  return {
    method: String(request.method || "POST").toUpperCase(),
    url: String(request.url || PENGUIN_OM_PUBLISH_API_URL),
    formFields: collected.fields,
  };
}

function readPenguinPublishRequestFields(request) {
  const url = typeof request?.url === "function" ? request.url() : "";
  const method = typeof request?.method === "function" ? request.method() : "";
  if (!/om\.qq\.com\/marticlepublish\/omPublish/i.test(url) || method.toUpperCase() !== "POST") return null;
  const postData = typeof request?.postData === "function" ? request.postData() : "";
  const headers = typeof request?.headers === "function" ? request.headers() : {};
  const contentType = String(headers?.["content-type"] || headers?.["Content-Type"] || "").slice(0, 160);
  let structuredBody = null;
  if (typeof request?.postDataJSON === "function") {
    try {
      structuredBody = request.postDataJSON();
    } catch {
      structuredBody = null;
    }
  }
  if (structuredBody == null && postData) {
    if (/json/i.test(contentType) || /^[\s]*[\[{]/.test(postData)) {
      try {
        structuredBody = JSON.parse(postData);
      } catch {
        structuredBody = null;
      }
    }
    if (structuredBody == null && !/multipart/i.test(contentType)) {
      structuredBody = Object.fromEntries(new URLSearchParams(postData));
    }
  }

  const collected = { fields: {}, safeFieldPaths: {} };
  collectPenguinSafeRequestFields(structuredBody, collected);
  const topLevelFieldNames = structuredBody && typeof structuredBody === "object" && !Array.isArray(structuredBody)
    ? Object.keys(structuredBody)
      .filter((key) => !PENGUIN_SENSITIVE_REQUEST_FIELD.test(key))
      .slice(0, 32)
      .map((key) => String(key).slice(0, 80))
    : [];
  const bodyKind = !postData
    ? "empty"
    : /multipart/i.test(contentType)
      ? "multipart"
      : /json/i.test(contentType) || /^[\s]*[\[{]/.test(postData)
        ? "json"
        : /x-www-form-urlencoded/i.test(contentType) || structuredBody
          ? "form"
          : "opaque";
  return {
    fields: collected.fields,
    metadata: {
      contentType,
      bodyKind,
      bodyBytes: Buffer.byteLength(String(postData || "")),
      topLevelFieldNames,
      ...(Object.keys(collected.safeFieldPaths).length ? { safeFieldPaths: collected.safeFieldPaths } : {}),
    },
  };
}

export function watchPenguinPublishApiResponses(page) {
  const state = {
    draftUrl: "",
    articleId: "",
    publishedUrl: "",
    blocker: "",
    publishClickArmed: false,
    publishAttempted: false,
    saveAttempted: false,
    saveSucceeded: false,
    publishSucceeded: false,
    lastSavePayload: null,
    lastPublishPayload: null,
    lastPublishRequestFields: null,
    lastPublishRequestMetadata: null,
  };
  const requestHandler = (request) => {
    const evidence = readPenguinPublishRequestFields(request);
    if (!evidence) return;
    state.lastPublishRequestFields = evidence.fields;
    state.lastPublishRequestMetadata = evidence.metadata;
  };
  const handler = async (response) => {
    const url = typeof response.url === "function" ? response.url() : "";
    if (!/om\.qq\.com\/.*(article|content|publish|save|create|draft|marticle|editorCache)/i.test(url)) return;
    const text = await response.text().catch(() => "");
    const payload = parseJsonLikePayload(text);
    // Prefer explicit article identifiers; avoid generic nested "id" from unrelated fields.
    const articleId = findNestedValue(payload, ["articleId", "article_id", "contentId", "cid"])
      || (/omSave|saveDraft|saveAndPreview|omBatchSave|omPublish/i.test(url)
        ? findNestedValue(payload, ["id"])
        : "");
    if (articleId && !/^\d{1,4}$/.test(String(articleId))) {
      state.articleId = String(articleId);
      state.draftUrl = penguinDraftUrlFromArticleId(articleId);
    }
    const isSaveCall = /(omSave|saveDraft|saveAndPreview|omBatchSave|\/save|editorCache\/update)/i.test(url);
    if (isSaveCall) {
      state.saveAttempted = true;
      state.lastSavePayload = payload;
      if (penguinApiPayloadSucceeded(payload)) {
        state.saveSucceeded = true;
      }
    }
    const semanticPublishCall = state.publishClickArmed
      && !isSaveCall
      && !/save|draft|getPublish|PublishRemain|remain|quota|precheck|check|validate|risk/i.test(url)
      && penguinApiPayloadSucceeded(payload)
      && Boolean(articleId || penguinPublishedUrlFromPayload(payload) || /submit|article|content|marticle|operation/i.test(url));
    const isPublishCall = (
      /(omPublish|omBatchPublish|quickPublish|\/publish)/i.test(url)
      || semanticPublishCall
    ) && !/save|draft|getPublish|PublishRemain/i.test(url);
    if (isPublishCall) {
      state.publishAttempted = true;
      state.lastPublishPayload = payload;
      const publishedUrl = penguinPublishedUrlFromPayload(payload);
      if (publishedUrl) state.publishedUrl = publishedUrl;
      if (penguinApiPayloadSucceeded(payload)) {
        state.publishSucceeded = true;
      }
      state.publishClickArmed = false;
    }
    if (isPublishCall && !penguinApiPayloadSucceeded(payload) && publishApiHasManualBlocker(payload)) {
      state.blocker = "PENGUIN_MANUAL_ACTION_REQUIRED";
    }
  };
  if (typeof page.on === "function") page.on("request", requestHandler);
  if (typeof page.on === "function") page.on("response", handler);
  return {
    state,
    dispose() {
      if (typeof page.off === "function") page.off("request", requestHandler);
      if (typeof page.off === "function") page.off("response", handler);
    }
  };
}

async function fillFirstLocator(page, selector, value, errorCode) {
  const locator = page.locator(selector).first();
  try {
    await locator.click?.().catch(() => undefined);
    await locator.fill(value);
    await locator.dispatchEvent?.("input").catch(() => undefined);
    await locator.dispatchEvent?.("change").catch(() => undefined);
    return locator;
  } catch (error) {
    throw new Error(`${errorCode}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function syncPenguinEditorContent(page, content, richHtml = "") {
  if (typeof page.evaluate !== "function") return false;
  return page.evaluate((payload) => {
    const text = payload.text;
    const suppliedHtml = payload.richHtml;
    const escapeHtml = (value) => String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const html = suppliedHtml || String(text || "")
      .split(/\n{2,}/)
      .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
      .join("") || "<p><br></p>";
    const editor = document.querySelector(payload.bodySelector);
    if (!editor) return false;
    editor.focus?.();

    // Prefer paste so ExEditor/ProseMirror plugins bind content into their document model.
    // Direct innerHTML alone can look correct in DOM but never enable omSave/omPublish.
    try {
      const transfer = new DataTransfer();
      transfer.setData("text/html", html);
      transfer.setData("text/plain", String(text || ""));
      const paste = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      });
      const handled = !editor.dispatchEvent(paste);
      if (!handled || !String(editor.innerText || "").trim()) {
        editor.innerHTML = html;
        editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: String(text || "") }));
      }
    } catch {
      editor.innerHTML = html;
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(text || "") }));
    }
    editor.dispatchEvent(new Event("change", { bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Process" }));
    return Boolean(String(editor.innerText || "").trim());
  }, { text: content, richHtml, bodySelector: PENGUIN_BODY_SELECTOR }).catch(() => false);
}

async function fillPenguinTitle(page, title) {
  // Research (2026-07-05): title is a contenteditable span (omui-inputautogrowing__inner),
  // not a plain input/textarea. Prefer semantic placeholder/title container before generic fields.
  if (typeof page.evaluate === "function") {
    const filled = await page.evaluate((value) => {
      const candidates = [
        ...document.querySelectorAll(".omui-inputautogrowing__inner[contenteditable='true']"),
        ...document.querySelectorAll("[contenteditable='true']"),
      ];
      const match = candidates.find((node) => {
        const text = String(node.getAttribute("data-placeholder") || node.getAttribute("placeholder") || node.getAttribute("aria-label") || node.textContent || "");
        const parentText = String(node.parentElement?.textContent || "");
        return /标题|title|5-64|请输入标题/i.test(`${text} ${parentText}`)
          || node.className?.toString?.().includes("omui-inputautogrowing");
      }) || candidates.find((node) => {
        // First short contenteditable above the ProseMirror body is typically the title.
        return !node.classList.contains("ProseMirror") && !node.closest?.(".ProseMirror");
      });
      if (!match) return false;
      match.focus?.();
      match.textContent = value;
      match.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      match.dispatchEvent(new Event("change", { bubbles: true }));
      match.dispatchEvent(new Event("blur", { bubbles: true }));
      return true;
    }, title).catch(() => false);
    if (filled) return null;
  }
  const selectors = [
    ".omui-inputautogrowing__inner[contenteditable='true']",
    "[contenteditable='true'][data-placeholder*='\u6807\u9898']",
    "[contenteditable='true'][placeholder*='\u6807\u9898']",
    "[class*='title'] [contenteditable='true']",
    "textarea[name='title']",
    "input[name='title']",
    "textarea[placeholder*='\u6807\u9898']",
    "input[placeholder*='\u6807\u9898']",
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const visible = await locator.isVisible?.().catch(() => false);
    if (!visible) continue;
    try {
      await locator.click?.().catch(() => undefined);
      if (typeof locator.fill === "function") {
        await locator.fill(title).catch(async () => {
          await locator.evaluate?.((node, value) => {
            node.textContent = value;
            node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
          }, title);
        });
      }
      await locator.dispatchEvent?.("input").catch(() => undefined);
      await locator.dispatchEvent?.("change").catch(() => undefined);
      return locator;
    } catch {
      continue;
    }
  }
  throw new Error("PENGUIN_TITLE_FIELD_NOT_FOUND");
}

async function fillPenguinBody(page, content, richHtml = "") {
  const locator = page.locator(PENGUIN_BODY_SELECTOR).first();
  try {
    await locator.click?.().catch(() => undefined);
    if (richHtml) {
      await locator.fill("");
      const synced = await syncPenguinEditorContent(page, content, richHtml);
      if (!synced) throw new Error("PENGUIN_RICH_BODY_SYNC_FAILED");
    } else {
      await locator.fill(content);
    }
    return locator;
  } catch {
    const synced = await syncPenguinEditorContent(page, content, richHtml);
    if (synced) return null;
    throw new Error("PENGUIN_BODY_FIELD_NOT_FOUND");
  }
}

async function choosePenguinDefaults(page, publishInput) {
  if (typeof page.locator !== "function") return;
  if (publishInput.category) {
    await page.locator(`text=${publishInput.category}`).first().click?.().catch(() => undefined);
  }
  if (/original|\u539f\u521b/i.test(publishInput.articleType)) {
    await page.locator("label:has-text('\u539f\u521b'), button:has-text('\u539f\u521b'), text=\u539f\u521b").first().click?.().catch(() => undefined);
  }
  if (/auto|\u81ea\u52a8/i.test(publishInput.coverMode)) {
    await page.locator("label:has-text('\u81ea\u52a8'), button:has-text('\u81ea\u52a8'), text=\u81ea\u52a8").first().click?.().catch(() => undefined);
  }
}

async function clickFirstVisibleLocator(page, selectors, options = {}) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (!(await locator.isVisible?.().catch(() => false))) continue;
    if (await locator.isDisabled?.().catch(() => false)) continue;
    await locator.scrollIntoViewIfNeeded?.().catch(() => undefined);
    await locator.click(options.clickOptions || { timeout: 5000 }).catch(async () => {
      await locator.click({ force: true, timeout: 5000 });
    });
    return true;
  }
  return false;
}

async function ensurePenguinAiDeclarationBySemanticSelectors(page) {
  const dialogSelectors = [
    ".omui-dialog-wrapper:has-text('\u53d1\u5e03\u5185\u5bb9\u81ea\u4e3b\u58f0\u660e')",
    "[role='dialog']:has-text('\u53d1\u5e03\u5185\u5bb9\u81ea\u4e3b\u58f0\u660e')",
    ".omui-dialog-wrapper:has-text('AI\u751f\u6210\u58f0\u660e')",
    "[role='dialog']:has-text('AI\u751f\u6210\u58f0\u660e')",
  ];
  const dialogVisible = async () => {
    for (const selector of dialogSelectors) {
      if (await page.locator(selector).first().isVisible?.().catch(() => false)) return true;
    }
    return false;
  };

  let opened = await dialogVisible();
  if (!opened) {
    opened = await clickFirstVisibleLocator(page, [
      "a:has-text('\u70b9\u51fb\u8fd9\u91cc')",
      "a:has-text('\u8fdb\u884c\u8865\u5145')",
      "a:has-text('\u5185\u5bb9\u81ea\u4e3b\u58f0\u660e')",
      "a:has-text('AI\u751f\u6210\u58f0\u660e')",
      "text=\u8fdb\u884c\u8865\u5145",
      "text=\u6dfb\u52a0\u5185\u5bb9\u81ea\u4e3b\u58f0\u660e",
    ]);
    if (opened) {
      await page.waitForTimeout?.(500).catch(() => undefined);
      opened = await dialogVisible();
    }
  }

  if (!opened) return false;

  const optionClicked = await clickFirstVisibleLocator(page, [
    ".omui-dialog-wrapper:has-text('AI\u751f\u6210\u58f0\u660e') label:has-text('\u56fe\u7247\u7d20\u6750')",
    "[role='dialog']:has-text('AI\u751f\u6210\u58f0\u660e') label:has-text('\u56fe\u7247\u7d20\u6750')",
    "label:has-text('\u56fe\u7247\u7d20\u6750')",
    ".omui-dialog-wrapper:has-text('\u53d1\u5e03\u5185\u5bb9\u81ea\u4e3b\u58f0\u660e') label:has-text('\u8be5\u6587\u7ae0\u7531AI\u751f\u6210')",
    "[role='dialog']:has-text('\u53d1\u5e03\u5185\u5bb9\u81ea\u4e3b\u58f0\u660e') label:has-text('\u8be5\u6587\u7ae0\u7531AI\u751f\u6210')",
    ".omui-dialog-wrapper:has-text('AI\u751f\u6210\u58f0\u660e') label:has-text('\u8be5\u6587\u7ae0\u7531AI\u751f\u6210')",
    "[role='dialog']:has-text('AI\u751f\u6210\u58f0\u660e') label:has-text('\u8be5\u6587\u7ae0\u7531AI\u751f\u6210')",
    "label:has-text('\u8be5\u6587\u7ae0\u7531AI\u751f\u6210')",
    "label:has-text('AI\u751f\u6210')",
    "[role='radio']:has-text('AI')",
    "[role='checkbox']:has-text('AI')",
  ]);

  const submitted = await clickFirstVisibleLocator(page, [
    ".omui-dialog-wrapper:has-text('\u53d1\u5e03\u5185\u5bb9\u81ea\u4e3b\u58f0\u660e') button:has-text('\u786e\u8ba4')",
    "[role='dialog']:has-text('\u53d1\u5e03\u5185\u5bb9\u81ea\u4e3b\u58f0\u660e') button:has-text('\u786e\u8ba4')",
    ".omui-dialog-wrapper:has-text('AI\u751f\u6210\u58f0\u660e') button:has-text('\u63d0\u4ea4')",
    "[role='dialog']:has-text('AI\u751f\u6210\u58f0\u660e') button:has-text('\u63d0\u4ea4')",
    "button:has-text('\u786e\u8ba4')",
    "button:has-text('\u63d0\u4ea4')",
  ]);
  if (!optionClicked && !submitted) return false;
  await page.waitForTimeout?.(700).catch(() => undefined);
  return true;
}

export async function ensurePenguinAiDeclaration(page) {
  if (await ensurePenguinAiDeclarationBySemanticSelectors(page)) return true;
  const submitCurrentAiDeclaration = async () => {
    const dialog = page.locator(
      ".omui-dialog-wrapper:has-text('AI\u751f\u6210\u58f0\u660e'), [role='dialog']:has-text('AI\u751f\u6210\u58f0\u660e'), .omui-dialog-wrapper:has-text('\u53d1\u5e03\u5185\u5bb9\u81ea\u4e3b\u58f0\u660e'), [role='dialog']:has-text('\u53d1\u5e03\u5185\u5bb9\u81ea\u4e3b\u58f0\u660e')"
    ).first();
    if (!(await dialog.isVisible?.().catch(() => false))) return false;

    const submit = page.locator(
      ".omui-dialog-wrapper:has-text('AI\u751f\u6210\u58f0\u660e') button:has-text('\u63d0\u4ea4'), [role='dialog']:has-text('AI\u751f\u6210\u58f0\u660e') button:has-text('\u63d0\u4ea4')"
    ).first();
    if (!(await submit.isVisible?.().catch(() => false))) return false;
    const disabled = await submit.isDisabled?.().catch(() => false);
    if (disabled) return false;
    await submit.scrollIntoViewIfNeeded?.().catch(() => undefined);
    await submit.click({ timeout: 5000 }).catch(async () => {
      await submit.click({ force: true, timeout: 5000 });
    });
    await page.waitForTimeout?.(700).catch(() => undefined);
    return true;
  };

  if (await submitCurrentAiDeclaration()) return true;

  const dialogSelector = ".omui-dialog-wrapper.open:has-text('发布内容自主声明'), [role='dialog']:has-text('发布内容自主声明')";
  let dialog = page.locator(dialogSelector).first();
  let dialogVisible = await dialog.isVisible?.().catch(() => false);
  if (!dialogVisible) {
    const trigger = page.locator(
      "a:has-text('点这里'), a:has-text('进行补充'), button:has-text('添加内容自主声明')"
    ).first();
    if (!(await trigger.isVisible?.().catch(() => false))) return false;
    await trigger.click();
    await page.waitForTimeout?.(500).catch(() => undefined);
    dialog = page.locator(dialogSelector).first();
    dialogVisible = await dialog.isVisible?.().catch(() => false);
    if (await submitCurrentAiDeclaration()) return true;
  }

  const optionSelector = dialogVisible
    ? ".omui-dialog-wrapper.open:has-text('发布内容自主声明') label:has-text('该文章由AI生成'), [role='dialog']:has-text('发布内容自主声明') label:has-text('该文章由AI生成')"
    : "label:has-text('该文章由AI生成')";
  const option = page.locator(optionSelector).first();
  if (await option.isVisible?.().catch(() => false)) {
    await option.click();
  } else {
    const fallbackOptionSelector = dialogVisible
      ? ".omui-dialog-wrapper.open:has-text('发布内容自主声明') input[type='radio'], .omui-dialog-wrapper.open:has-text('发布内容自主声明') input[type='checkbox'], [role='dialog']:has-text('发布内容自主声明') input[type='radio'], [role='dialog']:has-text('发布内容自主声明') input[type='checkbox']"
      : "input[type='radio'], input[type='checkbox']";
    const fallbackOption = page.locator(fallbackOptionSelector).first();
    if (!(await fallbackOption.isVisible?.().catch(() => false))) throw new Error("PENGUIN_AI_DECLARATION_OPTION_NOT_FOUND");
    await fallbackOption.scrollIntoViewIfNeeded?.().catch(() => undefined);
    await fallbackOption.click({ force: true }).catch(async () => {
      await fallbackOption.click();
    });
  }

  const confirmSelector = dialogVisible
    ? ".omui-dialog-wrapper.open:has-text('发布内容自主声明') button:has-text('确认'), [role='dialog']:has-text('发布内容自主声明') button:has-text('确认')"
    : "button:has-text('确认')";
  const confirm = page.locator(confirmSelector).first();
  if (!(await confirm.isVisible?.().catch(() => false))) throw new Error("PENGUIN_AI_DECLARATION_CONFIRM_NOT_FOUND");
  await confirm.click();
  await page.waitForTimeout?.(500).catch(() => undefined);
  return true;
}

async function waitForDraftSaved(page, timeoutMs) {
  if (typeof page.waitForFunction !== "function") return;
  await page.waitForFunction(() => {
    const text = document.body?.innerText || "";
    return /\u5df2\u4fdd\u5b58|\u4fdd\u5b58\u8349\u7a3f|\u5b58\u8349\u7a3f|\u8349\u7a3f|saved|draft/i.test(text);
  }, null, { timeout: timeoutMs }).catch(() => undefined);
}

async function clickPenguinDraftSave(page, timeoutMs, watcherState = null) {
  const selectors = [
    "button:has-text('\u4fdd\u5b58\u8349\u7a3f')",
    "button:has-text('\u5b58\u8349\u7a3f')",
    "button:has-text('\u4fdd\u5b58')",
    "[role='button']:has-text('\u8349\u7a3f')",
    "button:has-text('Save')",
    "button:has-text('Draft')"
  ];
  for (const selector of selectors) {
    const button = page.locator(selector).first();
    const visible = await button.isVisible?.().catch(() => false);
    const disabled = await button.isDisabled?.().catch(() => false);
    if (visible && !disabled) {
      await button.scrollIntoViewIfNeeded?.().catch(() => undefined);
      await button.click?.().catch(() => undefined);
      break;
    }
  }
  await waitForDraftSaved(page, timeoutMs);
  // Wait briefly for the real save API; UI toast alone is not enough evidence.
  const deadline = Date.now() + Math.min(Number(timeoutMs || 30000), 20000);
  while (watcherState && Date.now() < deadline) {
    if (watcherState.saveSucceeded || watcherState.articleId) return;
    if (typeof page.waitForTimeout === "function") await page.waitForTimeout(400).catch(() => undefined);
    else await new Promise((resolve) => setTimeout(resolve, 400));
  }
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

async function penguinDialogIsOpen(page) {
  if (typeof page.locator !== "function") return false;
  const mask = page.locator(".omui-dialog-mask, .omui-dialog-wrapper, [role='dialog'], .omui-modal, .ant-modal-mask, .ant-modal").first();
  return Boolean(await mask.isVisible?.().catch(() => false));
}

async function capturePenguinPublishButtonDiagnostic(page, selectors = [], stage = "publish-button-disabled") {
  try {
    const [{ mkdir, writeFile }, { join }, { homedir }] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
      import("node:os"),
    ]);
    const diagnosticsDir = join(homedir(), ".zhixin-ai", "diagnostics");
    await mkdir(diagnosticsDir, { recursive: true });
    const stamp = Date.now();
    const screenshotPath = join(diagnosticsDir, `penguin-${stage}-${stamp}.png`);
    const jsonPath = join(diagnosticsDir, `penguin-${stage}-${stamp}.json`);
    const snapshot = await page.evaluate?.((payload) => {
      const controls = [...document.querySelectorAll("button, [role='button'], a")].map((node) => ({
        text: (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160),
        tag: node.tagName,
        className: String(node.className || "").slice(0, 160),
        disabled: Boolean(node.disabled || node.getAttribute("aria-disabled") === "true" || node.classList?.contains("disabled")),
        href: node.getAttribute("href") || "",
      })).filter((item) => item.text || item.href).slice(0, 120);
      return {
        url: location.href,
        title: document.title,
        bodyText: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 4000),
        selectors: payload.selectors,
        controls,
      };
    }, { selectors }).catch((error) => ({ error: error instanceof Error ? error.message : String(error), selectors }));
    await page.screenshot?.({ path: screenshotPath, fullPage: true }).catch(() => undefined);
    await writeFile(jsonPath, JSON.stringify({ ...snapshot, screenshotPath, jsonPath }, null, 2), "utf8");
    console.error("[penguin] publish diagnostic", JSON.stringify({ stage, screenshotPath, jsonPath }));
    return { screenshotPath, jsonPath };
  } catch {
    return null;
  }
}

async function dismissOrConfirmPenguinDialogs(page, { allowPublishConfirm = true } = {}) {
  if (typeof page.locator !== "function") return false;
  let acted = false;
  for (let round = 0; round < 4; round += 1) {
    // Prefer completing required publish prompts (cover/category/confirm) before dismissing.
    const actionSelectors = [
      ...(allowPublishConfirm
        ? [
            ".omui-dialog-wrapper.open button:has-text('\u53d1\u5e03')",
            ".omui-dialog-wrapper.open button.omui-button--primary:has-text('\u53d1\u5e03')",
            ".omui-dialog-wrapper.open button:has-text('\u7ee7\u7eed\u53d1\u5e03')",
            ".omui-dialog-wrapper.open button:has-text('\u786e\u8ba4\u53d1\u5e03')",
          ]
        : []),
      ".omui-dialog-wrapper button:has-text('\u63d0\u4ea4')",
      "[role='dialog'] button:has-text('\u63d0\u4ea4')",
      ".omui-dialog-wrapper button.omui-button--primary",
      "[role='dialog'] button[class*='primary']",
      ".omui-dialog-wrapper.open button:has-text('\u786e\u5b9a')",
      ".omui-dialog-wrapper.open button:has-text('\u786e\u8ba4')",
      ".omui-dialog-wrapper.open button.omui-button--primary",
      ".ant-modal button.ant-btn-primary",
      ".ant-modal button:has-text('\u786e\u5b9a')",
      ".ant-modal button:has-text('\u786e\u8ba4')",
      "button:has-text('\u7ee7\u7eed\u53d1\u5e03')",
      "button:has-text('\u786e\u5b9a')",
      "button:has-text('OK')",
    ];
    const clicked = await clickFirstVisibleEnabled(page, actionSelectors);
    if (clicked) {
      acted = true;
      await page.waitForTimeout?.(800).catch(() => undefined);
    }
    if (clicked) continue;

    // If a non-blocking mask remains (leftover media dialog), close it.
    if (await penguinDialogIsOpen(page)) {
      await page.keyboard?.press?.("Escape").catch(() => undefined);
      const close = page.locator(
        ".omui-dialog-wrapper.open button:has-text('\u53d6\u6d88'), .omui-dialog-wrapper.open [aria-label='Close'], .omui-dialog-wrapper.open .omui-dialog-close, .ant-modal-close"
      ).first();
      if (await close.isVisible?.().catch(() => false)) {
        await close.click?.({ force: true }).catch(() => undefined);
        acted = true;
      }
      await page.waitForTimeout?.(500).catch(() => undefined);
      if (!(await penguinDialogIsOpen(page))) break;
      continue;
    }
    break;
  }
  return acted;
}

export async function clickPenguinPublish(page, timeoutMs = 45000, watcherState = null) {
  // Leftover image/media dialogs intercept the top-level publish button.
  await dismissOrConfirmPenguinDialogs(page, { allowPublishConfirm: false });

  const selectors = [
    "button.omui-button--primary:has-text('\u53d1\u5e03')",
    "button:has-text('\u53d1\u5e03')",
    "[role='button']:has-text('\u53d1\u5e03')",
    ".btn:has-text('\u53d1\u5e03')",
    "button:has-text('Publish')"
  ];
  const startedAt = Date.now();
  let clicked = false;
  while (Date.now() - startedAt < Math.max(1, Number(timeoutMs || 45000))) {
    if (watcherState?.publishAttempted || watcherState?.publishSucceeded || watcherState?.blocker) return clicked;
    if (await penguinDialogIsOpen(page)) {
      const dialogHandled = await dismissOrConfirmPenguinDialogs(page, { allowPublishConfirm: true });
      if (dialogHandled && !watcherState?.publishAttempted && !watcherState?.publishSucceeded && !watcherState?.blocker) {
        // Penguin returns to the editor after submitting the required AI declaration.
        // Re-arm the top-level publish action so the actual publish request is sent.
        clicked = false;
      }
      continue;
    }
    const diagnosticHandled = await clickFirstVisibleEnabled(page, [
      "button:has-text('\u5ffd\u7565')",
      "[role='button']:has-text('\u5ffd\u7565')",
      "button:has-text('\u6682\u4e0d\u8bca\u65ad')",
      "[role='button']:has-text('\u6682\u4e0d\u8bca\u65ad')",
      "button:has-text('\u7ee7\u7eed\u53d1\u5e03')",
      "[role='button']:has-text('\u7ee7\u7eed\u53d1\u5e03')",
      "button:has-text('\u6211\u77e5\u9053\u4e86')",
      "[role='button']:has-text('\u6211\u77e5\u9053\u4e86')",
    ], { timeoutMs: 800 });
    if (diagnosticHandled) {
      clicked = false;
      await page.waitForTimeout?.(800).catch(() => undefined);
      continue;
    }
    if (!clicked) {
      if (watcherState) watcherState.publishClickArmed = true;
      clicked = await clickFirstVisibleEnabled(page, selectors, { timeoutMs: 4000 });
      if (!clicked && watcherState && !watcherState.publishAttempted && !watcherState.publishSucceeded) {
        watcherState.publishClickArmed = false;
      }
    }
    if (clicked) {
      await page.waitForTimeout?.(350).catch(() => undefined);
      if (!watcherState && !(await penguinDialogIsOpen(page))) return true;
      continue;
    }

    for (const selector of selectors) {
      const button = page.locator(selector).first();
      const visible = await button.isVisible?.().catch(() => false);
      const disabled = await button.isDisabled?.().catch(() => false);
      if (visible && !disabled) {
        await button.scrollIntoViewIfNeeded?.().catch(() => undefined);
        try {
          if (watcherState) watcherState.publishClickArmed = true;
          await button.click({ timeout: 4000 });
        } catch {
          // If a dialog just opened and intercepts the top bar button, complete the dialog path.
          if (await penguinDialogIsOpen(page)) {
            if (watcherState) watcherState.publishClickArmed = true;
            await dismissOrConfirmPenguinDialogs(page, { allowPublishConfirm: true });
            return;
          }
          if (watcherState) watcherState.publishClickArmed = true;
          throw new Error("PENGUIN_PUBLISH_CLICK_UNCERTAIN");
        }
        return;
      }
    }
    await page.waitForTimeout?.(500).catch(() => undefined);
  }
  if (typeof page.getByRole === "function") {
    const roleButton = page.getByRole("button", { name: /^(\u53d1\u5e03|publish)$/i }).first();
    if (await waitForLocatorEnabled(roleButton, page, Math.min(timeoutMs, 5000))) {
      await roleButton.scrollIntoViewIfNeeded?.().catch(() => undefined);
      if (watcherState) watcherState.publishClickArmed = true;
      await roleButton.click({ timeout: 5000 });
      return;
    }
  }
  await capturePenguinPublishButtonDiagnostic(page, selectors, "publish-button-disabled");
  throw new Error(`PENGUIN_PUBLISH_BUTTON_${(await describeUnavailableButton(selectors.map((selector) => page.locator(selector).first()))).toUpperCase()}`);
}

async function confirmPenguinDialogs(page) {
  await dismissOrConfirmPenguinDialogs(page, { allowPublishConfirm: true });
}

async function readPenguinPlatformBlocker(page) {
  if (typeof page.evaluate !== "function") return "";
  const text = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
  if (/\u767b\u5f55|\u626b\u7801\u767b\u5f55|login/i.test(text) && !/\u521b\u4f5c|\u5185\u5bb9\u7ba1\u7406|\u53d1\u5e03|\u8349\u7a3f|creator|publish/i.test(text)) {
    return "PENGUIN_LOGIN_REQUIRED";
  }
  if (/captcha|security verification|risk control/i.test(text)) return "PENGUIN_MANUAL_ACTION_REQUIRED";
  if (/\u9a8c\u8bc1\u7801|\u5b89\u5168\u9a8c\u8bc1|\u62d6\u52a8\u6ed1\u5757|\u626b\u7801\u9a8c\u8bc1|\u98ce\u63a7|\u5b8c\u6210\u9a8c\u8bc1/.test(text)) return "PENGUIN_MANUAL_ACTION_REQUIRED";
  if (/\u654f\u611f\u8bcd|\u53d1\u5e03\u4e0a\u9650|\u4eca\u65e5\u53d1\u5e03|\u5ba1\u6838\u672a\u901a\u8fc7|\u8fdd\u89c4|\u9891\u7e41/.test(text)) return "PENGUIN_MANUAL_ACTION_REQUIRED";
  return "";
}

async function readPenguinPublishedUrl(page) {
  const current = typeof page.url === "function" ? page.url() : "";
  const normalizedCurrent = normalizePenguinPublishedUrl(current);
  if (normalizedCurrent) return normalizedCurrent;
  if (typeof page.locator === "function") {
    const candidates = [
      "a[href*='page.om.qq.com/page/']",
      "a[href*='news.qq.com']",
      "a[href*='new.qq.com']",
      "a[href*='view.inews.qq.com']",
      "a[href*='om.qq.com/a/']",
    ];
    for (const selector of candidates) {
      const href = await page.locator(selector).first().getAttribute?.("href").catch(() => "");
      const normalized = href ? normalizePenguinPublishedUrl(href.startsWith("http") ? href : new URL(href, PENGUIN_ORIGIN).toString()) : "";
      if (normalized) return normalized;
    }
  }
  return "";
}

const PENGUIN_MANAGE_URL = "https://om.qq.com/main/management/articleManage";

async function readPenguinPublicUrlFromResponse(response) {
  const responseUrl = typeof response?.url === "function" ? response.url() : "";
  const direct = findPenguinPublicUrlInValue(responseUrl);
  if (direct) return direct;
  if (typeof response?.json === "function") {
    const payload = await response.json().catch(() => null);
    const fromJson = findPenguinPublicUrlInValue(payload);
    if (fromJson) return fromJson;
  }
  if (typeof response?.text === "function") {
    const body = await response.text().catch(() => "");
    return findPenguinPublicUrlInValue(body);
  }
  return "";
}

async function readPenguinPublicUrlFromDom(page) {
  if (typeof page?.evaluate !== "function") return "";
  const value = await page.evaluate(() => {
    const attributes = ["href", "data-url", "data-link", "data-href", "src", "content"];
    for (const element of document.querySelectorAll("a, button, img, iframe, [data-url], [data-link], [data-href], meta")) {
      for (const attribute of attributes) {
        const candidate = element.getAttribute?.(attribute) || "";
        if (/page\.om\.qq\.com\/page\//i.test(candidate)) return candidate;
      }
    }
    const html = document.documentElement?.innerHTML || "";
    const match = html.match(/https?:\\?\/\\?\/page\.om\.qq\.com\\?\/page\\?\/[A-Za-z0-9_-]+/i);
    return match?.[0] || "";
  }).catch(() => "");
  return findPenguinPublicUrlInValue(value);
}

async function assertPenguinManagementAuthenticated(page) {
  const currentUrl = typeof page?.url === "function" ? page.url() : "";
  if (/\/userAuth(?:\/|\?|$)|\/login(?:\/|\?|$)/i.test(currentUrl)) {
    throw new Error("PENGUIN_LOGIN_REQUIRED");
  }
  const blocker = await readPenguinPlatformBlocker(page);
  if (blocker === "PENGUIN_LOGIN_REQUIRED") throw new Error(blocker);
}

export async function findPenguinPublicationFromManagement(page, input = {}) {
  const expectedTitle = cleanText(input.articleTitle || input.title || "");
  await page.goto(input.manageUrl || PENGUIN_MANAGE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout?.(2000).catch(() => undefined);
  await assertPenguinManagementAuthenticated(page);

  // Prefer searching by title when a search box exists.
  const search = page.locator(
    "input[placeholder*='标题'], input[placeholder*='关键词'], input[placeholder*='搜索'], input[type='search']"
  ).first();
  if (expectedTitle && await search.isVisible?.().catch(() => false)) {
    await search.fill("").catch(() => undefined);
    await search.fill(expectedTitle).catch(() => undefined);
    await search.press?.("Enter").catch(() => undefined);
    const searchButton = page.locator("button:has-text('查询'), button:has-text('搜索')").first();
    if (await searchButton.isVisible?.().catch(() => false)) await searchButton.click().catch(() => undefined);
    await page.waitForTimeout?.(2500).catch(() => undefined);
  }

  // Click published/all filters if present.
  for (const label of ["已发布", "全部"]) {
    const tab = page.locator(`button:has-text('${label}'), [role='tab']:has-text('${label}'), a:has-text('${label}')`).first();
    if (await tab.isVisible?.().catch(() => false)) {
      await tab.click().catch(() => undefined);
      await page.waitForTimeout?.(1500).catch(() => undefined);
      break;
    }
  }
  await assertPenguinManagementAuthenticated(page);

  const directlyLinked = await page.evaluate((title) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, "").toLowerCase();
    const wanted = normalize(title);
    const anchors = [...document.querySelectorAll("a[href]")];
    for (const anchor of anchors) {
      const href = anchor.getAttribute("href") || "";
      const text = normalize(`${anchor.textContent || ""} ${anchor.getAttribute("title") || ""}`);
      if (wanted && text && !text.includes(wanted) && !wanted.includes(text.slice(0, 12))) continue;
      if (/page\.om\.qq\.com\/page\/|news\.qq\.com|new\.qq\.com|view\.inews\.qq\.com|\/a\//i.test(href)) {
        try {
          return new URL(href, location.origin).toString();
        } catch {
          continue;
        }
      }
    }
    const rows = [...document.querySelectorAll("tr, .list-item, [class*='article'], [class*='content-item']")];
    for (const row of rows) {
      const text = normalize(row.textContent || "");
      if (wanted && !text.includes(wanted)) continue;
      const link = row.querySelector("a[href*='page.om.qq.com/page/'], a[href*='news.qq.com'], a[href*='new.qq.com'], a[href*='view.inews.qq.com']");
      if (link?.href) return link.href;
    }
    return "";
  }, expectedTitle).catch(() => "");
  const directPublicUrl = findPenguinPublicUrlInValue(directlyLinked);
  if (directPublicUrl) return directPublicUrl;
  if (!expectedTitle || typeof page.locator !== "function") return "";

  const responseTasks = new Set();
  let discoveredUrl = "";
  const responseHandler = (response) => {
    const task = readPenguinPublicUrlFromResponse(response)
      .then((candidate) => {
        if (candidate && !discoveredUrl) discoveredUrl = candidate;
      })
      .catch(() => undefined)
      .finally(() => responseTasks.delete(task));
    responseTasks.add(task);
  };
  page.on?.("response", responseHandler);

  try {
    const rows = page.locator("tr, .list-item, [class*='article'], [class*='content-item']");
    const row = typeof rows.filter === "function" ? rows.filter({ hasText: expectedTitle }).first() : rows.first();
    if (!await row.isVisible?.().catch(() => false)) return "";

    const mobileOpen = row.locator(
      "button:has-text('手机打开'), a:has-text('手机打开'), [role='button']:has-text('手机打开'), text=手机打开"
    ).first();
    if (!await mobileOpen.isVisible?.().catch(() => false)) return "";

    const popupPromise = typeof page.waitForEvent === "function"
      ? page.waitForEvent("popup", { timeout: 5000 }).catch(() => null)
      : Promise.resolve(null);
    await mobileOpen.click({ timeout: 5000 });
    const popup = await popupPromise;
    await popup?.waitForLoadState?.("domcontentloaded", { timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout?.(800).catch(() => undefined);
    if (responseTasks.size) await Promise.allSettled([...responseTasks]);

    discoveredUrl = discoveredUrl
      || findPenguinPublicUrlInValue(typeof popup?.url === "function" ? popup.url() : "")
      || await readPenguinPublicUrlFromDom(popup)
      || await readPenguinPublicUrlFromDom(page)
      || findPenguinPublicUrlInValue(typeof page.url === "function" ? page.url() : "");
    return discoveredUrl;
  } finally {
    page.off?.("response", responseHandler);
  }
}
async function verifyPenguinPublishedUrl(context, publishedUrl, expectedTitle, existingPage = null) {
  if (!publishedUrl) return true;
  const page = existingPage || (typeof context?.newPage === "function" ? await context.newPage() : null);
  if (!page) return true;
  const ownsPage = !existingPage;
  try {
    const response = await page.goto(publishedUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
    await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
    await page.waitForTimeout?.(1500).catch(() => undefined);
    const status = typeof response?.status === "function" ? response.status() : 0;
    const title = cleanText(await page.title().catch(() => ""));
    const text = cleanText(await page.evaluate?.(() => document.body?.innerText || "").catch(() => "") || "");
    if ([401, 403, 404, 410, 451, 521].includes(status)) throw new Error("PENGUIN_PUBLISHED_URL_NOT_PUBLIC");
    if (/^404\b|not found|forbidden|\u9875\u9762\u4e0d\u5b58\u5728/i.test(`${title} ${text}`)) throw new Error("PENGUIN_PUBLISHED_URL_NOT_PUBLIC");
    if (penguinPublicPageIsUnavailable(`${title}\n${text}`)) throw new Error("PENGUIN_PUBLISHED_URL_NOT_PUBLIC");
    if (expectedTitle && !text.includes(expectedTitle) && !title.includes(expectedTitle)) throw new Error("PENGUIN_PUBLISHED_URL_NOT_PUBLIC");
    return true;
  } finally {
    if (ownsPage) await page.close?.().catch(() => undefined);
  }
}

async function verifyPenguinPublicImages(context, publishedUrl, tasks, existingPage = null) {
  if (!tasks.length) return [];
  const publicPage = existingPage || await context.newPage();
  const ownsPage = !existingPage;
  try {
    if (ownsPage || (typeof publicPage.url === "function" && normalizePenguinPublishedUrl(publicPage.url()) !== publishedUrl)) {
      await publicPage.goto(publishedUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await publicPage.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
    }
    if (typeof publicPage.waitForFunction === "function") {
      await publicPage.waitForFunction((payload) => {
        const images = [...document.querySelectorAll(payload.selector)];
        return images.filter((image) => (
          /^https:\/\//i.test(image.getAttribute("src") || "")
          && image.complete
          && image.naturalWidth > 0
        )).length >= payload.expectedCount;
      }, { selector: PENGUIN_PUBLIC_IMAGE_SELECTOR, expectedCount: tasks.length }, { timeout: 30000 }).catch(() => undefined);
    }
    return verifyPlatformImages({
      tasks,
      readImages: () => readLocatorImages(publicPage, PENGUIN_PUBLIC_IMAGE_SELECTOR),
      stage: "public",
    });
  } finally {
    if (ownsPage) await publicPage.close?.().catch(() => undefined);
  }
}

function normalizedMatchText(value = "") {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

export function penguinPublicPageIsUnavailable(value = "") {
  const normalized = normalizedMatchText(value);
  if (!normalized) return false;
  return [
    "\u5185\u5bb9\u88ab\u5220\u9664",
    "\u8fd9\u7bc7\u6587\u7ae0\u4ece\u5730\u7403\u4e0a\u6d88\u5931\u4e86",
    "\u9875\u9762\u4e0d\u5b58\u5728",
    "\u5185\u5bb9\u4e0d\u5b58\u5728",
    "\u5df2\u4e0b\u7ebf",
    "404.html",
    "notfound",
    "forbidden",
  ].some((marker) => normalized.includes(normalizedMatchText(marker)));
}

function penguinMarkdownEvidenceFragments(value = "", articleTitle = "") {
  const normalizedTitle = normalizedMatchText(articleTitle);
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\n{2,}/)
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

// Penguin public pages interpose platform chrome between an article's own
// blocks. The image-module toolbar ("编辑" / "删除图注") is server-rendered as
// visible text between a section heading and its paragraph, and ProseMirror
// separator and trailing-break nodes add further block boundaries. A markdown
// fragment that merges a heading and its paragraph into one string therefore
// never appears verbatim on the public page even though every piece of the
// article is there, which failed bodyMatched for every published article that
// carries an image. Match each fragment as ordered pieces instead: platform
// text sitting between two pieces of our own article is then allowed, while a
// page that is missing a piece still fails.
function penguinEvidencePieces(fragment) {
  return String(fragment || "")
    .split(/\s+/)
    .map((piece) => normalizedMatchText(piece))
    .filter((piece) => piece.length >= 4);
}

function penguinEvidencePiecesAppear(pieces, normalizedPageBody) {
  let from = 0;
  for (const piece of pieces) {
    const index = normalizedPageBody.indexOf(piece, from);
    if (index < 0) return false;
    from = index + piece.length;
  }
  return true;
}

function penguinRenderedBodyMatches(contentMarkdown = "", bodyText = "", articleTitle = "") {
  if (!String(contentMarkdown || "").trim()) return true;
  const normalizedPageBody = normalizedMatchText(bodyText);
  if (!normalizedPageBody) return false;

  const fragments = penguinMarkdownEvidenceFragments(contentMarkdown, articleTitle)
    .map((fragment) => penguinEvidencePieces(fragment))
    .filter((pieces) => pieces.length > 0);
  if (!fragments.length) return false;

  const substantial = fragments.filter((pieces) => pieces.join("").length >= 24);
  const probes = (substantial.length ? substantial : fragments).slice(0, 3);
  const matched = probes.filter((pieces) => penguinEvidencePiecesAppear(pieces, normalizedPageBody)).length;
  const required = probes.length >= 2 ? 2 : 1;
  return matched >= required;
}

export async function inspectPenguinPublicArticle(page, input = {}) {
  const rawCandidate = input.publicUrl || input.publishedUrl || input.reviewUrl || "";
  let publicUrl = normalizePenguinPublishedUrl(rawCandidate);
  let pageAlreadyOpened = false;

  // The creator backend exposes /s/article/<backend-id> while an article is under
  // review. Open it only as a discovery candidate, then persist the final URL after
  // Tencent redirects to page.om.qq.com/page/<public-id>.
  const reviewCandidate = normalizePenguinReviewCandidateUrl(rawCandidate);
  if (!publicUrl && reviewCandidate) {
    await page.goto(reviewCandidate, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
    publicUrl = normalizePenguinPublishedUrl(typeof page.url === "function" ? page.url() : "");
    pageAlreadyOpened = Boolean(publicUrl);
  }

  if (!publicUrl) {
    publicUrl = await findPenguinPublicationFromManagement(page, input);
    pageAlreadyOpened = false;
  }
  if (!publicUrl) throw new Error("PENGUIN_PUBLIC_URL_INVALID");

  const existing = input.imagePublicationEvidence && typeof input.imagePublicationEvidence === "object"
    ? input.imagePublicationEvidence
    : {};
  const expected = Array.isArray(existing.expected) ? existing.expected : [];

  if (!pageAlreadyOpened || normalizePenguinPublishedUrl(typeof page.url === "function" ? page.url() : "") !== publicUrl) {
    await page.goto(publicUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
  }
  const redirectedPublicUrl = normalizePenguinPublishedUrl(typeof page.url === "function" ? page.url() : "");
  if (redirectedPublicUrl) publicUrl = redirectedPublicUrl;
  if (expected.length && typeof page.waitForFunction === "function") {
    await page.waitForFunction((payload) => {
      const images = [...document.querySelectorAll(payload.selector)];
      return images.filter((image) => (
        /^https:\/\//i.test(image.getAttribute("src") || "")
        && image.complete
        && image.naturalWidth > 0
      )).length >= payload.expectedCount;
    }, { selector: PENGUIN_PUBLIC_IMAGE_SELECTOR, expectedCount: expected.length }, { timeout: 30000 }).catch(() => undefined);
  }

  const publicEvidence = expected.length
    ? await verifyPublicImageEvidence({
        tasks: expected,
        readImages: () => readLocatorImages(page, PENGUIN_PUBLIC_IMAGE_SELECTOR),
        readBlocker: async () => String(await readPenguinPlatformBlocker(page).catch(() => "") || "").trim()
          || await readPublicPageBlockerFromPage(page),
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
  const bodyText = await page.locator("article, .article-content, .content, body").first().innerText().catch(() => "");
  const pageText = `${pageTitle}\n${bodyText}`.trim().slice(0, 12000);
  const unavailable = penguinPublicPageIsUnavailable(pageText);
  const expectedTitle = normalizedMatchText(input.articleTitle || input.title);
  const expectedBody = normalizedMatchText(input.contentMarkdown || input.content || input.richText);
  const normalizedPageTitle = normalizedMatchText(`${pageTitle}\n${bodyText}`);
  const titleMatched = !unavailable && Boolean(expectedTitle && normalizedPageTitle.includes(expectedTitle));
  const bodyMatched = !unavailable && (!expectedBody || penguinRenderedBodyMatches(input.contentMarkdown || input.content || input.richText, bodyText, input.articleTitle || input.title));

  return {
    found: titleMatched && bodyMatched,
    publicUrl,
    publishedUrl: publicUrl,
    pageText,
    pageTitle,
    unavailable,
    titleMatched,
    bodyMatched,
    ...(imagePublicationEvidence ? { imagePublicationEvidence } : {}),
  };
}

async function inspectPenguinPublicArticleAnonymously(browserType, input = {}) {
  let launcher = browserType;
  if (!launcher?.launch) {
    const chromium = await importPlaywrightChromium();
    launcher = chromium;
  }
  const browser = await launcher.launch({
    headless: input.publicVerificationHeadless !== false,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: "zh-CN" });
  const page = await context.newPage();
  try {
    return await inspectPenguinPublicArticle(page, input);
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

function notifyPublishProgress(input = {}, event = {}) {
  if (typeof input.onProgress !== "function") return;
  input.onProgress(event);
}

function penguinArticleIdFromUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const pathMatch = raw.match(/\/s\/article\/([^/?#]+)/i);
  if (pathMatch?.[1]) return decodeURIComponent(pathMatch[1]);
  try {
    const parsed = new URL(raw);
    const queryId = parsed.searchParams.get("articleId") || parsed.searchParams.get("id");
    if (queryId) return queryId;
  } catch {
    // Ignore non-URL discovery inputs.
  }
  return "";
}

export function penguinArticleIdFromDiscoveryInput(input = {}) {
  // The management list API is keyed by the platform's own article id, while the
  // discover command payload carries ZhiXin's internal article id in
  // ``articleId`` and the creator review URL in ``publicUrl``. URL sources must
  // therefore be resolved first, otherwise every lookup compares an internal id
  // against platform records and reports record: null forever.
  const urlSources = [input.reviewUrl, input.draftUrl, input.publicUrl, input.publishedUrl];
  for (const value of urlSources) {
    const urlId = penguinArticleIdFromUrl(value);
    if (urlId) return urlId;
  }
  // An order whose reviewUrl was already persisted from an earlier anonymous pass
  // hands the next discover command the public page URL in both publicUrl and
  // reviewUrl. Polling is useless there: the list API is keyed by platform ids, so
  // the internal article id this payload falls back to can never match a record,
  // and the command only burns itself reporting PUBLIC_URL_NOT_DISCOVERED. Return
  // "" so discovery verifies the public page it was already handed instead.
  if (urlSources.some((value) => normalizePenguinPublishedUrl(value))) return "";
  return cleanText(input.articleId || input.externalIds?.articleId || "");
}

export class PenguinAdapter extends ContentPlatformAdapter {
  constructor(options = {}) {
    super(contentPlatformConfigs.penguin, options);
    this.config = contentPlatformConfigs.penguin;
    this.platform = "penguin";
  }

  async discoverPublication(input = {}) {
    const context = await this.launchAuthEnvironment(input);
    const page = context.pages()[0] || await context.newPage();
    let authenticatedResult;
    try {
      const articleId = penguinArticleIdFromDiscoveryInput(input);
      if (articleId) {
        const platformConfig = input.platformConfig && typeof input.platformConfig === "object" ? input.platformConfig : {};
        const review = await pollPenguinArticleStatus(page, articleId, {
          timeoutMs: input.reviewPollTimeoutMs ?? 0,
          pollIntervalMs: input.reviewPollIntervalMs ?? 2500,
          listApiUrl: platformConfig.articleListApiUrl || PENGUIN_ARTICLE_LIST_API_URL,
        });
        if (review.status !== "1" || !review.publicCandidateUrl) {
          return {
            found: false,
            publishedUrl: "",
            publicUrl: "",
            reviewUrl: normalizePenguinPublishedUrl(review.record?.url || "") || "",
            platformStatus: review.rejected ? "rejected" : "submitted_for_review",
            reviewStatus: review.rejected ? "rejected" : "pending_public_visibility",
            managementStatus: review.status,
            externalIds: { articleId },
            publicationEvidence: sanitizeApiEvidence({ source: "api", review }),
          };
        }
        authenticatedResult = { publicUrl: review.publicCandidateUrl, publishedUrl: review.publicCandidateUrl };
      } else {
        authenticatedResult = await inspectPenguinPublicArticle(page, input);
      }
    } finally {
      await this.refreshCredentialAfterOperation(input, context, page, PENGUIN_EDITOR_URL);
      if (!input.keepBrowserOpen) await context.close().catch(() => undefined);
    }

    let browserType = this.browser;
    if (!browserType?.launch) {
      const chromium = await importPlaywrightChromium();
      browserType = chromium;
    }
    const anonymousBrowser = await browserType.launch({
      headless: input.publicVerificationHeadless !== false,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    const anonymousContext = await anonymousBrowser.newContext({
      viewport: { width: 1360, height: 900 },
      locale: "zh-CN",
    });
    const anonymousPage = await anonymousContext.newPage();
    try {
      return await inspectPenguinPublicArticle(anonymousPage, {
        ...input,
        publicUrl: authenticatedResult.publicUrl || authenticatedResult.publishedUrl || "",
        publishedUrl: "",
        reviewUrl: "",
      });
    } finally {
      await anonymousContext.close().catch(() => undefined);
      await anonymousBrowser.close().catch(() => undefined);
    }
  }

  async publishArticle(input = {}) {
    const publishInput = normalizePublishInput(input);
    const context = await this.launchAuthEnvironment(input);
    const page = context.pages()[0] || await context.newPage();
    const keepOpen = Boolean(input.keepBrowserOpen);
    const watcher = watchPenguinPublishApiResponses(page);
    try {
      page.setDefaultTimeout?.(15000);
      page.setDefaultNavigationTimeout?.(45000);
      const editorCandidates = input.editorUrl
        ? [input.editorUrl]
        : PENGUIN_EDITOR_URL_FALLBACKS;
      let opened = false;
      for (const editorUrl of editorCandidates) {
        await page.goto(editorUrl, { waitUntil: "domcontentloaded" });
        await bringToFrontIfAllowed(page, input);
        await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
        await page.waitForTimeout?.(1500).catch(() => undefined);
        const hasEditor = await page.locator(".ProseMirror, .omui-inputautogrowing__inner[contenteditable='true'], [contenteditable='true']").first().isVisible?.().catch(() => false);
        if (hasEditor) {
          opened = true;
          break;
        }
      }
      if (!opened) {
        await page.goto(PENGUIN_EDITOR_URL, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
      }

      const cookies = await context.cookies([PENGUIN_ORIGIN, "https://graph.qq.com", "https://xui.ptlogin2.qq.com"]);
      const pageState = await readConfiguredPlatformPageState(page);
      if (!hasPenguinStrongCookie(cookies) || !isConfiguredPlatformLoggedIn(this.config, cookies, pageState)) {
        throw new Error("PENGUIN_LOGIN_REQUIRED");
      }

      const openBlocker = await readPenguinPlatformBlocker(page);
      if (openBlocker === "PENGUIN_LOGIN_REQUIRED") throw new Error(openBlocker);
      if (openBlocker) {
        notifyPublishProgress(input, {
          type: "manual_verification_required",
          platform: "penguin",
          message: "\u4f01\u9e45\u53f7\u9700\u8981\u4eba\u5de5\u5904\u7406\u5b89\u5168\u9a8c\u8bc1\u3001\u654f\u611f\u8bcd\u3001\u53d1\u5e03\u4e0a\u9650\u6216\u5e73\u53f0\u5ba1\u6838\u63d0\u793a\u3002",
          currentUrl: typeof page.url === "function" ? page.url() : ""
        });
        throw new Error(openBlocker);
      }

      await fillPenguinTitle(page, publishInput.title);
      await fillPenguinBody(page, publishInput.content, publishInput.richHtml);
      // Nudge ExEditor to treat the document as dirty so save/publish APIs bind.
      await page.locator(".ProseMirror.ExEditor-basic, .ProseMirror").first().click?.().catch(() => undefined);
      await page.keyboard?.type?.(" ").catch(() => undefined);
      await page.keyboard?.press?.("Backspace").catch(() => undefined);
      const uploadedImages = publishInput.platformImageTasks.length
        ? await uploadPenguinInlineImages(page, publishInput.platformImageTasks, { onProgress: input.onProgress })
        : [];
      await choosePenguinDefaults(page, publishInput);
      await ensurePenguinAiDeclaration(page);
      if (publishInput.confirmPublish) {
        const preparedHtml = await readPenguinPreparedEditorHtml(page);
        const platformConfig = input.platformConfig && typeof input.platformConfig === "object" ? input.platformConfig : {};
        const cookieMediaId = cookies.find((cookie) => String(cookie.name || "").toLowerCase() === "userid")?.value || "";
        const cookieCsrfToken = cookies.find((cookie) => /^(?:csrf|csrftoken|csrf_token|x-csrf-token)$/i.test(String(cookie.name || "")))?.value || "";
        const csrfToken = input.csrfToken || platformConfig.csrfToken || cookieCsrfToken || await readPenguinCsrfToken(page);
        const configuredMediaId = input.mediaId || platformConfig.mediaId || (/^\d+$/.test(cookieMediaId) ? cookieMediaId : "");
        const mediaId = await resolvePenguinMediaId(page, {
          mediaId: configuredMediaId,
          csrfToken,
          accountApiUrl: platformConfig.accountIdApiUrl || PENGUIN_ACCOUNT_ID_API_URL,
        });
        const apiResult = await publishPenguinViaCapturedApi(page, context, {
          title: publishInput.title,
          richHtml: preparedHtml || publishInput.richHtml || penguinHtmlFromText(publishInput.content),
          uploadedImages,
          coverUrl: firstPenguinImageUrlFromHtml(preparedHtml),
          categoryId: input.categoryId || input.category_id || platformConfig.categoryId || platformConfig.category_id || "",
          mediaId,
          selfDeclare: input.selfDeclare ?? platformConfig.selfDeclare,
          csrfToken,
          saveApiUrl: platformConfig.omSaveApiUrl || platformConfig.omSaveUrl || PENGUIN_OM_SAVE_API_URL,
          publishApiUrl: platformConfig.omPublishApiUrl || platformConfig.omPublishUrl || PENGUIN_OM_PUBLISH_API_URL,
        });
        const draftImageEvidence = publishInput.platformImageTasks.length
          ? buildImagePublicationEvidence(publishInput.platformImageTasks, uploadedImages, uploadedImages, [], PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED)
          : undefined;
        const articleId = apiResult.externalIds.articleId;
        input.evidenceSink?.({ externalIds: { articleId }, platformStatus: "submitted_for_review" });
        const review = await pollPenguinArticleStatus(page, articleId, {
          timeoutMs: input.reviewPollTimeoutMs ?? 15000,
          pollIntervalMs: input.reviewPollIntervalMs ?? 2500,
          listApiUrl: platformConfig.articleListApiUrl || PENGUIN_ARTICLE_LIST_API_URL,
        });
        const publicationEvidence = sanitizeApiEvidence({
          ...apiResult.publicationEvidence,
          review: {
            status: review.status,
            pending: Boolean(review.pending),
            rejected: Boolean(review.rejected),
            previousStatuses: review.previousStatuses,
            record: review.record,
          },
        });
        if (review.rejected) {
          const error = new Error("PENGUIN_REVIEW_REJECTED");
          error.apiResponse = review.record;
          throw error;
        }
        if (review.status === "1" && review.publicCandidateUrl) {
          const publicResult = await inspectPenguinPublicArticleAnonymously(this.browser, {
            publicUrl: review.publicCandidateUrl,
            articleTitle: publishInput.title,
            contentMarkdown: publishInput.content,
            imagePublicationEvidence: draftImageEvidence,
            publicVerificationHeadless: input.publicVerificationHeadless,
          }).catch(() => null);
          if (publicResult?.found && (!publicResult.imagePublicationEvidence || publicResult.imagePublicationEvidence.status === "verified")) {
            const publishedResult = {
              ...apiResult,
              draftUrl: penguinDraftUrlFromArticleId(articleId),
              publishedUrl: publicResult.publicUrl,
              backlinkUrl: publicResult.publicUrl,
              reviewUrl: "",
              platformStatus: "published",
              publiclyVisible: true,
              publicVerified: true,
              reviewStatus: "public",
              publicationEvidence: sanitizeApiEvidence({
                ...publicationEvidence,
                public: {
                  endpoint: publicResult.publicUrl,
                  titleMatched: publicResult.titleMatched === true,
                  bodyMatched: publicResult.bodyMatched === true,
                  imageCount: publicResult.imagePublicationEvidence?.public?.verifiedCount || 0,
                },
              }),
              ...(publicResult.imagePublicationEvidence ? { imagePublicationEvidence: publicResult.imagePublicationEvidence } : {}),
            };
            if (input.cleanupTestArticle === true) {
              const cleanup = await deletePenguinArticle(page, articleId, {
                deleteApiUrl: platformConfig.deleteApiUrl || PENGUIN_DELETE_API_URL,
                referer: PENGUIN_MANAGE_URL,
              });
              publishedResult.testCleanup = {
                deleted: cleanup.deleted === true,
                articleId: cleanup.articleId,
                publicationEvidence: sanitizeApiEvidence(cleanup.publicationEvidence),
              };
            }
            return publishedResult;
          }
        }
        return {
          ...apiResult,
          reviewUrl: review.publicCandidateUrl || apiResult.reviewUrl,
          publicationEvidence,
          ...(draftImageEvidence ? { imagePublicationEvidence: draftImageEvidence } : {}),
          message: "Penguin accepted the article and it is pending review or anonymous public verification.",
        };
      }
      await clickPenguinDraftSave(page, publishInput.draftTimeoutMs, watcher.state);
      if (!watcher.state.saveSucceeded && !watcher.state.articleId) {
        // Retry one dirty-nudge + save cycle before failing hard.
        await page.locator(".ProseMirror.ExEditor-basic, .ProseMirror").first().click?.().catch(() => undefined);
        await page.keyboard?.type?.(".").catch(() => undefined);
        await page.keyboard?.press?.("Backspace").catch(() => undefined);
        await clickPenguinDraftSave(page, publishInput.draftTimeoutMs, watcher.state);
      }
      if (!watcher.state.saveSucceeded && !watcher.state.articleId) {
        throw new Error("PENGUIN_SAVE_NOT_CONFIRMED");
      }
      let draftUrl = watcher.state.draftUrl;
      if (publishInput.platformImageTasks.length || !publishInput.confirmPublish) {
        draftUrl = await waitForPenguinDraftUrl(watcher.state, page, publishInput.draftTimeoutMs);
      } else if (!draftUrl) {
        const currentUrl = typeof page.url === "function" ? String(page.url() || "") : "";
        draftUrl = /[?&]id=/i.test(currentUrl) ? currentUrl : "";
      }
      let draftImages = [];
      if (publishInput.platformImageTasks.length) {
        await input.onProgress?.({ type: "verifying_draft_images", total: publishInput.platformImageTasks.length });
        // Prefer in-place draft verification. Navigating to a generic create URL without an
        // article id reloads a blank editor and falsely fails draft image checks.
        const currentUrl = typeof page.url === "function" ? String(page.url() || "") : "";
        const canReloadDraft = penguinDraftUrlHasArticleId(draftUrl)
          && draftUrl
          && draftUrl !== currentUrl;
        if (canReloadDraft) {
          await page.goto(draftUrl, { waitUntil: "domcontentloaded" });
          await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
        } else {
          await page.waitForTimeout?.(1500).catch(() => undefined);
        }
        let reloadedImages = [];
        try {
          reloadedImages = await waitForPenguinEditorImages(
            page,
            publishInput.platformImageTasks.length,
            Math.max(publishInput.draftTimeoutMs, 45000)
          );
        } catch (error) {
          reloadedImages = penguinDraftImagesFromUploadedFallback(publishInput.platformImageTasks, uploadedImages);
          if (!reloadedImages.length) throw error;
          await input.onProgress?.({
            type: "draft_image_verification_fallback",
            platform: "penguin",
            expectedCount: publishInput.platformImageTasks.length,
            observedCount: reloadedImages.length,
          });
        }
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
          draftUrl: draftUrl || watcher.state.draftUrl || "",
          publishedUrl: "",
          platformStatus: "draft_saved",
          title: publishInput.title,
          ...(draftImageEvidence ? { imagePublicationEvidence: draftImageEvidence } : {}),
        };
      }
    } finally {
      watcher.dispose();
      await this.refreshCredentialAfterOperation(input, context, page, PENGUIN_EDITOR_URL);
      if (!keepOpen) await context.close().catch(() => undefined);
    }
  }
}

export async function describeUnavailableButton(locators) {
  const states = await Promise.all(locators.map(async (locator) => {
    try {
      const count = await locator.count?.();
      if (count === 0) return "missing";
      const visible = await locator.isVisible?.();
      if (visible === false) return count > 0 ? "hidden" : "unknown";
      if (visible !== true) return "unknown";
      const disabled = await locator.isDisabled?.();
      return disabled === true ? "disabled" : "unknown";
    } catch { return "unknown"; }
  }));
  return ["disabled", "hidden", "unknown", "missing"].find((state) => states.includes(state)) || "unknown";
}
