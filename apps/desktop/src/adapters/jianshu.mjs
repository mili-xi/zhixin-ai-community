import path from "node:path";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import {
  ContentPlatformAdapter,
  contentPlatformConfigs,
  isConfiguredPlatformLoggedIn,
  readConfiguredPlatformPageState,
} from "./content-platform.mjs";
import { pasteRichHtml, pasteRichHtmlWithSystemClipboard, readLocatorImages, readPublicPageBlockerFromPage, verifyPlatformImages, verifyPublicImageEvidence } from "../editor-image-upload.mjs";
import { buildImagePublicationEvidence, PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED, isPersistentPlatformImageUrl } from "../platform-images.mjs";
import { composeRichArticleHtml } from "../rich-content.mjs";
import { bringToFrontIfAllowed } from "../browser-visibility.mjs";
import { platformApiFetch } from "./platform-api.mjs";

// Kept in the hot-updatable adapter: installed shared modules cannot be replaced by a bundle.
function persistentImages(images = [], options = {}) {
  const requireLoaded = options.requireLoaded !== false;
  return (Array.isArray(images) ? images : []).filter((image) => (
    isPersistentPlatformImageUrl(image?.platformImageUrl || image?.src || image?.url)
    && (!requireLoaded || image?.loaded !== false)
  ));
}

function bindTask(task, image) {
  return {
    assetId: String(task?.assetId || ""),
    sectionId: String(task?.sectionId || ""),
    position: Number(task?.position ?? -1),
    platformImageId: String(image?.platformImageId || ""),
    platformImageUrl: String(image?.platformImageUrl || image?.src || image?.url || ""),
    loaded: image?.loaded !== false,
  };
}

export async function uploadJianshuPlatformImages(options = {}) {
  const tasks = Array.isArray(options.tasks) ? options.tasks : [];
  if (!tasks.length) return [];
  if (typeof options.readImages !== "function" || typeof options.selectFile !== "function") {
    throw new Error("PLATFORM_IMAGE_UPLOADER_INVALID");
  }
  const timeoutMs = Math.max(1, Number(options.timeoutMs || 45000));
  const pollMs = Math.max(1, Number(options.pollMs || 250));
  const requireLoaded = options.requireLoaded !== false;
  const uploaded = [];

  for (const [index, task] of tasks.entries()) {
    await options.onProgress?.({
      type: "uploading_image_start",
      completed: index,
      total: tasks.length,
      assetId: task.assetId || "",
      sectionId: task.sectionId || "",
    });
    const before = persistentImages(await options.readImages(), { requireLoaded });
    const knownUrls = new Set(before.map((image) => String(image.platformImageUrl || image.src || image.url || "")));
    await options.onProgress?.({
      type: "uploading_image_snapshot",
      stage: "before_select",
      completed: index,
      total: tasks.length,
      assetId: task.assetId || "",
      sectionId: task.sectionId || "",
      imageCount: before.length,
      ...(typeof options.debugSnapshot === "function" ? await options.debugSnapshot("before_select", task, index).catch(() => ({})) : {}),
    });
    await options.positionForTask?.(task, index);
    await options.selectFile(task, index);
    await options.onProgress?.({
      type: "uploading_image_snapshot",
      stage: "after_select",
      completed: index,
      total: tasks.length,
      assetId: task.assetId || "",
      sectionId: task.sectionId || "",
      imageCount: persistentImages(await options.readImages(), { requireLoaded }).length,
      ...(typeof options.debugSnapshot === "function" ? await options.debugSnapshot("after_select", task, index).catch(() => ({})) : {}),
    });
    const startedAt = Date.now();
    let selected = null;
    while (Date.now() - startedAt < timeoutMs) {
      const current = persistentImages(await options.readImages(), { requireLoaded });
      selected = current.find((image) => !knownUrls.has(String(image.platformImageUrl || image.src || image.url || "")))
        || (current.length > before.length ? current.at(-1) : null);
      if (selected) break;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    // Check once at the deadline: the image may have arrived during the last poll sleep.
    const finalImages = !selected ? persistentImages(await options.readImages(), { requireLoaded }) : [];
    if (!selected) {
      selected = finalImages.find((image) => !knownUrls.has(String(image.platformImageUrl || image.src || image.url || "")))
        || (finalImages.length > before.length ? finalImages.at(-1) : null);
    }
    if (!selected) {
      await options.onProgress?.({
        type: "uploading_image_snapshot",
        stage: "timeout",
        completed: index,
        total: tasks.length,
        assetId: task.assetId || "",
        sectionId: task.sectionId || "",
        beforeCount: before.length,
        imageCount: finalImages.length,
        ...(typeof options.debugSnapshot === "function" ? await options.debugSnapshot("timeout", task, index).catch(() => ({})) : {}),
      });
      throw new Error("PLATFORM_IMAGE_UPLOAD_TIMEOUT");
    }
    uploaded.push(bindTask(task, selected));
    await options.onProgress?.({
      type: "uploading_images",
      completed: index + 1,
      total: tasks.length,
      assetId: task.assetId || "",
      sectionId: task.sectionId || "",
    });
  }
  return uploaded;
}


const JIANSHU_ORIGIN = "https://www.jianshu.com";
const JIANSHU_EDITOR_URL = "https://www.jianshu.com/writer";
export const JIANSHU_PUBLIC_IMAGE_SELECTOR = [
  "article img[src*='upload-images.jianshu.io/upload_images/']",
  ".show-content img[src*='upload-images.jianshu.io/upload_images/']",
  ".show-content-free img[src*='upload-images.jianshu.io/upload_images/']",
  ".article-content img[src*='upload-images.jianshu.io/upload_images/']",
  "[data-note-content] img[src*='upload-images.jianshu.io/upload_images/']",
  ".note-content img[src*='upload-images.jianshu.io/upload_images/']",
].join(", ");

export function normalizeJianshuSectionHeading(value = "") {
  return String(value || "")
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .trim();
}

export async function positionJianshuCursorAfterSection(editorLocator, task = {}) {
  if (!editorLocator || typeof editorLocator.evaluate !== "function") return false;
  return editorLocator.evaluate((editor, payload) => {
    const normalizeHeading = (value = "") => String(value || "")
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .trim();
    const isHeadingNode = (node) => {
      const tagName = String(node?.tagName || "").toUpperCase();
      const text = String(node?.textContent || "");
      return /^H[1-6]$/.test(tagName) || /^\s{0,3}#{1,6}\s+/.test(text);
    };
    const sectionTitle = normalizeHeading(payload.sectionTitle);
    const nodes = [...(editor.children || [])];
    const directHeading = sectionTitle
      ? nodes.find((node) => normalizeHeading(node?.textContent) === sectionTitle && isHeadingNode(node))
      : null;
    const nestedHeading = sectionTitle && typeof editor.querySelectorAll === "function"
      ? [...editor.querySelectorAll("h1, h2, h3, h4, h5, h6")]
        .find((node) => normalizeHeading(node?.textContent) === sectionTitle)
      : null;
    const heading = directHeading || nestedHeading;
    if (sectionTitle && !heading) return false;
    let target = editor.lastElementChild || editor;
    if (heading) {
      const siblings = [...(heading.parentElement?.children || nodes)];
      const headingIndex = siblings.indexOf(heading);
      target = heading;
      for (let index = headingIndex + 1; index < siblings.length; index += 1) {
        const candidate = siblings[index];
        if (isHeadingNode(candidate)) break;
        target = candidate;
      }
    }
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
    sectionTitle: normalizeJianshuSectionHeading(task.sectionTitle || task.title || ""),
  }).catch(() => false);
}

export async function positionJianshuNativeCursorAfterSection(page, editorLocator, task = {}) {
  if (
    !page?.keyboard
    || typeof page.keyboard.press !== "function"
    || !editorLocator
    || typeof editorLocator.evaluate !== "function"
    || typeof editorLocator.locator !== "function"
  ) return false;

  const section = await editorLocator.evaluate((editor, payload) => {
    const normalizeHeading = (value = "") => String(value || "")
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .trim();
    const isHeadingNode = (node) => {
      const tagName = String(node?.tagName || "").toUpperCase();
      const text = String(node?.textContent || "");
      return /^H[1-6]$/.test(tagName) || /^\s{0,3}#{1,6}\s+/.test(text);
    };
    const pathFromEditor = (node) => {
      const path = [];
      let current = node;
      while (current && current !== editor) {
        const parent = current.parentElement;
        if (!parent) return null;
        const index = [...(parent.children || [])].indexOf(current);
        if (index < 0) return null;
        path.unshift(index);
        current = parent;
      }
      return current === editor ? path : null;
    };
    const nodes = [...(editor.children || [])];
    if (!nodes.length) return null;

    const sectionTitle = normalizeHeading(payload.sectionTitle);
    const directHeading = sectionTitle
      ? nodes.find((node) => normalizeHeading(node?.textContent) === sectionTitle && isHeadingNode(node))
      : null;
    const nestedHeading = sectionTitle && typeof editor.querySelectorAll === "function"
      ? [...editor.querySelectorAll("h1, h2, h3, h4, h5, h6")]
        .find((node) => normalizeHeading(node?.textContent) === sectionTitle)
      : null;
    const heading = directHeading || nestedHeading;
    if (sectionTitle && !heading) return null;

    let target = nodes.at(-1);
    if (heading) {
      const siblings = [...(heading.parentElement?.children || nodes)];
      const headingIndex = siblings.indexOf(heading);
      target = heading;
      for (let index = headingIndex + 1; index < siblings.length; index += 1) {
        if (isHeadingNode(siblings[index])) break;
        target = siblings[index];
      }
    }

    const targetPath = pathFromEditor(target);
    return targetPath?.length ? { targetPath } : null;
  }, {
    sectionTitle: normalizeJianshuSectionHeading(task.sectionTitle || task.title || ""),
  }).catch(() => null);

  const targetPath = Array.isArray(section?.targetPath)
    ? section.targetPath
    : Number.isInteger(section?.targetIndex) && section.targetIndex >= 0
      ? [section.targetIndex]
      : [];
  if (!targetPath.length || targetPath.some((index) => !Number.isInteger(index) || index < 0)) return false;

  let targetBlock = editorLocator;
  for (const index of targetPath) {
    targetBlock = targetBlock.locator(":scope > *").nth(index);
  }
  await targetBlock.scrollIntoViewIfNeeded().catch(() => undefined);
  const box = await targetBlock.boundingBox().catch(() => null);
  if (!box || box.width <= 0 || box.height <= 0) return false;

  try {
    await targetBlock.click({
      position: {
        x: Math.max(1, box.width - 4),
        y: Math.max(1, box.height / 2),
      },
    });
    await page.keyboard.press("End");
  } catch {
    return false;
  }

  return editorLocator.evaluate((editor, payload) => {
    const selection = window.getSelection?.();
    if (!selection || !selection.anchorNode) return false;

    const selectedBlock = selection.anchorNode.nodeType === Node.ELEMENT_NODE
      ? selection.anchorNode
      : selection.anchorNode.parentElement;
    if (!selectedBlock) return false;

    let target = editor;
    for (const index of payload.targetPath || []) {
      target = target?.children?.[index];
      if (!target) return false;
    }
    return selectedBlock === target
      || target.contains?.(selectedBlock) === true
      || selectedBlock.contains?.(target) === true;
  }, { targetPath }).catch(() => false);
}

export async function waitForJianshuEditorAutosave(page, timeoutMs = 15000) {
  if (typeof page?.waitForFunction === "function") {
    await page.waitForFunction(
      () => {
        const text = String(document.body?.innerText || "").replace(/\s+/g, " ");
        return /\u5df2\u4fdd\u5b58|\u4fdd\u5b58\u6210\u529f|\u521a\u521a|saved/i.test(text);
      },
      null,
      { timeout: Math.max(1, Number(timeoutMs || 15000)) },
    ).catch(() => undefined);
  }
  await page?.waitForTimeout?.(500).catch(() => undefined);
}

export async function uploadJianshuInlineImages(page, tasks = [], options = {}) {
  if (!tasks.length) return [];
  const editor = page.locator(".kalamu-area[contenteditable='true'], .kalamu-area").first();
  const uploaded = await uploadJianshuPlatformImages({
    tasks,
    readImages: () => readLocatorImages(page, ".kalamu-area img"),
    positionForTask: async (task) => {
      await waitForJianshuEditorAutosave(page, options.saveTimeoutMs || 15000);
      const positioned = await positionJianshuNativeCursorAfterSection(page, editor, task);
      if (!positioned) throw new Error("JIANSHU_SECTION_POSITION_FAILED");
      return true;
    },
    selectFile: async (task) => {
      await page.locator("a[data-action='openImageModal']").first().click();
      await page.locator("#kalamu-upload-image[type='file']").first().setInputFiles(task.path);
    },
    onProgress: options.onProgress,
    timeoutMs: options.timeoutMs || 60000,
  });
  // Kalamu renders the CDN image before its editor state finishes committing the final upload.
  const imageSettleMs = Math.max(0, Number(options.imageSettleMs ?? 3500));
  if (imageSettleMs > 0) await page.waitForTimeout?.(imageSettleMs);
  return uploaded;
}

export async function readJianshuEditorImages(page) {
  return readLocatorImages(page, ".kalamu-area img, .CodeMirror img, .markdown-body img");
}

export function bindJianshuSectionImages(tasks = [], observedImages = []) {
  const queues = new Map();
  for (const image of Array.isArray(observedImages) ? observedImages : []) {
    const key = normalizeJianshuSectionHeading(image?.sectionTitle || "");
    if (!key) continue;
    const queue = queues.get(key) || [];
    queue.push(image);
    queues.set(key, queue);
  }
  const bound = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const key = normalizeJianshuSectionHeading(task?.sectionTitle || task?.title || "");
    const image = key ? queues.get(key)?.shift() : null;
    if (!image) continue;
    bound.push({
      assetId: String(task?.assetId || ""),
      sectionId: String(task?.sectionId || ""),
      position: Number(task?.position ?? -1),
      platformImageId: String(image?.platformImageId || ""),
      platformImageUrl: String(image?.platformImageUrl || image?.src || image?.url || ""),
      loaded: image?.loaded !== false,
    });
  }
  return bound;
}

