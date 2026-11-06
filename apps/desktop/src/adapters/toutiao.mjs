import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ContentPlatformAdapter,
  contentPlatformConfigs,
  isConfiguredPlatformLoggedIn,
  readConfiguredPlatformPageState,
} from "./content-platform.mjs";
import { pasteImageFile, positionCursorAfterSection, readLocatorImages, readPublicPageBlockerFromPage, uploadPlatformImages, verifyPlatformImages, verifyPublicImageEvidence } from "../editor-image-upload.mjs";
import { buildImagePublicationEvidence, PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED, isPersistentPlatformImageUrl } from "../platform-images.mjs";
import { platformApiFetch } from "./platform-api.mjs";
import { bringToFrontIfAllowed } from "../browser-visibility.mjs";

const TOUTIAO_ORIGIN = "https://mp.toutiao.com";
const TOUTIAO_EDITOR_URL = "https://mp.toutiao.com/profile_v4/graphic/publish";
const TOUTIAO_PUBLISH_PATH = "/mp/agw/article/publish";
const TOUTIAO_PUBLIC_IMAGE_SELECTOR = [
  "article img",
  ".article-content img",
  ".tt-article-content img",
  "img[src*='toutiaoimg.com']",
  "img[src*='byteimg.com']",
  "img[src*='pstatp.com']",
].join(", ");

const TOUTIAO_TITLE_FIELD_SELECTORS = [
  "textarea[placeholder*='\u8bf7\u8f93\u5165\u6587\u7ae0\u6807\u9898']",
  "textarea[placeholder*='2\uff5e30']",
  "textarea[placeholder*='2~30']",
  "textarea[placeholder*='\u6807\u9898']",
  "textarea.article-title",
  "input[placeholder*='\u6807\u9898']",
  "textarea[name='title']",
  "input[name='title']",
  ".title-container textarea",
  ".title-container input",
];
const TOUTIAO_EDITOR_SURFACE_SELECTOR = ".ProseMirror, .ql-editor, [contenteditable='true']";
const TOUTIAO_BODY_EDITOR_SELECTORS = [
  ".ProseMirror[contenteditable='true']",
  ".ql-editor[contenteditable='true']",
  "[contenteditable='true']:not([class*='title'])",
];
const TOUTIAO_SAVE_TOAST_SELECTORS = [
  "[class*='toast' i]",
  "[class*='Toast']",
  "[class*='snackbar' i]",
  "[class*='notification' i]",
];
// A toast element is the only trustworthy local "saved" signal. Matching the whole
// body text always succeeded on the save button's own label, so the draft save was
// never actually waited for.
const TOUTIAO_SAVE_TOAST_PATTERN = /\u4fdd\u5b58\u6210\u529f|\u5df2\u4fdd\u5b58|\u4fdd\u5b58\u5b8c\u6bd5|\u8349\u7a3f\u5df2\u4fdd\u5b58|saved successfully|draft saved/i;
// Article-scoped URL params. pgc_id is deliberately absent: it is the PGC
// (account) id, so a draft URL built from it opens a new empty article.
const TOUTIAO_ARTICLE_ID_URL_PARAMS = ["article_id", "pgc_article_id", "group_id", "item_id"];
// The only save-button labels that may be clicked. A loose "草稿" match also
// caught navigation targets such as 草稿箱, and leaving the editor to visit the
// draft box loses the article that still only exists inside the page.
const TOUTIAO_SAVE_BUTTON_LABELS = ["存草稿", "保存草稿", "Save Draft"];
// Mining keys for draft identity: exactly the URL params that reopen the article.
// pgc_id names the account and a bare "id" is ambiguous (author/comment/user ids
// share the key), so both are excluded from mining and kept for diagnostics only.
const TOUTIAO_DRAFT_ARTICLE_ID_KEYS = [...TOUTIAO_ARTICLE_ID_URL_PARAMS];

// Ids only for diagnostics. The strict mining keys above deliberately exclude
// both of these: pgc_id names the account, and a bare "id" is shared by author,
// comment and user objects, so either can masquerade as the article id.
const TOUTIAO_ID_DIAGNOSTIC_KEYS = [...TOUTIAO_ARTICLE_ID_URL_PARAMS, "id", "pgc_id"];

export async function uploadToutiaoInlineImages(page, tasks = [], options = {}) {
  if (!tasks.length) return [];
  const editor = page.locator(".ProseMirror[contenteditable='true'], .ProseMirror").first();
  return uploadPlatformImages({
    tasks,
    readImages: () => readLocatorImages(page, ".ProseMirror img"),
    positionForTask: (task) => positionCursorAfterSection(editor, task),
    selectFile: async (task) => {
      // Prefer native toolbar upload; fall back to ProseMirror paste/drop for Syl editor variants.
      let uploadedViaToolbar = false;
      let toolbarFailureReason = "";
      try {
        const tool = page.locator(".syl-toolbar-tool.image").first();
        const toolButton = page.locator(".syl-toolbar-tool.image .syl-toolbar-button, .syl-toolbar-tool.image button, .syl-toolbar-tool.image").first();
        const fileChooserPromise = typeof page.waitForEvent === "function"
          ? page.waitForEvent("filechooser", { timeout: 4000 }).catch(() => null)
          : Promise.resolve(null);
        await tool.scrollIntoViewIfNeeded?.().catch(() => undefined);
        await toolButton.click({ timeout: 3000 });
        const fileInput = page.locator(
          ".upload-image-panel input[type='file'], .syl-toolbar-tool.image input[type='file'], input[type='file'][accept*='image']"
        ).first();
        if (await fileInput.count?.().catch(() => 0)) {
          await fileInput.setInputFiles(task.path);
        } else {
          const chooser = await fileChooserPromise;
          if (!chooser) throw new Error("TOUTIAO_IMAGE_FILE_INPUT_NOT_FOUND");
          await chooser.setFiles(task.path);
        }
        const material = page.locator(
          ".upload-image-wrapper img, .upload-image-panel img[src*='image-tt-private'], .upload-image-panel img[src*='toutiao']"
        ).last();
        await material.waitFor?.({ state: "visible", timeout: 20000 });
        await material.click();
        const confirm = page.locator(
          ".upload-image-panel button:has-text('确定'), .upload-image-panel button:has-text('确认'), .upload-image-panel button:has-text('完成')"
        ).first();
        if (!(await confirm.isVisible?.().catch(() => false))) throw new Error("TOUTIAO_IMAGE_CONFIRM_NOT_FOUND");
        await confirm.click();
        uploadedViaToolbar = true;
      } catch (error) {
        uploadedViaToolbar = false;
        toolbarFailureReason = String(error?.message || error || "toolbar_upload_failed").slice(0, 200);
      }
      if (!uploadedViaToolbar) {
        // The toolbar failure used to be swallowed, so a run could end with
        // {status: "pending", observedCount: 0} and no hint why. Keep the reason
        // and make the fallback visible in the upload evidence.
        const toolbarFailure = String(toolbarFailureReason || "").slice(0, 200);
        await options.onProgress?.({
          type: "uploading_image_fallback",
          assetId: task.assetId || "",
          sectionId: task.sectionId || "",
          toolbarFailure,
        });
        const pasted = await pasteImageFile(editor, task.path);
        if (!pasted) {
          const reason = toolbarFailure || "TOUTIAO_IMAGE_PASTE_DISPATCH_FAILED";
          await options.onProgress?.({
            type: "uploading_image_failed",
            assetId: task.assetId || "",
            sectionId: task.sectionId || "",
            reason,
          });
          throw new Error(`TOUTIAO_IMAGE_UPLOAD_FAILED ${reason}`);
        }
      }
    },
    onProgress: options.onProgress,
    timeoutMs: options.timeoutMs || 90000,
  });
}

export async function readToutiaoEditorImages(page) {
  const images = await readLocatorImages(page, ".ProseMirror img");
  return [...new Map(images.map((image) => [image.platformImageUrl, image])).values()];
}

export function toutiaoDraftUrlFromArticleId(articleId) {
  const value = String(articleId || "").trim();
  return value ? `${TOUTIAO_EDITOR_URL}?pgc_id=${encodeURIComponent(value)}` : TOUTIAO_EDITOR_URL;
}

// Ordered draft URL guesses. The first one that actually reopens our article wins;
// every other guess is recorded in the reload receipts so the next real run tells
// us which form Toutiao really uses.
function toutiaoDraftUrlCandidates(state = {}, page = null, accountPgcId = "", draftUrl = "") {
  const articleId = cleanText(state?.draftArticleId || "");
  const account = cleanText(accountPgcId);
  // An account-only URL reopens a brand new empty article, so once the platform
  // failed to expose an article-scoped id the recorded URLs are known-invalid
  // candidates and must not be retried. This is the second gate: the first one
  // keeps them out of the state in the first place.
  const accountOnly = state?.draftUrlAccountOnly === true;
  const urls = [];
  const push = (url) => {
    const value = cleanText(url);
    if (!value || urls.includes(value)) return;
    // Even outside the account-only state, a URL that names only the known
    // account pgc id is a known-invalid candidate; one with an unknown pgc id
    // may still be the article, so it stays.
    if (!toutiaoArticleScopedUrl(value) && account && toutiaoPgcIdFromUrl(value) === account) return;
    urls.push(value);
  };
  // An id that names the account identifies no article: the account-scoped guess
  // is dropped by the gate above, and the article-scoped one would carry the
  // account id into ?article_id= and reopen something unrelated. Offer neither.
  if (articleId && articleId !== account) {
    push(`${TOUTIAO_EDITOR_URL}?pgc_id=${encodeURIComponent(articleId)}`);
    push(account && account !== articleId
      ? `${TOUTIAO_EDITOR_URL}?pgc_id=${encodeURIComponent(account)}&article_id=${encodeURIComponent(articleId)}`
      : `${TOUTIAO_EDITOR_URL}?article_id=${encodeURIComponent(articleId)}`);
  }
  if (!accountOnly) {
    push(draftUrl);
    push(state?.draftUrl);
  }
  const currentUrl = typeof page?.url === "function" ? String(page.url() || "") : "";
  push(toutiaoArticleScopedUrl(currentUrl));
  return urls.slice(0, 3);
}

