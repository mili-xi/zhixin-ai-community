import path from "node:path";
import { readFile } from "node:fs/promises";
import { NeteaseAdapter, contentPlatformConfigs, isConfiguredPlatformLoggedIn, readConfiguredPlatformPageState } from "./content-platform.mjs";
import { pasteRichHtml, readLocatorImages, uploadPlatformImages, verifyPlatformImages, verifyPublicImageEvidence } from "../editor-image-upload.mjs";
import { readPublicPageBlockerFromPage } from "../public-page-blocker.mjs";
import { composeRichArticleHtml } from "../rich-content.mjs";
import { buildImagePublicationEvidence, PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED } from "../platform-images.mjs";
import { platformApiFetch } from "./platform-api.mjs";
import { bringToFrontIfAllowed } from "../browser-visibility.mjs";
import { importPlaywrightChromium } from "./browser-runtime.mjs";

const NETEASE_ORIGIN = "https://mp.163.com";
const NETEASE_PUBLISH_URL = "https://mp.163.com/#/article-publish";
const NETEASE_MANAGE_URL = "https://mp.163.com/subscribe_v4/index.html#/content-manage";
const NETEASE_ACCOUNT_QUERY_URL = `${NETEASE_ORIGIN}/wemedia/bee/account/query.do`;
const NETEASE_IMAGE_UPLOAD_URL = `${NETEASE_ORIGIN}/api/v3/upload/picupload`;
const NETEASE_PICTURE_REGISTER_URL = `${NETEASE_ORIGIN}/wemedia/material/picture/addPic.do`;
const NETEASE_PUBLISH_API_URL = `${NETEASE_ORIGIN}/wemedia/article/status/api/publishV2.do`;

export async function positionNeteaseCursorAfterSection(editorLocator, task = {}, tasks = [], index = 0) {
  if (!editorLocator || typeof editorLocator.evaluate !== "function") return false;
  const nextSectionTitle = String(tasks[index + 1]?.sectionTitle || "").trim();
  return editorLocator.evaluate((editor, payload) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const sectionId = String(payload.sectionId || "");
    const sectionTitle = clean(payload.sectionTitle);
    let target = sectionId
      ? editor.querySelector(`[data-zhixin-section="${CSS.escape(sectionId)}"]`)
      : null;

    if (!target && sectionTitle) {
      const blocks = [...editor.querySelectorAll("[data-block='true']")];
      const headingIndex = blocks.findIndex((block) => clean(block.textContent) === sectionTitle);
      if (headingIndex >= 0) {
        let nextHeadingIndex = blocks.length;
        if (payload.nextSectionTitle) {
          const candidate = blocks.findIndex((block, blockIndex) => (
            blockIndex > headingIndex && clean(block.textContent) === clean(payload.nextSectionTitle)
          ));
          if (candidate >= 0) nextHeadingIndex = candidate;
        }
        target = blocks[Math.max(headingIndex, nextHeadingIndex - 1)] || blocks[headingIndex];
      }
    }

    target ||= editor.lastElementChild || editor;
    const selection = window.getSelection();
    if (!selection) return false;
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    editor.focus?.();
    return true;
  }, {
    sectionId: String(task.sectionId || ""),
    sectionTitle: String(task.sectionTitle || task.title || ""),
    nextSectionTitle,
  }).catch(() => false);
}

export async function confirmNeteaseImageDialog(page, timeoutMs = 60000, onProgress) {
  const selector = ".ne-modal.picture-adder:visible button:has-text('确定'):visible";
  let visible = false;
  let disabled = true;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const button = page.locator(selector).first();
    visible = await button.isVisible?.().catch(() => false);
    disabled = await button.isDisabled?.().catch(() => true);
    if (visible && !disabled) {
      await button.click();
      await page.waitForTimeout?.(500).catch(() => undefined);
      return;
    }
    await page.waitForTimeout?.(250).catch(() => undefined);
  }
  await onProgress?.({ type: "uploading_image_snapshot", stage: "confirm_timeout", confirmVisible: visible, confirmDisabled: disabled });
  throw new Error(visible ? "NETEASE_IMAGE_CONFIRM_BUTTON_DISABLED" : "NETEASE_IMAGE_CONFIRM_BUTTON_NOT_VISIBLE");
}