export async function readJianshuEditorSectionImages(page, tasks = []) {
  const editor = page.locator(".kalamu-area[contenteditable='true'], .kalamu-area").first();
  const observed = await editor.evaluate((surface) => {
    const normalizeHeading = (value = "") => String(value || "")
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .trim();
    const isHeading = (node) => /^H[1-6]$/.test(String(node?.tagName || "").toUpperCase())
      || /^\s{0,3}#{1,6}\s+/.test(String(node?.textContent || ""));
    const images = [];
    let sectionTitle = "";
    for (const child of [...(surface.children || [])]) {
      if (isHeading(child)) sectionTitle = normalizeHeading(child.textContent);
      const nodes = String(child?.tagName || "").toUpperCase() === "IMG"
        ? [child]
        : [...child.querySelectorAll("img")];
      for (const image of nodes) {
        images.push({
          sectionTitle,
          platformImageUrl: image.currentSrc || image.getAttribute("src") || "",
          loaded: typeof image.complete === "boolean"
            ? image.complete && Number(image.naturalWidth || 0) > 0
            : true,
        });
      }
    }
    return images;
  }).catch(() => []);
  return bindJianshuSectionImages(tasks, observed);
}

export function jianshuDraftUrlFromNoteId(noteId, notebookId = "") {
  const note = String(noteId || "").trim();
  const notebook = String(notebookId || "").trim();
  return note && notebook
    ? `${JIANSHU_EDITOR_URL}#/notebooks/${encodeURIComponent(notebook)}/notes/${encodeURIComponent(note)}`
    : JIANSHU_EDITOR_URL;
}

function normalizeJianshuDraftUrl(url = "") {
  const value = String(url || "");
  return /jianshu\.com\/writer#\/notebooks\/[^/]+\/notes\/[^/?#]+/i.test(value) ? value : "";
}

export async function waitForJianshuDraftUrl(state, page, timeoutMs = 30000, pollMs = 250) {
  const deadline = Date.now() + Math.max(1, Number(timeoutMs || 30000));
  // Prefer note/notebook-specific URLs from API callbacks, but do not block forever on the
  // generic writer shell which is already a valid draft workspace for image verification.
  const softDeadline = Math.min(deadline, Date.now() + Math.min(2500, Math.max(pollMs * 4, 500)));
  do {
    const currentUrl = typeof page?.url === "function" ? String(page.url() || "") : "";
    const liveDraftUrl = normalizeJianshuDraftUrl(currentUrl);
    if (liveDraftUrl) return liveDraftUrl;
    const callbackDraftUrl = normalizeJianshuDraftUrl(state?.draftUrl);
    if (callbackDraftUrl) return callbackDraftUrl;
    if (state?.draftId && state?.notebookId) return jianshuDraftUrlFromNoteId(state.draftId, state.notebookId);
    if (Date.now() >= softDeadline && /jianshu\.com\/writer/i.test(currentUrl)) {
      return currentUrl;
    }
    if (typeof page?.waitForTimeout === "function") await page.waitForTimeout(pollMs);
    else await new Promise((resolve) => setTimeout(resolve, pollMs));
  } while (Date.now() < deadline);
  const fallback = typeof page?.url === "function" ? String(page.url() || "") : "";
  if (/jianshu\.com\/writer/i.test(fallback)) return fallback;
  throw new Error("JIANSHU_DRAFT_URL_NOT_FOUND");
}

export async function waitForJianshuEditorImages(page, expectedCount, timeoutMs = 30000, pollMs = 250) {
  const expected = Math.max(0, Number(expectedCount || 0));
  const deadline = Date.now() + Math.max(1, Number(timeoutMs || 30000));
  let images = [];
  do {
    images = await readJianshuEditorImages(page);
    const persistent = images.filter((image) => (
      isPersistentPlatformImageUrl(image.platformImageUrl) && image.loaded !== false
    ));
    if (persistent.length >= expected) return persistent;
    if (typeof page?.waitForTimeout === "function") await page.waitForTimeout(pollMs);
    else await new Promise((resolve) => setTimeout(resolve, pollMs));
  } while (Date.now() < deadline);
  throw new Error("DRAFT_IMAGE_MISSING");
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizePublishInput(input = {}) {
  const title = cleanText(input.articleTitle || input.title);
  const content = String(input.contentMarkdown || input.content || input.body || input.markdown || "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!title) throw new Error("JIANSHU_TITLE_REQUIRED");
  if (title.length > 100) throw new Error("JIANSHU_TITLE_TOO_LONG");
  if (!cleanText(content) || cleanText(content).length < 5) throw new Error("JIANSHU_CONTENT_REQUIRED");
  return {
    title,
    content,
    contentBlocks: Array.isArray(input.contentBlocks) ? input.contentBlocks : [],
    contentHtmlWithoutImages: String(input.contentHtmlWithoutImages || "").trim(),
    platformImageTasks: Array.isArray(input.platformImageTasks) ? input.platformImageTasks : [],
    notebook: cleanText(input.notebook || input.collection || input.column || ""),
    confirmPublish: input.confirmPublish === true || input.publishMode === "publish",
    draftTimeoutMs: Number(input.draftTimeoutMs || 30000),
    publishTimeoutMs: Number(input.publishTimeoutMs || 45000),
  };
}

function parseJsonLikePayload(text = "") {
  const value = String(text || "").trim();
  if (!value) return null;
  try {
    return JSON.parse(value.startsWith("{") ? value : value.replace(/^[^(]*\(/, "").replace(/\)\s*;?\s*$/, ""));
  } catch {
    return null;
  }
}

export function normalizeJianshuPublishedUrl(url = "") {
  try {
    const parsed = new URL(String(url || ""), JIANSHU_ORIGIN);
    if (!/(^|\.)jianshu\.com$/i.test(parsed.hostname)) return "";
    if (/\/p\/[a-z0-9]+/i.test(parsed.pathname)) return parsed.toString().replace(/^http:/, "https:");
  } catch {
    return "";
  }
  return "";
}

export function jianshuPublishEndpointIsMutation(url = "") {
  try {
    return /\/(?:notes|articles)\/[^/]+\/(?:publish|publicize|release|submit)\/?$/i.test(
      new URL(String(url)).pathname,
    );
  } catch {
    return false;
  }
}

function jianshuPayloadMessages(payload) {
  if (!payload || typeof payload !== "object") return false;
  const messages = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:error|errors|message|msg|detail|reason)$/i.test(key) && typeof item !== "object") {
        messages.push(String(item || ""));
      } else if (item && typeof item === "object") {
        visit(item);
      }
    }
  };
  visit(payload);
  return messages.join(" ");
}

export function jianshuPayloadManualActionCode(payload) {
  const messages = jianshuPayloadMessages(payload);
  if (/绑定手机号|绑定手机|发送验证码/.test(messages)) return "JIANSHU_PHONE_BINDING_REQUIRED";
  if (/captcha|security verification|risk control|manual verification|验证码|安全验证|拖动滑块|扫码验证|风控|敏感词|发布上限|违规/i.test(messages)) {
    return "JIANSHU_MANUAL_ACTION_REQUIRED";
  }
  return "";
}

export function jianshuPayloadRequiresManualAction(payload) {
  return Boolean(jianshuPayloadManualActionCode(payload));
}

function findJianshuNestedValue(value, keys = [], depth = 0, seen = new Set()) {
  if (depth > 8 || value == null) return "";
  if (typeof value !== "object") return "";
  if (seen.has(value)) return "";
  seen.add(value);
  for (const [key, nested] of Object.entries(value)) {
    if (keys.some((candidate) => candidate.toLowerCase() === String(key).toLowerCase()) && nested != null) {
      return String(nested);
    }
  }
  for (const nested of Object.values(value)) {
    const found = findJianshuNestedValue(nested, keys, depth + 1, seen);
    if (found) return found;
  }
  return "";
}