export async function waitForToutiaoDraftUrl(state, page, timeoutMs = 30000, pollMs = 250) {
  const options = pollMs && typeof pollMs === "object" ? pollMs : { pollMs };
  const pollIntervalMs = Math.max(1, Number(options.pollMs || 250));
  const accountPgcId = cleanText(options.accountPgcId || "");
  // The editor URL carries the account pgc id from the moment it loads, so give the
  // platform a short bounded chance to publish an article-scoped id before settling
  // for the account-only editor URL.
  const scopedDeadline = Date.now() + Math.max(0, Number(options.scopedWaitMs ?? 1500));
  const deadline = Date.now() + Math.max(1, Number(timeoutMs || 30000));
  do {
    if (state?.draftUrl) return state.draftUrl;
    const currentUrl = typeof page?.url === "function" ? String(page.url() || "") : "";
    const scoped = toutiaoArticleScopedUrl(currentUrl);
    if (scoped) return scoped;
    if (typeof page?.waitForTimeout === "function") await page.waitForTimeout(pollIntervalMs);
    else await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  } while (Date.now() < deadline);
  // The editor URL always carries the account pgc id, so settling for it would
  // hand the caller a candidate known to reopen an empty article. Report the
  // miss instead: the caller then sees TOUTIAO_DRAFT_URL_MISSING ("no article id
  // was ever captured") rather than DRAFT_EDITOR_LOST ("the draft was reopened
  // and lost"), which are two very different failures.
  if (state) state.draftUrlAccountOnly = true;
  return "";
}

export async function waitForToutiaoEditorImages(page, expectedCount, timeoutMs = 30000, pollMs = 250) {
  const expected = Math.max(0, Number(expectedCount || 0));
  const deadline = Date.now() + Math.max(1, Number(timeoutMs || 30000));
  let images = [];
  do {
    images = await readToutiaoEditorImages(page);
    const persistent = images.filter((image) => (
      isPersistentPlatformImageUrl(image.platformImageUrl) && image.loaded !== false
    ));
    if (persistent.length >= expected) return persistent;
    if (typeof page?.waitForTimeout === "function") await page.waitForTimeout(pollMs);
    else await new Promise((resolve) => setTimeout(resolve, pollMs));
  } while (Date.now() < deadline);
  const editorState = await readToutiaoEditorState(page).catch(() => null);
  throw new Error(describeToutiaoDraftImageGap(expected, editorState || { images }));
}

async function sleepInToutiaoPage(page, ms) {
  const wait = Math.max(0, Number(ms || 0));
  if (typeof page?.waitForTimeout === "function") {
    await page.waitForTimeout(wait).catch(() => undefined);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, wait));
}

async function readToutiaoEditorFieldText(page, selectors) {
  if (typeof page?.locator !== "function") return "";
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (typeof locator.isVisible === "function" && !(await locator.isVisible().catch(() => false))) continue;
    let text = "";
    if (typeof locator.inputValue === "function") text = await locator.inputValue().catch(() => "") || "";
    if (!text && typeof locator.innerText === "function") text = await locator.innerText().catch(() => "") || "";
    text = cleanText(text);
    if (text) return text;
  }
  return "";
}

export async function readToutiaoEditorState(page) {
  const images = await readToutiaoEditorImages(page).catch(() => []);
  const state = { editorPresent: false, editorText: "", titleFieldText: "", images };
  if (typeof page?.locator !== "function") return state;
  const surface = page.locator(TOUTIAO_EDITOR_SURFACE_SELECTOR).first();
  let surfaceCount = 0;
  if (typeof surface.count === "function") surfaceCount = await surface.count().catch(() => 0) || 0;
  state.editorPresent = surfaceCount > 0
    || (typeof surface.isVisible === "function" ? await surface.isVisible().catch(() => false) : false);
  state.titleFieldText = await readToutiaoEditorFieldText(page, TOUTIAO_TITLE_FIELD_SELECTORS);
  state.editorText = await readToutiaoEditorFieldText(page, TOUTIAO_BODY_EDITOR_SELECTORS);
  return state;
}

function toutiaoTextsOverlap(expected, actual, minChars = 8) {
  const left = normalizedMatchText(expected);
  const right = normalizedMatchText(actual);
  if (!left || !right) return false;
  if (left.includes(right) || right.includes(left)) return true;
  const probe = left.slice(0, Math.min(20, left.length));
  return probe.length >= minChars && right.includes(probe);
}

// Decides whether a reloaded editor page is still the article we just wrote. A
// draft URL that named the account instead of the article opens an empty editor,
// and the old code read that empty editor as "the images went missing".
export function toutiaoEditorHoldsArticle(state = {}, publishInput = {}) {
  if (!state || state.editorPresent !== true) return false;
  const titleField = String(state.titleFieldText || "");
  const body = String(state.editorText || "");
  if (titleField && !toutiaoTextsOverlap(publishInput?.title || "", titleField, 4)) return false;
  if (body && publishInput?.content) return toutiaoTextsOverlap(publishInput.content, body, 12);
  return Boolean(body || titleField);
}