export async function uploadNeteaseInlineImages(page, tasks = [], options = {}) {
  if (!tasks.length) return [];
  const editor = page.locator(".public-DraftEditor-content[contenteditable='true'], [contenteditable='true'].editor").first();
  return uploadPlatformImages({
    tasks,
    readImages: () => readLocatorImages(page, ".public-DraftEditor-content img, [contenteditable='true'].editor img"),
    positionForTask: (task, index) => positionNeteaseCursorAfterSection(editor, task, tasks, index),
    selectFile: async (task) => {
      await page.locator("button.rich-editor-panel-item:has(img[src*='icon_image'])").first().click();
      await page.locator(".ne-modal.picture-adder:visible input[type='file'][name='pic']").last().setInputFiles(task.path);
      await confirmNeteaseImageDialog(page, options.dialogTimeoutMs ?? options.timeoutMs ?? 60000, options.onProgress);
    },
    onProgress: options.onProgress,
    timeoutMs: options.timeoutMs || 60000,
  });
}
function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeMultilineText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripMarkdownForNetease(value) {
  return normalizeMultilineText(value)
    .replace(/^\s*!\[[^\]]*\]\([^\n)]+\)\s*$/gm, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function textFromNeteaseBlocks(blocks = []) {
  return (Array.isArray(blocks) ? blocks : [])
    .filter((block) => block?.type === "section")
    .flatMap((block) => [cleanText(block.title), normalizeMultilineText(block.content)])
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function stripEmbeddedImages(html = "") {
  return String(html || "")
    .replace(/<figure\b[^>]*>[\s\S]*?<\/figure>/gi, "")
    .replace(/<img\b[^>]*>/gi, "")
    .trim();
}

function buildNeteaseBody(input = {}) {
  const contentBlocks = Array.isArray(input.contentBlocks) ? input.contentBlocks : [];
  const source = String(input.contentMarkdown || input.content || input.body || input.markdown || "");
  const blockText = textFromNeteaseBlocks(contentBlocks);
  const content = blockText || stripMarkdownForNetease(source);
  const suppliedHtml = stripEmbeddedImages(input.contentHtmlWithoutImages || "");
  const blockHtml = contentBlocks.length
    ? composeRichArticleHtml(contentBlocks, { includeImages: false })
    : "";
  return {
    content,
    contentBlocks,
    richHtml: suppliedHtml || blockHtml,
  };
}

function isNeteaseCookie(cookie = {}) {
  const domain = String(cookie.domain || "").replace(/^\./, "");
  return domain === "163.com" || domain.endsWith(".163.com");
}

function normalizeNeteaseCookie(cookie = {}) {
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

async function createNeteaseCookieInjectedContext(options = {}) {
  const rawCookies = Array.isArray(options.cookies) ? options.cookies : [];
  const cookies = rawCookies.filter(isNeteaseCookie).map(normalizeNeteaseCookie);
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
  return { browser, context, cookies };
}

function normalizePublishInput(input = {}) {
  const title = cleanText(input.articleTitle || input.title);
  const body = buildNeteaseBody(input);
  if (!title) throw new Error("NETEASE_TITLE_REQUIRED");
  if (title.length < 5) throw new Error("NETEASE_TITLE_TOO_SHORT");
  if (title.length > 64) throw new Error("NETEASE_TITLE_TOO_LONG");
  if (!body.content || body.content.length < 20) throw new Error("NETEASE_CONTENT_REQUIRED");
  return {
    title,
    content: body.content,
    richHtml: body.richHtml,
    contentBlocks: body.contentBlocks,
    platformImageTasks: Array.isArray(input.platformImageTasks) ? input.platformImageTasks : [],
    coverImagePath: cleanText(input.coverImagePath),
    coverImageUrl: cleanText(input.coverImageUrl),
    category: cleanText(input.category || input.categoryName || "科技"),
    coverMode: cleanText(input.coverMode || input.imageStrategy || "auto"),
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

function findNestedNumber(value, keys = []) {
  if (!value || typeof value !== "object") return null;
  for (const key of keys) {
    const direct = value[key];
    if (typeof direct === "number") return direct;
    if (typeof direct === "string" && direct.trim() !== "" && !Number.isNaN(Number(direct))) return Number(direct);
  }
  for (const item of Object.values(value)) {
    if (item && typeof item === "object") {
      const nested = findNestedNumber(item, keys);
      if (nested !== null) return nested;
    }
  }
  return null;
}

function readPublishReadiness(payload, pageText = "") {
  const todayPubCount = findNestedNumber(payload, ["todayPubCount", "todayPublishCount", "pubCount"]);
  const maxDailyPublishCount = findNestedNumber(payload, ["maxDailyPublishCount", "maxPublishCount", "dailyPublishLimit"]);
  const auditState = findNestedNumber(payload, ["auditState", "verifyState", "onlineState"]);
  const text = cleanText(pageText);
  const underReview = /审核中|账号信息正在审核|耐心等待|under review/i.test(text);
  if (underReview) {
    return {
      ok: false,
      platformStatus: "account_under_review",
      message: "网易号账号仍在审核中，暂不能自动发布。"
    };
  }
  if (maxDailyPublishCount !== null && todayPubCount !== null && maxDailyPublishCount <= todayPubCount) {
    return {
      ok: false,
      platformStatus: "quota_blocked",
      message: `网易号今日发布额度不足：${todayPubCount}/${maxDailyPublishCount}。`
    };
  }
  if (maxDailyPublishCount === 0) {
    return {
      ok: false,
      platformStatus: "quota_blocked",
      message: "网易号发布额度为 0，可能账号仍在审核或暂未开通发布权限。"
    };
  }
  if (auditState === 0) {
    return {
      ok: false,
      platformStatus: "account_under_review",
      message: "网易号账号状态未通过审核，暂不能自动发布。"
    };
  }
  return { ok: true };
}

function safeNeteaseResponseUrl(value = "") {
  try {
    const parsed = new URL(String(value || ""));
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(value || "").split("?")[0].slice(0, 240);
  }
}

function summarizeNeteaseResponse(payload) {
  if (!payload || typeof payload !== "object") return {};
  const message = cleanText(
    payload.message || payload.msg || payload.errorMessage || payload.data?.message || payload.data?.msg || ""
  ).slice(0, 240);
  return {
    code: payload.code ?? payload.statusCode ?? payload.resultCode ?? "",
    businessStatus: payload.status ?? payload.data?.status ?? payload.data?.state ?? "",
    message,
  };
}

function neteasePayloadHasSubmissionMeaning(payload) {
  if (!payload || typeof payload !== "object") return false;
  const text = JSON.stringify(payload);
  if (/\u5931\u8d25|\u9519\u8bef|error|denied|rejected|captcha|risk|security|\u98ce\u63a7|\u9a8c\u8bc1\u7801|\u5fc5\u586b|\u8bf7\u9009\u62e9|\u8bf7\u586b\u5199/i.test(text)) return false;
  return /\u63d0\u4ea4\u6210\u529f|\u53d1\u5e03\u6210\u529f|\u5ba1\u6838\u4e2d|\u5f85\u5ba1\u6838|\u7b49\u5f85\u5ba1\u6838|\u5df2\u63d0\u4ea4|auditing|pending_review|submitted|publish_success/i.test(text);
}

function isNeteaseDraftOnlyResponse(url, payload) {
  const text = JSON.stringify(payload || {});
  return /(?:save|draft|autosave|upload|image|picture|cover|preview|postpage|navinfo)/i.test(url)
    || /\u8349\u7a3f(?:\u4fdd\u5b58)?\u6210\u529f|\u5df2\u4fdd\u5b58\u8349\u7a3f|\u81ea\u52a8\u4fdd\u5b58/i.test(text);
}

function neteasePreflightStage(url = "") {
  if (/\/assistant\/check\/content\.do/i.test(url)) return "content";
  if (/\/similar\/wrongWordDetect\.do/i.test(url)) return "wording";
  if (/\/assistant\/check\/coverPic\.do/i.test(url)) return "cover";
  return "";
}

function hasCompletedNeteasePreflight(state = {}) {
  const stages = new Set(state.preflightStages || []);
  return stages.has("content") && stages.has("cover");
}

async function waitForNeteasePreflightCompletion(page, state, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 30000);
  const pollMs = Number(options.pollMs || 500);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (hasCompletedNeteasePreflight(state)) {
      await options.onProgress?.({
        type: "publish_preflight_recheck_completed",
        stages: [...(state.preflightStages || [])],
      });
      return true;
    }
    await page.waitForTimeout?.(pollMs).catch(() => undefined);
  }
  await options.onProgress?.({
    type: "publish_preflight_recheck_timeout",
    stages: [...(state.preflightStages || [])],
  });
  return false;
}


function watchNeteaseApiResponses(page, options = {}) {
  const state = {
    readinessPayload: null,
    publishedUrl: "",
    publishAccepted: false,
    publishPayload: null,
    blocker: "",
    armed: false,
    observedResponses: [],
    preflightStages: [],
  };
  const handler = async (response) => {
    const url = typeof response.url === "function" ? response.url() : "";
    if (!/mp\.163\.com\/wemedia\//i.test(url)) return;
    const text = await response.text().catch(() => "");
    const payload = parseJsonLikePayload(text);
    if (/\/(navinfo|article\/postpage)\.do/i.test(url)) {
      state.readinessPayload = payload || state.readinessPayload;
    }
    if (!state.armed) return;
    const preflightStage = neteasePreflightStage(url);
    if (preflightStage && !state.preflightStages.includes(preflightStage)) {
      state.preflightStages.push(preflightStage);
      await options.onProgress?.({
        type: "publish_preflight_response_observed",
        stage: preflightStage,
        completed: hasCompletedNeteasePreflight(state),
      });
    }

    const method = response.request?.().method?.() || "";
    const isKnownPublishEndpoint = /\/(?:article\/(?:status\/api\/)?publish(?:v2)?|content\/publish|publish)\.do/i.test(url);
    if (method && method.toUpperCase() !== "POST" && !isKnownPublishEndpoint) return;

    const draftOnly = isNeteaseDraftOnlyResponse(url, payload);
    const accepted = !draftOnly && neteasePayloadIndicatesAccepted(payload);
    const diagnostic = {
      url: safeNeteaseResponseUrl(url),
      method: method || "UNKNOWN",
      httpStatus: response.status?.() || 0,
      draftOnly,
      accepted,
      ...summarizeNeteaseResponse(payload),
    };
    state.observedResponses.push(diagnostic);
    if (state.observedResponses.length > 20) state.observedResponses.shift();
    await options.onProgress?.({ type: "publish_response_observed", ...diagnostic });

    if (accepted || isKnownPublishEndpoint) {
      state.publishPayload = payload || state.publishPayload;
      const publishedUrl = neteasePublishedUrlFromPayload(payload);
      if (publishedUrl) state.publishedUrl = publishedUrl;
      if (accepted) state.publishAccepted = true;
      else if (neteasePayloadHasManualBlocker(payload)) state.blocker = "NETEASE_MANUAL_ACTION_REQUIRED";
    }
  };
  if (typeof page.on === "function") page.on("response", handler);
  return {
    state,
    markPublishAttempt() {
      state.armed = true;
    },
    resetPreflight() {
      state.preflightStages = [];
    },
    dispose() {
      if (typeof page.off === "function") page.off("response", handler);
    }
  };
}

function normalizeNeteasePublishedUrl(url = "") {
  try {
    const parsed = new URL(String(url || ""), "https://www.163.com");
    if (!/(^|\.)163\.com$/i.test(parsed.hostname)) return "";
    if (/\/(dy\/article|article)\/[^/]+\.html/i.test(parsed.pathname)) return parsed.toString().replace(/^http:/, "https:");
  } catch {
    return "";
  }
  return "";
}

function neteasePublishedUrlFromPayload(payload) {
  if (!payload || typeof payload !== "object") return "";
  const direct = payload.url || payload.href || payload.link || payload.articleUrl || payload.docUrl || payload.shareUrl;
  const normalized = normalizeNeteasePublishedUrl(direct);
  if (normalized) return normalized;
  for (const item of Object.values(payload)) {
    if (item && typeof item === "object") {
      const nested = neteasePublishedUrlFromPayload(item);
      if (nested) return nested;
    }
  }
  return "";
}

function neteasePayloadArticleIdentifier(payload) {
  if (!payload || typeof payload !== "object") return "";
  const direct = payload.articleId || payload.docid || payload.docId || payload.contentId;
  if (direct !== undefined && direct !== null && String(direct).trim()) return String(direct).trim();
  for (const item of Object.values(payload)) {
    if (item && typeof item === "object") {
      const nested = neteasePayloadArticleIdentifier(item);
      if (nested) return nested;
    }
  }
  return "";
}

function neteaseRecordArticleIdentifier(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return "";
  const direct = record.articleId ?? record.docid ?? record.docId ?? record.contentId;
  return direct !== undefined && direct !== null ? String(direct).trim() : "";
}

function neteaseRecordPublishedUrl(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return "";
  const direct = record.url || record.href || record.link || record.articleUrl || record.docUrl || record.shareUrl;
  return normalizeNeteasePublishedUrl(direct);
}

function comparableTitle(value) {
  return cleanText(value).toLocaleLowerCase("zh-CN");
}

function isNeteasePublicationPublic(record = {}) {
  const numericState = Number(record.contentState ?? record.publishState ?? record.onlineState);
  if (Number.isFinite(numericState) && numericState === 3) return true;
  const text = JSON.stringify({
    status: record.status,
    state: record.state,
    contentStatus: record.contentStatus,
    auditStatus: record.auditStatus,
  });
  return /published|publish_success|public|online|\u5df2\u53d1\u5e03|\u5df2\u4e0a\u7ebf/i.test(text)
    && !/pending|review|auditing|\u5ba1\u6838\u4e2d|\u5f85\u5ba1\u6838/i.test(text);
}

function matchingPublicationRecordFromPayload(payload, expectedTitle) {
  if (!payload || typeof payload !== "object") return null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const matched = matchingPublicationRecordFromPayload(item, expectedTitle);
      if (matched) return matched;
    }
    return null;
  }

  const normalizedExpected = comparableTitle(expectedTitle);
  const titleEntry = Object.entries(payload)
    .find(([key, value]) => typeof value === "string" && /(title|headline|name)$/i.test(key)
      && comparableTitle(value) === normalizedExpected);
  let titleOnlyMatch = null;
  if (normalizedExpected && titleEntry) {
    const articleId = neteaseRecordArticleIdentifier(payload);
    const publicState = isNeteasePublicationPublic(payload);
    const direct = publicState ? neteaseRecordPublishedUrl(payload) : "";
    const publicUrl = direct || (publicState && articleId
      ? normalizeNeteasePublishedUrl(`https://www.163.com/dy/article/${encodeURIComponent(articleId)}.html`)
      : "");
    titleOnlyMatch = {
      title: String(titleEntry[1]),
      articleId,
      status: payload.status ?? payload.state ?? payload.contentState ?? payload.contentStatus ?? "",
      contentState: payload.contentState ?? payload.publishState ?? payload.onlineState,
      restrictionReason: cleanText(payload.unrecomReason || payload.restrictionReason),
      appealStatus: payload.appealStatus ?? null,
      publicUrl,
    };
    if (articleId || direct) return titleOnlyMatch;
  }

  for (const item of Object.values(payload)) {
    if (item && typeof item === "object") {
      const matched = matchingPublicationRecordFromPayload(item, expectedTitle);
      if (matched) return matched;
    }
  }
  return null;
}

function safeNeteaseManagementEvidence(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  return {
    title: cleanText(record.title),
    articleId: cleanText(record.articleId),
    status: record.status ?? "",
    contentState: record.contentState ?? record.status ?? "",
    restrictionReason: cleanText(record.restrictionReason),
    appealStatus: record.appealStatus ?? null,
    publicUrl: normalizeNeteasePublishedUrl(record.publicUrl),
  };
}

function isNeteaseDistributionRestricted(managementEvidence) {
  return Number(managementEvidence?.contentState ?? managementEvidence?.status) === 3
    && Boolean(cleanText(managementEvidence?.restrictionReason));
}

function neteaseDistributionRestrictedResult(managementEvidence, title) {
  return {
    found: false,
    submissionAccepted: true,
    publicUrl: "",
    publishedUrl: "",
    reviewUrl: "",
    candidateUrl: "",
    platformStatus: "published_restricted",
    publiclyVisible: false,
    reviewStatus: "distribution_restricted",
    managementRecordFound: true,
    managementEvidence,
    managementVerificationReason: "PUBLICATION_DISTRIBUTION_RESTRICTED",
    message: "\u7f51\u6613\u53f7\u5df2\u63a5\u6536\u6587\u7ae0\uff0c\u4f46\u5185\u5bb9\u5206\u53d1\u53d7\u9650\uff0c\u5f53\u524d\u6ca1\u6709\u53ef\u9a8c\u8bc1\u516c\u5f00 URL\u3002\u8bf7\u524d\u5f80\u7f51\u6613\u53f7\u5185\u5bb9\u7ba1\u7406\u70b9\u51fb\u7533\u8bc9\u3002",
    title,
  };
}

// A distribution restriction is a recommendation decision, not a review verdict:
// the article can be fully public at its own address while the platform simply
// refuses to recommend it. So a restricted record does not get to skip the
// public-page gate. When the record carries an address, this puts it through the
// same anonymous read every other path uses and returns that address only when
// the page answers with the expected headline. An empty string means there is
// genuinely no verifiable public URL, which is what earns the restricted verdict.
async function verifyNeteaseRestrictedPublicUrl(context, managementEvidence, expectedTitle) {
  const candidate = normalizeNeteasePublishedUrl(managementEvidence?.publicUrl);
  if (!candidate) return "";
  return verifyNeteasePublishedUrl(context, candidate, expectedTitle)
    .then(() => candidate)
    .catch(() => "");
}

function watchNeteasePublicationList(page, expectedTitle) {
  const state = { publicUrl: "", record: null };
  const handler = async (response) => {
    const url = typeof response.url === "function" ? response.url() : "";
    if (!/mp\.163\.com\/wemedia\//i.test(url)) return;
    const text = await response.text().catch(() => "");
    const payload = parseJsonLikePayload(text);
    const record = matchingPublicationRecordFromPayload(payload, expectedTitle);
    if (record) {
      state.record = record;
      if (record.publicUrl) state.publicUrl = record.publicUrl;
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
async function searchNeteaseContentManagement(page, expectedTitle) {
  if (typeof page.locator !== "function") return;
  const search = page.locator("input.ne-input[type='text'], input[type='search']").first();
  const visible = await search.isVisible?.().catch(() => false);
  if (!visible) return;
  await search.fill(expectedTitle).catch(() => undefined);
  const searchButton = page.locator(".search-btn").first();
  const searchButtonVisible = await searchButton.isVisible?.().catch(() => false);
  if (searchButtonVisible) await searchButton.click().catch(() => undefined);
  else await search.press?.("Enter").catch(() => undefined);
  await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout?.(1200).catch(() => undefined);
}

async function readManagedPublicationUrl(page, expectedTitle) {
  if (typeof page.evaluate !== "function") return "";
  const candidate = await page.evaluate((title) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase("zh-CN");
    const expected = normalize(title);
    if (!expected) return "";
    const containers = Array.from(document.querySelectorAll("tr, [role='row'], li, .ant-list-item, .article-item, .content-item"));
    for (const container of containers) {
      if (!normalize(container.textContent).includes(expected)) continue;
      const links = Array.from(container.querySelectorAll("a[href], [data-href], [data-url]"));
      for (const link of links) {
        const value = link.getAttribute("href") || link.getAttribute("data-href") || link.getAttribute("data-url") || "";
        if (value) return value;
      }
    }
    return "";
  }, expectedTitle).catch(() => "");
  return normalizeNeteasePublishedUrl(candidate);
}

async function readManagedPublicationRecord(page, expectedTitle) {
  if (typeof page.evaluate !== "function") return null;
  const record = await page.evaluate((title) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase("zh-CN");
    const expected = normalize(title);
    if (!expected) return null;
    const containers = Array.from(document.querySelectorAll("tr, [role='row'], li, .ant-list-item, .article-item, .content-item"));
    for (const container of containers) {
      const containerText = String(container.textContent || "").replace(/\s+/g, " ").trim();
      if (!normalize(containerText).includes(expected)) continue;
      const links = Array.from(container.querySelectorAll("a[href], [data-href], [data-url]"));
      const candidate = links
        .map((link) => link.getAttribute("href") || link.getAttribute("data-href") || link.getAttribute("data-url") || "")
        .find(Boolean) || "";
      return {
        title,
        status: containerText,
        publicUrl: candidate,
      };
    }
    return null;
  }, expectedTitle).catch(() => null);
  if (!record || typeof record !== "object") return null;
  const publicState = /\u5df2\u53d1\u5e03|\u5df2\u4e0a\u7ebf|published|public|online/i.test(String(record.status || ""))
    && !/\u5ba1\u6838\u4e2d|\u5f85\u5ba1\u6838|pending|review|auditing/i.test(String(record.status || ""));
  return {
    title: String(record.title || expectedTitle),
    articleId: "",
    status: String(record.status || ""),
    publicUrl: publicState ? normalizeNeteasePublishedUrl(record.publicUrl) : "",
  };
}

async function readManagedPublicationTextRecord(page, expectedTitle) {
  if (typeof page.evaluate !== "function") return null;
  const text = cleanText(await page.evaluate(() => document.body?.innerText || "").catch(() => ""));
  const normalizedText = comparableTitle(text);
  const normalizedExpected = comparableTitle(expectedTitle);
  if (!normalizedExpected || !normalizedText.includes(normalizedExpected)) return null;

  const titleIndex = normalizedText.indexOf(normalizedExpected);
  const evidenceWindow = text.slice(Math.max(0, titleIndex - 120), titleIndex + expectedTitle.length + 260);
  const hasPublicationState = /\u5ba1\u6838\u4e2d|\u5f85\u53d1\u5e03|\u5df2\u53d1\u5e03|\u672a\u901a\u8fc7|\u5904\u7406\u5931\u8d25|\u521b\u5efa\u4e8e|\u5c55\u73b0|\u89c2\u770b|pending|review|published/i.test(evidenceWindow);
  if (!hasPublicationState) return null;

  return {
    title: expectedTitle,
    articleId: "",
    status: cleanText(evidenceWindow),
    publicUrl: "",
  };
}

async function confirmNeteaseSubmissionInManagement(page, expectedTitle, options = {}) {
  const watcher = watchNeteasePublicationList(page, expectedTitle);
  try {
    await options.onProgress?.({
      type: "publish_management_verification",
      stage: "started",
      title: expectedTitle,
    });
    await page.goto(options.manageUrl || NETEASE_MANAGE_URL, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
    await page.waitForTimeout?.(1000).catch(() => undefined);
    await searchNeteaseContentManagement(page, expectedTitle);
    const record = watcher.state.record
      || await readManagedPublicationRecord(page, expectedTitle)
      || await readManagedPublicationTextRecord(page, expectedTitle);
    const evidence = safeNeteaseManagementEvidence(record);
    await options.onProgress?.({
      type: "publish_management_verification",
      stage: "completed",
      found: Boolean(evidence),
      title: evidence?.title || "",
      articleId: evidence?.articleId || "",
      status: evidence?.status ?? "",
      publicUrl: evidence?.publicUrl || "",
    });
    return record;
  } finally {
    watcher.dispose();
  }
}

function neteasePayloadIndicatesAccepted(payload) {
  if (!neteasePayloadHasSubmissionMeaning(payload)) return false;
  return Boolean(neteasePublishedUrlFromPayload(payload) || neteasePayloadArticleIdentifier(payload));
}

function findNeteaseDocId(value) {
  const direct = neteasePayloadArticleIdentifier(value);
  if (direct) return direct;
  if (typeof value === "string") {
    const match = value.match(/\b(?:docId|docid|articleId|article_id)=([^&,\s]+)/i);
    return match ? cleanText(decodeURIComponent(match[1])) : "";
  }
  if (!value || typeof value !== "object") return "";
  for (const item of Object.values(value)) {
    const nested = findNeteaseDocId(item);
    if (nested) return nested;
  }
  return "";
}

function findNeteaseStringField(value, keys = []) {
  if (!value || typeof value !== "object") return "";
  for (const key of keys) {
    const direct = value[key];
    if (direct !== undefined && direct !== null && cleanText(direct)) return cleanText(direct);
  }
  for (const item of Object.values(value)) {
    if (item && typeof item === "object") {
      const nested = findNeteaseStringField(item, keys);
      if (nested) return nested;
    }
  }
  return "";
}

function findNeteaseImageUrl(value) {
  const direct = findNeteaseStringField(value, ["url", "picUrl", "imgUrl", "imageUrl", "src"]);
  if (/^https?:\/\//i.test(direct)) return direct;
  if (!value || typeof value !== "object") return "";
  for (const item of Object.values(value)) {
    if (typeof item === "string" && /^https?:\/\//i.test(item)) return item;
    if (item && typeof item === "object") {
      const nested = findNeteaseImageUrl(item);
      if (nested) return nested;
    }
  }
  return "";
}

async function neteaseApiConfig(page, input = {}) {
  const config = input.platformConfig && typeof input.platformConfig === "object" ? input.platformConfig : {};
  let wemediaId = cleanText(config.wemediaId || config.mediaId || config.accountId);
  let realUserId = cleanText(config.realUserId || config.userId || config.uid);
  if (!wemediaId || !realUserId) {
    const account = await platformApiFetch(page, NETEASE_ACCOUNT_QUERY_URL, {
      headers: { Referer: NETEASE_PUBLISH_URL },
    });
    if ([401, 403].includes(account.status)) throw new Error("NETEASE_LOGIN_REQUIRED");
    wemediaId ||= findNeteaseStringField(account.payload, ["wemediaId", "mediaId"]);
    realUserId ||= findNeteaseStringField(account.payload, ["realUserId", "beeUid", "userId", "uid"]);
  }
  if (!wemediaId) throw new Error("NETEASE_API_WEMEDIA_ID_REQUIRED");
  if (!realUserId) throw new Error("NETEASE_API_REAL_USER_ID_REQUIRED");
  return { wemediaId, realUserId };
}

function shouldPublishNeteaseViaApi(input = {}, publishInput = {}) {
  if (!publishInput.confirmPublish) return false;
  const config = input.platformConfig && typeof input.platformConfig === "object" ? input.platformConfig : {};
  const hasConfig = Boolean(config.wemediaId && config.realUserId);
  return Boolean((input.apiFirst === true || hasConfig) && publishInput.coverImagePath);
}

function neteaseApiErrorIsTerminal(error) {
  const message = String(error?.message || error || "");
  return /LOGIN_REQUIRED|MANUAL_ACTION_REQUIRED|WEMEDIA_ID_REQUIRED|REAL_USER_ID_REQUIRED|AUTH|CAPTCHA|RISK|SECURITY|VERIFY/i.test(message);
}

function neteaseHtmlContent(publishInput = {}) {
  if (publishInput.richHtml) return publishInput.richHtml;
  return String(publishInput.content || "")
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${cleanText(paragraph)}</p>`)
    .join("") || "<p><br></p>";
}

function neteaseApiBaseParams(config = {}) {
  return `wemediaId=${encodeURIComponent(config.wemediaId)}&realUserId=${encodeURIComponent(config.realUserId)}`;
}

async function uploadNeteaseCoverViaApi(page, publishInput = {}, config = {}) {
  const coverBuffer = await readFile(publishInput.coverImagePath);
  const coverName = path.basename(publishInput.coverImagePath) || "cover.jpg";
  const upload = await platformApiFetch(
    page,
    `${NETEASE_IMAGE_UPLOAD_URL}?${neteaseApiBaseParams(config)}`,
    {
      method: "POST",
      multipart: {
        pic: {
          name: coverName,
          mimeType: /\.png$/i.test(coverName) ? "image/png" : "image/jpeg",
          buffer: coverBuffer,
        },
      },
      headers: { Referer: NETEASE_PUBLISH_URL },
    },
  );
  if ([401, 403].includes(upload.status)) throw new Error("NETEASE_LOGIN_REQUIRED");
  const coverUrl = findNeteaseImageUrl(upload.payload);
  if (!upload.ok || !coverUrl) throw new Error("NETEASE_API_COVER_UPLOAD_FAILED");

  const material = await platformApiFetch(
    page,
    `${NETEASE_PICTURE_REGISTER_URL}?${neteaseApiBaseParams(config)}`,
    {
      method: "POST",
      form: {
        picUrl: coverUrl,
        title: publishInput.title,
      },
      headers: { Referer: NETEASE_PUBLISH_URL },
    },
  );
  if ([401, 403].includes(material.status)) throw new Error("NETEASE_LOGIN_REQUIRED");
  const picId = findNeteaseStringField(material.payload, ["picId", "pid", "id"]);

  return {
    coverUrl,
    picId,
    thumbnailUrl: coverUrl,
    evidence: [upload.evidence, material.evidence],
  };
}

async function readNeteaseRuntimePublishFields(page) {
  const fields = await page.evaluate?.(() => {
    const read = (name) => String(
      document.querySelector(`[name="${name}"]`)?.value
      || document.querySelector(`[data-${name}]`)?.getAttribute(`data-${name}`)
      || ""
    ).trim();
    return { ursToken: read("ursToken"), sign: read("sign"), timestamp: read("timestamp") };
  }).catch(() => null);
  if (!fields?.ursToken || !fields?.sign || !fields?.timestamp) throw new Error("NETEASE_RUNTIME_FIELDS_REQUIRED");
  return fields;
}

function neteaseCapturedPublishForm(publishInput, cover, articleId, operation, runtime = {}) {
  return {
    wemediaId: "",
    articleId: articleId || "",
    title: publishInput.title,
    content: neteaseHtmlContent(publishInput),
    cover: "single",
    operation,
    scheduled: "false",
    ursToken: runtime.ursToken,
    onlineState: "2",
    picUrl: cover.coverUrl,
    original: "0",
    subjectId: "",
    essayId: "",
    essayTitle: "",
    essayUrl: "",
    essayClassify: "",
  };
}

async function publishNeteaseViaApi(page, input = {}, publishInput = {}) {
  const config = await neteaseApiConfig(page, input);
  const runtime = await readNeteaseRuntimePublishFields(page);
  const cover = await uploadNeteaseCoverViaApi(page, publishInput, config);
  const endpoint = `${NETEASE_PUBLISH_API_URL}?${neteaseApiBaseParams(config)}`;
  const saves = [];
  let docId = "";
  for (let index = 0; index < 3; index += 1) {
    const save = await platformApiFetch(page, endpoint, {
      method: "POST",
      form: { ...neteaseCapturedPublishForm(publishInput, cover, docId, "saveDraft", runtime), wemediaId: config.wemediaId },
      headers: { Referer: NETEASE_PUBLISH_URL },
    });
    if ([401, 403].includes(save.status)) throw new Error("NETEASE_LOGIN_REQUIRED");
    if (neteasePayloadHasManualBlocker(save.payload)) throw new Error("NETEASE_MANUAL_ACTION_REQUIRED");
    docId ||= findNeteaseDocId(save.payload);
    saves.push(save);
  }

  const final = await platformApiFetch(page, endpoint, {
    method: "POST",
    form: {
      ...neteaseCapturedPublishForm(publishInput, cover, docId, "publish", runtime),
      wemediaId: config.wemediaId,
      firstPub: "true",
      sign: runtime.sign,
      timestamp: runtime.timestamp,
    },
    headers: { Referer: NETEASE_PUBLISH_URL },
  });
  if ([401, 403].includes(final.status)) throw new Error("NETEASE_LOGIN_REQUIRED");
  if (neteasePayloadHasManualBlocker(final.payload)) throw new Error("NETEASE_MANUAL_ACTION_REQUIRED");
  const finalDocId = docId || findNeteaseDocId(final.payload);
  const accepted = final.ok && Boolean(finalDocId || neteasePayloadIndicatesAccepted(final.payload));
  if (!accepted) throw new Error("NETEASE_API_PUBLISH_NOT_ACCEPTED");
  // The publish request was accepted, so report the doc id before public-page or
  // management verification can discard it.
  input.evidenceSink?.({
    draftUrl: NETEASE_MANAGE_URL,
    reviewUrl: NETEASE_MANAGE_URL,
    externalIds: { docId: finalDocId, picId: cover.picId || "" },
    platformStatus: "submitted_for_review"
  });
  return {
    draftUrl: NETEASE_MANAGE_URL,
    publishedUrl: "",
    reviewUrl: NETEASE_MANAGE_URL,
    platformStatus: "submitted_for_review",
    publiclyVisible: false,
    reviewStatus: "pending_public_visibility",
    title: publishInput.title,
    externalIds: {
      docId: finalDocId,
      picId: cover.picId || "",
    },
    publicationEvidence: {
      source: "api",
      accepted,
      httpStatus: final.status,
      endpoint: final.evidence.request.url,
      responses: [...cover.evidence, ...saves.map((save) => save.evidence), final.evidence],
    },
    message: "NetEase accepted the API publish request; public URL still requires management/public-page verification.",
  };
}

function neteasePayloadHasManualBlocker(payload) {
  if (!payload || typeof payload !== "object") return false;
  const text = JSON.stringify(payload);
  return /captcha|risk|security|manual|发布额度|今日已发布|未开通|验证码|风控|必填|请选择|请填写|发布失败|提交失败/i.test(text);
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

async function fillNeteaseTitle(page, title) {
  return fillFirstLocator(
    page,
    "textarea.netease-textarea, textarea[placeholder*='标题'], textarea",
    title,
    "NETEASE_TITLE_FIELD_NOT_FOUND"
  );
}

async function fillNeteaseBody(page, publishInput) {
  const selector = ".public-DraftEditor-content[contenteditable='true'], #editor_wyh [contenteditable='true'], [contenteditable='true']";
  const locator = page.locator(selector).first();
  try {
    await locator.click?.().catch(() => undefined);
    let pasted = false;
    if (publishInput.richHtml) {
      pasted = await pasteRichHtml(locator, publishInput.richHtml, publishInput.content);
      await page.waitForTimeout?.(500).catch(() => undefined);
      if (pasted && typeof locator.innerText === "function") {
        const actualText = cleanText(await locator.innerText().catch(() => ""));
        const expectedMarkers = publishInput.contentBlocks
          .filter((block) => block?.type === "section")
          .map((block) => cleanText(block.title || block.content).slice(0, 24))
          .filter(Boolean);
        if (!actualText || expectedMarkers.some((marker) => !actualText.includes(marker))) pasted = false;
      }
    }
    if (!pasted) await locator.fill(publishInput.content);
    await locator.dispatchEvent?.("input").catch(() => undefined);
    await locator.dispatchEvent?.("change").catch(() => undefined);
    return locator;
  } catch (error) {
    throw new Error(`NETEASE_BODY_FIELD_NOT_FOUND: ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function chooseNeteaseDefaults(page, publishInput) {
  if (typeof page.locator !== "function") return;
  if (!publishInput.confirmPublish && /auto|自动/i.test(publishInput.coverMode)) {
    await page.locator("label:has-text('自动'), button:has-text('自动'), text=自动").first().click?.().catch(() => undefined);
  }
  if (publishInput.category) {
    await page.locator(`text=${publishInput.category}`).first().click?.().catch(() => undefined);
  }
}

async function waitForVisibleLocator(locator, page, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await locator.isVisible?.().catch(() => false)) return true;
    await page.waitForTimeout?.(100).catch(() => undefined);
  }
  return false;
}

export async function chooseNeteaseSingleCover(page, options = {}) {
  if (typeof page?.locator !== "function") throw new Error("NETEASE_COVER_UI_NOT_AVAILABLE");
  const timeoutMs = Number(options.timeoutMs || 15000);
  const singleCoverOption = page.locator("label:has(input[type='radio'][value='custom']), input[type='radio'][value='custom']").first();
  await singleCoverOption.click?.().catch((error) => {
    throw new Error(`NETEASE_SINGLE_COVER_OPTION_NOT_FOUND: ${error instanceof Error ? error.message : String(error)}`);
  });

  const chooser = page.locator(".cover-pic__single__content__choose").first();
  if (!await waitForVisibleLocator(chooser, page, timeoutMs)) {
    throw new Error("NETEASE_COVER_CHOOSER_NOT_FOUND");
  }
  await chooser.click();

  const modal = page.locator(".ne-modal.cover-picture").first();
  if (!await waitForVisibleLocator(modal, page, timeoutMs)) {
    throw new Error("NETEASE_COVER_DIALOG_NOT_OPEN");
  }

  const candidates = page.locator(".ne-modal.cover-picture .cover-picture__item");
  const candidateCount = await candidates.count?.().catch(() => 0) || 0;
  if (!candidateCount) throw new Error("NETEASE_COVER_CANDIDATE_NOT_FOUND");
  await candidates.first().click();

  const confirmSelectors = [
    ".ne-modal.cover-picture [role='none']:has-text('确认'):not(.disabled)",
    ".ne-modal.cover-picture button:has-text('确认')",
    ".ne-modal.cover-picture .ne-button:has-text('确认')",
  ];
  let confirmed = false;
  const startedAt = Date.now();
  while (!confirmed && Date.now() - startedAt < timeoutMs) {
    for (const selector of confirmSelectors) {
      const confirmButton = page.locator(selector).first();
      const visible = await confirmButton.isVisible?.().catch(() => false);
      const disabled = await confirmButton.isDisabled?.().catch(() => true);
      if (!visible || disabled) continue;
      await confirmButton.click();
      confirmed = true;
      break;
    }
    if (!confirmed) await page.waitForTimeout?.(100).catch(() => undefined);
  }
  if (!confirmed) throw new Error(`NETEASE_COVER_CONFIRM_BUTTON_${(await describeUnavailableButton(confirmSelectors.map((selector) => page.locator(selector.replace(":not(.disabled)", "")).first()))).toUpperCase()}`);

  const committedCover = page.locator(".cover-pic__single img, .cover-pic__single__content img").first();
  if (!await waitForVisibleLocator(committedCover, page, timeoutMs)) {
    throw new Error("NETEASE_COVER_NOT_COMMITTED");
  }
  return { selected: true, candidateCount };
}

async function waitForDraftSaved(page, timeoutMs) {
  if (typeof page.waitForFunction !== "function") return;
  await page.waitForFunction(() => {
    const text = document.body?.innerText || "";
    return /草稿|已保存|保存成功|saved|draft/i.test(text);
  }, null, { timeout: timeoutMs }).catch(() => undefined);
}

async function readNeteasePlatformBlocker(page) {
  if (typeof page.evaluate !== "function") return "";
  const text = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
  if (/登录|注册|login/i.test(text) && !/创作|内容管理|发布|草稿/.test(text)) return "NETEASE_LOGIN_REQUIRED";
  if (/审核中|账号信息正在审核|发布额度|今日已发布\s*0\s*\/\s*0|未开通/.test(text)) return "NETEASE_ACCOUNT_OR_QUOTA_BLOCKED";
  if (/验证码|安全验证|风控|请完成验证|滑块/.test(text)) return "NETEASE_MANUAL_ACTION_REQUIRED";
  return "";
}

async function describeNeteaseControl(locator, selector) {
  const text = cleanText(await locator.innerText?.().catch(() => "")).slice(0, 120);
  const className = cleanText(await locator.getAttribute?.("class").catch(() => "")).slice(0, 160);
  return { selector, text, className };
}

async function clickNeteasePublish(page, timeoutMs, options = {}) {
  const publishText = "\u53d1\u5e03";
  const selectors = [
    `button.ne-button.primary_button:has-text('${publishText}')`,
    `button[type='primary']:has-text('${publishText}')`,
    `button:has-text('${publishText}')`,
    `[role='button']:has-text('${publishText}')`
  ];
  timeoutMs = Number.isFinite(Number(timeoutMs)) ? Math.min(60000, Math.max(1, Number(timeoutMs))) : 30000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    for (const selector of selectors) {
      const button = page.locator(selector).first();
      const visible = await button.isVisible?.().catch(() => false);
      const disabled = await button.isDisabled?.().catch(() => true);
      if (visible && !disabled) {
        const detail = await describeNeteaseControl(button, selector);
        await options.onProgress?.({ type: "publish_button_found", disabled: false, ...detail });
        await button.scrollIntoViewIfNeeded?.().catch(() => undefined);
        await button.click({ timeout: Math.max(1, Math.min(5000, timeoutMs - (Date.now() - startedAt))) });
        await options.onProgress?.({
          type: "publish_button_clicked",
          pageUrl: safeNeteaseResponseUrl(typeof page.url === "function" ? page.url() : ""),
          ...detail,
        });
        return detail;
      }
    }
    await page.waitForTimeout?.(500).catch(() => undefined);
  }
  throw new Error(`NETEASE_PUBLISH_BUTTON_${(await describeUnavailableButton(selectors.map((selector) => page.locator(selector).first()))).toUpperCase()}`);
}

async function findAvailableNeteasePublishControl(page) {
  if (typeof page?.locator !== "function") return null;
  const publishText = "\u53d1\u5e03";
  const selectors = [
    `button.ne-button.primary_button:has-text('${publishText}')`,
    `button[type='primary']:has-text('${publishText}')`,
    `button:has-text('${publishText}')`,
    `[role='button']:has-text('${publishText}')`,
  ];
  for (const selector of selectors) {
    const button = page.locator(selector).first();
    const visible = await button.isVisible?.().catch(() => false);
    const disabled = await button.isDisabled?.().catch(() => true);
    if (visible && !disabled) return { button, selector };
  }
  return null;
}

async function readVisibleNeteaseDialogs(page) {
  if (typeof page.locator !== "function") return [];
  const locator = page.locator(".ne-modal:visible, .ant-modal:visible, [role='dialog']:visible");
  const values = await locator.allInnerTexts?.().catch(() => []) || [];
  return values.map((value) => cleanText(value).slice(0, 300)).filter(Boolean).slice(0, 5);
}

async function confirmNeteaseDialogs(page, options = {}) {
  if (typeof page.locator !== "function") return [];
  const confirmPublish = "\u786e\u8ba4\u53d1\u5e03";
  const ignoreAndPublish = "\u5ffd\u7565\u5e76\u53d1\u5e03";
  const continuePublish = "\u7ee7\u7eed\u53d1\u5e03";
  const publish = "\u53d1\u5e03";
  const confirm = "\u786e\u8ba4";
  const ok = "\u786e\u5b9a";
  const selectors = [
    `.ne-modal button:has-text('${confirmPublish}')`,
    `.ne-modal button:has-text('${ignoreAndPublish}')`,
    `.ne-modal button:has-text('${continuePublish}')`,
    `.ne-modal button:has-text('${publish}')`,
    `.ne-modal button:has-text('${confirm}')`,
    `.ne-modal button:has-text('${ok}')`,
    `.ant-modal button:has-text('${confirmPublish}')`,
    `.ant-modal button:has-text('${continuePublish}')`,
    `.ant-modal button:has-text('${confirm}')`,
    `[role='dialog'] button:has-text('${confirmPublish}')`,
    `[role='dialog'] button:has-text('${continuePublish}')`,
    `[role='dialog'] button:has-text('${confirm}')`,

  ];
  const clickedControls = [];
  for (let index = 0; index < 4; index += 1) {
    const dialogs = await readVisibleNeteaseDialogs(page);
    if (dialogs.length) await options.onProgress?.({ type: "publish_dialog_observed", dialogs });
    let clicked = false;
    for (const selector of selectors) {
      const button = page.locator(selector).first();
      const visible = await button.isVisible?.().catch(() => false);
      const disabled = await button.isDisabled?.().catch(() => false);
      if (visible && !disabled) {
        const detail = await describeNeteaseControl(button, selector);
        await button.click?.().catch(() => undefined);
        clickedControls.push(detail);
        await options.onProgress?.({ type: "publish_dialog_confirmed", ...detail, dialogs });
        clicked = true;
        await page.waitForTimeout?.(1000).catch(() => undefined);
        break;
      }
    }
    if (!clicked) break;
  }
  return clickedControls;
}

async function adoptNeteasePreflightSuggestions(page, options = {}) {
  if (typeof page.locator !== "function") return 0;
  const adopt = "\u91c7\u7eb3";
  const adoptAll = "\u4e00\u952e\u91c7\u7eb3";
  const selectors = [
    `button:has-text('${adoptAll}')`,
    `[role='button']:has-text('${adoptAll}')`,
    `text=${adoptAll}`,
    `button:has-text('${adopt}')`,
    `[role='button']:has-text('${adopt}')`,
  ];
  let adopted = 0;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    let clicked = false;
    for (const selector of selectors) {
      const control = page.locator(selector).first();
      const visible = await control.isVisible?.().catch(() => false);
      const disabled = await control.isDisabled?.().catch(() => true);
      if (!visible || disabled) continue;
      const detail = await describeNeteaseControl(control, selector);
      await control.click?.();
      adopted += 1;
      clicked = true;
      await options.onProgress?.({
        type: "publish_preflight_suggestion_adopted",
        adopted,
        ...detail,
      });
      await page.waitForTimeout?.(300).catch(() => undefined);
      break;
    }
    if (!clicked) break;
  }
  return adopted;
}

async function rerunNeteasePreflight(page, options = {}) {
  if (typeof page.locator !== "function") return false;
  const recheck = "\u91cd\u65b0\u68c0\u6d4b";
  const selectors = [
    `button:has-text('${recheck}')`,
    `[role='button']:has-text('${recheck}')`,
    `text=${recheck}`,
  ];
  for (const selector of selectors) {
    const control = page.locator(selector).first();
    const visible = await control.isVisible?.().catch(() => false);
    const disabled = await control.isDisabled?.().catch(() => true);
    if (!visible || disabled) continue;
    const detail = await describeNeteaseControl(control, selector);
    await options.beforeClick?.();
    await control.click?.();
    await options.onProgress?.({
      type: "publish_preflight_recheck_clicked",
      ...detail,
    });
    return true;
  }
  return false;
}

async function captureNeteasePublishDiagnostic(page, options = {}) {
  const dialogs = await readVisibleNeteaseDialogs(page);
  const controls = typeof page.locator === "function"
    ? await page.locator("button:visible, [role='button']:visible, input[type='button']:visible, input[type='submit']:visible")
      .allInnerTexts?.()
      .catch(() => []) || []
    : [];
  const pageText = typeof page.evaluate === "function"
    ? cleanText(await page.evaluate(() => document.body?.innerText || "").catch(() => "")).slice(-2500)
    : "";
  const screenshotPath = cleanText(options.screenshotPath || process.env.ZHIXIN_NETEASE_DIAGNOSTIC_SCREENSHOT || "");
  let screenshotSaved = false;
  if (screenshotPath && typeof page.screenshot === "function") {
    screenshotSaved = await page.screenshot({ path: screenshotPath, fullPage: true })
      .then(() => true)
      .catch(() => false);
  }
  const diagnostic = {
    type: "publish_ui_diagnostic",
    pageUrl: safeNeteaseResponseUrl(typeof page.url === "function" ? page.url() : ""),
    dialogs,
    controls: controls.map((value) => cleanText(value).slice(0, 160)).filter(Boolean).slice(0, 40),
    pageText,
    screenshotSaved,
    observedResponses: Array.isArray(options.observedResponses) ? options.observedResponses.slice(-20) : [],
  };
  await options.onProgress?.(diagnostic);
  return diagnostic;
}

async function readNeteasePublishedUrl(page) {
  const current = typeof page.url === "function" ? page.url() : "";
  const normalizedCurrent = normalizeNeteasePublishedUrl(current);
  if (normalizedCurrent) return normalizedCurrent;
  if (typeof page.locator === "function") {
    const links = page.locator("a[href*='163.com'][href*='.html'], a[href*='/dy/article/']");
    const count = typeof links.count === "function"
      ? await links.count().catch(() => 0)
      : 1;
    if (count < 1) return "";
    const href = await links.first().getAttribute?.("href", { timeout: 250 }).catch(() => "");
    if (href) return normalizeNeteasePublishedUrl(href);
  }
  return "";
}

async function readNeteasePublicHeadline(page) {
  if (typeof page?.locator !== "function") return "";
  const selectors = [
    "h1",
    ".article-title",
    ".post_title",
    "[class*='post_title']",
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const value = cleanText(await locator.innerText?.({ timeout: 3000 }).catch(() => "") || "");
    if (value) return value;
  }
  return "";
}

async function verifyNeteasePublishedUrl(context, publishedUrl, expectedTitle) {
  if (!publishedUrl || typeof context?.newPage !== "function") return true;
  const page = await context.newPage();
  try {
    const response = await page.goto(publishedUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
    await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
    await page.waitForTimeout?.(2000).catch(() => undefined);
    const status = typeof response?.status === "function" ? response.status() : 0;
    const title = cleanText(await page.title().catch(() => ""));
    const text = cleanText(await page.locator?.("body")?.innerText?.({ timeout: 10000 }).catch(() => "") || await page.evaluate?.(() => document.body?.innerText || "").catch(() => "") || "");
    const headline = await readNeteasePublicHeadline(page);
    if ([401, 403, 404, 410, 451, 521].includes(status)) throw new Error("NETEASE_PUBLISHED_URL_NOT_PUBLIC");
    if (/^404\b|not found|forbidden|椤甸潰涓嶅瓨鍦?/i.test(`${title} ${text}`)) throw new Error("NETEASE_PUBLISHED_URL_NOT_PUBLIC");
    if (expectedTitle && comparableTitle(headline) !== comparableTitle(expectedTitle)) {
      throw new Error("NETEASE_PUBLISHED_URL_NOT_PUBLIC");
    }
    return true;
  } finally {
    await page.close?.().catch(() => undefined);
  }
}

// The shared verifyPublicPageImages returns its evidence promise from inside a
// try block whose finally closes the page, so the page is torn down before the
// read settles and every locator call fails against a closed target: the public
// stage then reports observedCount 0 on a page that plainly carries its images,
// and a published article stays stuck on platform review. That helper lives in a
// shared module an adapter bundle cannot ship (only adapters/*.mjs may be
// hot-updated; every other module installs as a re-export bridge to the
// installer's copy), so netease carries the same read with the evidence awaited
// before the page is closed. Retire this once the shared fix ships in a desktop
// release.
const NETEASE_PUBLIC_IMAGE_SELECTOR = "article img, .post_body img, .article-content img";
const NETEASE_PUBLIC_IMAGE_FALLBACK_SELECTOR = "article img, main img, .post_body img, .article-content img, .article img";

async function scrollNeteasePublicPageIntoView(page) {
  if (typeof page.evaluate !== "function") return;
  await page.evaluate(async () => {
    const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
    for (let offset = 0; offset < document.body.scrollHeight; offset += step) {
      window.scrollTo(0, offset);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }).catch(() => undefined);
}

async function verifyNeteasePublicPageImages(context, publishedUrl, tasks = []) {
  if (!tasks.length) return { images: [], blocker: "" };
  if (!context || typeof context.newPage !== "function") throw new Error("PUBLIC_IMAGE_CONTEXT_INVALID");
  const page = await context.newPage();
  try {
    await page.goto(publishedUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
    // Article bodies lazy-load their images, so without a scroll the locator sees
    // zero <img> elements and a healthy page would be reported as image-less.
    await scrollNeteasePublicPageIntoView(page);
    await page.waitForFunction?.((payload) => {
      const images = [...document.querySelectorAll(payload.selector)];
      const loaded = images.filter((image) => {
        const source = image.getAttribute("src") || "";
        return /^https:\/\//i.test(source) && image.complete && image.naturalWidth > 0;
      });
      return loaded.length >= payload.expectedCount;
    }, { selector: NETEASE_PUBLIC_IMAGE_SELECTOR, expectedCount: tasks.length }, { timeout: 30000 }).catch(() => undefined);
    // Await the evidence before returning: a bare `return promise` inside try
    // hands control to finally, which closes the page before the read settles.
    const evidence = await verifyPublicImageEvidence({
      tasks,
      readImages: async () => {
        const primary = await readLocatorImages(page, NETEASE_PUBLIC_IMAGE_SELECTOR);
        if (primary.length >= tasks.length) return primary;
        const fallback = await readLocatorImages(page, NETEASE_PUBLIC_IMAGE_FALLBACK_SELECTOR);
        return fallback.length > primary.length ? fallback : primary;
      },
      readBlocker: () => readPublicPageBlockerFromPage(page),
    });
    return evidence;
  } finally {
    await page.close?.().catch(() => undefined);
  }
}

export class NeteasePublishAdapter extends NeteaseAdapter {
  constructor(options = {}) {
    super(options);
    this.config = contentPlatformConfigs.netease;
    this.platform = "netease";
  }

  async publishArticle(input = {}) {
    const publishInput = normalizePublishInput(input);
    const context = await this.launchAuthEnvironment(input);
    const page = context.pages()[0] || await context.newPage();
    const keepOpen = Boolean(input.keepBrowserOpen);
    const watcher = watchNeteaseApiResponses(page, { onProgress: input.onProgress });
    try {
      page.setDefaultTimeout?.(15000);
      page.setDefaultNavigationTimeout?.(45000);
      if (shouldPublishNeteaseViaApi(input, publishInput)) {
        await page.goto?.(input.editorUrl || NETEASE_PUBLISH_URL, { waitUntil: "domcontentloaded" });
        return await publishNeteaseViaApi(page, input, publishInput);
      }
      await page.goto(input.editorUrl || NETEASE_PUBLISH_URL, { waitUntil: "domcontentloaded" });
      await bringToFrontIfAllowed(page, input);
      await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
      await page.waitForTimeout?.(1500).catch(() => undefined);

      const cookies = await context.cookies([NETEASE_ORIGIN, "https://www.163.com", "https://reg.163.com"]);
      const pageState = await readConfiguredPlatformPageState(page);
      if (!isConfiguredPlatformLoggedIn(this.config, cookies, pageState)) throw new Error("NETEASE_LOGIN_REQUIRED");

      const readiness = readPublishReadiness(watcher.state.readinessPayload, pageState.text);
      if (!readiness.ok) {
        return {
          draftUrl: typeof page.url === "function" ? page.url() : NETEASE_PUBLISH_URL,
          publishedUrl: "",
          platformStatus: readiness.platformStatus,
          publiclyVisible: false,
          reviewStatus: readiness.platformStatus,
          message: readiness.message,
          title: publishInput.title
        };
      }

      const openBlocker = await readNeteasePlatformBlocker(page);
      if (openBlocker === "NETEASE_LOGIN_REQUIRED") throw new Error(openBlocker);
      if (openBlocker === "NETEASE_ACCOUNT_OR_QUOTA_BLOCKED") {
        return {
          draftUrl: typeof page.url === "function" ? page.url() : NETEASE_PUBLISH_URL,
          publishedUrl: "",
          platformStatus: "quota_blocked",
          publiclyVisible: false,
          reviewStatus: "quota_blocked",
          message: "网易号账号审核或发布额度阻塞，暂不能自动发布。",
          title: publishInput.title
        };
      }
      if (openBlocker) throw new Error(openBlocker);

      await fillNeteaseTitle(page, publishInput.title);
      await fillNeteaseBody(page, publishInput);
      const uploadedImages = publishInput.platformImageTasks.length
        ? await uploadNeteaseInlineImages(page, publishInput.platformImageTasks, { onProgress: input.onProgress })
        : [];
      await chooseNeteaseDefaults(page, publishInput);
      await waitForDraftSaved(page, publishInput.draftTimeoutMs);
      const draftUrl = typeof page.url === "function" ? page.url() : NETEASE_PUBLISH_URL;
      let draftImages = [];
      if (publishInput.platformImageTasks.length) {
        await input.onProgress?.({ type: "verifying_draft_images", total: publishInput.platformImageTasks.length });
        await page.goto(draftUrl, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
        draftImages = await verifyPlatformImages({
          tasks: publishInput.platformImageTasks,
          readImages: () => readLocatorImages(page, ".public-DraftEditor-content img, [contenteditable='true'].editor img"),
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

      await input.onProgress?.({ type: "configuring_cover", mode: "single", source: "article_images" });
      const coverResult = await chooseNeteaseSingleCover(page, { timeoutMs: publishInput.publishTimeoutMs });
      await input.onProgress?.({ type: "cover_configured", ...coverResult });

      watcher.markPublishAttempt();
      await clickNeteasePublish(
        page,
        publishInput.publishTimeoutMs,
        { onProgress: input.onProgress }
      );
      await page.waitForTimeout?.(2500).catch(() => undefined);
      await confirmNeteaseDialogs(
        page,
        { onProgress: input.onProgress }
      );
      await page.waitForTimeout?.(1000).catch(() => undefined);

      let publishedUrl = watcher.state.publishedUrl || "";
      let preflightPublishRetryCount = 0;
      const retryPublishAfterPreflight = async () => {
        if (
          publishedUrl
          || watcher.state.publishAccepted
          || watcher.state.blocker
          || !hasCompletedNeteasePreflight(watcher.state)
        ) return false;

        const adopted = await adoptNeteasePreflightSuggestions(page, {
          onProgress: input.onProgress,
        });
        if (adopted > 0) {
          const recheckClicked = await rerunNeteasePreflight(page, {
            onProgress: input.onProgress,
            beforeClick: () => watcher.resetPreflight(),
          });
          await input.onProgress?.({
            type: "publish_preflight_suggestions_resolved",
            adopted,
            recheckClicked,
          });
          if (recheckClicked) {
            const recheckCompleted = await waitForNeteasePreflightCompletion(page, watcher.state, {
              timeoutMs: Math.min(Math.max(publishInput.publishTimeoutMs, 30000), 60000),
              onProgress: input.onProgress,
            });
            if (!recheckCompleted) return false;
          }
        }

        if (preflightPublishRetryCount >= 3) return false;
        const publishControl = await findAvailableNeteasePublishControl(page);
        await input.onProgress?.({
          type: "preflight_ready_waiting_for_publish_button",
          available: Boolean(publishControl),
          selector: publishControl?.selector || "",
          pageUrl: safeNeteaseResponseUrl(typeof page.url === "function" ? page.url() : ""),
        });
        if (!publishControl) return false;
        await input.onProgress?.({
          type: "publish_preflight_completed",
          stages: [...watcher.state.preflightStages],
          pageUrl: safeNeteaseResponseUrl(typeof page.url === "function" ? page.url() : ""),
        });
        await clickNeteasePublish(
          page,
          Math.min(publishInput.publishTimeoutMs, 15000),
          { onProgress: input.onProgress }
        );
        preflightPublishRetryCount += 1;
        await page.waitForTimeout?.(2000).catch(() => undefined);
        await confirmNeteaseDialogs(page, { onProgress: input.onProgress });
        return true;
      };

      await retryPublishAfterPreflight();
      publishedUrl = watcher.state.publishedUrl || await readNeteasePublishedUrl(page);
      for (let attempt = 0; attempt < 15; attempt += 1) {
        await retryPublishAfterPreflight();
        publishedUrl = watcher.state.publishedUrl || await readNeteasePublishedUrl(page);
        if (publishedUrl || watcher.state.publishAccepted || watcher.state.blocker) break;
        await page.waitForTimeout?.(1000).catch(() => undefined);
        await confirmNeteaseDialogs(page, { onProgress: input.onProgress });
      }

      if (watcher.state.blocker) throw new Error(watcher.state.blocker);
      publishedUrl = watcher.state.publishedUrl || publishedUrl || await readNeteasePublishedUrl(page);
      let managementRecord = null;
      if (!publishedUrl) {
        managementRecord = await confirmNeteaseSubmissionInManagement(page, publishInput.title, {
          onProgress: input.onProgress,
        });
        if (managementRecord?.publicUrl) publishedUrl = managementRecord.publicUrl;
      }
      if (!publishedUrl && (managementRecord || watcher.state.publishAccepted)) {
        return {
          draftUrl,
          publishedUrl: "",
          platformStatus: "submitted_for_review",
          publiclyVisible: false,
          reviewStatus: "pending_public_visibility",
          message: managementRecord
            ? "网易号内容管理已找到本次文章，正在等待平台审核和公开链接。"
            : "网易号接口已返回可关联的提交记录，正在等待平台审核和公开链接。",
          title: publishInput.title,
          ...(draftImageEvidence ? { imagePublicationEvidence: draftImageEvidence } : {}),
        };
      }
      if (!publishedUrl) {
        await captureNeteasePublishDiagnostic(page, {
          onProgress: input.onProgress,
          observedResponses: watcher.state.observedResponses,
        });
        throw new Error(watcher.state.publishPayload
          ? "NETEASE_PUBLISH_ACCEPTANCE_NOT_CONFIRMED"
          : "NETEASE_PUBLISHED_URL_NOT_FOUND");
      }

      // Set when a distribution-restricted management record still clears the
      // public-page gate, so the publish continues to the verified return below
      // instead of the "no verifiable public URL" verdict.
      let distributionRestrictedPublicUrl = "";
      try {
        await verifyNeteasePublishedUrl(context, publishedUrl, publishInput.title);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("NETEASE_PUBLISHED_URL_NOT_PUBLIC") && watcher.state.publishAccepted) {
          return {
            draftUrl,
            publishedUrl: "",
            reviewUrl: "",
            candidateUrl: "",
            platformStatus: "submitted_for_review",
            publiclyVisible: false,
            reviewStatus: "pending_public_visibility",
            message: "网易号已提交，但公开页暂时不可访问，等待平台审核或公开延迟。",
            title: publishInput.title,
            ...(draftImageEvidence ? { imagePublicationEvidence: draftImageEvidence } : {}),
          };
        }
        if (message.includes("NETEASE_PUBLISHED_URL_NOT_PUBLIC")) {
          const fallbackRecord = await confirmNeteaseSubmissionInManagement(page, publishInput.title, {
            onProgress: input.onProgress,
          }).catch(() => null);
          const fallbackEvidence = safeNeteaseManagementEvidence(fallbackRecord);
          if (fallbackEvidence) {
            if (isNeteaseDistributionRestricted(fallbackEvidence)) {
              // The restriction is a recommendation decision, not a review
              // verdict, so it cannot skip the public-page gate: the record's
              // own address goes through the same anonymous read the candidate
              // just failed. Only a page that fails it earns the restricted
              // verdict; a page that answers with this article's headline is an
              // approved public address, and the publish then falls through to
              // the verified return below.
              distributionRestrictedPublicUrl = await verifyNeteaseRestrictedPublicUrl(
                context,
                fallbackEvidence,
                publishInput.title,
              );
              if (!distributionRestrictedPublicUrl) {
                return {
                  draftUrl,
                  ...neteaseDistributionRestrictedResult(fallbackEvidence, publishInput.title),
                  ...(draftImageEvidence ? { imagePublicationEvidence: draftImageEvidence } : {}),
                };
              }
              publishedUrl = distributionRestrictedPublicUrl;
            }
            if (!distributionRestrictedPublicUrl) {
              return {
                draftUrl,
                publishedUrl: "",
                reviewUrl: "",
                candidateUrl: "",
                platformStatus: "submitted_for_review",
                publiclyVisible: false,
                reviewStatus: "pending_public_visibility",
                managementRecordFound: true,
                managementEvidence: fallbackEvidence,
                managementVerificationReason: "CANDIDATE_URL_REJECTED_MANAGEMENT_RECORD_FOUND",
                message: "\u7f51\u6613\u53f7\u5185\u5bb9\u7ba1\u7406\u5df2\u627e\u5230\u672c\u6b21\u6587\u7ae0\uff0c\u4f46\u5019\u9009\u516c\u5f00\u9875\u6682\u672a\u5339\u914d\uff0c\u7b49\u5f85\u5e73\u53f0\u5ba1\u6838\u6216\u516c\u5f00\u5ef6\u8fdf\u3002",
                title: publishInput.title,
                ...(draftImageEvidence ? { imagePublicationEvidence: draftImageEvidence } : {}),
              };
            }
          }
          if (!distributionRestrictedPublicUrl) {
            await captureNeteasePublishDiagnostic(page, {
              onProgress: input.onProgress,
              observedResponses: watcher.state.observedResponses,
            });
            input.evidenceSink?.({
              ...(draftUrl ? { draftUrl } : {}),
              platformStatus: "submitted_for_review"
            });
            throw new Error("NETEASE_PUBLISH_ACCEPTANCE_NOT_CONFIRMED");
          }
        }
        // A restricted record whose own address cleared the gate above falls
        // through to the verified publish return below; every other error,
        // including one that never reached the gate, still surfaces here.
        if (!distributionRestrictedPublicUrl) throw error;
      }

      let publicImages = [];
      let publicBlocker = "";
      if (publishInput.platformImageTasks.length) {
        await input.onProgress?.({ type: "verifying_public_images", total: publishInput.platformImageTasks.length });
        // A draft image URL is not public evidence. When the public page cannot be
        // observed the stage becomes "unverifiable" rather than silently reusing
        // the draft stage, which used to report PUBLIC_IMAGE_MISSING on a live page.
        const publicEvidence = await verifyNeteasePublicPageImages(
          context,
          publishedUrl,
          publishInput.platformImageTasks,
        ).catch(() => ({ images: [], blocker: "NETEASE_PUBLIC_IMAGE_VERIFICATION_FAILED" }));
        publicImages = publicEvidence.images;
        publicBlocker = publicEvidence.blocker;
      }
      const imagePublicationEvidence = publishInput.platformImageTasks.length
        ? buildImagePublicationEvidence(publishInput.platformImageTasks, uploadedImages, draftImages, publicImages, publicBlocker)
        : undefined;

      return {
        draftUrl,
        publishedUrl,
        platformStatus: "published",
        publiclyVisible: true,
        reviewStatus: "public",
        title: publishInput.title,
        ...(imagePublicationEvidence ? { imagePublicationEvidence } : {}),
      };
    } finally {
      watcher.dispose();
      await this.refreshCredentialAfterOperation(input, context, page, NETEASE_PUBLISH_URL);
      if (!keepOpen) await context.close().catch(() => undefined);
    }
  }

  async discoverPublication(input = {}) {
    const title = cleanText(input.articleTitle || input.title);
    if (!title) throw new Error("NETEASE_DISCOVERY_TITLE_REQUIRED");
    const context = await this.launchAuthEnvironment(input);
    const page = context.pages()[0] || await context.newPage();
    const keepOpen = Boolean(input.keepBrowserOpen);
    const watcher = watchNeteasePublicationList(page, title);
    try {
      page.setDefaultTimeout?.(15000);
      page.setDefaultNavigationTimeout?.(45000);
      await page.goto(input.manageUrl || NETEASE_MANAGE_URL, { waitUntil: "domcontentloaded" });
      await bringToFrontIfAllowed(page, input);
      await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
      await page.waitForTimeout?.(1500).catch(() => undefined);

      const cookies = await context.cookies([NETEASE_ORIGIN, "https://www.163.com", "https://reg.163.com"]);
      const pageState = await readConfiguredPlatformPageState(page);
      if (!isConfiguredPlatformLoggedIn(this.config, cookies, pageState)) throw new Error("NETEASE_LOGIN_REQUIRED");

      await searchNeteaseContentManagement(page, title);
      const managementRecord = watcher.state.record || await readManagedPublicationRecord(page, title);
      const managementEvidence = safeNeteaseManagementEvidence(managementRecord);
      const publicUrl = managementEvidence?.publicUrl || "";
      const distributionRestricted = isNeteaseDistributionRestricted(managementEvidence);
      // A distribution restriction is a recommendation decision, not a review
      // verdict, so a restricted record still has to clear the same anonymous
      // public-page gate below. Only a page that fails it earns the restricted
      // verdict; the record's own address is the candidate that gets verified.
      if (!publicUrl) {
        const managementRecordFound = Boolean(managementEvidence);
        return {
          found: false,
          publicUrl: "",
          publishedUrl: "",
          platformStatus: managementRecordFound ? "submitted_for_review" : "not_found",
          publiclyVisible: false,
          reviewStatus: managementRecordFound ? "pending_public_visibility" : "management_record_not_found",
          managementRecordFound,
          managementEvidence,
          managementVerificationReason: managementRecordFound
            ? "PUBLIC_URL_NOT_DISCOVERED"
            : "MANAGEMENT_RECORD_NOT_FOUND",
          message: managementRecordFound
            ? "\u7f51\u6613\u53f7\u5185\u5bb9\u7ba1\u7406\u5df2\u627e\u5230\u7cbe\u786e\u6587\u7ae0\u8bb0\u5f55\uff0c\u4f46\u516c\u5f00\u94fe\u63a5\u5c1a\u672a\u751f\u6210\u3002"
            : "\u7f51\u6613\u53f7\u5185\u5bb9\u7ba1\u7406\u672a\u627e\u5230\u4e0e\u672c\u6b21\u6807\u9898\u7cbe\u786e\u5339\u914d\u7684\u6587\u7ae0\u8bb0\u5f55\u3002",
          title
        };
      }

      try {
        await verifyNeteasePublishedUrl(context, publicUrl, title);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("NETEASE_PUBLISHED_URL_NOT_PUBLIC")) {
          if (isNeteaseDistributionRestricted(managementEvidence)) {
            return neteaseDistributionRestrictedResult(managementEvidence, title);
          }
          return {
            found: false,
            publicUrl: "",
            publishedUrl: "",
            reviewUrl: "",
            candidateUrl: "",
            platformStatus: "submitted_for_review",
            publiclyVisible: false,
            reviewStatus: "pending_public_visibility",
            managementRecordFound: true,
            managementEvidence,
            managementVerificationReason: "PUBLIC_PAGE_NOT_VERIFIED",
            message: "\u7f51\u6613\u53f7\u5df2\u627e\u5230\u672c\u6b21\u6587\u7ae0\u8bb0\u5f55\uff0c\u4f46\u516c\u5f00\u9875\u6807\u9898\u6216\u8bbf\u95ee\u72b6\u6001\u5c1a\u672a\u901a\u8fc7\u9a8c\u8bc1\u3002",
            title
          };
        }
        throw error;
      }

      const existingEvidence = input.imagePublicationEvidence && typeof input.imagePublicationEvidence === "object"
        ? input.imagePublicationEvidence
        : {};
      const expectedImageTasks = Array.isArray(existingEvidence.expected) ? existingEvidence.expected : [];
      let imagePublicationEvidence;
      if (expectedImageTasks.length) {
        await input.onProgress?.({ type: "verifying_public_images", total: expectedImageTasks.length });
        // The public page is the only stage a discovery recheck can still observe, so it
        // re-reads the images there instead of trusting the stale verdict. Upload/draft
        // observations carry over from the order evidence; stages the order never observed
        // are rewritten to not_observed by the backend recovery.
        const publicEvidence = await verifyNeteasePublicPageImages(
          context,
          publicUrl,
          expectedImageTasks,
        ).catch(() => ({ images: [], blocker: "NETEASE_PUBLIC_IMAGE_VERIFICATION_FAILED" }));
        imagePublicationEvidence = buildImagePublicationEvidence(
          expectedImageTasks,
          existingEvidence.upload?.images || [],
          existingEvidence.draft?.images || [],
          publicEvidence.images,
          publicEvidence.blocker,
        );
      }

      return {
        found: true,
        publicUrl,
        publishedUrl: publicUrl,
        platformStatus: "published",
        publiclyVisible: true,
        reviewStatus: "public",
        managementRecordFound: true,
        managementEvidence,
        managementVerificationReason: distributionRestricted
          ? "PUBLIC_PAGE_VERIFIED_DISTRIBUTION_RESTRICTED"
          : "PUBLIC_PAGE_VERIFIED",
        // The page cleared the gate, so the article is published and public; the
        // restriction only withholds recommendation, which is worth reporting
        // without letting it erase the address the backend needs for the backlink.
        ...(distributionRestricted
          ? {
            message: `\u7f51\u6613\u53f7\u6587\u7ae0\u5df2\u5ba1\u6838\u901a\u8fc7\u5e76\u516c\u5f00\uff0c\u4f46\u5e73\u53f0\u9650\u5236\u5206\u53d1\uff08${managementEvidence.restrictionReason}\uff09\u3002`,
          }
          : {}),
        title,
        ...(imagePublicationEvidence ? { imagePublicationEvidence } : {}),
      };
    } finally {
      watcher.dispose();
      await this.refreshCredentialAfterOperation(input, context, page, NETEASE_MANAGE_URL);
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