function jianshuApiConfig(input = {}) {
  const config = input.platformConfig && typeof input.platformConfig === "object" ? input.platformConfig : {};
  return {
    currentUserApiUrl: cleanText(config.currentUserApiUrl || `${JIANSHU_ORIGIN}/author/current_user`),
    notebooksApiUrl: cleanText(config.notebooksApiUrl || `${JIANSHU_ORIGIN}/author/notebooks`),
    createNoteApiUrl: cleanText(config.createNoteApiUrl || `${JIANSHU_ORIGIN}/author/notes`),
    updateNoteApiUrl: cleanText(config.updateNoteApiUrl || `${JIANSHU_ORIGIN}/author/notes/{noteId}`),
    noteContentApiUrl: cleanText(config.noteContentApiUrl || `${JIANSHU_ORIGIN}/author/notes/{noteId}/content`),
    noteListApiUrl: cleanText(config.noteListApiUrl || `${JIANSHU_ORIGIN}/author/notebooks/{notebookId}/notes?page=1&count=10&nid={noteId}`),
    publicizeApiUrl: cleanText(config.publicizeApiUrl || `${JIANSHU_ORIGIN}/author/notes/{noteId}/publicize`),
    publicNoteApiUrl: cleanText(config.publicNoteApiUrl || `${JIANSHU_ORIGIN}/shakespeare/v2/notes/{slug}`),
    softDestroyApiUrl: cleanText(config.softDestroyApiUrl || `${JIANSHU_ORIGIN}/author/notes/{noteId}/soft_destroy`),
    notebookId: cleanText(config.notebookId || input.notebookId || ""),
    notebook: cleanText(config.notebook || input.notebook || ""),
    csrfToken: cleanText(config.csrfToken || input.csrfToken || ""),
  };
}

function jianshuApiUrl(template = "", values = {}) {
  const resolved = typeof values === "object" && values !== null
    ? values
    : { noteId: values };
  return String(template || "")
    .replace(/\{noteId\}|\{note_id\}/g, encodeURIComponent(String(resolved.noteId || "")))
    .replace(/\{notebookId\}|\{notebook_id\}/g, encodeURIComponent(String(resolved.notebookId || "")))
    .replace(/\{slug\}/g, encodeURIComponent(String(resolved.slug || "")));
}

function jianshuApiHeaders(config = {}) {
  return {
    Accept: "application/json",
    Referer: JIANSHU_EDITOR_URL,
    Origin: JIANSHU_ORIGIN,
    "Cache-Control": "no-cache",
    ...(config.csrfToken ? { "X-CSRF-Token": config.csrfToken } : {}),
  };
}

function assertJianshuApiAccepted(response, stage) {
  if ([401, 403].includes(response.status)) throw new Error("JIANSHU_LOGIN_REQUIRED");
  const manualAction = jianshuPayloadManualActionCode(response.payload);
  if (manualAction) throw new Error(manualAction);
  if (!response.ok || !jianshuApiPayloadAccepted(response.payload)) {
    throw new Error(`JIANSHU_API_${stage}_NOT_ACCEPTED`);
  }
  return response;
}

function jianshuApiPayloadAccepted(payload) {
  if (payload && typeof payload === "object") {
    if (payload.success === false || payload.ok === false) return false;
    const code = payload.code ?? payload.errno ?? payload.status;
    if (code !== undefined && ![0, "0", 200, "200"].includes(code)) return false;
    if (jianshuPayloadRequiresManualAction(payload)) return false;
  }
  return true;
}

function jianshuPublishedUrlFromPayload(payload) {
  const direct = findJianshuNestedValue(payload, ["permalink", "url", "publishedUrl", "publicUrl", "shareUrl"]);
  const directUrl = normalizeJianshuPublishedUrl(direct);
  if (directUrl) return directUrl;
  const slug = findJianshuNestedValue(payload, ["slug", "public_slug", "publicSlug"]);
  if (slug && /^[a-z0-9]+$/i.test(slug)) return `${JIANSHU_ORIGIN}/p/${encodeURIComponent(slug)}`;
  return "";
}