// Keeps the DRAFT_IMAGE_MISSING prefix the platform runbooks and service side
// already match on, then adds the counts that tell "image upload lost it" apart
// from "this editor page is not our article at all".
export function describeToutiaoDraftImageGap(expectedCount, state = {}) {
  const expected = Math.max(0, Number(expectedCount || 0));
  const images = Array.isArray(state?.images) ? state.images : [];
  const persistent = images.filter((image) => (
    isPersistentPlatformImageUrl(image?.platformImageUrl) && image?.loaded !== false
  ));
  const imageText = persistent
    .slice(0, 4)
    .map((image) => `${image.platformImageUrl}${image.loaded === false ? "[unloaded]" : "[loaded]"}`)
    .join(";");
  return [
    "DRAFT_IMAGE_MISSING",
    `expected=${expected}`,
    `actual=${persistent.length}`,
    `editorImages=${images.length}`,
    `editor=${state?.editorPresent === true}`,
    `titleField=${cleanText(state?.titleFieldText) ? "present" : "empty"}`,
    `bodyTextLen=${String(state?.editorText || "").length}`,
    `images=${imageText || "none"}`,
  ].join(":");
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizePublishInput(input = {}) {
  let title = cleanText(input.articleTitle || input.title);
  const content = cleanText(input.contentMarkdown || input.content || input.body || input.markdown);
  if (!title) throw new Error("TOUTIAO_TITLE_REQUIRED");
  // Live editor enforces 2-30 Chinese characters for the title field.
  if (title.length > 30) title = title.slice(0, 30);
  if (title.length < 2) throw new Error("TOUTIAO_TITLE_TOO_SHORT");
  if (!content || content.length < 10) throw new Error("TOUTIAO_CONTENT_REQUIRED");
  return {
    title,
    content,
    richHtml: String((input.platformImageTasks?.length ? input.contentHtmlWithoutImages : input.contentHtml) || "").trim(),
    platformImageTasks: Array.isArray(input.platformImageTasks) ? input.platformImageTasks : [],
    category: cleanText(input.category || input.categoryName || ""),
    coverImagePath: cleanText(input.coverImagePath || input.coverPath || ""),
    confirmPublish: input.confirmPublish === true || input.publishMode === "publish",
    draftTimeoutMs: Number(input.draftTimeoutMs || 30000),
    draftAutoSaveProbeMs: Math.max(0, Number(input.draftAutoSaveProbeMs || 6000)),
    publishTimeoutMs: Number(input.publishTimeoutMs || 60000),
    draftImageVerifyAttempts: Math.max(1, Number(input.draftImageVerifyAttempts || 2)),
    draftImageRetryDelayMs: Math.max(0, Number(input.draftImageRetryDelayMs || 2000)),
    draftEditorSettleMs: Math.max(1000, Number(input.draftEditorSettleMs || 6000)),
    draftManageLookupMs: Math.max(250, Number(input.draftManageLookupMs || 6000)),
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

function normalizeToutiaoArticleId(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : "";
  }
  const normalized = String(value || "").trim();
  return normalized && normalized !== "0" ? normalized : "";
}

export function findToutiaoArticleId(value) {
  if (!value || typeof value !== "object") return "";
  // Article-scoped ids first; pgc_id names the account and is only the last
  // resort, so a payload carrying both never reports the account as the article.
  for (const key of ["article_id", "pgc_article_id", "group_id", "item_id", "id", "pgc_id"]) {
    const direct = normalizeToutiaoArticleId(value[key]);
    if (direct) return direct;
  }
  for (const item of Object.values(value)) {
    if (item && typeof item === "object") {
      const nested = findToutiaoArticleId(item);
      if (nested) return nested;
    }
  }
  return "";
}

// Draft identity is not the PGC (account) id. Toutiao's editor URL already carries
// ?pgc_id=<account>, so a draft URL built from a pgc_id reopens a brand new empty
// article instead of the draft that was just saved. Prefer the article-scoped ids
// and never fall back to pgc_id at all: the account ids are collected from the
// whole payload first, so a draft id is either article-scoped or there is none.
export function findToutiaoDraftArticleId(value, accountPgcId = "") {
  if (!value || typeof value !== "object") return "";
  const excluded = new Set([cleanText(accountPgcId)].filter(Boolean));
  // Every pgc_id in the payload names an account, at any depth, and none of them
  // is ever the article id. Collecting them up front is what stops a nested
  // account id from being mined as the draft and built into a reopen URL.
  const collectAccountIds = (node) => {
    if (!node || typeof node !== "object") return;
    for (const [key, item] of Object.entries(node)) {
      if (key === "pgc_id") {
        const normalized = normalizeToutiaoArticleId(item);
        if (normalized) excluded.add(normalized);
      } else if (item && typeof item === "object") {
        collectAccountIds(item);
      }
    }
  };
  collectAccountIds(value);
  const search = (node) => {
    if (!node || typeof node !== "object") return "";
    for (const key of TOUTIAO_DRAFT_ARTICLE_ID_KEYS) {
      const direct = normalizeToutiaoArticleId(node[key]);
      if (direct && !excluded.has(direct)) return direct;
    }
    for (const item of Object.values(node)) {
      if (item && typeof item === "object") {
        const nested = search(item);
        if (nested) return nested;
      }
    }
    return "";
  };
  return search(value);
}

export function toutiaoPgcIdFromUrl(url = "") {
  const match = /[?&]pgc_id=(\d+)/i.exec(String(url || ""));
  return match ? match[1] : "";
}

function toutiaoArticleScopedUrl(url = "") {
  const value = String(url || "").toLowerCase();
  for (const param of TOUTIAO_ARTICLE_ID_URL_PARAMS) {
    const needle = `${param}=`;
    if (value.includes(`?${needle}`) || value.includes(`&${needle}`)) return String(url || "");
  }
  return "";
}

// The editor URL is the second place a fresh article id shows up, and it is the
// only one left when the save response carries none. pgc_id never counts here:
// it names the account, and a draft URL built from it opens a new empty article.
export function toutiaoDraftArticleIdFromUrl(url = "", accountPgcId = "") {
  const value = String(url || "");
  if (!value) return "";
  const account = cleanText(accountPgcId);
  for (const param of TOUTIAO_ARTICLE_ID_URL_PARAMS) {
    const match = new RegExp(`[?&]${param}=(\\d+)`, "i").exec(value);
    const articleId = normalizeToutiaoArticleId(match?.[1]);
    if (articleId && (!account || articleId !== account)) return articleId;
  }
  return "";
}

// Fills the watcher's draft identity from the page URL only while it is still
// empty, so an id the platform returned in a save response is never overwritten.
function captureToutiaoDraftArticleId(watcher, url, accountPgcId = "") {
  if (!watcher?.state || watcher.state.draftArticleId) return "";
  const articleId = toutiaoDraftArticleIdFromUrl(url, accountPgcId);
  if (!articleId) return "";
  watcher.state.draftArticleId = articleId;
  watcher.state.draftUrl = toutiaoDraftUrlFromArticleId(articleId);
  watcher.state.draftUrlAccountOnly = false;
  return articleId;
}

export function toutiaoApiPayloadSucceeded(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.success === false) return false;
  const explicitCode = payload.code ?? payload.status_code ?? payload.err_no;
  if (explicitCode !== undefined && ![0, "0", 200, "200"].includes(explicitCode)) return false;
  if ([0, "0", 200, "200"].includes(explicitCode) || payload.success === true) return true;
  return Boolean(
    findToutiaoArticleId(payload)
    || normalizeToutiaoPublishedUrl(payload.url || payload.href || payload.article_url || payload.link || "")
  );
}

export function toutiaoPublishEndpointIsMutation(url = "") {
  try {
    return /\/mp\/agw\/article\/publish\/?$/i.test(new URL(String(url)).pathname);
  } catch {
    return false;
  }
}

function toutiaoArticleEndpointIsMutation(url = "") {
  try {
    return /\/mp\/agw\/article\/(?:new|edit|publish)\/?$/i.test(new URL(String(url)).pathname);
  } catch {
    return false;
  }
}

// Save-form endpoints (save/draft/create) can carry the article id too, and a
// save that lands on one of them used to leave the draft unidentified. The wider
// gate is only for id capture: the save-confirmation signal (mutationCount) stays
// on the strict gate, where it is known to be reliable.
function toutiaoArticleEndpointCarriesDraftId(url = "") {
  try {
    return /\/mp\/agw\/article\/(?:new|edit|save|draft|create|publish)\/?$/i.test(new URL(String(url)).pathname);
  } catch {
    return false;
  }
}

export function toutiaoPayloadRequiresManualAction(payload) {
  if (!payload || typeof payload !== "object" || toutiaoApiPayloadSucceeded(payload)) return false;
  const errorMetadata = [
    payload.message,
    payload.msg,
    payload.reason,
    payload.error,
    payload.error_message,
    payload.errorMessage,
    payload.data?.message,
    payload.data?.msg,
    payload.data?.reason,
    payload.data?.error,
  ].filter((value) => value !== undefined && value !== null);
  const text = errorMetadata
    .map((value) => typeof value === "string" ? value : JSON.stringify(value))
    .join(" ");
  return /captcha|security verification|risk control|manual verification|\u9a8c\u8bc1\u7801|\u5b89\u5168\u9a8c\u8bc1|\u62d6\u52a8\u6ed1\u5757|\u626b\u7801\u9a8c\u8bc1|\u98ce\u63a7|\u654f\u611f\u8bcd|\u53d1\u5e03\u4e0a\u9650|\u9891\u7e41/i.test(text);
}

export function normalizeToutiaoPublishedUrl(url = "") {
  try {
    const parsed = new URL(String(url || ""), TOUTIAO_ORIGIN);
    if (!/(^|\.)toutiao\.com$/i.test(parsed.hostname) && !/(^|\.)jinritian\.com$/i.test(parsed.hostname)) return "";
    if (/\/(article|item|group)\/\d+/i.test(parsed.pathname)) return parsed.toString().replace(/^http:/, "https:");
  } catch {
    return "";
  }
  return "";
}

function toutiaoApiConfig(input = {}) {
  const config = input.platformConfig && typeof input.platformConfig === "object" ? input.platformConfig : {};
  return {
    userId: cleanText(config.userId || config.accountId || ""),
    hasCapturedPublishUrl: Boolean(cleanText(config.publishApiUrl || config.publishUrl || "")),
  };
}

function shouldPublishToutiaoViaApi(input = {}, publishInput = {}) {
  if (!publishInput.confirmPublish) return false;
  return Boolean(input.apiFirst === true || toutiaoApiConfig(input).hasCapturedPublishUrl);
}

function toutiaoApiErrorIsTerminal(error) {
  const message = String(error?.message || error || "");
  return /LOGIN_REQUIRED|MANUAL_ACTION_REQUIRED|RUNTIME_SIGNATURE_REQUIRED|AUTH|CAPTCHA|RISK|SECURITY|VERIFY/i.test(message);
}

// Signing tokens ride in the query string of these endpoints, so the remembered
// endpoint keeps only origin and path.
function toutiaoEndpointWithoutQuery(url = "") {
  try {
    const parsed = new URL(String(url));
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "";
  }
}

async function readToutiaoRuntimeRequestFields(page, context) {
  const runtime = await page.evaluate?.(() => {
    const signer = globalThis.byted_acrawler?.sign;
    if (typeof signer !== "function") return null;
    try {
      const signed = signer({ url: "/mp/agw/article/publish" });
      if (!signed || typeof signed !== "object") return null;
      const aBogus = String(signed.a_bogus || signed.aBogus || "").trim();
      return aBogus ? { aBogus } : null;
    } catch {
      return null;
    }
  }).catch(() => null);
  const cookies = await context?.cookies?.([TOUTIAO_ORIGIN]).catch(() => []);
  const msToken = String((cookies || []).find((cookie) => String(cookie?.name || "").toLowerCase() === "mstoken")?.value || "").trim();
  if (!runtime?.aBogus || !msToken) throw new Error("TOUTIAO_RUNTIME_SIGNATURE_REQUIRED");
  return { aBogus: runtime.aBogus, msToken };
}

async function publishToutiaoViaCapturedApi(page, context, input = {}, publishInput = {}) {
  const config = toutiaoApiConfig(input);
  const runtime = await readToutiaoRuntimeRequestFields(page, context);
  const endpoint = new URL(TOUTIAO_PUBLISH_PATH, TOUTIAO_ORIGIN);
  endpoint.searchParams.set("a_bogus", runtime.aBogus);
  endpoint.searchParams.set("msToken", runtime.msToken);
  const result = await platformApiFetch(page, endpoint.toString(), {
    method: "POST",
    form: {
      title: publishInput.title,
      content: publishInput.richHtml || publishInput.content,
      article_type: "0",
      source: config.userId || "zhixin-ai",
      extra: JSON.stringify({
        cover: publishInput.coverImagePath ? "single" : "",
        category: publishInput.category || "",
      }),
    },
    headers: {
      Referer: TOUTIAO_EDITOR_URL,
    },
  });
  if ([401, 403].includes(result.status)) throw new Error("TOUTIAO_LOGIN_REQUIRED");
  if (toutiaoPayloadRequiresManualAction(result.payload)) throw new Error("TOUTIAO_MANUAL_ACTION_REQUIRED");
  const accepted = result.ok && toutiaoApiPayloadSucceeded(result.payload);
  if (!accepted) throw new Error("TOUTIAO_API_PUBLISH_NOT_ACCEPTED");
  const articleId = findToutiaoArticleId(result.payload);
  const reviewUrl = articleId ? toutiaoDraftUrlFromArticleId(articleId) : "";
  if (articleId) input.evidenceSink?.({ externalIds: { articleId }, draftUrl: reviewUrl, platformStatus: "submitted_for_review" });
  return {
    draftUrl: reviewUrl,
    publishedUrl: "",
    reviewUrl,
    platformStatus: "submitted_for_review",
    publiclyVisible: false,
    reviewStatus: "pending_review",
    title: publishInput.title,
    externalIds: {
      articleId,
    },
    publicationEvidence: {
      source: "api",
      accepted,
      httpStatus: result.status,
      endpoint: result.evidence.request.url,
      response: result.evidence.response.payload,
    },
    message: "Toutiao accepted the captured API publish request; public URL still requires review/public-page verification.",
  };
}

export function watchToutiaoApiResponses(page) {
  const state = {
    draftUrl: "",
    draftArticleId: "",
    articleId: "",
    publishedUrl: "",
    blocker: "",
    publishAttempted: false,
    mutationCount: 0,
    lastMutation: "",
    mutationEndpoints: [],
    draftUrlAccountOnly: false,
    idCandidates: [],
  };
  let accountPgcId = "";
  const handler = async (response) => {
    const url = typeof response.url === "function" ? response.url() : "";
    if (!/mp\.toutiao\.com\/.*(article|pgc|publish|save|create|draft)/i.test(url)) return;
    const text = await response.text().catch(() => "");
    const payload = parseJsonLikePayload(text);
    const succeeded = toutiaoApiPayloadSucceeded(payload);
    const carriesDraftId = succeeded && toutiaoArticleEndpointCarriesDraftId(url);
    const articleId = carriesDraftId ? findToutiaoArticleId(payload) : "";
    if (articleId) {
      state.articleId = articleId;
    }
    if (carriesDraftId) {
      // Ids only: never tokens, signatures or request bodies.
      for (const candidate of collectToutiaoIdCandidates(payload)) {
        if (!state.idCandidates.some((known) => known.key === candidate.key && known.id === candidate.id)) {
          state.idCandidates.push(candidate);
        }
      }
      const draftArticleId = findToutiaoDraftArticleId(payload, accountPgcId);
      if (draftArticleId) {
        state.draftArticleId = draftArticleId;
        state.draftUrl = toutiaoDraftUrlFromArticleId(draftArticleId);
        state.draftUrlAccountOnly = false;
      } else if (!state.draftArticleId) {
        // A later id-less autosave ping must not un-identify a draft an earlier
        // response already named.
        state.draftUrlAccountOnly = true;
      }
    }
    if (succeeded && toutiaoArticleEndpointIsMutation(url)) {
      state.mutationCount += 1;
      state.lastMutation = toutiaoEndpointWithoutQuery(url);
    }
    // Which endpoints the editor actually called, query stripped. A save that
    // never yields an article id is only diagnosable if the run remembers where
    // the save went, so this is recorded for every article endpoint, not just
    // the ones that succeeded.
    const mutationEndpoint = toutiaoArticleEndpointCarriesDraftId(url) ? toutiaoEndpointWithoutQuery(url) : "";
    if (mutationEndpoint && !state.mutationEndpoints.includes(mutationEndpoint)) {
      if (state.mutationEndpoints.length < 5) state.mutationEndpoints.push(mutationEndpoint);
    }
    const isPublishCall = toutiaoPublishEndpointIsMutation(url);
    if (isPublishCall && succeeded) state.publishAttempted = true;
    // Never invent a public URL from article id alone. Only accept real public link fields.
    if (isPublishCall && succeeded) {
      const publishedUrl = normalizeToutiaoPublishedUrl(
        payload?.url || payload?.href || payload?.article_url || payload?.link || ""
      );
      if (publishedUrl) state.publishedUrl = publishedUrl;
    }
    if (isPublishCall && toutiaoPayloadRequiresManualAction(payload)) {
      state.blocker = "TOUTIAO_MANUAL_ACTION_REQUIRED";
    }
  };
  if (typeof page.on === "function") page.on("response", handler);
  return {
    state,
    // The editor learns the account pgc id from its own URL only after it loads.
    setAccountPgcId(value) {
      const normalized = cleanText(value);
      if (normalized) accountPgcId = normalized;
    },
    dispose() {
      if (typeof page.off === "function") page.off("response", handler);
    },
  };
}

function collectToutiaoIdCandidates(value, bucket = [], seen = new Set()) {
  if (!value || typeof value !== "object" || bucket.length >= 8) return bucket;
  // Diagnostics keep the ambiguous keys too: when mining finds no draft id, the
  // candidates are the only record of which ids the payload did carry.
  for (const key of TOUTIAO_ID_DIAGNOSTIC_KEYS) {
    const id = normalizeToutiaoArticleId(value[key]);
    if (id && !seen.has(`${key}:${id}`)) {
      seen.add(`${key}:${id}`);
      bucket.push({ key, id });
    }
  }
  for (const item of Object.values(value)) {
    if (item && typeof item === "object") collectToutiaoIdCandidates(item, bucket, seen);
  }
  return bucket;
}

async function fillToutiaoTitle(page, title) {
  const selectors = TOUTIAO_TITLE_FIELD_SELECTORS;
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const visible = await locator.isVisible?.().catch(() => false);
    if (!visible) continue;
    try {
      await locator.click?.().catch(() => undefined);
      await locator.fill("");
      await locator.fill(title);
      await locator.dispatchEvent?.("input").catch(() => undefined);
      await locator.dispatchEvent?.("change").catch(() => undefined);
      return locator;
    } catch {
      continue;
    }
  }
  throw new Error("TOUTIAO_TITLE_FIELD_NOT_FOUND");
}

