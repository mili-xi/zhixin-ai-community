import { readPublicPageBlockerFromPage } from "./public-page-blocker.mjs";
export { readPublicPageBlockerFromPage } from "./public-page-blocker.mjs";
import { isPersistentPlatformImageUrl } from "./platform-images.mjs";
import { readFile } from "node:fs/promises";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function normalizeImageUrlCandidate(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("//")) return `https:${text}`;
  return text;
}

function srcsetImageCandidates(value = "") {
  return String(value || "")
    .split(",")
    .map((item) => normalizeImageUrlCandidate(item.trim().split(/\s+/)[0] || ""))
    .filter(Boolean);
}

function choosePersistentImageUrl(candidates = []) {
  const normalized = candidates.map(normalizeImageUrlCandidate);
  for (const candidate of normalized) {
    if (isPersistentPlatformImageUrl(candidate)) return candidate;
  }
  return normalized.find((candidate) => /^(https?:|\/\/|data:|blob:)/i.test(candidate)) || normalized.find(Boolean) || "";
}

export async function pasteRichHtml(editorLocator, html, text = "") {
  if (!editorLocator || typeof editorLocator.evaluate !== "function") return false;
  return editorLocator.evaluate((editor, payload) => {
    const transfer = new DataTransfer();
    transfer.setData("text/html", payload.html);
    transfer.setData("text/plain", payload.text);
    editor.focus?.();
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    });
    editor.dispatchEvent(event);
    return true;
  }, { html: String(html || ""), text: String(text || "") }).catch(() => false);
}

export async function pasteRichHtmlWithSystemClipboard(page, editorLocator, html, text = "", options = {}) {
  if (!page || !editorLocator || typeof page.evaluate !== "function") return false;
  const origin = String(options.origin || "").trim();
  try {
    const context = typeof page.context === "function" ? page.context() : null;
    if (origin && typeof context?.grantPermissions === "function") {
      await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    }
    const written = await page.evaluate(async (payload) => {
      if (!navigator.clipboard?.write || typeof ClipboardItem !== "function") return false;
      const item = new ClipboardItem({
        "text/html": new Blob([payload.html], { type: "text/html" }),
        "text/plain": new Blob([payload.text], { type: "text/plain" }),
      });
      await navigator.clipboard.write([item]);
      return true;
    }, { html: String(html || ""), text: String(text || "") });
    if (!written) return false;
    await editorLocator.click?.();
    const shortcut = process.platform === "darwin" ? "Meta+V" : "Control+V";
    await page.keyboard?.press?.(shortcut);
    return true;
  } catch {
    return false;
  }
}