function jianshuHtmlText(html = "") {
  return String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function normalizedJianshuComparisonText(value = "") {
  return jianshuHtmlText(value).replace(/\s+/g, "").toLowerCase();
}

function jianshuContentMatches(actualHtml = "", expectedHtml = "") {
  const actual = normalizedJianshuComparisonText(actualHtml);
  const expected = normalizedJianshuComparisonText(expectedHtml);
  if (!expected) return true;
  if (actual.includes(expected)) return true;
  if (expected.length <= 96) return false;
  const windowSize = Math.min(48, Math.floor(expected.length / 3));
  const starts = [0, Math.floor((expected.length - windowSize) / 2), expected.length - windowSize];
  return starts.every((start) => actual.includes(expected.slice(start, start + windowSize)));
}

function normalizeJianshuImageUrl(value = "") {
  try {
    const parsed = new URL(String(value || ""), JIANSHU_ORIGIN);
    if (parsed.protocol !== "https:" || parsed.hostname !== "upload-images.jianshu.io") return "";
    if (!parsed.pathname.startsWith("/upload_images/")) return "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

export function extractJianshuImageUrlsFromHtml(html = "") {
  const urls = [];
  for (const imageMatch of String(html || "").matchAll(/<img\b[^>]*>/gi)) {
    const attributes = [...imageMatch[0].matchAll(/\b(data-original-src|src)\s*=\s*["']([^"']+)["']/gi)];
    const preferred = attributes.find((match) => match[1].toLowerCase() === "data-original-src") || attributes[0];
    const normalized = normalizeJianshuImageUrl(preferred?.[2] || "");
    if (normalized && !urls.includes(normalized)) urls.push(normalized);
  }
  return urls;
}

function requireExpectedJianshuImages(actualUrls = [], expectedUrls = [], errorCode = "JIANSHU_IMAGE_MISSING") {
  const normalizedActual = actualUrls.map(normalizeJianshuImageUrl).filter(Boolean);
  const normalizedExpected = expectedUrls.map(normalizeJianshuImageUrl).filter(Boolean);
  const matched = normalizedExpected.map((expected) => normalizedActual.find((actual) => actual === expected) || "");
  if (matched.some((url) => !url) || normalizedExpected.length !== expectedUrls.length) {
    throw new Error(errorCode);
  }
  return matched;
}

function bindJianshuApiImages(tasks = [], imageUrls = []) {
  return (Array.isArray(tasks) ? tasks : []).map((task, index) => ({
    assetId: String(task?.assetId || ""),
    sectionId: String(task?.sectionId || ""),
    position: Number(task?.position ?? -1),
    platformImageId: "",
    platformImageUrl: normalizeJianshuImageUrl(imageUrls[index] || ""),
    loaded: Boolean(normalizeJianshuImageUrl(imageUrls[index] || "")),
  }));
}

export async function readJianshuCurrentUserViaApi(page, input = {}) {
  const config = jianshuApiConfig(input);
  const response = assertJianshuApiAccepted(await platformApiFetch(page, config.currentUserApiUrl, {
    method: "GET",
    headers: jianshuApiHeaders(config),
  }), "CURRENT_USER");
  const userId = findJianshuNestedValue(response.payload, ["id", "user_id", "userId"]);
  if (!userId) throw new Error("JIANSHU_LOGIN_REQUIRED");
  return {
    userId,
    nickname: cleanText(response.payload?.nickname || response.payload?.name || ""),
  };
}

export async function listJianshuNotebooksViaApi(page, input = {}) {
  const config = jianshuApiConfig(input);
  const response = assertJianshuApiAccepted(await platformApiFetch(page, config.notebooksApiUrl, {
    method: "GET",
    headers: jianshuApiHeaders(config),
  }), "NOTEBOOKS");
  if (!Array.isArray(response.payload)) throw new Error("JIANSHU_NOTEBOOKS_INVALID");
  return response.payload
    .map((notebook) => ({
      id: cleanText(notebook?.id),
      name: cleanText(notebook?.name),
    }))
    .filter((notebook) => notebook.id);
}

async function resolveJianshuNotebookId(page, input = {}) {
  const config = jianshuApiConfig(input);
  if (config.notebookId) return config.notebookId;
  const notebooks = await listJianshuNotebooksViaApi(page, input);
  if (!notebooks.length) throw new Error("JIANSHU_NOTEBOOK_NOT_FOUND");
  if (!config.notebook) return notebooks[0].id;
  const matched = notebooks.find((notebook) => notebook.name === config.notebook);
  if (!matched) throw new Error("JIANSHU_NOTEBOOK_NOT_FOUND");
  return matched.id;
}

export async function createJianshuNoteViaApi(page, title, input = {}) {
  const config = jianshuApiConfig(input);
  const notebookId = await resolveJianshuNotebookId(page, input);
  const response = assertJianshuApiAccepted(await platformApiFetch(page, config.createNoteApiUrl, {
    method: "POST",
    json: {
      notebook_id: notebookId,
      title: cleanText(title),
      at_bottom: false,
    },
    headers: jianshuApiHeaders(config),
  }), "CREATE");
  const noteId = findJianshuNestedValue(response.payload, ["id", "note_id", "noteId"]);
  const slug = findJianshuNestedValue(response.payload, ["slug", "public_slug", "publicSlug"]);
  const responseNotebookId = findJianshuNestedValue(response.payload, ["notebook_id", "notebookId"]);
  if (!noteId) throw new Error("JIANSHU_API_NOTE_ID_NOT_FOUND");
  if (!slug) throw new Error("JIANSHU_API_SLUG_NOT_FOUND");
  if (responseNotebookId && responseNotebookId !== notebookId) throw new Error("JIANSHU_API_NOTEBOOK_ID_MISMATCH");
  return {
    noteId,
    notebookId: responseNotebookId || notebookId,
    slug,
    autosaveControl: Number(response.payload?.autosave_control || 0),
  };
}

export async function updateJianshuNoteViaApi(page, draft = {}, title = "", html = "", input = {}) {
  const config = jianshuApiConfig(input);
  const noteId = cleanText(draft.noteId || draft.id);
  if (!noteId) throw new Error("JIANSHU_API_NOTE_ID_NOT_FOUND");
  const autosaveControl = Math.max(0, Number(draft.autosaveControl || 0)) + 1;
  const response = assertJianshuApiAccepted(await platformApiFetch(
    page,
    jianshuApiUrl(config.updateNoteApiUrl, { noteId }),
    {
      method: "PUT",
      json: {
        id: noteId,
        autosave_control: autosaveControl,
        title: cleanText(title),
        content: String(html || ""),
      },
      headers: jianshuApiHeaders(config),
    },
  ), "UPDATE");
  const responseNoteId = findJianshuNestedValue(response.payload, ["id", "note_id", "noteId"]);
  if (responseNoteId && responseNoteId !== noteId) throw new Error("JIANSHU_API_NOTE_ID_MISMATCH");
  return {
    autosaveControl,
    contentUpdatedAt: Number(response.payload?.content_updated_at || 0),
    lastCompiledAt: Number(response.payload?.last_compiled_at || 0),
  };
}

async function readJianshuNoteContentViaApi(page, noteId, input = {}) {
  const config = jianshuApiConfig(input);
  const response = assertJianshuApiAccepted(await platformApiFetch(
    page,
    jianshuApiUrl(config.noteContentApiUrl, { noteId }),
    { method: "GET", headers: jianshuApiHeaders(config) },
  ), "READ_CONTENT");
  if (!response.payload || typeof response.payload.content !== "string") {
    throw new Error("JIANSHU_DRAFT_CONTENT_INVALID");
  }
  return response.payload.content;
}

async function readJianshuNoteMetadataViaApi(page, draft = {}, input = {}) {
  const config = jianshuApiConfig(input);
  const noteId = cleanText(draft.noteId || draft.id);
  const notebookId = cleanText(draft.notebookId || draft.notebook_id);
  if (!noteId || !notebookId) throw new Error("JIANSHU_DRAFT_IDENTITY_INCOMPLETE");
  const response = assertJianshuApiAccepted(await platformApiFetch(
    page,
    jianshuApiUrl(config.noteListApiUrl, { noteId, notebookId }),
    { method: "GET", headers: jianshuApiHeaders(config) },
  ), "READ_METADATA");
  if (!Array.isArray(response.payload)) throw new Error("JIANSHU_DRAFT_METADATA_INVALID");
  const metadata = response.payload.find((note) => cleanText(note?.id) === noteId);
  if (!metadata) throw new Error("JIANSHU_DRAFT_METADATA_NOT_FOUND");
  return metadata;
}

export async function verifyJianshuDraftViaApi(page, expected = {}, input = {}) {
  const noteId = cleanText(expected.noteId || expected.id);
  const content = await readJianshuNoteContentViaApi(page, noteId, input);
  const metadata = await readJianshuNoteMetadataViaApi(page, expected, input);
  if (cleanText(metadata.title) !== cleanText(expected.title)) throw new Error("JIANSHU_DRAFT_TITLE_MISMATCH");
  if (expected.slug && cleanText(metadata.slug) !== cleanText(expected.slug)) throw new Error("JIANSHU_DRAFT_SLUG_MISMATCH");
  if (!jianshuContentMatches(content, expected.html)) throw new Error("JIANSHU_DRAFT_CONTENT_MISMATCH");
  if (typeof expected.shared === "boolean" && Boolean(metadata.shared) !== expected.shared) {
    throw new Error(expected.shared ? "JIANSHU_NOTE_NOT_PUBLIC" : "JIANSHU_DRAFT_ALREADY_PUBLIC");
  }
  const actualImageUrls = extractJianshuImageUrlsFromHtml(content);
  const imageUrls = requireExpectedJianshuImages(
    actualImageUrls,
    Array.isArray(expected.expectedImageUrls) ? expected.expectedImageUrls : [],
    "JIANSHU_DRAFT_IMAGE_MISSING",
  );
  return { verified: true, content, metadata, imageUrls };
}

export async function publicizeJianshuNoteViaApi(page, draft = {}, input = {}) {
  const config = jianshuApiConfig(input);
  const noteId = cleanText(draft.noteId || draft.id);
  const slug = cleanText(draft.slug);
  if (!noteId) throw new Error("JIANSHU_API_NOTE_ID_NOT_FOUND");
  if (!slug) throw new Error("JIANSHU_API_SLUG_NOT_FOUND");
  const response = assertJianshuApiAccepted(await platformApiFetch(
    page,
    jianshuApiUrl(config.publicizeApiUrl, { noteId }),
    { method: "POST", json: {}, headers: jianshuApiHeaders(config) },
  ), "PUBLICIZE");
  const lastCompiledAt = Number(response.payload?.last_compiled_at || 0);
  if (!lastCompiledAt) throw new Error("JIANSHU_PUBLICIZE_COMPILE_TIMESTAMP_MISSING");
  return {
    publishedUrl: `${JIANSHU_ORIGIN}/p/${encodeURIComponent(slug)}`,
    lastCompiledAt,
  };
}

export async function inspectJianshuPublicArticleViaApi(page, expected = {}, input = {}) {
  const config = jianshuApiConfig(input);
  const noteId = cleanText(expected.noteId || expected.id);
  const slug = cleanText(expected.slug);
  if (!slug) throw new Error("JIANSHU_API_SLUG_NOT_FOUND");
  const response = assertJianshuApiAccepted(await platformApiFetch(
    page,
    jianshuApiUrl(config.publicNoteApiUrl, { slug }),
    { method: "GET", headers: jianshuApiHeaders(config) },
  ), "PUBLIC_VERIFY");
  const payloadNoteId = findJianshuNestedValue(response.payload, ["id", "note_id", "noteId"]);
  const payloadSlug = findJianshuNestedValue(response.payload, ["slug", "public_slug", "publicSlug"]);
  if (noteId && payloadNoteId !== noteId) throw new Error("JIANSHU_PUBLIC_NOTE_ID_MISMATCH");
  if (payloadSlug !== slug) throw new Error("JIANSHU_PUBLIC_SLUG_MISMATCH");
  const publicTitle = cleanText(response.payload?.public_title || response.payload?.title || "");
  const publicHtml = String(response.payload?.free_content || response.payload?.content || "");
  if (publicTitle !== cleanText(expected.title)) throw new Error("JIANSHU_PUBLIC_TITLE_MISMATCH");
  if (!jianshuContentMatches(publicHtml, expected.html)) throw new Error("JIANSHU_PUBLIC_CONTENT_MISMATCH");
  const actualImageUrls = extractJianshuImageUrlsFromHtml(publicHtml);
  const imageUrls = requireExpectedJianshuImages(
    actualImageUrls,
    Array.isArray(expected.expectedImageUrls) ? expected.expectedImageUrls : [],
    "JIANSHU_PUBLIC_IMAGE_MISSING",
  );
  return {
    found: true,
    publicUrl: `${JIANSHU_ORIGIN}/p/${encodeURIComponent(slug)}`,
    publishedUrl: `${JIANSHU_ORIGIN}/p/${encodeURIComponent(slug)}`,
    titleMatched: true,
    bodyMatched: true,
    imageUrls,
    payload: {
      id: payloadNoteId,
      slug: payloadSlug,
      publicTitle,
    },
  };
}

export async function softDestroyJianshuNoteViaApi(page, noteId, input = {}) {
  const config = jianshuApiConfig(input);
  const expectedNoteId = cleanText(noteId);
  if (!expectedNoteId) throw new Error("JIANSHU_API_NOTE_ID_NOT_FOUND");
  const response = assertJianshuApiAccepted(await platformApiFetch(
    page,
    jianshuApiUrl(config.softDestroyApiUrl, { noteId: expectedNoteId }),
    { method: "POST", headers: jianshuApiHeaders(config) },
  ), "SOFT_DESTROY");
  const deletedNoteId = findJianshuNestedValue(response.payload, ["id", "note_id", "noteId"]);
  const deletedAt = Number(response.payload?.deleted_at || 0);
  if (deletedNoteId !== expectedNoteId || !deletedAt) throw new Error("JIANSHU_SOFT_DESTROY_NOT_CONFIRMED");
  return { deleted: true, noteId: deletedNoteId, deletedAt };
}

function watchJianshuApiResponses(page) {
  const state = { draftId: "", draftUrl: "", publishedUrl: "", blocker: "", publishAttempted: false };
  const handler = async (response) => {
    const url = typeof response.url === "function" ? response.url() : "";
    if (!/jianshu\.com\/.*(notes|notebooks|publish|save|articles)/i.test(url)) return;
    const text = await response.text().catch(() => "");
    const payload = parseJsonLikePayload(text);
    if (payload?.id) {
      state.draftId = String(payload.id);
      state.draftUrl = normalizeJianshuDraftUrl(typeof page.url === "function" ? page.url() : "");
    }
    const isPublishCall = jianshuPublishEndpointIsMutation(url);
    if (isPublishCall) state.publishAttempted = true;
    if (isPublishCall) {
      const href = payload?.permalink || payload?.url || payload?.slug || "";
      if (href) {
        const normalized = normalizeJianshuPublishedUrl(href.startsWith("http") ? href : `${JIANSHU_ORIGIN}${href}`);
        if (normalized) state.publishedUrl = normalized;
      }
    }
    if (isPublishCall) {
      state.blocker = jianshuPayloadManualActionCode(payload) || state.blocker;
    }
  };
  if (typeof page.on === "function") page.on("response", handler);
  return {
    state,
    dispose() {
      if (typeof page.off === "function") page.off("response", handler);
    },
  };
}

export async function ensureJianshuEditableNote(page) {
  // Live writer often lands on a notebook with an empty "无标题文章" note selected.
  // Keep the selected note when its editor is already mounted; changing selection remounts React inputs.
  const titleInput = page.locator("input._24i7u").first();
  if (await titleInput.isVisible?.().catch(() => false)) return;

  const existingEmpty = page.locator("text=无标题文章").first();
  if (await existingEmpty.isVisible?.().catch(() => false)) {
    await existingEmpty.click?.().catch(() => undefined);
    await page.waitForTimeout?.(500).catch(() => undefined);
    if (await titleInput.isVisible?.().catch(() => false)) return;
  }
  const createNote = page.locator("a:has-text('新建文章'), button:has-text('新建文章')").first();
  if (await createNote.isVisible?.().catch(() => false)) {
    await createNote.click?.().catch(() => undefined);
    await page.waitForTimeout?.(800).catch(() => undefined);
  }
  // Give the React writer shell a moment to mount the title input.
  await page.waitForTimeout?.(500).catch(() => undefined);
  if (typeof page.waitForSelector === "function") {
    await page.waitForSelector("input._24i7u, input[type='text']", { timeout: 5000 }).catch(() => undefined);
  }
}

async function fillJianshuTitle(page, title) {
  await ensureJianshuEditableNote(page);
  const selectors = [
    "input._24i7u",
    "input[placeholder*='无标题']",
    "input[placeholder*='标题']",
    "input.title-input",
    "textarea[placeholder*='标题']",
    ".input-title",
    "input[type='text']:not([name='name'])",
    "[placeholder*='title' i]",
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (!(await locator.isVisible?.().catch(() => false))) continue;
    // Skip notebook name input.
    const placeholder = await locator.getAttribute?.("placeholder").catch(() => "") || "";
    const name = await locator.getAttribute?.("name").catch(() => "") || "";
    if (/文集|notebook/i.test(placeholder) || name === "name") continue;
    try {
      await locator.click?.().catch(() => undefined);
      await locator.fill(title);
      await locator.dispatchEvent?.("input").catch(() => undefined);
      await locator.dispatchEvent?.("change").catch(() => undefined);
      return locator;
    } catch {
      continue;
    }
  }
  // Fallback: the active title field may only be a styled input without placeholder.
  if (typeof page.evaluate === "function") {
    const filled = await page.evaluate((value) => {
      const inputs = [...document.querySelectorAll("input[type='text'], input:not([type])")];
      const target = inputs.find((input) => {
        const rect = input.getBoundingClientRect();
        const placeholder = String(input.getAttribute("placeholder") || "");
        const name = String(input.getAttribute("name") || "");
        return rect.width > 120 && rect.height > 20 && !/文集|notebook/i.test(placeholder) && name !== "name";
      });
      if (!target) return false;
      target.focus();
      target.value = value;
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, title).catch(() => false);
    if (filled) return null;
  }
  throw new Error("JIANSHU_TITLE_FIELD_NOT_FOUND");
}

async function syncJianshuMarkdownContent(page, content) {
  if (typeof page.evaluate !== "function") return false;
  return page.evaluate((text) => {
    const cm = document.querySelector(".CodeMirror");
    if (cm?.CodeMirror) {
      cm.CodeMirror.setValue(String(text || ""));
      cm.CodeMirror.refresh?.();
      return true;
    }
    const editor = document.querySelector(".markdown-editor, .content-body, [contenteditable='true']:not(.title-input)");
    if (editor) {
      editor.focus?.();
      editor.innerHTML = String(text || "").replace(/\n/g, "<br>");
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    return false;
  }, content).catch(() => false);
}

function jianshuBodyHtml(content) {
  const escapeHtml = (value) => String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return String(content || "")
    .split(/\n{2,}/)
    .map((block) => {
      const value = block.trim();
      const heading = /^(#{1,6})\s+([\s\S]+)$/.exec(value);
      if (heading) {
        const level = Math.min(3, heading[1].length);
        return `<h${level}>${escapeHtml(heading[2].trim())}</h${level}>`;
      }
      return `<p>${escapeHtml(value).replace(/\n/g, "<br>")}</p>`;
    })
    .join("") || "<p><br></p>";
}
function stripJianshuMarkdownImages(content = "") {
  return String(content || "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripJianshuMarkdownFormatting(content = "") {
  return String(content || "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

function stripEmbeddedImages(html = "") {
  return String(html || "")
    .replace(/<figure\b[^>]*>[\s\S]*?<img\b[\s\S]*?<\/figure>/gi, "")
    .replace(/<img\b[^>]*>/gi, "")
    .trim();
}

export function buildJianshuBodyHtml(input = {}) {
  const value = typeof input === "string" ? { content: input } : (input || {});
  const markdown = stripJianshuMarkdownImages(
    value.contentMarkdown || value.content || value.body || value.markdown || ""
  );
  const markdownText = stripJianshuMarkdownFormatting(markdown);
  const blocks = Array.isArray(value.contentBlocks) ? value.contentBlocks : [];
  const blockHtml = blocks.length
    ? composeRichArticleHtml(blocks, { includeImages: false })
    : "";
  const suppliedHtml = stripEmbeddedImages(value.contentHtmlWithoutImages || value.richHtml || "");
  const resolvedHtml = blockHtml || suppliedHtml || jianshuBodyHtml(markdown);
  const blockHeadings = blocks
    .filter((block) => block?.type === "section" && block?.title)
    .map((block) => normalizeJianshuSectionHeading(block.title));
  const htmlHeadings = [...resolvedHtml.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)]
    .map((match) => normalizeJianshuSectionHeading(match[1].replace(/<[^>]+>/g, "")))
    .filter(Boolean);
  const editorBlocks = blocks
    .filter((block) => block?.type === "section" && block?.title)
    .map((block) => ({
      heading: normalizeJianshuSectionHeading(block.title),
      paragraphs: String(block.content || "")
        .replace(/\r\n?/g, "\n")
        .split(/\n{2,}/)
        .map((paragraph) => paragraph.trim())
        .filter(Boolean),
    }));
  const text = editorBlocks.length
    ? editorBlocks
      .flatMap((block) => [block.heading, ...block.paragraphs])
      .filter(Boolean)
      .join("\n\n")
    : markdownText;
  return {
    html: resolvedHtml,
    text,
    headings: blockHeadings.length ? blockHeadings : htmlHeadings,
    editorBlocks,
    requiresRichText: blocks.length > 0 || Boolean(suppliedHtml),
  };
}

export async function readJianshuBodyState(editorLocator) {
  if (!editorLocator || typeof editorLocator.evaluate !== "function") return { text: "", headings: [] };
  return editorLocator.evaluate((editor) => ({
    text: String(editor?.innerText || editor?.textContent || ""),
    headings: [...editor.querySelectorAll("h1, h2, h3, h4, h5, h6")]
      .map((node) => String(node.textContent || "").trim())
      .filter(Boolean),
  })).catch(() => ({ text: "", headings: [] }));
}

export async function verifyJianshuBodyStructure(editorLocator, body) {
  const state = await readJianshuBodyState(editorLocator);
  const insertedText = cleanText(state.text || "");
  const expectedText = cleanText(body?.text || "");
  if (expectedText && !insertedText.includes(expectedText.slice(0, 24))) return false;
  const actualHeadings = (state.headings || []).map(normalizeJianshuSectionHeading);
  return (body?.headings || []).every((heading) => actualHeadings.includes(normalizeJianshuSectionHeading(heading)));
}

export function isStableJianshuDraftUrl(url = "") {
  return /^https:\/\/(?:www\.)?jianshu\.com\/writer#\/notebooks\/[^/]+\/notes\/[^/?#]+/i.test(String(url || ""));
}

export async function reloadJianshuDraftForVerification(page, draftUrl, body, options = {}) {
  if (isStableJianshuDraftUrl(draftUrl)) {
    const currentDraftUrl = normalizeJianshuDraftUrl(typeof page.url === "function" ? page.url() : "");
    if (currentDraftUrl !== draftUrl) {
      await page.goto(draftUrl, { waitUntil: "domcontentloaded" });
    }
    if (typeof page.reload === "function") {
      await page.reload({ waitUntil: "domcontentloaded" });
    } else {
      await page.goto(draftUrl, { waitUntil: "domcontentloaded" });
    }
    await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
  } else {
    await page.waitForTimeout?.(1500).catch(() => undefined);
  }

  const editor = page.locator(".kalamu-area[contenteditable='true'], .kalamu-area").first();
  const timeoutMs = Math.max(1, Number(options.timeoutMs || 15000));
  const pollMs = Math.max(1, Number(options.pollMs || 250));
  const deadline = Date.now() + timeoutMs;
  do {
    const visible = typeof editor.isVisible === "function"
      ? await editor.isVisible().catch(() => false)
      : true;
    if (visible && await verifyJianshuBodyStructure(editor, body)) return editor;
    if (Date.now() >= deadline) break;
    await waitOnJianshuPage(page, pollMs);
  } while (Date.now() < deadline);

  throw new Error("JIANSHU_RICH_BODY_RELOAD_FAILED");
}

async function insertJianshuEditorText(page, value) {
  const text = String(value || "");
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line) {
      if (typeof page.keyboard?.insertText === "function") await page.keyboard.insertText(line);
      else await page.keyboard?.type?.(line);
    }
    if (index < lines.length - 1) await page.keyboard?.press?.("Shift+Enter");
  }
}

async function captureJianshuBodyDebug(page, editorLocator, body, stage) {
  const safeStage = String(stage || "unknown").replace(/[^a-z0-9_-]+/gi, "-");
  const screenshotPath = `apps/desktop/docs/verification/jianshu-body-${safeStage}-${Date.now()}.png`;
  const state = await readJianshuBodyState(editorLocator);
  await page.screenshot?.({ path: screenshotPath, fullPage: true }).catch(() => undefined);
  console.error("[jianshu] body sync diagnostic", JSON.stringify({
    stage,
    screenshotPath,
    expectedHeadings: body?.headings || [],
    actualHeadings: state.headings || [],
    expectedTextPrefix: cleanText(body?.text || "").slice(0, 80),
    actualTextPrefix: cleanText(state.text || "").slice(0, 80),
  }));
  return { screenshotPath, state };
}
async function findExactJianshuHeadingParagraph(page, heading) {
  const normalizedHeading = normalizeJianshuSectionHeading(heading);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidates = page.locator(".kalamu-area > p, .kalamu-area > div").filter({ hasText: normalizedHeading });
    const count = await candidates.count?.().catch(() => 0) || 0;
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      const text = normalizeJianshuSectionHeading(await candidate.innerText?.().catch(() => ""));
      if (text === normalizedHeading) return candidate;
    }
    if (attempt < 11) await page.waitForTimeout?.(200).catch(() => undefined);
  }
  return null;
}

export async function formatJianshuHeadingParagraphs(page, editorLocator, headings = []) {
  const headingMenu = page.locator("li[data-index='2']").first();
  const headingAction = page.locator("a[data-action='insertTitle'][data-level='2']").first();

  for (const rawHeading of headings) {
    const heading = normalizeJianshuSectionHeading(rawHeading);
    const before = await readJianshuBodyState(editorLocator);
    if ((before.headings || []).map(normalizeJianshuSectionHeading).includes(heading)) continue;

    let converted = false;
    for (let actionAttempt = 0; actionAttempt < 3 && !converted; actionAttempt += 1) {
      const paragraph = await findExactJianshuHeadingParagraph(page, heading);
      if (!paragraph) break;
      await paragraph.click({ position: { x: 8, y: 8 } });
      await headingMenu.hover?.().catch(() => undefined);
      if (!(await headingAction.isVisible?.().catch(() => false))) {
        await page.waitForTimeout?.(300).catch(() => undefined);
        continue;
      }
      await headingAction.click();

      for (let attempt = 0; attempt < 12; attempt += 1) {
        const state = await readJianshuBodyState(editorLocator);
        converted = (state.headings || []).map(normalizeJianshuSectionHeading).includes(heading);
        if (converted) break;
        await page.waitForTimeout?.(200).catch(() => undefined);
      }
      if (!converted) await page.waitForTimeout?.(300).catch(() => undefined);
    }
    if (!converted) return false;
    await page.waitForTimeout?.(250).catch(() => undefined);
  }
  return true;
}

export async function clearJianshuEditorBody(page, editorLocator) {
  if (!editorLocator || typeof editorLocator.evaluate !== "function") {
    throw new Error("JIANSHU_BODY_FIELD_NOT_FOUND");
  }

  const textBlock = typeof editorLocator.locator === "function"
    ? editorLocator.locator(":scope > p, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6").first()
    : null;
  const textBlockVisible = await textBlock?.isVisible?.().catch(() => false);
  if (textBlockVisible) {
    await textBlock.click({ position: { x: 8, y: 8 } });
  } else {
    await editorLocator.click?.({ position: { x: 8, y: 8 } });
  }

  const press = typeof page?.keyboard?.press === "function"
    ? (key) => page.keyboard.press(key)
    : (key) => editorLocator.press?.(key);
  const selectAllShortcut = process.platform === "darwin" ? "Meta+A" : "Control+A";
  await press(selectAllShortcut);

  const selectionState = await editorLocator.evaluate((editor) => {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const fragment = range?.cloneContents();
    return {
      imageCount: editor.querySelectorAll("img").length,
      selectedImageCount: fragment?.querySelectorAll?.("img").length || 0,
      selectedTextLength: String(selection || "").length,
      textLength: String(editor.innerText || editor.textContent || "").trim().length,
    };
  }).catch(() => null);
  if (!selectionState) throw new Error("JIANSHU_BODY_SELECTION_FAILED");
  if (
    selectionState.selectedImageCount < selectionState.imageCount
    || (selectionState.textLength > 0 && selectionState.selectedTextLength === 0)
  ) {
    throw new Error("JIANSHU_BODY_SELECTION_INCOMPLETE");
  }

  await press("Backspace");
  await page?.waitForTimeout?.(100);
  const clearedState = await editorLocator.evaluate((editor) => ({
    imageCount: editor.querySelectorAll("img").length,
    text: String(editor.innerText || editor.textContent || "")
      .replace(/[\u200b\ufeff]/g, "")
      .trim(),
  })).catch(() => null);
  if (!clearedState || clearedState.imageCount > 0 || clearedState.text) {
    throw new Error("JIANSHU_BODY_CLEAR_FAILED");
  }
  return true;
}

export async function fillJianshuStructuredBodyWithToolbar(page, editorLocator, body) {
  const blocks = Array.isArray(body?.editorBlocks) ? body.editorBlocks : [];
  if (!blocks.length) return false;

  await clearJianshuEditorBody(page, editorLocator);

  for (const block of blocks) {
    await insertJianshuEditorText(page, block.heading);
    await page.keyboard?.press?.("Enter");
    for (const paragraph of block.paragraphs) {
      await insertJianshuEditorText(page, paragraph);
      await page.keyboard?.press?.("Enter");
    }
  }

  const formatted = await formatJianshuHeadingParagraphs(page, editorLocator, body.headings || []);
  if (!formatted) {
    await captureJianshuBodyDebug(page, editorLocator, body, "heading-format-failed");
    return false;
  }
  await page.waitForTimeout?.(500).catch(() => undefined);
  const verified = await verifyJianshuBodyStructure(editorLocator, body);
  if (!verified) await captureJianshuBodyDebug(page, editorLocator, body, "toolbar-verify-failed");
  return verified;
}

export async function fillJianshuBody(page, input) {
  const body = buildJianshuBodyHtml(input);
  const kalamu = page.locator(".kalamu-area[contenteditable='true'], .kalamu-area").first();
  if (await kalamu.isVisible?.().catch(() => false)) {
    await clearJianshuEditorBody(page, kalamu);
    const pasted = await pasteRichHtmlWithSystemClipboard(
      page,
      kalamu,
      body.html,
      body.text,
      { origin: JIANSHU_ORIGIN },
    );
    await page.waitForTimeout?.(500).catch(() => undefined);
    if (pasted && await verifyJianshuBodyStructure(kalamu, body)) return kalamu;

    if (body.requiresRichText && await fillJianshuStructuredBodyWithToolbar(page, kalamu, body)) {
      return kalamu;
    }

    if (!body.requiresRichText) {
      const syntheticPaste = await pasteRichHtml(kalamu, body.html, body.text);
      await page.waitForTimeout?.(300).catch(() => undefined);
      if (syntheticPaste && await verifyJianshuBodyStructure(kalamu, body)) return kalamu;
    }
  }

  if (body.requiresRichText) throw new Error("JIANSHU_RICH_BODY_SYNC_FAILED");
  await syncJianshuMarkdownContent(page, body.text);
  const selectors = [
    ".CodeMirror-code",
    ".markdown-body",
    ".content-body",
    "textarea.content",
    "[contenteditable='true']:not([class*='title'])",
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (!(await locator.isVisible?.().catch(() => false))) continue;
    try {
      await locator.click?.().catch(() => undefined);
      await locator.fill(body.text);
      await syncJianshuMarkdownContent(page, body.text);
      return locator;
    } catch {
      continue;
    }
  }
  const synced = await syncJianshuMarkdownContent(page, body.text);
  if (!synced) throw new Error("JIANSHU_BODY_FIELD_NOT_FOUND");
  return null;
}

async function waitForJianshuDraftSaved(page, timeoutMs) {
  if (typeof page.waitForFunction !== "function") return;
  await page.waitForFunction(
    () => {
      const text = document.body?.innerText || "";
      return /已保存|草稿|saved|draft|刚刚/i.test(text);
    },
    null,
    { timeout: timeoutMs }
  ).catch(() => undefined);
}

export async function saveJianshuDraftAndWait(page, timeoutMs = 15000) {
  const timeout = Math.max(1, Number(timeoutMs || 15000));
  const responsePromise = typeof page?.waitForResponse === "function"
    ? page.waitForResponse((response) => {
        const url = typeof response?.url === "function" ? response.url() : "";
        const method = typeof response?.request === "function" && typeof response.request()?.method === "function"
          ? response.request().method()
          : "";
        const status = typeof response?.status === "function" ? response.status() : 0;
        return /jianshu\.com\/author\/notes\/[^/?#]+/i.test(url)
          && /^(?:PUT|PATCH|POST)$/i.test(method)
          && status >= 200
          && status < 300;
      }, { timeout }).catch(() => null)
    : Promise.resolve(null);
  if (typeof page?.keyboard !== "undefined") {
    await page.keyboard?.press?.("Control+s").catch(() => undefined);
  }
  const savedResponse = await responsePromise;
  if (!savedResponse) await waitForJianshuDraftSaved(page, timeout);
  return Boolean(savedResponse);
}

export async function clickJianshuPublish(page, timeoutMs) {
  const selectors = [
    "a[data-action='compile']",
    "a[data-action='publicize']",
    "a.publish",
    "button.btn-publish",
    "button:has-text('发布')",
    "[role='button']:has-text('发布')",
    "a:has-text('发布文章')",
    ".publish-btn",
  ];
  const directPublishSelectors = [
    "li:has(i.fa-share):visible",
    "li:has-text('直接发布')",
    "li:has-text('发布文章')",
    "[role='menuitem']:has-text('直接发布')",
    "[role='menuitem']:has-text('发布文章')",
  ];
  timeoutMs = Number.isFinite(Number(timeoutMs)) ? Math.min(60000, Math.max(1, Number(timeoutMs))) : 30000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    for (const selector of selectors) {
      const button = page.locator(selector).first();
      const visible = await button.isVisible?.().catch(() => false);
      const disabled = await button.isDisabled?.().catch(() => true);
      if (visible && !disabled) {
        await button.scrollIntoViewIfNeeded?.().catch(() => undefined);
        await button.click({ timeout: Math.max(1, Math.min(5000, timeoutMs - (Date.now() - startedAt))) });
        await page.waitForTimeout?.(300).catch(() => undefined);
        for (const directSelector of directPublishSelectors) {
          const directPublish = page.locator(directSelector).first();
          if (await directPublish.isVisible?.().catch(() => false) && !(await directPublish.isDisabled?.().catch(() => true))) {
            await directPublish.click({ timeout: Math.max(1, Math.min(5000, timeoutMs - (Date.now() - startedAt))) });
            return;
          }
        }
        if (selector !== "a[data-action='compile']") return;
      }
    }
    await page.waitForTimeout?.(500).catch(() => undefined);
  }
  throw new Error(`JIANSHU_PUBLISH_BUTTON_${(await describeUnavailableButton(selectors.map((selector) => page.locator(selector).first()))).toUpperCase()}`);
}

export async function confirmJianshuDialogs(page) {
  if (typeof page.locator !== "function") return;
  const selectors = [
    "a:has-text('确认发布')",
    "[role='button']:has-text('确认发布')",
    "button:has-text('确认发布')",
    "button:has-text('确定')",
    "button:has-text('确认')",
    "a:has-text('确定')",
    "a:has-text('确认')",
    "[role='button']:has-text('确定')",
    "[role='button']:has-text('确认')",
    ".modal button.confirm",
    ".modal a.confirm",
    ".modal-footer button:not([disabled])",
    ".modal-footer a:not([disabled])",
    "button:has-text('OK')",
  ];
  for (let round = 0; round < 2; round += 1) {
    let clicked = false;
    for (const selector of selectors) {
      const button = page.locator(selector).first();
      if (await button.isVisible?.().catch(() => false) && !(await button.isDisabled?.().catch(() => false))) {
        await button.click?.().catch(() => undefined);
        clicked = true;
        await page.waitForTimeout?.(800).catch(() => undefined);
        break;
      }
    }
    if (!clicked) break;
  }
}

export async function readJianshuPublishUiState(page) {
  const url = typeof page?.url === "function" ? String(page.url() || "") : "";
  const title = typeof page?.title === "function" ? String(await page.title().catch(() => "")) : "";
  const state = typeof page?.evaluate === "function"
    ? await page.evaluate(() => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const visible = (element) => {
          const rect = element.getBoundingClientRect?.() || { width: 0, height: 0 };
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        };
        const controls = [...document.querySelectorAll("a, button, li, [role='button'], [role='menuitem']")]
          .filter(visible)
          .map((element) => ({
            tagName: String(element.tagName || "").toLowerCase(),
            text: clean(element.textContent).slice(0, 80),
            dataAction: clean(element.getAttribute?.("data-action")),
            role: clean(element.getAttribute?.("role")),
            className: clean(element.getAttribute?.("class")),
            href: clean(element.getAttribute?.("href")),
          }))
          .filter((item) => item.text || item.dataAction || item.href)
          .slice(0, 80);
        return {
          bodyText: clean(document.body?.innerText || "").slice(0, 2000),
          controls,
        };
      }).catch(() => ({ bodyText: "", controls: [] }))
    : { bodyText: "", controls: [] };
  return { url, title, ...state };
}

async function captureJianshuPublishDiagnostic(page, stage, extra = {}) {
  const diagnosticsDir = path.join(homedir(), ".zhixin-ai", "diagnostics");
  await mkdir(diagnosticsDir, { recursive: true }).catch(() => undefined);
  const safeStage = String(stage || "unknown").replace(/[^a-z0-9_-]+/gi, "-");
  const screenshotPath = path.join(diagnosticsDir, `jianshu-${safeStage}-${Date.now()}.png`);
  const uiState = await readJianshuPublishUiState(page);
  await page?.screenshot?.({ path: screenshotPath, fullPage: true }).catch(() => undefined);
  return {
    stage,
    screenshotPath,
    ...extra,
    ...uiState,
  };
}

export async function openJianshuPublishedArticleFromNoteMenu(page, title = "", timeoutMs = 5000) {
  if (typeof page?.evaluate !== "function") return "";
  const menuState = await page.evaluate((payload) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      const rect = element.getBoundingClientRect?.() || { width: 0, height: 0 };
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const title = clean(payload.title);
    const notes = [...document.querySelectorAll("li")];
    const selectedNote = notes.find((note) => (
      visible(note)
      && (!title || clean(note.textContent).includes(title) || /_25Ilv/.test(String(note.getAttribute("class") || "")))
      && note.querySelector(".fa-gear")
    ));
    const gear = selectedNote?.querySelector(".fa-gear")
      || [...document.querySelectorAll(".fa-gear")].filter(visible).at(-1);
    if (!gear) return false;
    const rect = gear.getBoundingClientRect();
    gear.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    gear.click();
    return {
      opened: true,
      gearBox: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      },
    };
  }, { title }).catch(() => false);
  if (!menuState) return "";

  await page.waitForTimeout?.(500).catch(() => undefined);
  const itemBox = await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      const rect = element.getBoundingClientRect?.() || { width: 0, height: 0 };
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const item = [...document.querySelectorAll("li, a, button, [role='menuitem']")]
      .map((element) => {
        const text = clean(element.textContent);
        if (!visible(element) || !text.includes("在新窗口打开")) return null;
        const rect = element.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          text,
          childCount: element.children?.length || 0,
        };
      })
      .filter(Boolean)
      .sort((left, right) => {
        const leftArea = left.width * left.height;
        const rightArea = right.width * right.height;
        const leftPenalty = left.text.length > 40 ? 100000 : 0;
        const rightPenalty = right.text.length > 40 ? 100000 : 0;
        return (leftArea + leftPenalty) - (rightArea + rightPenalty);
      })
      .at(0);
    if (!item) return null;
    return item;
  }).catch(() => null);

  const clickAndReadPopup = async (x, y) => {
    const popupPromise = typeof page.waitForEvent === "function"
      ? page.waitForEvent("popup", { timeout: Math.max(1000, Number(timeoutMs || 5000)) }).catch(() => null)
      : Promise.resolve(null);
    await page.mouse?.click?.(x, y).catch(() => undefined);
    const popup = await popupPromise;
    if (popup) {
      await popup.waitForLoadState?.("domcontentloaded", { timeout: 10000 }).catch(() => undefined);
      const popupUrl = normalizeJianshuPublishedUrl(typeof popup.url === "function" ? popup.url() : "");
      if (popupUrl) return popupUrl;
    }
    await page.waitForTimeout?.(500).catch(() => undefined);
    return normalizeJianshuPublishedUrl(typeof page.url === "function" ? page.url() : "");
  };

  const likelyMenuRow = itemBox
    && Number(itemBox.width || 0) > 0
    && Number(itemBox.height || 0) > 0
    && Number(itemBox.width || 0) <= 240
    && Number(itemBox.height || 0) <= 70
    && String(itemBox.text || "").length <= 40;
  if (likelyMenuRow) {
    const popupUrl = await clickAndReadPopup(itemBox.x + itemBox.width / 2, itemBox.y + itemBox.height / 2);
    if (popupUrl) return popupUrl;
  }

  const gearBox = typeof menuState === "object" && menuState?.gearBox ? menuState.gearBox : null;
  if (gearBox && typeof page?.mouse?.click === "function") {
    const x = Number(gearBox.x || 0) - 35;
    const y = Number(gearBox.y || 0) + 255;
    const popupUrl = await clickAndReadPopup(x, y);
    if (popupUrl) return popupUrl;
  }
  return normalizeJianshuPublishedUrl(typeof page.url === "function" ? page.url() : "");
}