async function syncToutiaoEditorContent(page, content, richHtml = "") {
  if (typeof page.evaluate !== "function") return false;
  return page.evaluate((payload) => {
    const text = typeof payload === "string" ? payload : payload.text;
    const suppliedHtml = typeof payload === "string" ? "" : payload.richHtml;
    const escapeHtml = (value) =>
      String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    const html = suppliedHtml ||
      String(text || "")
        .split(/\n{2,}/)
        .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
        .join("") || "<p><br></p>";

    const selectors = [
      ".ProseMirror[contenteditable='true']",
      ".ql-editor[contenteditable='true']",
      "[contenteditable='true'].editor-content",
      ".article-content [contenteditable='true']",
      ".content-editable [contenteditable='true']",
      "[contenteditable='true']:not([class*='title'])",
    ];
    for (const selector of selectors) {
      const editor = document.querySelector(selector);
      if (!editor) continue;
      editor.focus?.();
      editor.innerHTML = html;
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
      editor.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Process" }));
      return true;
    }
    return false;
  }, richHtml ? { text: content, richHtml } : content).catch(() => false);
}

async function fillToutiaoBody(page, content, richHtml = "") {
  const synced = await syncToutiaoEditorContent(page, content, richHtml);
  if (synced) return null;
  const selectors = TOUTIAO_BODY_EDITOR_SELECTORS;
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const visible = await locator.isVisible?.().catch(() => false);
    if (!visible) continue;
    try {
      await locator.click?.().catch(() => undefined);
      await locator.fill(content);
      await syncToutiaoEditorContent(page, content, richHtml);
      return locator;
    } catch {
      continue;
    }
  }
  throw new Error("TOUTIAO_BODY_FIELD_NOT_FOUND");
}

async function uploadToutiaoCover(page, coverImagePath) {
  if (!coverImagePath || typeof page.locator !== "function") return false;
  const uploadInput = page.locator("input[type='file'][accept*='image'], .cover-upload input[type='file']").first();
  try {
    await uploadInput.setInputFiles?.(coverImagePath);
    await page.waitForTimeout?.(2000).catch(() => undefined);
    const confirm = page.locator("button:has-text('确定'), button:has-text('确认')").first();
    if (await confirm.isVisible?.().catch(() => false)) {
      await confirm.click?.().catch(() => undefined);
      await page.waitForTimeout?.(1000).catch(() => undefined);
    }
    return true;
  } catch {
    return false;
  }
}