export async function uploadPlatformImages(options = {}) {
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
      await sleep(pollMs);
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

export async function verifyPlatformImages(options = {}) {
  const tasks = Array.isArray(options.tasks) ? options.tasks : [];
  if (!tasks.length) return [];
  if (typeof options.readImages !== "function") throw new Error("PLATFORM_IMAGE_READER_INVALID");
  const timeoutMs = Math.max(0, Number(options.timeoutMs || 0));
  const pollMs = Math.max(1, Number(options.pollMs || 500));
  const startedAt = Date.now();
  let images = [];
  do {
    images = persistentImages(await options.readImages());
    if (images.length >= tasks.length) break;
    if (!timeoutMs || Date.now() - startedAt >= timeoutMs) break;
    await sleep(pollMs);
  } while (Date.now() - startedAt < timeoutMs);
  if (images.length < tasks.length) {
    const stage = String(options.stage || "public").toUpperCase();
    throw new Error(`${stage}_IMAGE_MISSING`);
  }
  return tasks.map((task, index) => bindTask(task, images[index]));
}

// Public-stage image verification has to answer three questions, not two: the
// images are there, they are missing, or the platform never let us look. Only the
// second is a defect, and it stays non-terminal through the PUBLIC_IMAGE_MISSING
// issue. `readBlocker` is the per-platform probe that tells the third apart from
// the first two, so a missing image on a page we were allowed to read must keep
// reporting a defect and only a walled-off page reports "unverifiable".
export async function verifyPublicImageEvidence(options = {}) {
  const tasks = Array.isArray(options.tasks) ? options.tasks : [];
  if (!tasks.length) return { images: [], blocker: "" };
  let blocker = "";
  try {
    const images = await verifyPlatformImages({
      tasks,
      readImages: options.readImages,
      stage: "public",
    });
    return { images, blocker: "" };
  } catch (error) {
    if (!String(error?.message || error).includes("PUBLIC_IMAGE_MISSING")) throw error;
    blocker = typeof options.readBlocker === "function"
      ? String(await options.readBlocker().catch(() => "") || "").trim()
      : "";
  }
  return { images: [], blocker };
}

export async function readLocatorImages(surface, selector = "img") {
  if (!surface || typeof surface.locator !== "function") return [];
  const locator = surface.locator(selector);
  const count = await locator.count?.().catch(() => 0) || 0;
  const images = [];
  for (let index = 0; index < count; index += 1) {
    const image = locator.nth(index);
    const attributeSrc = await image.getAttribute?.("src").catch(() => "") || "";
    const dataSrc = await image.getAttribute?.("data-src").catch(() => "") || "";
    const dataOriginal = await image.getAttribute?.("data-original").catch(() => "") || "";
    const dataLazySrc = await image.getAttribute?.("data-lazy-src").catch(() => "") || "";
    const dataUrl = await image.getAttribute?.("data-url").catch(() => "") || "";
    const srcset = await image.getAttribute?.("srcset").catch(() => "") || "";
    const altText = await image.getAttribute?.("alt").catch(() => "") || "";
    const imageState = await image.evaluate?.((element) => {
      if (!(element instanceof HTMLImageElement)) return { currentSrc: "", loaded: true };
      return {
        currentSrc: String(element.currentSrc || element.src || ""),
        loaded: element.complete && element.naturalWidth > 0,
      };
    }).catch(() => null);
    const currentSrc = typeof imageState === "object" && imageState ? String(imageState.currentSrc || "") : "";
    const platformImageUrl = choosePersistentImageUrl([
      currentSrc,
      dataSrc,
      dataOriginal,
      dataLazySrc,
      dataUrl,
      ...srcsetImageCandidates(srcset).reverse(),
      attributeSrc,
    ]);
    const loaded = typeof imageState === "boolean" ? imageState : imageState?.loaded === true;
    images.push({ platformImageUrl, altText, loaded });
  }
  return images;
}

export async function positionCursorAfterSection(editorLocator, task = {}) {
  if (!editorLocator || typeof editorLocator.evaluate !== "function") return false;
  return editorLocator.evaluate((editor, payload) => {
    const sectionId = String(payload.sectionId || "");
    const sectionTitle = String(payload.sectionTitle || "").trim();
    let target = sectionId
      ? editor.querySelector(`[data-zhixin-section="${CSS.escape(sectionId)}"]`)
      : null;
    if (!target && sectionTitle) {
      const candidates = [...editor.querySelectorAll("h1,h2,h3,h4,p,div")];
      target = candidates.find((element) => String(element.textContent || "").trim() === sectionTitle) || null;
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
  }).catch(() => false);
}

export async function pasteImageFile(editorLocator, filePath, mimeType = "image/png") {
  if (!editorLocator || typeof editorLocator.evaluate !== "function") return false;
  const base64 = (await readFile(filePath)).toString("base64");
  return editorLocator.evaluate((editor, payload) => {
    const bytes = Uint8Array.from(atob(payload.base64), (character) => character.charCodeAt(0));
    const file = new File([bytes], payload.filename, { type: payload.mimeType });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    editor.focus?.();
    const paste = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer });
    const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer });
    const pasteHandled = !editor.dispatchEvent(paste);
    if (!pasteHandled) editor.dispatchEvent(drop);
    return true;
  }, {
    base64,
    mimeType,
    filename: String(filePath).split(/[\\/]/).pop() || "inline-image.png",
  }).catch(() => false);
}

export async function verifyPublicPageImages(context, publishedUrl, tasks = [], imageSelector = "article img") {
  if (!tasks.length) return { images: [], blocker: "" };
  if (!context || typeof context.newPage !== "function") throw new Error("PUBLIC_IMAGE_CONTEXT_INVALID");
  const page = await context.newPage();
  try {
    await page.goto(publishedUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
    // Article bodies on most platforms lazy-load their images. Without a scroll the
    // locator sees zero <img> elements and we would report a missing image on a
    // perfectly healthy public page.
    await scrollPublicPageIntoView(page);
    await page.waitForFunction?.((payload) => {
      const images = [...document.querySelectorAll(payload.selector)];
      const loaded = images.filter((image) => {
        const source = image.getAttribute("src") || "";
        return /^https:\/\//i.test(source) && image.complete && image.naturalWidth > 0;
      });
      return loaded.length >= payload.expectedCount;
    }, { selector: imageSelector, expectedCount: tasks.length }, { timeout: 30000 }).catch(() => undefined);
    // Returning the promise directly would let the finally block close the page
    // before it settles: the evidence read would still be in flight against a
    // closed target, every locator call would fail, and the page would be
    // reported as image-less. The read has to finish before the page may go.
    const evidence = await verifyPublicImageEvidence({
      tasks,
      readImages: async () => {
        const primary = await readLocatorImages(page, imageSelector);
        if (primary.length >= tasks.length) return primary;
        const fallback = await readLocatorImages(page, "article img, main img, .post_body img, .article-content img, .article img");
        return fallback.length > primary.length ? fallback : primary;
      },
      readBlocker: () => readPublicPageBlockerFromPage(page),
    });
    return evidence;
  } finally {
    await page.close?.().catch(() => undefined);
  }
}

async function scrollPublicPageIntoView(page) {
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