async function readJianshuPublishedUrl(page) {
  const current = typeof page.url === "function" ? page.url() : "";
  const normalized = normalizeJianshuPublishedUrl(current);
  if (normalized) return normalized;
  if (typeof page.locator === "function") {
    const href = await page
      .locator("a[href*='/p/']")
      .first()
      .getAttribute?.("href")
      .catch(() => "");
    if (href) {
      try {
        return normalizeJianshuPublishedUrl(new URL(href, JIANSHU_ORIGIN).toString());
      } catch {
        return "";
      }
    }
  }
  return "";
}

export async function readJianshuPlatformBlocker(page) {
  if (typeof page.evaluate !== "function") return "";
  const messages = await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    return [...document.querySelectorAll(
      "[role='dialog'], [role='alert'], .modal, [class*='toast'], [class*='message'], [class*='notice'], [class*='error']"
    )]
      .filter(visible)
      .map((element) => String(element.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
  }).catch(() => []);
  if (!Array.isArray(messages)) return "";
  return jianshuPayloadManualActionCode({ message: messages.join(" ") });
}

async function verifyJianshuPublicImages(context, publishedUrl, tasks, existingPage = null) {
  if (!tasks.length) return [];
  const publicPage = existingPage || await context.newPage();
  const ownsPage = !existingPage;
  try {
    if (ownsPage || (typeof publicPage.url === "function" && normalizeJianshuPublishedUrl(publicPage.url()) !== publishedUrl)) {
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
      }, { selector: JIANSHU_PUBLIC_IMAGE_SELECTOR, expectedCount: tasks.length }, { timeout: 30000 }).catch(() => undefined);
    }
    return verifyPlatformImages({
      tasks,
      readImages: () => readLocatorImages(publicPage, JIANSHU_PUBLIC_IMAGE_SELECTOR),
      stage: "public",
    });
  } finally {
    if (ownsPage) await publicPage.close?.().catch(() => undefined);
  }
}