async function waitForToutiaoDraftSaved(page, timeoutMs, watcher = null, options = {}) {
  const deadline = Date.now() + Math.max(1, Number(timeoutMs || 30000));
  // A probe compares against the mutations that were already counted before the
  // editor was filled, so an autosave that fired while we typed still counts.
  const startedMutations = Number(options.baselineMutations ?? watcher?.state?.mutationCount ?? 0);
  // A toast already on screen when the wait starts belongs to an earlier save in
  // this same page session, so a probe may not read it as proof that this save
  // landed. The click path passes nothing here and keeps its old behaviour.
  const knownToast = cleanText(options.knownToast);
  const pageUrl = () => (typeof page?.url === "function" ? String(page.url() || "") : "");
  let toast = "";
  do {
    if (!toast) toast = await readToutiaoSaveToast(page);
    if (toast && knownToast && toast === knownToast) toast = "";
    if (Number(watcher?.state?.mutationCount || 0) > startedMutations) {
      return { saved: true, signal: "platform_save_response", toast, url: pageUrl() };
    }
    if (toast) return { saved: true, signal: "save_toast", toast, url: pageUrl() };
    await sleepInToutiaoPage(page, 250);
  } while (Date.now() < deadline);
  return { saved: false, signal: "timeout", toast, url: pageUrl() };
}

async function toutiaoSaveButtonIsClickable(button) {
  if (!button) return false;
  const visible = await button.isVisible?.().catch(() => false);
  if (!visible) return false;
  return !(await button.isDisabled?.().catch(() => false));
}

// Returns the save verdict instead of dropping it: a save that never landed has
// to stay visible to the caller, and the URL it leaves behind is the second place
// a fresh article id shows up.
export async function clickToutiaoDraftSave(page, timeoutMs, watcher = null) {
  for (const label of TOUTIAO_SAVE_BUTTON_LABELS) {
    // Exact accessible-name match only. The loose ":has-text('草稿')" selector
    // this replaced also resolved to navigation targets such as 草稿箱, and
    // clicking one of those navigates away from an editor that still holds the
    // only copy of the article.
    const button = typeof page.getByRole === "function"
      ? page.getByRole("button", { name: label, exact: true }).first()
      : page.locator(`button:has-text('${label}'), [role='button']:has-text('${label}')`).first();
    if (await toutiaoSaveButtonIsClickable(button)) {
      await button.click?.().catch(() => undefined);
      const saved = await waitForToutiaoDraftSaved(page, timeoutMs, watcher);
      if (saved.saved) return { ...saved, clicked: true };
      // The first click can land before the editor finishes hydrating, and the
      // save request is then never sent. One re-click covers exactly that.
      await button.click?.().catch(() => undefined);
      const repeated = await waitForToutiaoDraftSaved(page, timeoutMs, watcher);
      return { ...repeated, clicked: true };
    }
  }
  // No save button is rendered at all. The editor either autosaved outside the
  // probe window or never will, and either way nothing was clicked here, so the
  // verdict must not claim otherwise.
  const waited = await waitForToutiaoDraftSaved(page, Math.min(timeoutMs, 5000), watcher);
  return { ...waited, clicked: false };
}

// The save step used to be an unconditional click on the save button. The editor
// saves on its own schedule, so that click is no longer what makes a draft
// exist -- it is only a risk: a selector that resolves to a neighbouring control
// navigates away from the editor, and a button that never renders leaves the
// caller waiting on a click that cannot happen. Probe for the platform's own
// save first and only fall back to the button when the platform has shown no
// save evidence at all. The save verdict itself is unchanged either way, because
// the article id and the draft URL both come out of it.
export async function saveToutiaoDraft(page, timeoutMs, watcher = null, options = {}) {
  const probeMs = Math.max(0, Number(options.probeMs || 0));
  const baselineMutations = Number(options.baselineMutations ?? watcher?.state?.mutationCount ?? 0);
  if (probeMs > 0) {
    const probe = await waitForToutiaoDraftSaved(page, probeMs, watcher, {
      baselineMutations,
      knownToast: await readToutiaoSaveToast(page),
    });
    if (probe.saved) return { ...probe, strategy: "autosave" };
  }
  const saved = await clickToutiaoDraftSave(page, timeoutMs, watcher);
  return { ...saved, strategy: saved.clicked ? "button" : "none" };
}

// Reads toast elements only. The body-text matcher this replaced was satisfied by
// the save button's own label, so a save that never landed still looked confirmed.
async function readToutiaoSaveToast(page) {
  if (typeof page?.evaluate !== "function") return "";
  const toasts = await page.evaluate((selector) => {
    return [...document.querySelectorAll(selector)].slice(0, 8).map((node) => ({
      text: String(node.textContent || node.innerText || "").trim(),
      insideButton: Boolean(node.closest("button, [role='button']")),
    }));
  }, TOUTIAO_SAVE_TOAST_SELECTORS.join(", ")).catch(() => null);
  if (!Array.isArray(toasts)) return "";
  for (const toast of toasts) {
    const text = cleanText(toast?.text);
    if (!text || toast?.insideButton === true) continue;
    if (TOUTIAO_SAVE_TOAST_PATTERN.test(text)) return text.slice(0, 120);
  }
  return "";
}

function summarizeToutiaoEditorState(state = {}) {
  const images = Array.isArray(state?.images) ? state.images : [];
  return {
    editorPresent: state?.editorPresent === true,
    titleFieldLength: cleanText(state?.titleFieldText).length,
    bodyTextLength: String(state?.editorText || "").length,
    imageCount: images.length,
  };
}

// Opens a draft URL and waits for the editor to hydrate. The returned state is what
// decides whether we are still looking at our own article.
async function openToutiaoDraftEditor(page, draftUrl, settleMs = 6000) {
  if (cleanText(draftUrl)) await page.goto(draftUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
  const deadline = Date.now() + Math.max(1000, Number(settleMs || 6000));
  let state = await readToutiaoEditorState(page).catch(() => null);
  while (
    Date.now() < deadline
    && !(state?.editorPresent && (String(state?.editorText || "").length || state?.images?.length || cleanText(state?.titleFieldText).length))
  ) {
    await sleepInToutiaoPage(page, 300);
    state = await readToutiaoEditorState(page).catch(() => null);
  }
  return state || { editorPresent: false, editorText: "", titleFieldText: "", images: [] };
}

// Third and last source for the article id: the content management page is the
// only surface that lists every draft with a real edit link, so it can name the
// article a save response never identified. Bounded and non-fatal on purpose --
// the page's DOM changes often, and a failed lookup leaves the previous draft URL
// in place. The caller reopens the editor afterwards either way.
const TOUTIAO_CONTENT_MANAGE_URL = "https://mp.toutiao.com/profile_v4/manage/content/all";

// Only the article-scoped params may name a draft here. pgc_id is deliberately
// absent: the management list links drafts with the account id as often as with
// an article id, and an id that names the account reopens a brand new empty
// article. Built from TOUTIAO_ARTICLE_ID_URL_PARAMS so the two cannot drift.
const TOUTIAO_MANAGE_PAGE_ID_PARAM_PATTERN = `[?&](?:${TOUTIAO_ARTICLE_ID_URL_PARAMS.join("|")})=(\\d{6,})`;

export async function findToutiaoDraftArticleIdInManagePage(page, title = "", settleMs = 8000, accountPgcId = "") {
  const wanted = normalizedMatchText(title).slice(0, 12);
  const account = cleanText(accountPgcId);
  if (typeof page?.goto !== "function" || wanted.length < 4) return "";
  await page.goto(TOUTIAO_CONTENT_MANAGE_URL, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
  const deadline = Date.now() + Math.max(1000, Number(settleMs || 8000));
  let articleId = "";
  while (Date.now() < deadline && !articleId) {
    // The callback runs inside the browser, so it cannot reach module scope.
    // The pattern and the excluded id therefore travel in as arguments.
    articleId = await page.evaluate?.((needle, pattern, excluded) => {
      const idPattern = new RegExp(pattern, "i");
      const normalize = (value) => String(value || "").replace(/\s+/g, "").toLowerCase();
      for (const anchor of document.querySelectorAll("a[href*='publish']")) {
        const href = String(anchor.getAttribute("href") || anchor.href || "");
        const match = idPattern.exec(href);
        if (!match) continue;
        // An id that names the account is not a draft, whichever param carried it.
        if (excluded && match[1] === excluded) continue;
        const row = anchor.closest("tr, li, [class*='item'], [class*='card'], [class*='row']");
        const text = normalize((row || anchor).textContent || "");
        if (text.includes(needle)) return match[1];
      }
      return "";
    }, wanted, TOUTIAO_MANAGE_PAGE_ID_PARAM_PATTERN, account).catch(() => "") || "";
    // Only a real id may leave the page: the lookup reads whatever text the
    // management list happens to expose, and a page-shaped string is not one.
    articleId = /^\d{6,}$/.test(articleId) ? articleId : "";
    // Same rule on the way out, so the account id cannot survive either check.
    if (account && articleId === account) articleId = "";
    if (!articleId) await sleepInToutiaoPage(page, 500);
  }
  return articleId;
}

// Draft image verification. Four outcomes: verified, the draft was never
// identified at all, the editor lost our article (a draft URL that named the
// account instead of the article), or the article is there and the images really
// are missing.
export async function verifyToutiaoDraftImages(options = {}) {
  const page = options.page;
  const publishInput = options.publishInput;
  const watcher = options.watcher || null;
  const expected = publishInput.platformImageTasks.length;
  const attempts = Math.max(1, Number(publishInput.draftImageVerifyAttempts || 2));
  const retryDelayMs = Math.max(0, Number(publishInput.draftImageRetryDelayMs || 2000));
  const settleMs = Math.max(1000, Number(publishInput.draftEditorSettleMs || 6000));
  const candidates = toutiaoDraftUrlCandidates(watcher?.state, page, options.accountPgcId, options.draftUrl);
  const reload = { candidates, attempts: [] };
  // Two very different failures used to share one label. A draft that was never
  // identified at all -- no article id and no article-scoped URL -- leaves
  // nothing to reopen, while an identified draft that reopens empty means the
  // platform dropped what we just saved. Only the second is an editor loss.
  const recordedArticleId = cleanText(watcher?.state?.draftArticleId);
  const account = cleanText(options.accountPgcId);
  // Counting an id that names the account would turn "no article id was ever
  // captured" into "the editor lost our draft" -- the mis-attribution this split
  // exists to prevent, and the reason a wrong param name in the manage-page
  // lookup used to surface as TOUTIAO_DRAFT_EDITOR_LOST.
  const draftIdentified = (Boolean(recordedArticleId) && recordedArticleId !== account)
    || candidates.some((candidateUrl) => toutiaoArticleScopedUrl(candidateUrl));
  if (!candidates.length || !draftIdentified) {
    return {
      status: "draft_url_missing",
      images: [],
      reload,
      gap: "Toutiao never exposed an article-scoped draft URL, so the saved draft cannot be reopened for image verification.",
    };
  }
  let lastGap = "";

  for (const candidateUrl of candidates) {
    const state = await openToutiaoDraftEditor(page, candidateUrl, settleMs);
    const holdsArticle = toutiaoEditorHoldsArticle(state, publishInput);
    reload.attempts.push({ url: candidateUrl, holdsArticle, ...summarizeToutiaoEditorState(state) });
    if (!holdsArticle) continue;

    lastGap = describeToutiaoDraftImageGap(expected, state);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const images = await readToutiaoEditorImages(page).catch(() => []);
      const persistent = images.filter((image) => (
        isPersistentPlatformImageUrl(image.platformImageUrl) && image.loaded !== false
      ));
      lastGap = describeToutiaoDraftImageGap(expected, { ...state, images: persistent });
      if (persistent.length >= expected) {
        const draftImages = await verifyPlatformImages({
          tasks: publishInput.platformImageTasks,
          readImages: async () => persistent,
          stage: "draft",
        });
        return { status: "verified", images: draftImages, reload, gap: lastGap };
      }
      if (attempt >= attempts) break;
      // The editor keeps images in insertion order, so the missing ones are the
      // tail of the task list. Re-uploading only those keeps already inserted
      // images from being duplicated.
      const missing = publishInput.platformImageTasks.slice(persistent.length);
      if (!missing.length) break;
      if (retryDelayMs) await sleepInToutiaoPage(page, retryDelayMs);
      // Same conditional save as the main flow: an autosave that already landed
      // after the re-upload must not be followed by a button click.
      const mutationsBeforeUpload = Number(watcher?.state?.mutationCount || 0);
      await uploadToutiaoInlineImages(page, missing, { onProgress: options.onProgress });
      await saveToutiaoDraft(page, publishInput.draftTimeoutMs, watcher, {
        baselineMutations: mutationsBeforeUpload,
        probeMs: publishInput.draftAutoSaveProbeMs,
      });
      await openToutiaoDraftEditor(page, candidateUrl, settleMs);
    }
    throw new Error(lastGap);
  }
  return { status: "editor_lost", images: [], reload, gap: lastGap };
}

export async function clickReadyToutiaoButton(page, label, timeoutMs, errorCode, options = {}) {
  const locator = typeof page.getByRole === "function"
    ? page.getByRole("button", { name: label, exact: true })
    : page.locator(`button:has-text("${label}")`).first();
  const startedAt = Date.now();
  let state = { count: 0, visible: false, disabled: null };
  while (Date.now() - startedAt < timeoutMs) {
    if (options.noImages === true) await selectToutiaoNoCover(page);
    const count = typeof locator.count === "function" ? await locator.count().catch(() => 0) : 1;
    const visible = count > 0 && await locator.isVisible?.().catch(() => false);
    const disabled = visible ? await locator.isDisabled?.().catch(() => null) : null;
    state = { count, visible: Boolean(visible), disabled: disabled ?? null };
    if (visible && disabled === false) {
      await locator.scrollIntoViewIfNeeded?.().catch(() => undefined);
      await locator.click({ timeout: Math.max(1000, timeoutMs - (Date.now() - startedAt)) });
      return true;
    }
    await page.waitForTimeout?.(250).catch(() => undefined);
  }
  const reason = state.count === 0 ? "NOT_FOUND" : !state.visible ? "NOT_VISIBLE" : state.disabled === true ? "DISABLED" : "STATE_UNAVAILABLE";
  const code = errorCode.replace(/NOT_READY$/, reason);
  // Persist only button metadata in the error: never article text, cookies or page HTML.
  let screenshotPath = "";
  if (typeof page.screenshot === "function") {
    try {
      const directory = join(homedir(), ".zhixin-ai", "diagnostics");
      await mkdir(directory, { recursive: true });
      const destination = join(directory, `toutiao-${code.toLowerCase()}-${Date.now()}.png`);
      await page.screenshot({ path: destination, fullPage: true, timeout: 5000 });
      screenshotPath = destination;
    } catch { /* Diagnostic failure must not replace the publishing failure. */ }
  }
  const error = new Error(`${code}: ${JSON.stringify({ ...state, screenshotPath })}`);
  error.code = code;
  error.buttonState = state;
  error.screenshotPath = screenshotPath;
  throw error;
}

// Select only a mode explicitly offered by the live platform. Never infer that
// no-image articles are unsupported when this optional control is absent.
export async function selectToutiaoNoCover(page) {
  if (typeof page.getByRole !== "function") return false;
  const radio = page.getByRole("radio", { name: "无封面", exact: true });
  try {
    if (await radio.count() !== 1 || !await radio.isVisible() || await radio.isDisabled()) return false;
    if (!await radio.isChecked()) await radio.check({ timeout: 1000 });
    return true;
  } catch { return false; }
}

export async function completeToutiaoPublishFlow(page, timeoutMs = 60000, options = {}) {
  const stepTimeoutMs = Math.max(1000, Number(timeoutMs || 60000));
  await clickReadyToutiaoButton(
    page,
    "\u9884\u89c8\u5e76\u53d1\u5e03",
    stepTimeoutMs,
    "TOUTIAO_PREVIEW_AND_PUBLISH_BUTTON_NOT_READY",
  );
  await clickReadyToutiaoButton(
    page,
    "\u786e\u8ba4\u53d1\u5e03",
    stepTimeoutMs,
    "TOUTIAO_CONFIRM_PUBLISH_BUTTON_NOT_READY",
    options,
  );
  return { previewClicked: true, confirmClicked: true };
}

async function clickToutiaoPublish(page, timeoutMs, options) {
  return completeToutiaoPublishFlow(page, timeoutMs, options);
}

async function confirmToutiaoDialogs(page) {
  if (typeof page.locator !== "function") return;
  const selectors = [
    ".byte-modal button:has-text('确定')",
    ".byte-modal button:has-text('确认')",
    ".ant-modal button.ant-btn-primary",
    "button:has-text('继续发表')",
    "button:has-text('知道了')",
    "button:has-text('OK')",
  ];
  for (let round = 0; round < 3; round += 1) {
    let clicked = false;
    for (const selector of selectors) {
      const button = page.locator(selector).first();
      if (await button.isVisible?.().catch(() => false) && !(await button.isDisabled?.().catch(() => false))) {
        await button.click?.().catch(() => undefined);
        clicked = true;
        await page.waitForTimeout?.(1000).catch(() => undefined);
        break;
      }
    }
    if (!clicked) break;
  }
}

async function readToutiaoPublishedUrl(page) {
  const current = typeof page.url === "function" ? page.url() : "";
  const normalized = normalizeToutiaoPublishedUrl(current);
  if (normalized) return normalized;
  if (typeof page.locator === "function") {
    const href = await page
      .locator("a[href*='toutiao.com/article'], a[href*='toutiao.com/item'], a[href*='toutiao.com/group']")
      .first()
      .getAttribute?.("href")
      .catch(() => "");
    if (href) return normalizeToutiaoPublishedUrl(href) || "";
  }
  return "";
}

export async function readToutiaoPlatformBlocker(page) {
  if (typeof page.evaluate !== "function") return "";
  const snapshot = await page.evaluate(() => {
    const selectors = [
      "[role='dialog']",
      "[role='alert']",
      "[aria-live='assertive']",
      ".byte-message",
      ".byte-notification",
      "[class*='toast']",
      "[class*='modal']",
      "[class*='captcha']",
      "[class*='verify']",
      "[class*='risk']",
    ];
    const noticeTexts = [...new Set(
      [...document.querySelectorAll(selectors.join(", "))]
        .filter((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none"
            && style.visibility !== "hidden"
            && rect.width > 0
            && rect.height > 0;
        })
        .map((element) => String(element.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
    )];
    return { pageUrl: location.href, noticeTexts };
  }).catch(() => ({ pageUrl: "", noticeTexts: [] }));
  const noticeTexts = Array.isArray(snapshot?.noticeTexts)
    ? snapshot.noticeTexts
    : typeof snapshot === "string"
      ? [snapshot]
      : [];
  const text = noticeTexts.join(" ");
  if (/captcha|security verification|risk control|manual verification/i.test(text)) {
    return "TOUTIAO_MANUAL_ACTION_REQUIRED";
  }
  if (/\u9a8c\u8bc1\u7801|\u5b89\u5168\u9a8c\u8bc1|\u62d6\u52a8\u6ed1\u5757|\u626b\u7801\u9a8c\u8bc1|\u98ce\u63a7/.test(text)) {
    return "TOUTIAO_MANUAL_ACTION_REQUIRED";
  }
  if (/\u654f\u611f\u8bcd|\u53d1\u5e03\u4e0a\u9650|\u5ba1\u6838\u672a\u901a\u8fc7|\u8fdd\u89c4|\u9891\u7e41/.test(text)) {
    return "TOUTIAO_MANUAL_ACTION_REQUIRED";
  }
  return "";
}

async function verifyToutiaoPublicImages(context, publishedUrl, tasks, existingPage = null) {
  if (!tasks.length) return [];
  const publicPage = existingPage || await context.newPage();
  const ownsPage = !existingPage;
  try {
    if (ownsPage || (typeof publicPage.url === "function" && normalizeToutiaoPublishedUrl(publicPage.url()) !== publishedUrl)) {
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
      }, { selector: TOUTIAO_PUBLIC_IMAGE_SELECTOR, expectedCount: tasks.length }, { timeout: 30000 }).catch(() => undefined);
    }
    return verifyPlatformImages({
      tasks,
      readImages: () => readLocatorImages(publicPage, TOUTIAO_PUBLIC_IMAGE_SELECTOR),
      stage: "public",
    });
  } finally {
    if (ownsPage) await publicPage.close?.().catch(() => undefined);
  }
}

function normalizedMatchText(value = "") {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

export async function inspectToutiaoPublicArticle(page, input = {}) {
  const publicUrl = normalizeToutiaoPublishedUrl(
    input.publicUrl || input.publishedUrl || input.reviewUrl || ""
  );
  if (!publicUrl) throw new Error("TOUTIAO_PUBLIC_URL_INVALID");

  const existing = input.imagePublicationEvidence && typeof input.imagePublicationEvidence === "object"
    ? input.imagePublicationEvidence
    : {};
  const expected = Array.isArray(existing.expected) ? existing.expected : [];

  await page.goto(publicUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
  if (expected.length && typeof page.waitForFunction === "function") {
    await page.waitForFunction((payload) => {
      const images = [...document.querySelectorAll(payload.selector)];
      return images.filter((image) => (
        /^https:\/\//i.test(image.getAttribute("src") || "")
        && image.complete
        && image.naturalWidth > 0
      )).length >= payload.expectedCount;
    }, { selector: TOUTIAO_PUBLIC_IMAGE_SELECTOR, expectedCount: expected.length }, { timeout: 30000 }).catch(() => undefined);
  }

  const publicEvidence = expected.length
    ? await verifyPublicImageEvidence({
        tasks: expected,
        readImages: () => readLocatorImages(page, TOUTIAO_PUBLIC_IMAGE_SELECTOR),
        readBlocker: async () => String(await readToutiaoPlatformBlocker(page).catch(() => "") || "").trim()
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
  const bodyText = await page.locator("article, .article-content, .tt-article-content, body").first().innerText().catch(() => "");
  const pageText = `${pageTitle}\n${bodyText}`.trim().slice(0, 12000);
  const expectedTitle = normalizedMatchText(input.articleTitle || input.title);
  const expectedBody = normalizedMatchText(input.contentMarkdown || input.content || input.richText);
  const normalizedPageTitle = normalizedMatchText(`${pageTitle}\n${bodyText}`);
  const titleMatched = Boolean(expectedTitle && normalizedPageTitle.includes(expectedTitle));
  const actualBody = normalizedMatchText(bodyText);
  const bodyMatched = !expectedBody || (actualBody.includes(expectedBody.slice(0, 80))
    && actualBody.includes(expectedBody.slice(-80)));

  return {
    found: titleMatched && bodyMatched,
    publicUrl,
    publishedUrl: publicUrl,
    pageText,
    pageTitle,
    titleMatched,
    bodyMatched,
    ...(imagePublicationEvidence ? { imagePublicationEvidence } : {}),
  };
}

function notifyPublishProgress(input = {}, event = {}) {
  if (typeof input.onProgress !== "function") return;
  input.onProgress(event);
}

export class ToutiaoAdapter extends ContentPlatformAdapter {
  constructor(options = {}) {
    super(contentPlatformConfigs.toutiao, options);
  }

  async discoverPublication(input = {}) {
    const context = await this.launchAuthEnvironment(input);
    const page = context.pages()[0] || await context.newPage();
    try {
      return await inspectToutiaoPublicArticle(page, input);
    } finally {
      await this.refreshCredentialAfterOperation(input, context, page, TOUTIAO_EDITOR_URL);
      if (!input.keepBrowserOpen) await context.close().catch(() => undefined);
    }
  }

  async publishArticle(input = {}) {
    const publishInput = normalizePublishInput(input);
    const context = await this.launchAuthEnvironment(input);

    const page = context.pages()[0] || await context.newPage();
    const keepOpen = Boolean(input.keepBrowserOpen);
    const watcher = watchToutiaoApiResponses(page);

    try {
      page.setDefaultTimeout?.(15000);
      page.setDefaultNavigationTimeout?.(45000);
      if (shouldPublishToutiaoViaApi(input, publishInput)) {
        await page.goto?.(input.editorUrl || TOUTIAO_EDITOR_URL, { waitUntil: "domcontentloaded" });
        return await publishToutiaoViaCapturedApi(page, context, input, publishInput);
      }
      await page.goto(input.editorUrl || TOUTIAO_EDITOR_URL, { waitUntil: "domcontentloaded" });
      await bringToFrontIfAllowed(page, input);
      await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
      await page.waitForTimeout?.(1500).catch(() => undefined);

      const cookies = await context.cookies([TOUTIAO_ORIGIN, "https://sso.toutiao.com", "https://www.toutiao.com"]);
      const pageState = await readConfiguredPlatformPageState(page);
      if (!isConfiguredPlatformLoggedIn(this.config, cookies, pageState)) throw new Error("TOUTIAO_LOGIN_REQUIRED");

      const openBlocker = await readToutiaoPlatformBlocker(page);
      if (openBlocker) {
        notifyPublishProgress(input, {
          type: "manual_verification_required",
          platform: "toutiao",
          message: "头条号当前需要人工处理安全验证、敏感词或平台提示。",
          currentUrl: typeof page.url === "function" ? page.url() : "",
        });
        throw new Error(openBlocker);
      }

      // Baseline for the autosave probe: every article mutation counted after
      // this point is the platform responding to the content we are about to
      // put in the editor, which is what makes an autosave detectable.
      const mutationsBeforeFill = Number(watcher.state.mutationCount || 0);
      await fillToutiaoTitle(page, publishInput.title);
      await fillToutiaoBody(page, publishInput.content, publishInput.richHtml);
      // The editor only reveals its own pgc_id after it loads, and that id is the
      // account id, never the article id. Capture it before any save so draft URLs
      // can be told apart from "open a new empty article".
      const accountPgcId = toutiaoPgcIdFromUrl(
        typeof page.url === "function" ? String(page.url() || "") : ""
      );
      if (accountPgcId) watcher.setAccountPgcId(accountPgcId);
      const uploadedImages = publishInput.platformImageTasks.length
        ? await uploadToutiaoInlineImages(page, publishInput.platformImageTasks, { onProgress: input.onProgress })
        : [];
      if (publishInput.coverImagePath) await uploadToutiaoCover(page, publishInput.coverImagePath);
      let draftUrl = watcher.state.draftUrl || "";
      let draftImages = [];
      let prePublicImageEvidence;
      if (!publishInput.confirmPublish) {
        // A draft-only run keeps the whole draft stage: the draft URL is the only
        // proof of what it left on the platform, and the image check has no
        // public page to fall back on, so it reopens the editor to run it. The
        // mutation baseline taken before the fill is what tells the platform's
        // own autosave apart from the page that was just filled.
        const editorBeforeSave = publishInput.platformImageTasks.length
          ? await readToutiaoEditorState(page)
          : null;
        const draftSave = await saveToutiaoDraft(page, publishInput.draftTimeoutMs, watcher, {
          baselineMutations: mutationsBeforeFill,
          probeMs: publishInput.draftAutoSaveProbeMs,
        });
        // Second source for the article id: the editor URL the save left behind.
        // A save response without an id used to leave the account-only URL as the
        // only record of the draft.
        captureToutiaoDraftArticleId(watcher, draftSave.url, accountPgcId);
        if (!draftSave.saved) {
          notifyPublishProgress(input, {
            type: "toutiao_draft_save_unconfirmed",
            platform: "toutiao",
            message: draftSave.strategy === "button"
              ? "Toutiao draft save was re-clicked once but never confirmed by a save response or toast."
              : "Toutiao showed no autosave response and no save button, so the draft was never confirmed.",
            saveStrategy: draftSave.strategy,
          });
        }
        draftUrl = await waitForToutiaoDraftUrl(watcher.state, page, publishInput.draftTimeoutMs, { accountPgcId });
        // Third source: the content management page lists every draft with a real
        // edit link, so it can name the article the save response never identified.
        // Only worth the detour when the image path reopens the editor anyway.
        if (publishInput.platformImageTasks.length && !watcher.state.draftArticleId) {
          const managedArticleId = await findToutiaoDraftArticleIdInManagePage(
            page,
            publishInput.title,
            publishInput.draftManageLookupMs,
            accountPgcId,
          );
          if (managedArticleId) {
            watcher.state.draftArticleId = managedArticleId;
            watcher.state.draftUrl = toutiaoDraftUrlFromArticleId(managedArticleId);
            watcher.state.draftUrlAccountOnly = false;
            draftUrl = watcher.state.draftUrl;
          }
          // The manage page replaced the live editor either way, so reopen the
          // draft before anything else touches this page.
          await openToutiaoDraftEditor(page, draftUrl || TOUTIAO_EDITOR_URL, publishInput.draftEditorSettleMs);
        }
        // The editor already saved a draft here, so a later image timeout has to
        // report that draft instead of looking like nothing was ever written.
        if (draftUrl) input.evidenceSink?.({ draftUrl, platformStatus: "draft_saved" });
        if (publishInput.platformImageTasks.length) {
          await input.onProgress?.({ type: "verifying_draft_images", total: publishInput.platformImageTasks.length });
          const draftImageReport = await verifyToutiaoDraftImages({
            page,
            publishInput,
            watcher,
            draftUrl,
            accountPgcId,
            editorBeforeSave,
            onProgress: input.onProgress,
          });
          draftImages = draftImageReport.images;
          if (draftImageReport.status === "editor_lost" || draftImageReport.status === "draft_url_missing") {
            const lostDraftEvidence = buildImagePublicationEvidence(
              publishInput.platformImageTasks,
              uploadedImages,
              [],
              [],
              PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED,
            );
            // Publishing from this page would push something else entirely, and a
            // draft that was never identified cannot be reopened at all. Either way
            // the honest outcome is a failure, so keep everything the reload learned
            // in the evidence the failure event replays.
            input.evidenceSink?.({
              draftUrl: draftUrl || watcher.state.draftUrl || "",
              draftImageReload: draftImageReport.reload,
              draftImageGap: draftImageReport.gap,
              imagePublicationEvidence: lostDraftEvidence,
            });
            notifyPublishProgress(input, {
              type: draftImageReport.status === "draft_url_missing"
                ? "toutiao_draft_url_missing"
                : "toutiao_draft_reload_lost",
              platform: "toutiao",
              message: draftImageReport.status === "draft_url_missing"
                ? "Toutiao never exposed an article-scoped draft URL, so the saved draft cannot be reopened for image verification."
                : "Toutiao reopened an empty editor instead of the saved draft, so the publish is abandoned instead of pushing the wrong article.",
            });
            throw new Error(
              draftImageReport.status === "draft_url_missing"
                ? "TOUTIAO_DRAFT_URL_MISSING"
                : "TOUTIAO_DRAFT_EDITOR_LOST"
            );
          }
        }
        prePublicImageEvidence = publishInput.platformImageTasks.length
          ? buildImagePublicationEvidence(publishInput.platformImageTasks, uploadedImages, draftImages, [], PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED)
          : undefined;
        const resolvedDraftUrl = draftUrl || watcher.state.draftUrl || "";
        return {
          draftUrl: resolvedDraftUrl,
          publishedUrl: "",
          platformStatus: "draft_saved",
          title: publishInput.title,
          // A confirmed save with no article-scoped URL is a draft that cannot be
          // reopened; name the miss so the failure reads DRAFT_URL_MISSING
          // instead of leaving an unexplained empty URL behind.
          ...(resolvedDraftUrl ? {} : { message: "TOUTIAO_DRAFT_URL_MISSING" }),
          ...(prePublicImageEvidence ? { imagePublicationEvidence: prePublicImageEvidence } : {}),
        };
      }

      // Publishing from the filled editor has no draft stage at all: nothing
      // saves and reopens a draft on this path, so the editor upload is the
      // entire pre-public state. The draft stage therefore mirrors the upload,
      // the same convention Penguin's API publish path follows. Recording it as
      // an empty stage instead would flag DRAFT_IMAGE_MISSING on every image
      // publish and hold the verdict at submitted_for_review even when the
      // public page shows every image.
      const prePublicStageImages = uploadedImages;

      // Publishing skips the draft stage entirely and goes straight from the
      // editor that was just filled to 预览并发布. The draft stage used to be the
      // article id and draft URL supply, but the article now lives in the page
      // that was filled, so there is no reopen left to lose it: the save button,
      // the article-id hunt, the manage-page detour and the reopen-and-verify
      // step are all skipped. The images are verified on the public page once
      // the article is out, which is the only stage that looks at what a reader
      // will actually see.
      notifyPublishProgress(input, {
        type: "toutiao_publishing_from_editor",
        platform: "toutiao",
        message: "Toutiao is publishing straight from the filled editor; draft save and draft image verification are skipped.",
      });
      await clickToutiaoPublish(page, publishInput.publishTimeoutMs, {
        noImages: !publishInput.coverImagePath && publishInput.platformImageTasks.length === 0
          && !/<img\b/i.test(publishInput.richHtml || "")
          && !/!\[[^\]]*\]\(/.test(publishInput.content || ""),
      });
      await page.waitForLoadState?.("networkidle", { timeout: publishInput.publishTimeoutMs }).catch(() => undefined);
      await page.waitForTimeout?.(2000).catch(() => undefined);
      await confirmToutiaoDialogs(page);
      await page.waitForLoadState?.("networkidle", { timeout: publishInput.publishTimeoutMs }).catch(() => undefined);
      await page.waitForTimeout?.(2000).catch(() => undefined);

      const publishBlocker = await readToutiaoPlatformBlocker(page);
      if (publishBlocker || watcher.state.blocker) {
        notifyPublishProgress(input, {
          type: "manual_verification_required",
          platform: "toutiao",
          message: "头条号发布被平台验证、风控或内容规则拦截，请在桌面端打开的窗口处理后重试。",
          currentUrl: typeof page.url === "function" ? page.url() : "",
        });
        throw new Error(publishBlocker || watcher.state.blocker);
      }

      // Upload evidence with the public stage still ahead: if the published URL
      // never resolves, the failure replay still shows the images reached the
      // editor.
      prePublicImageEvidence = publishInput.platformImageTasks.length
        ? buildImagePublicationEvidence(publishInput.platformImageTasks, uploadedImages, prePublicStageImages, [], PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED)
        : undefined;

      const publishedUrl = watcher.state.publishedUrl || (await readToutiaoPublishedUrl(page));
      const candidateReviewUrl = watcher.state.articleId
        ? `https://www.toutiao.com/article/${encodeURIComponent(watcher.state.articleId)}/`
        : "";

      // The publish response names the article even when no public URL resolves,
      // and a throw after this point replays the evidence, so record the id
      // while it is known instead of losing it with the page.
      if (watcher.state.articleId) {
        input.evidenceSink?.({ externalIds: { articleId: watcher.state.articleId } });
      }

      if (!publishedUrl) {
        if (watcher.state.publishAttempted || watcher.state.articleId) {
          return {
            draftUrl: draftUrl || watcher.state.draftUrl || "",
            publishedUrl: "",
            reviewUrl: candidateReviewUrl,
            platformStatus: "submitted_for_review",
            publiclyVisible: false,
            reviewStatus: "pending_review",
            message: "头条号已提交，正在审核，审核通过后公开。",
            title: publishInput.title,
            ...(prePublicImageEvidence ? { imagePublicationEvidence: prePublicImageEvidence } : {}),
          };
        }
        throw new Error("TOUTIAO_PUBLISHED_URL_NOT_FOUND");
      }

      let publicImages = [];
      let publicVerified = false;
      if (publishInput.platformImageTasks.length) {
        await input.onProgress?.({ type: "verifying_public_images", total: publishInput.platformImageTasks.length });
        try {
          publicImages = await verifyToutiaoPublicImages(context, publishedUrl, publishInput.platformImageTasks, page);
          publicVerified = publicImages.length >= publishInput.platformImageTasks.length;
        } catch {
          publicImages = [];
          publicVerified = false;
        }
      } else {
        publicVerified = true;
      }

      const imagePublicationEvidence = publishInput.platformImageTasks.length
        ? buildImagePublicationEvidence(publishInput.platformImageTasks, uploadedImages, prePublicStageImages, publicImages)
        : undefined;

      if (!publicVerified || (imagePublicationEvidence && imagePublicationEvidence.status !== "verified")) {
        return {
          draftUrl: draftUrl || watcher.state.draftUrl || "",
          publishedUrl: "",
          reviewUrl: publishedUrl || candidateReviewUrl,
          platformStatus: "submitted_for_review",
          publiclyVisible: false,
          reviewStatus: "pending_review",
          message: "头条号已提交，正在审核或公开页图片证据未就绪。",
          title: publishInput.title,
          ...(imagePublicationEvidence || prePublicImageEvidence
            ? { imagePublicationEvidence: imagePublicationEvidence || prePublicImageEvidence }
            : {}),
        };
      }

      return {
        draftUrl: draftUrl || watcher.state.draftUrl || "",
        publishedUrl,
        platformStatus: "published",
        publiclyVisible: true,
        reviewStatus: "public",
        title: publishInput.title,
        ...(imagePublicationEvidence ? { imagePublicationEvidence } : {}),
      };
    } finally {
      watcher.dispose();
      await this.refreshCredentialAfterOperation(input, context, page, TOUTIAO_EDITOR_URL);
      if (!keepOpen) {
        await context.close().catch(() => undefined);
      }
    }
  }
}