function normalizedMatchText(value = "") {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

export async function inspectJianshuPublicArticle(page, input = {}) {
  const publicUrl = normalizeJianshuPublishedUrl(
    input.publicUrl || input.publishedUrl || input.reviewUrl || ""
  );
  if (!publicUrl) throw new Error("JIANSHU_PUBLIC_URL_INVALID");

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
    }, { selector: JIANSHU_PUBLIC_IMAGE_SELECTOR, expectedCount: expected.length }, { timeout: 30000 }).catch(() => undefined);
  }

  const publicEvidence = expected.length
    ? await verifyPublicImageEvidence({
        tasks: expected,
        readImages: () => readLocatorImages(page, JIANSHU_PUBLIC_IMAGE_SELECTOR),
        readBlocker: async () => String(await readJianshuPlatformBlocker(page).catch(() => "") || "").trim()
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
  const bodyText = await page.locator("article, .show-content, .article-content, body").first().innerText().catch(() => "");
  const pageText = `${pageTitle}\n${bodyText}`.trim().slice(0, 12000);
  const expectedTitle = normalizedMatchText(input.articleTitle || input.title);
  const expectedBody = normalizedMatchText(input.contentMarkdown || input.content || input.richText);
  const normalizedPageTitle = normalizedMatchText(`${pageTitle}\n${bodyText}`);
  const titleMatched = Boolean(expectedTitle && normalizedPageTitle.includes(expectedTitle));
  const bodyMatched = !expectedBody || normalizedMatchText(bodyText).includes(expectedBody.slice(0, 80));

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

function waitOnJianshuPage(page, delayMs) {
  if (typeof page?.waitForTimeout === "function") return page.waitForTimeout(delayMs);
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitForJianshuApiVerification(operation, options = {}) {
  const timeoutMs = Math.max(1, Number(options.timeoutMs || 30000));
  const pollMs = Math.max(1, Number(options.pollMs || 500));
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  do {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error || "");
      if (!/NOT_FOUND|MISMATCH|IMAGE_MISSING|NOTE_NOT_PUBLIC|NOT_ACCEPTED/i.test(message)) throw error;
    }
    await waitOnJianshuPage(options.page, pollMs);
  } while (Date.now() < deadline);
  throw lastError || new Error("JIANSHU_API_VERIFICATION_TIMEOUT");
}

async function withJianshuTimeout(operation, timeoutMs, stage) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`JIANSHU_${String(stage || "operation").toUpperCase()}_TIMEOUT`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class JianshuAdapter extends ContentPlatformAdapter {
  constructor(options = {}) {
    super(contentPlatformConfigs.jianshu, options);
  }

  async discoverPublication(input = {}) {
    const context = await this.launchAuthEnvironment(input);
    const page = context.pages()[0] || await context.newPage();
    try {
      return await inspectJianshuPublicArticle(page, input);
    } finally {
      await this.refreshCredentialAfterOperation(input, context, page, JIANSHU_EDITOR_URL);
      if (!input.keepBrowserOpen) await context.close().catch(() => undefined);
    }
  }

  async publishArticleViaDom(input = {}) {
    throw new Error("JIANSHU_DOM_PUBLISH_DISABLED");
    /* c8 ignore start -- retained temporarily for compatibility with legacy helper tests. */
    const publishInput = normalizePublishInput(input);
    const context = await this.launchAuthEnvironment(input);

    const page = context.pages()[0] || await context.newPage();
    const keepOpen = Boolean(input.keepBrowserOpen);
    const watcher = watchJianshuApiResponses(page);

    try {
      page.setDefaultTimeout?.(15000);
      page.setDefaultNavigationTimeout?.(45000);
      if (shouldPublishJianshuViaApi(input, publishInput)) {
        try {
          return await publishJianshuViaApi(page, input, publishInput);
        } catch (error) {
          if (jianshuApiErrorIsTerminal(error)) throw error;
          notifyPublishProgress(input, {
            type: "api_publish_fallback",
            platform: "jianshu",
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
      }
      await page.goto(input.editorUrl || JIANSHU_EDITOR_URL, { waitUntil: "domcontentloaded" });
      await bringToFrontIfAllowed(page, input);
      await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
      await page.waitForTimeout?.(1500).catch(() => undefined);

      const cookies = await context.cookies([JIANSHU_ORIGIN]);
      const pageState = await readConfiguredPlatformPageState(page);
      if (!isConfiguredPlatformLoggedIn(this.config, cookies, pageState)) throw new Error("JIANSHU_LOGIN_REQUIRED");

      const openBlocker = await readJianshuPlatformBlocker(page);
      if (openBlocker) {
        notifyPublishProgress(input, {
          type: "manual_verification_required",
          platform: "jianshu",
          message: openBlocker === "JIANSHU_PHONE_BINDING_REQUIRED"
            ? "简书账号需要先绑定手机号，完成平台验证码后才能发布文章。"
            : "简书当前需要人工处理安全验证或平台提示。",
          currentUrl: typeof page.url === "function" ? page.url() : "",
        });
        throw new Error(openBlocker);
      }

      await fillJianshuTitle(page, publishInput.title);
      const expectedBody = buildJianshuBodyHtml(publishInput);
      await fillJianshuBody(page, publishInput);
      const uploadedImages = publishInput.platformImageTasks.length
        ? await uploadJianshuInlineImages(page, publishInput.platformImageTasks, { onProgress: input.onProgress })
        : [];
      await saveJianshuDraftAndWait(page, publishInput.draftTimeoutMs);
      const draftUrl = await waitForJianshuDraftUrl(watcher.state, page, publishInput.draftTimeoutMs);
      let draftImages = [];
      let draftReloaded = false;
      if (expectedBody.requiresRichText) {
        await input.onProgress?.({ type: "verifying_draft_body", headings: expectedBody.headings.length });
        await reloadJianshuDraftForVerification(page, draftUrl, expectedBody);
        draftReloaded = isStableJianshuDraftUrl(draftUrl);
      }
      if (publishInput.platformImageTasks.length) {
        await input.onProgress?.({ type: "verifying_draft_images", total: publishInput.platformImageTasks.length });
        if (!draftReloaded && isStableJianshuDraftUrl(draftUrl)) {
          await page.goto(draftUrl, { waitUntil: "domcontentloaded" });
          await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
        } else if (!draftReloaded) {
          await page.waitForTimeout?.(1500).catch(() => undefined);
        }
        draftImages = await verifyPlatformImages({
          tasks: publishInput.platformImageTasks,
          readImages: () => readJianshuEditorSectionImages(page, publishInput.platformImageTasks),
          timeoutMs: publishInput.draftTimeoutMs,
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

      await clickJianshuPublish(page, publishInput.publishTimeoutMs);
      await page.waitForLoadState?.("networkidle", { timeout: publishInput.publishTimeoutMs }).catch(() => undefined);
      await page.waitForTimeout?.(2000).catch(() => undefined);
      await confirmJianshuDialogs(page);
      await page.waitForLoadState?.("networkidle", { timeout: publishInput.publishTimeoutMs }).catch(() => undefined);
      await page.waitForTimeout?.(2000).catch(() => undefined);

      const publishBlocker = await readJianshuPlatformBlocker(page);
      if (publishBlocker || watcher.state.blocker) {
        const blocker = publishBlocker || watcher.state.blocker;
        notifyPublishProgress(input, {
          type: "manual_verification_required",
          platform: "jianshu",
          message: blocker === "JIANSHU_PHONE_BINDING_REQUIRED"
            ? "简书账号尚未绑定手机号，请完成平台短信验证码绑定后重试发布。"
            : "简书发布被平台拦截，请在桌面端打开的窗口处理后重试。",
          currentUrl: typeof page.url === "function" ? page.url() : "",
        });
        throw new Error(blocker);
      }

      const publishedUrl = watcher.state.publishedUrl
        || (await readJianshuPublishedUrl(page))
        || (await openJianshuPublishedArticleFromNoteMenu(page, publishInput.title, publishInput.publishTimeoutMs));
      if (!publishedUrl) {
        const diagnostic = await captureJianshuPublishDiagnostic(page, "publish-not-confirmed", {
          publishAttempted: watcher.state.publishAttempted,
          watcherDraftUrl: watcher.state.draftUrl,
          watcherPublishedUrl: watcher.state.publishedUrl,
        });
        notifyPublishProgress(input, {
          type: "publish_not_confirmed_diagnostic",
          platform: "jianshu",
          diagnostic,
        });
        throw new Error(
          watcher.state.publishAttempted ? "JIANSHU_PUBLISH_NOT_CONFIRMED" : "JIANSHU_PUBLISHED_URL_NOT_FOUND"
        );
      }

      let publicImages = [];
      if (publishInput.platformImageTasks.length) {
        await input.onProgress?.({ type: "verifying_public_images", total: publishInput.platformImageTasks.length });
        publicImages = await verifyJianshuPublicImages(context, publishedUrl, publishInput.platformImageTasks, page).catch(() => []);
      }
      const imagePublicationEvidence = publishInput.platformImageTasks.length
        ? buildImagePublicationEvidence(publishInput.platformImageTasks, uploadedImages, draftImages, publicImages)
        : undefined;
      if (imagePublicationEvidence && imagePublicationEvidence.status !== "verified") {
        return {
          draftUrl,
          publishedUrl: "",
          reviewUrl: publishedUrl,
          platformStatus: "submitted_for_review",
          publiclyVisible: false,
          reviewStatus: "pending_public_visibility",
          message: "简书已发布，但公开页正文图片证据不完整，等待复验。",
          title: publishInput.title,
          imagePublicationEvidence,
        };
      }

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
      await this.refreshCredentialAfterOperation(input, context, page, JIANSHU_EDITOR_URL);
      if (!keepOpen) {
        await context.close().catch(() => undefined);
      }
    }
    /* c8 ignore stop */
  }

  async ensurePublishSession(page, input = {}) {
    await page.goto(input.editorUrl || JIANSHU_EDITOR_URL, { waitUntil: "domcontentloaded" });
    await bringToFrontIfAllowed(page, input);
    await page.waitForLoadState?.("domcontentloaded", { timeout: 15000 }).catch(() => undefined);
    return readJianshuCurrentUserViaApi(page, input);
  }

  async publishArticleViaApi(page, context, publishInput, input = {}) {
    await this.ensurePublishSession(page, input);
    await input.onProgress?.({ type: "publish_transport", transport: "api", platform: "jianshu" });

    const body = buildJianshuBodyHtml(publishInput);
    let draft = null;
    let result = null;
    let cleanup = null;
    let operationError = null;

    try {
      await input.onProgress?.({ type: "creating_draft", transport: "api" });
      draft = await createJianshuNoteViaApi(page, publishInput.title, {
        ...input,
        notebook: publishInput.notebook || input.notebook,
      });
      const draftUrl = jianshuDraftUrlFromNoteId(draft.noteId, draft.notebookId);
      await input.onProgress?.({
        type: "draft_opened",
        transport: "api",
        draftId: draft.noteId,
        draftUrl,
      });

      await input.onProgress?.({ type: "updating_draft", transport: "api", draftId: draft.noteId });
      const update = await updateJianshuNoteViaApi(page, draft, publishInput.title, body.html, input);
      draft.autosaveControl = update.autosaveControl;

      let uploadedImages = [];
      let expectedImageUrls = [];
      if (publishInput.platformImageTasks.length) {
        await reloadJianshuDraftForVerification(page, draftUrl, body, {
          timeoutMs: Math.max(1, Number(publishInput.draftTimeoutMs || 30000)),
          pollMs: Math.max(1, Number(input.editorHydrationPollMs || 250)),
        });
        const observedUploads = await uploadJianshuInlineImages(page, publishInput.platformImageTasks, {
          onProgress: input.onProgress,
          timeoutMs: Math.max(60000, publishInput.draftTimeoutMs),
        });
        uploadedImages = publishInput.platformImageTasks.map((task, index) => ({
          ...task,
          ...(observedUploads[index] || {}),
          platformImageUrl: normalizeJianshuImageUrl(
            observedUploads[index]?.platformImageUrl || observedUploads[index]?.src || observedUploads[index]?.url || "",
          ),
          loaded: observedUploads[index]?.loaded !== false,
        }));
        expectedImageUrls = uploadedImages.map((image) => image.platformImageUrl).filter(Boolean);
        if (expectedImageUrls.length !== publishInput.platformImageTasks.length) {
          throw new Error("JIANSHU_UPLOAD_IMAGE_MISSING");
        }
      }

      await input.onProgress?.({
        type: "verifying_draft",
        transport: "api",
        draftId: draft.noteId,
        imageCount: expectedImageUrls.length,
      });
      const draftInspection = await waitForJianshuApiVerification(
        () => verifyJianshuDraftViaApi(page, {
          ...draft,
          title: publishInput.title,
          html: body.html,
          expectedImageUrls,
          shared: false,
        }, input),
        {
          page,
          timeoutMs: Math.max(15000, publishInput.draftTimeoutMs),
          pollMs: Number(input.apiVerifyPollMs || 500),
        },
      );
      const draftImages = bindJianshuApiImages(publishInput.platformImageTasks, draftInspection.imageUrls);
      const draftImageEvidence = publishInput.platformImageTasks.length
        ? buildImagePublicationEvidence(publishInput.platformImageTasks, uploadedImages, draftImages, [], PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED)
        : undefined;

      // The note already exists in the notebook, so a later draft or public
      // verification failure must not lose its identity.
      input.evidenceSink?.({
        draftUrl,
        externalIds: { noteId: draft.noteId, notebookId: draft.notebookId, slug: draft.slug },
        platformStatus: "draft_saved"
      });
      if (!publishInput.confirmPublish) {
        result = {
          draftUrl,
          publishedUrl: "",
          platformStatus: "draft_saved",
          title: publishInput.title,
          transport: "api",
          externalIds: { noteId: draft.noteId, notebookId: draft.notebookId, slug: draft.slug },
          publicationEvidence: {
            source: "api",
            accepted: true,
            draftVerified: true,
          },
          ...(draftImageEvidence ? { imagePublicationEvidence: draftImageEvidence } : {}),
        };
      } else {
        await input.onProgress?.({ type: "publishing", transport: "api", draftId: draft.noteId });
        const published = await publicizeJianshuNoteViaApi(page, draft, input);

        await input.onProgress?.({
          type: "verifying_public_article",
          platform: "jianshu",
          publishedUrl: published.publishedUrl,
          imageCount: expectedImageUrls.length,
        });
        const sharedInspection = await waitForJianshuApiVerification(
          () => verifyJianshuDraftViaApi(page, {
            ...draft,
            title: publishInput.title,
            html: body.html,
            expectedImageUrls,
            shared: true,
          }, input),
          {
            page,
            timeoutMs: Math.max(15000, publishInput.publishTimeoutMs),
            pollMs: Number(input.apiVerifyPollMs || 500),
          },
        );
        const publicInspection = await waitForJianshuApiVerification(
          () => inspectJianshuPublicArticleViaApi(page, {
            ...draft,
            title: publishInput.title,
            html: body.html,
            expectedImageUrls,
          }, input),
          {
            page,
            timeoutMs: Math.max(15000, publishInput.publishTimeoutMs),
            pollMs: Number(input.apiVerifyPollMs || 500),
          },
        );
        const publicImages = bindJianshuApiImages(publishInput.platformImageTasks, publicInspection.imageUrls);
        const imagePublicationEvidence = publishInput.platformImageTasks.length
          ? buildImagePublicationEvidence(publishInput.platformImageTasks, uploadedImages, draftImages, publicImages)
          : undefined;
        if (imagePublicationEvidence && imagePublicationEvidence.status !== "verified") {
          throw new Error("JIANSHU_PUBLIC_IMAGE_NOT_VERIFIED");
        }

        result = {
          draftUrl,
          publishedUrl: publicInspection.publishedUrl,
          platformStatus: "published",
          publiclyVisible: true,
          reviewStatus: "public",
          publicVerified: true,
          title: publishInput.title,
          transport: "api",
          externalIds: { noteId: draft.noteId, notebookId: draft.notebookId, slug: draft.slug },
          publicationEvidence: {
            source: "api",
            accepted: true,
            create: {
              endpoint: `${JIANSHU_ORIGIN}/author/notes`,
              noteId: draft.noteId,
              notebookId: draft.notebookId,
              slug: draft.slug,
            },
            update: {
              endpoint: `${JIANSHU_ORIGIN}/author/notes/${encodeURIComponent(draft.noteId)}`,
              draftVerified: true,
              sharedBeforePublish: Boolean(draftInspection.metadata.shared),
            },
            publicize: {
              endpoint: `${JIANSHU_ORIGIN}/author/notes/${encodeURIComponent(draft.noteId)}/publicize`,
              lastCompiledAt: published.lastCompiledAt,
            },
            public: {
              endpoint: `${JIANSHU_ORIGIN}/shakespeare/v2/notes/${encodeURIComponent(draft.slug)}`,
              noteId: publicInspection.payload.id,
              slug: publicInspection.payload.slug,
              titleMatched: publicInspection.titleMatched,
              bodyMatched: publicInspection.bodyMatched,
              shared: Boolean(sharedInspection.metadata.shared),
              imageCount: publicInspection.imageUrls.length,
            },
          },
          ...(imagePublicationEvidence ? { imagePublicationEvidence } : {}),
        };
      }
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      if (input.cleanupTestArticle === true && draft?.noteId) {
        try {
          cleanup = await softDestroyJianshuNoteViaApi(page, draft.noteId, input);
        } catch (cleanupError) {
          if (!operationError) throw cleanupError;
          notifyPublishProgress(input, {
            type: "test_cleanup_failed",
            platform: "jianshu",
            noteId: draft.noteId,
            errorMessage: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      }
    }

    return cleanup ? { ...result, testCleanup: cleanup } : result;
  }

  async publishArticle(input = {}) {
    const publishInput = normalizePublishInput(input);
    const keepOpen = Boolean(input.keepBrowserOpen);
    const imageCount = publishInput.platformImageTasks.length;
    const operationTimeoutMs = Math.min(
      600000,
      Math.max(180000, Number(input.operationTimeoutMs) || (180000 + imageCount * 60000)),
    );
    const context = await this.launchAuthEnvironment(input);
    const page = context.pages()[0] || await context.newPage();
    try {
      page.setDefaultTimeout?.(15000);
      page.setDefaultNavigationTimeout?.(45000);
      await input.onProgress?.({
        type: "publish_attempt",
        platform: "jianshu",
        attempt: 1,
        maxAttempts: 1,
        operationTimeoutMs,
        imageCount,
      });
      return await withJianshuTimeout(
        this.publishArticleViaApi(page, context, publishInput, input),
        operationTimeoutMs,
        "publish_article",
      );
    } finally {
      await this.refreshCredentialAfterOperation(input, context, page, JIANSHU_EDITOR_URL).catch(() => undefined);
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
