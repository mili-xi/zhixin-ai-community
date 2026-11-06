import crypto from "node:crypto";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { collectWebStorage } from "./zhihu.mjs";
import {
  refreshCredentialFromWorkspace,
  resolveProfileDir,
  seedPersistentContext,
  summarizeCredentialExpiry
} from "../session-manager.mjs";
import { pasteRichHtml, positionCursorAfterSection, readLocatorImages, uploadPlatformImages, verifyPlatformImages, verifyPublicImageEvidence, verifyPublicPageImages } from "../editor-image-upload.mjs";
import { readPublicPageBlockerFromPage } from "../public-page-blocker.mjs";
import { buildImagePublicationEvidence, PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED } from "../platform-images.mjs";
import { bindContentBlocksToImages, composeRichArticleHtml } from "../rich-content.mjs";
import { platformApiFetch } from "./platform-api.mjs";
import { importPlaywrightChromium } from "./browser-runtime.mjs";
import { bringToFrontIfAllowed } from "../browser-visibility.mjs";

const SOHU_ORIGIN = "https://mp.sohu.com";
const SOHU_PASSPORT_ORIGIN = "https://passport.sohu.com";
const SOHU_LOGIN_URL = "https://mp.sohu.com/";
const SOHU_EDITOR_URL = "https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=1";
const SOHU_MANAGE_URL = "https://mp.sohu.com/mpfe/v4/contentManagement/news/articlelist";
const SOHU_PUBLIC_IMAGE_SELECTOR = "article img, .article-content img, .article-text img, .text img, .article img";
const DEFAULT_WAIT_LOGIN_MS = 300000;
// The Sohu SMS gate can only be cleared by a person, so the adapter holds the
// publish and resumes instead of failing. The budget is capped by the operation
// timeout that is still left, so withSohuTimeout can never discard the wait.
const SOHU_MANUAL_VERIFICATION_TIMEOUT_MS = 300000;
const SOHU_MANUAL_VERIFICATION_POLL_MS = 3000;
const SOHU_OPERATION_TIMEOUT_MS = 180000;

function normalizeSohuPublicImageUrl(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("//")) return `https:${text}`;
  return /^https?:\/\//i.test(text) ? text : "";
}

async function readSohuPublicArticleImages(page) {
  const domImages = await readLocatorImages(page, SOHU_PUBLIC_IMAGE_SELECTOR);
  const listedImages = await page.evaluate?.(() => {
    const items = Array.isArray(window.cfgs?.imgsList) ? window.cfgs.imgsList : [];
    return items
      .map((item) => (typeof item === "string" ? item : item?.url || item?.src || ""))
      .filter(Boolean);
  }).catch(() => []) || [];
  return [
    ...domImages,
    ...listedImages.map((url) => ({
      platformImageUrl: normalizeSohuPublicImageUrl(url),
      altText: "",
      loaded: true,
    })),
  ];
}

async function readSohuEditorImages(page) {
  if (page?.evaluate) {
    const images = await page.evaluate(() => {
      const visible = (element) => {
        if (!element) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const editors = Array.from(document.querySelectorAll(".ql-editor"));
      const activeEditors = editors.filter(visible);
      const roots = activeEditors.length ? activeEditors : editors;
      return roots.flatMap((root) => Array.from(root.querySelectorAll("img")))
      .map((image) => ({
        platformImageUrl: image.currentSrc || image.src || image.getAttribute("src") || "",
        altText: image.getAttribute("alt") || "",
        loaded: image instanceof HTMLImageElement ? image.naturalWidth > 0 || image.complete : true,
      }));
    }).catch(() => []);
    if (Array.isArray(images) && images.length) return images;
  }
  const visible = await readLocatorImages(page, ".ql-editor:visible img");
  const all = await readLocatorImages(page, ".ql-editor img");
  const byUrl = new Map();
  for (const image of [...all, ...visible]) {
    const url = String(image.platformImageUrl || image.src || image.url || "");
    if (!url) continue;
    const previous = byUrl.get(url);
    byUrl.set(url, {
      ...(previous || {}),
      ...image,
      loaded: previous?.loaded === true || image.loaded === true,
    });
  }
  return [...byUrl.values()];
}

async function readSohuImageUploadDebugSnapshot(page, stage, task = {}, index = 0) {
  if (!page?.evaluate) return {};
  const snapshot = await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const dialogs = Array.from(document.querySelectorAll(".local-upload, .upload-dialog, .el-dialog, [role='dialog']"))
      .filter(visible);
    const editorImages = Array.from(document.querySelectorAll(".ql-editor img"));
    return {
      currentUrl: location.href,
      dialogCount: dialogs.length,
      dialogText: dialogs.map((element) => clean(element.innerText)).join(" | ").slice(0, 1000),
      dialogButtons: dialogs.flatMap((root) => Array.from(root.querySelectorAll("button, [role='button'], .button")))
        .filter(visible)
        .map((element) => ({
          className: String(element.className || ""),
          text: clean(element.innerText || element.textContent),
          disabled: Boolean(element.disabled) || element.getAttribute("aria-disabled") === "true",
        }))
        .slice(0, 20),
      fileInputCount: document.querySelectorAll("input[type='file']").length,
      editorImageCount: editorImages.length,
        editorImages: editorImages.map((image) => ({
          src: image.currentSrc || image.src || image.getAttribute("src") || "",
          complete: image instanceof HTMLImageElement ? image.complete : true,
          naturalWidth: image instanceof HTMLImageElement ? image.naturalWidth : 0,
      })).slice(0, 10),
    };
  }).catch(() => ({}));

  if (stage === "timeout" && typeof page.screenshot === "function") {
    const outputDir = path.join(process.cwd(), "docs", "verification", "artifacts");
    await mkdir(outputDir, { recursive: true }).catch(() => undefined);
    const safeAsset = cleanText(task.assetId || `image-${index + 1}`).replace(/[^a-zA-Z0-9._-]+/g, "-") || `image-${index + 1}`;
    const screenshotPath = path.join(outputDir, `sohu-upload-timeout-${Date.now()}-${safeAsset}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
    snapshot.screenshotPath = screenshotPath;
  }
  return snapshot;
}

async function writeSohuCoverUploadDebugSnapshot(page, stage = "cover-file-input") {
  const outputDir = path.join(process.cwd(), "docs", "verification", "artifacts");
  await mkdir(outputDir, { recursive: true }).catch(() => undefined);
  const stamp = Date.now();
  const screenshotPath = path.join(outputDir, `sohu-cover-${stage}-${stamp}.png`);
  const jsonPath = path.join(outputDir, `sohu-cover-${stage}-${stamp}.json`);
  const snapshot = page?.evaluate ? await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const scoreEditor = (element) => {
      const rect = element.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      const inAside = Boolean(element.closest("aside, .ai-panel, .creation-assistant, .helper, .right-panel, .side-panel"));
      const inMain = Boolean(element.closest("main, .article-editor, .news-editor, .content-editor, .editor-box, .editor-container, .main-content"));
      return area + (inMain ? 50000 : 0) - (inAside ? 100000 : 0);
    };
    const visibleDialogs = Array.from(document.querySelectorAll(".el-dialog, .el-drawer, [role='dialog'], .upload-dialog, .local-upload")).filter(visible);
    const fileInputs = Array.from(document.querySelectorAll("input[type='file']"));
    const editors = Array.from(document.querySelectorAll(".ql-editor"))
      .sort((a, b) => scoreEditor(b) - scoreEditor(a))
      .map((editor) => {
        const rect = editor.getBoundingClientRect();
        return {
          className: String(editor.className || ""),
          contenteditable: editor.getAttribute("contenteditable") || "",
          visible: visible(editor),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          htmlLength: editor.innerHTML?.length || 0,
          imageCount: editor.querySelectorAll("img").length,
          images: Array.from(editor.querySelectorAll("img")).map((image) => ({
            src: image.getAttribute("src") || "",
            currentSrc: image.currentSrc || "",
            dataSrc: image.getAttribute("data-src") || "",
            dataOriginal: image.getAttribute("data-original") || "",
            complete: image instanceof HTMLImageElement ? image.complete : true,
            naturalWidth: image instanceof HTMLImageElement ? image.naturalWidth : 0,
            outerHTML: String(image.outerHTML || "").slice(0, 1000),
          })).slice(0, 12),
        };
      });
    return {
      currentUrl: location.href,
      title: document.title,
      bodyText: clean(document.body?.innerText || "").slice(0, 2000),
      dialogCount: visibleDialogs.length,
      dialogs: visibleDialogs.map((dialog) => ({
        tag: dialog.tagName,
        className: String(dialog.className || ""),
        text: clean(dialog.innerText || dialog.textContent || "").slice(0, 1200),
      })).slice(0, 8),
      fileInputs: fileInputs.map((input) => ({
        className: String(input.className || ""),
        accept: input.getAttribute("accept") || "",
        multiple: input.hasAttribute("multiple"),
        visible: visible(input),
        rootText: clean(input.closest(".el-dialog, .el-drawer, [role='dialog'], .upload-dialog, .local-upload")?.innerText || "").slice(0, 800),
      })),
      editors: editors.slice(0, 8),
      clickableTexts: Array.from(document.querySelectorAll("button, [role='button'], a, p, span, h3, .upload-btn, .cover-button, .upload-tip"))
        .filter(visible)
        .map((element) => ({ tag: element.tagName, className: String(element.className || ""), text: clean(element.innerText || element.textContent || "").slice(0, 120) }))
        .filter((item) => item.text || /upload|cover|button/i.test(item.className))
        .slice(0, 80),
    };
  }).catch((error) => ({ error: String(error?.message || error) })) : {};
  await page?.screenshot?.({ path: screenshotPath, fullPage: true }).catch(() => undefined);
  await writeFile(jsonPath, JSON.stringify({ ...snapshot, screenshotPath, jsonPath }, null, 2), "utf8").catch(() => undefined);
  return { ...snapshot, screenshotPath, jsonPath };
}

async function clickSohuPositiveConfirm(page, timeoutMs = 60000) {
  const selectors = [
    ".local-upload .bottom-buttons .positive-button:visible",
    ".local-upload .button.positive-button:visible",
    ".upload-dialog .positive-button:visible",
    ".el-dialog:visible .bottom-buttons .positive-button:visible",
    ".el-dialog:visible .dialog-footer .positive-button:visible",
    ".el-dialog:visible .footer .positive-button:visible",
    ".el-dialog:visible li.positive-button:visible",
    ".el-dialog:visible div.positive-button:visible",
    ".el-dialog:visible span.positive-button:visible",
    ".el-dialog:visible p.positive-button:visible",
    ".el-dialog:visible .el-button--primary:visible",
    ".el-dialog:visible .confirm-button:visible",
    ".el-dialog:visible .confirm-btn:visible",
    ".el-dialog .positive-button:has-text('\u786e\u5b9a'):visible",
    ".el-dialog .positive-button:has-text('\u786e\u8ba4'):visible",
    ".el-dialog .positive-button:has-text('\u5b8c\u6210'):visible",
    ".el-dialog .positive-button:has-text('\u4fdd\u5b58'):visible",
    ".el-dialog .positive-button:has-text('\u4f7f\u7528'):visible",
    ".el-dialog :is(button,li,div,span):has-text('\u786e\u5b9a'):visible",
    ".el-dialog :is(button,li,div,span):has-text('\u786e\u8ba4'):visible",
    ".el-dialog :is(button,li,div,span):has-text('\u5b8c\u6210'):visible",
    ".el-dialog :is(button,li,div,span):has-text('\u4fdd\u5b58'):visible",
    ".el-dialog :is(button,li,div,span):has-text('\u4f7f\u7528'):visible",
    "[role='dialog'] .positive-button:has-text('\u786e\u5b9a'):visible",
    "[role='dialog'] .positive-button:has-text('\u786e\u8ba4'):visible",
    "button.positive-button:has-text('\u786e\u5b9a'):visible",
    ".positive-button:has-text('\u786e\u5b9a'):visible",
    ".positive-button:has-text('\u786e\u8ba4'):visible",
  ];
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    for (const selector of selectors) {
      const confirm = page.locator(selector).first();
      const visible = await confirm.isVisible?.().catch(() => false);
      const disabled = await isSohuConfirmDisabled(confirm);
      if (visible && !disabled) {
        await withSohuActionTimeout(confirm.click({ force: true }), 5000, undefined);
        return;
      }
    }
    const clicked = await clickSohuPositiveConfirmByDom(page).catch(() => null);
    if (clicked?.clicked) return;
    if (typeof page.waitForTimeout === "function") await page.waitForTimeout(300);
    else await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("SOHU_UPLOAD_CONFIRM_NOT_READY");
}

async function isSohuConfirmDisabled(locator) {
  const disabled = typeof locator.isDisabled === "function"
    ? await withSohuActionTimeout(locator.isDisabled(), 2000, false).catch(() => false)
    : false;
  if (disabled) return true;
  const className = typeof locator.getAttribute === "function"
    ? await withSohuActionTimeout(locator.getAttribute("class"), 2000, "").catch(() => "") || ""
    : "";
  const ariaDisabled = typeof locator.getAttribute === "function"
    ? await withSohuActionTimeout(locator.getAttribute("aria-disabled"), 2000, "").catch(() => "") || ""
    : "";
  return ariaDisabled === "true" || /(^|[\s_-])(?:disabled?|is-disabled)(?:[\s_-]|$)/i.test(className);
}

async function clickSohuPositiveConfirmByDom(page) {
  if (typeof page.evaluate !== "function") return { clicked: false };
  return page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const disabled = (element) => {
      const className = String(element.className || "");
      return Boolean(element.disabled)
        || element.getAttribute("aria-disabled") === "true"
        || /(^|[\s_-])(?:disabled?|is-disabled)(?:[\s_-]|$)/i.test(className);
    };
    const positiveText = /(\u786e\u5b9a|\u786e\u8ba4|\u5b8c\u6210|\u4fdd\u5b58|\u4f7f\u7528|\u63d2\u5165|\u4e0b\u4e00\u6b65)/;
    const negativeText = /(\u53d6\u6d88|\u5173\u95ed|\u8fd4\u56de|cancel|close)/i;
    const positiveClass = /(positive|primary|confirm|submit|ok|sure|save)/i;
    const negativeClass = /(close|cancel|negative)/i;
    const roots = Array.from(document.querySelectorAll(".el-dialog, .el-drawer, [role='dialog'], .local-upload, .upload-dialog"))
      .filter(visible);
    const searchRoots = roots.length ? roots : [document.body];
    const candidates = searchRoots.flatMap((root) => Array.from(root.querySelectorAll([
      "button",
      "[role='button']",
      "a",
      "li",
      "p[class*='button']",
      "span[class*='button']",
      "div[class*='button']",
      "span[class*='btn']",
      "div[class*='btn']",
      ".positive-button",
      ".el-button",
      ".confirm-button",
      ".confirm-btn",
      ".primary",
      ".btn-primary"
    ].join(","))))
      .filter((element, index, list) => list.indexOf(element) === index)
      .filter((element) => visible(element) && !disabled(element));
    const ranked = candidates
      .map((element) => {
        const text = clean(element.innerText || element.textContent || element.getAttribute("aria-label") || element.title || "");
        const className = String(element.className || "");
        if (negativeText.test(text) || negativeClass.test(className)) return null;
        let score = 0;
        if (positiveText.test(text)) score += 10;
        if (positiveClass.test(className)) score += 6;
        if (/button/i.test(element.tagName) || element.getAttribute("role") === "button") score += 2;
        if (!text && !positiveClass.test(className)) score -= 4;
        return { element, text, className, score };
      })
      .filter(Boolean)
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);
    const target = ranked[0]?.element;
    if (!target) return { clicked: false, candidateCount: candidates.length };
    target.scrollIntoView?.({ block: "center", inline: "center" });
    target.click();
    return {
      clicked: true,
      tag: target.tagName,
      className: String(target.className || ""),
      text: clean(target.innerText || target.textContent || "").slice(0, 80),
    };
  });
}

async function setSohuImageFileInput(page, filePath, timeoutMs = 10000) {
  const selectors = [
    ".el-dialog:visible .board:visible input[type='file']",
    ".el-dialog:visible .upload-area:visible input[type='file']",
    ".el-dialog:visible [contentpictures]:visible input[type='file']",
    ".el-dialog:visible input[type='file']",
    ".el-drawer:visible input[type='file']",
    ".local-upload input[type='file']",
    ".upload-dialog input[type='file']",
    "input[type='file']",
  ];
  for (const selector of selectors) {
    const input = page.locator(selector).last();
    const count = typeof input.count === "function" ? await input.count().catch(() => 0) : 1;
    if (count <= 0) continue;
    let settled = false;
    await withSohuActionTimeout(
      input.setInputFiles(filePath).then(() => { settled = true; }),
      Math.min(timeoutMs, 8000),
      undefined
    ).catch(() => undefined);
    if (settled) return true;
  }
  return false;
}

async function clickSohuLocalUploadTab(page, timeoutMs = 10000) {
  const selectors = [
    ".el-dialog:visible .dialog-title h3:has-text('\u672c\u5730\u4e0a\u4f20')",
    ".el-dialog:visible h3:has-text('\u672c\u5730\u4e0a\u4f20')",
    ".el-dialog:visible :text('\u672c\u5730\u4e0a\u4f20')",
    ".el-drawer:visible :text('\u672c\u5730\u4e0a\u4f20')",
    ":text('\u672c\u5730\u4e0a\u4f20')",
    ".local-upload:visible",
    ".upload-dialog:visible .local-upload",
    ".upload-btn:visible",
    ".upload-button:visible",
  ];
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    for (const selector of selectors) {
      const tab = page.locator(selector).last();
      const visible = await tab.isVisible?.().catch(() => false);
      if (!visible) continue;
      await withSohuActionTimeout(tab.click?.({ force: true }) ?? Promise.resolve(), 3000, undefined).catch(() => undefined);
      if (await isSohuLocalUploadTabActive(page).catch(() => false)) return true;
    }
    const clickedByMouse = await clickSohuLocalUploadTabByMouse(page).catch(() => null);
    if (clickedByMouse?.clicked && await isSohuLocalUploadTabActive(page).catch(() => false)) return true;
    const clickedByDom = await clickSohuLocalUploadTabByDom(page).catch(() => null);
    if (clickedByDom?.clicked && await isSohuLocalUploadTabActive(page).catch(() => false)) return true;
    if (typeof page.getByText === "function") {
      const tab = page.getByText("\u672c\u5730\u4e0a\u4f20", { exact: true }).last();
      const visible = await tab.isVisible?.().catch(() => false);
      if (visible) {
        await withSohuActionTimeout(tab.click?.({ force: true }) ?? Promise.resolve(), 3000, undefined).catch(() => undefined);
        if (await isSohuLocalUploadTabActive(page).catch(() => false)) return true;
      }
    }
    if (typeof page.waitForTimeout === "function") await page.waitForTimeout(300);
    else await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

async function clickSohuLocalUploadTabByMouse(page) {
  if (typeof page.evaluate !== "function" || !page.mouse?.click) return { clicked: false, reason: "mouse_unavailable" };
  const point = await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const target = Array.from(document.querySelectorAll(".el-dialog h3, [role='dialog'] h3"))
      .find((element) => visible(element) && clean(element.textContent || "") === "\u672c\u5730\u4e0a\u4f20");
    if (!target) return null;
    const rect = target.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  if (!point) return { clicked: false, reason: "tab_not_found" };
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout?.(300).catch(() => undefined);
  return { clicked: true, x: point.x, y: point.y };
}

async function isSohuLocalUploadTabActive(page) {
  if (typeof page.evaluate !== "function") return false;
  const result = await page.evaluate(() => Array.from(document.querySelectorAll(".el-dialog h3, [role='dialog'] h3"))
    .some((element) => String(element.textContent || "").trim() === "\u672c\u5730\u4e0a\u4f20" && String(element.className || "").includes("selected")));
  return result === true;
}

async function hasSohuLocalUploadTab(page) {
  if (typeof page.evaluate !== "function") return false;
  const result = await page.evaluate(() => Array.from(document.querySelectorAll(".el-dialog h3, [role='dialog'] h3"))
    .some((element) => String(element.textContent || "").trim() === "\u672c\u5730\u4e0a\u4f20"));
  return result === true;
}

async function clickSohuLocalUploadTabByDom(page) {
  if (typeof page.evaluate !== "function") return { clicked: false };
  return page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const roots = Array.from(document.querySelectorAll(".el-dialog, .el-drawer, [role='dialog'], .upload-dialog"))
      .filter(visible);
    const searchRoots = roots.length ? roots : [document.body];
    const candidates = searchRoots.flatMap((root) => Array.from(root.querySelectorAll("button,[role='button'],a,li,div,span,p")))
      .filter((element, index, list) => list.indexOf(element) === index)
      .filter(visible)
      .map((element) => ({ element, text: clean(element.innerText || element.textContent || ""), className: String(element.className || "") }))
      .filter((item) => item.text === "\u672c\u5730\u4e0a\u4f20" || (/upload-tab/i.test(item.className) && item.text.includes("\u672c\u5730")));
    const target = candidates[0]?.element;
    if (!target) return { clicked: false, candidateCount: candidates.length };
    target.scrollIntoView?.({ block: "center", inline: "center" });
    target.click();
    return { clicked: true, tag: target.tagName, className: String(target.className || ""), text: clean(target.textContent || "") };
  });
}

export async function uploadSohuInlineImages(page, tasks = [], options = {}) {
  if (!tasks.length) return [];
  const editor = page.locator(".ql-editor[contenteditable='true']:visible, .ql-editor:visible").first();
  return uploadPlatformImages({
    tasks,
    readImages: () => readSohuEditorImages(page),
    positionForTask: (task) => positionCursorAfterSection(editor, task),
    selectFile: async (task) => {
      await page.locator("button.ql-image, .ql-toolbar .ql-image").first().click();
      const dialogInput = page.locator(".local-upload input[type='file'][accept*='image'], .upload-dialog input[type='file'][accept*='image']").last();
      if (await dialogInput.count?.().catch(() => 0)) {
        await dialogInput.setInputFiles(task.path);
      } else {
        await page.locator("input[type='file'][accept*='image']").last().setInputFiles(task.path);
      }
      await clickSohuPositiveConfirm(page, options.timeoutMs || 60000);
    },
    onProgress: options.onProgress,
    debugSnapshot: (stage, task, index) => readSohuImageUploadDebugSnapshot(page, stage, task, index),
    timeoutMs: options.timeoutMs || 60000,
  });
}

function sohuCreationStatementValue(value = "") {
  const statement = cleanText(value);
  if (/AI|\u4eba\u5de5\u667a\u80fd/i.test(statement)) return "2";
  if (/\u865a\u6784|fiction/i.test(statement)) return "3";
  if (/\u5f15\u7528|reference|quote/i.test(statement)) return "1";
  return "0";
}

function cssTextLiteral(value = "") {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

async function readSohuPublicationConfig(page) {
  if (typeof page.evaluate !== "function") return {};
  return page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const selectedCategory = Array.from(document.querySelectorAll(".select.plugin-dropdown .select-main, .select .select-main"))
      .filter(visible)
      .map((element) => clean(element.textContent || ""))
      .find((text) => text && !/未选择|请选择|请搜索/i.test(text)) || "";
    const checkedRadio = document.querySelector(".info-radio input[type='radio']:checked")
      || document.querySelector(".info-radio-label input[type='radio']:checked")
      || document.querySelector("label.info-radio-label.is-checked input[type='radio']")
      || document.querySelector(".el-radio.is-checked input[type='radio']")
      || document.querySelector(".info-radio .is-checked input[type='radio']");
    const checkedLabel = checkedRadio?.closest("label")?.textContent || "";
    const cover = Array.from(document.querySelectorAll(".pic-cover, .cover-button .pic-cover"))
      .filter(visible)
      .some((element) => {
        const background = getComputedStyle(element).backgroundImage || element.style.backgroundImage || "";
        const text = clean(element.textContent || element.closest(".cover-button")?.textContent || "");
        return (background && background !== "none" && !/url\((\"\"|''|)\)/.test(background))
          || (text.includes("编辑封面") && !text.includes("上传图片"));
      });
    return {
      selectedCategory,
      creationStatementValue: checkedRadio?.value || "",
      creationStatementText: clean(checkedLabel),
      coverSelected: cover,
    };
  }).catch(() => ({}));
}

async function waitForSohuPublicationConfig(page, input = {}, timeoutMs = 60000) {
  if (typeof page.evaluate !== "function") return {};
  const expectedStatementValue = input.creationStatement ? sohuCreationStatementValue(input.creationStatement) : "";
  const startedAt = Date.now();
  let lastState = {};
  while (Date.now() - startedAt < timeoutMs) {
    lastState = await readSohuPublicationConfig(page);
    const categoryOk = !input.category || lastState.selectedCategory === input.category;
    const statementOk = !input.creationStatement || lastState.creationStatementValue === expectedStatementValue;
    const coverOk = !input.coverImagePath || lastState.coverSelected === true;
    if (categoryOk && statementOk && coverOk) return lastState;
    if (typeof page.waitForTimeout === "function") await page.waitForTimeout(500);
    else await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const missing = [
    input.category && lastState.selectedCategory !== input.category ? "category" : "",
    input.creationStatement && lastState.creationStatementValue !== expectedStatementValue ? "creationStatement" : "",
    input.coverImagePath && lastState.coverSelected !== true ? "cover" : "",
  ].filter(Boolean).join(",");
  const error = new Error(`SOHU_PUBLICATION_CONFIG_INCOMPLETE:${missing || "unknown"}`);
  error.state = lastState;
  throw error;
}

async function selectSohuCategory(page, category) {
  if (await clickSohuCategoryOptionByDom(page, category).then((result) => result?.clicked === true).catch(() => false)) return true;
  const dropdowns = page.locator(".select.plugin-dropdown:visible, .select:visible");
  const count = typeof dropdowns.count === "function" ? await dropdowns.count().catch(() => 0) : 0;
  for (let index = 0; index < count; index += 1) {
    const dropdown = dropdowns.nth(index);
    const text = await dropdown.innerText?.().catch(() => "");
    if (!text.includes(category)) continue;
    await withSohuActionTimeout(dropdown.locator(".select-main").first().click({ force: true }), 3000, undefined).catch(() => undefined);
    if (await clickSohuCategoryOption(page, category)) {
      await clickSohuPositiveConfirm(page, 5000).catch(() => undefined);
      return true;
    }
  }
  await withSohuActionTimeout(page.locator(".select.plugin-dropdown:visible .select-main:visible").first().click({ force: true }), 3000, undefined).catch(() => undefined);
  const selected = await clickSohuCategoryOption(page, category);
  if (selected) await clickSohuPositiveConfirm(page, 5000).catch(() => undefined);
  return selected;
}

async function clickSohuCategoryOption(page, category) {
  if (!category) return false;
  if (typeof page.getByText === "function") {
    const option = page.getByText(category, { exact: true }).last();
    const visible = await withSohuActionTimeout(option.isVisible?.() ?? Promise.resolve(false), 2000, false).catch(() => false);
    if (visible) {
      await withSohuActionTimeout(option.click({ force: true }), 5000, undefined).catch(() => undefined);
      return true;
    }
  }
  const domClicked = await clickSohuCategoryOptionByDom(page, category).catch(() => null);
  return domClicked?.clicked === true;
}

async function clickSohuCategoryOptionByDom(page, category) {
  if (typeof page.evaluate !== "function") return { clicked: false };
  return page.evaluate((expected) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const roots = Array.from(document.querySelectorAll(".select-dialog, .select-option, .el-dialog, .el-popper, [role='listbox']"))
      .filter(visible);
    const searchRoots = roots.length ? roots : [document.body];
    const candidates = searchRoots.flatMap((root) => Array.from(root.querySelectorAll("li,div,span,p,button,[role='option'],[role='button']")))
      .filter((element, index, list) => list.indexOf(element) === index)
      .filter(visible)
      .map((element) => ({ element, text: clean(element.innerText || element.textContent || "") }))
      .filter((item) => item.text === expected || item.text.split(" ").includes(expected));
    const target = candidates[0]?.element;
    if (!target) return { clicked: false, candidateCount: candidates.length };
    target.scrollIntoView?.({ block: "center", inline: "center" });
    target.click();
    return { clicked: true, text: clean(target.innerText || target.textContent || "") };
  }, category);
}

async function selectSohuCreationStatement(page, creationStatement) {
  const value = sohuCreationStatementValue(creationStatement);
  const label = page.locator(`label.info-radio-label:has(input[value='${cssTextLiteral(value)}']), .info-radio:visible label:has(input[value='${cssTextLiteral(value)}']), .el-radio:has(input[value='${cssTextLiteral(value)}'])`).first();
  const visible = await label.isVisible?.().catch(() => true);
  if (visible) {
    const clicked = await withSohuActionTimeout(label.click({ force: true }).then(() => true), 3000, false).catch(() => false);
    if (clicked) return;
  }
  const inputClicked = await withSohuActionTimeout(
    page.locator(`label.info-radio-label input[value='${cssTextLiteral(value)}'], .info-radio input[value='${cssTextLiteral(value)}'], .el-radio input[value='${cssTextLiteral(value)}']`).first().click({ force: true }).then(() => true),
    3000,
    false
  ).catch(() => false);
  if (inputClicked) return;
  await clickSohuCreationStatementByDom(page, value).catch(() => undefined);
}

async function clickSohuCreationStatementByDom(page, value) {
  if (typeof page.evaluate !== "function") return false;
  return page.evaluate((expectedValue) => {
    const escapedValue = CSS.escape(String(expectedValue || ""));
    const input = document.querySelector(`label.info-radio-label input[value="${escapedValue}"]`)
      || document.querySelector(`.info-radio input[value="${escapedValue}"]`)
      || document.querySelector(`.el-radio input[value="${escapedValue}"]`)
      || Array.from(document.querySelectorAll("input[type='radio']")).find((element) => String(element.value) === String(expectedValue || ""));
    const target = input?.closest("label") || input;
    if (!target) return false;
    target.scrollIntoView?.({ block: "center", inline: "center" });
    target.click?.();
    input.checked = true;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, value);
}

async function configureSohuPublicationLegacy(page, input = {}, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 60000);
  const expectedInput = { ...input };
  if (input.coverImagePath) {
    await page.locator(".cover-button").first().click();
    await page.waitForTimeout?.(800).catch(() => undefined);
    let coverFileSet = await setSohuImageFileInput(page, input.coverImagePath, Math.min(timeoutMs, 5000));
    if (!coverFileSet) {
      const localUpload = page.locator(
        ".el-dialog:visible :text('本地上传'), .el-drawer:visible :text('本地上传'), :text('本地上传'), .local-upload, .upload-btn, .upload-button"
      ).last();
      await withSohuActionTimeout(localUpload.click?.(), Math.min(timeoutMs, 5000), undefined).catch(() => undefined);
      await page.waitForTimeout?.(500).catch(() => undefined);
      await page.locator(".el-dialog:visible input[type='file'], .el-drawer:visible input[type='file'], input[type='file']").last().setInputFiles(input.coverImagePath);
    }
    await clickSohuPositiveConfirm(page, timeoutMs);
  }
  if (input.category) {
    const selected = await selectSohuCategory(page, input.category);
    if (!selected) expectedInput.category = "";
  }
  if (input.creationStatement) {
    await selectSohuCreationStatement(page, input.creationStatement);
  }
  return waitForSohuPublicationConfig(page, expectedInput, Math.min(timeoutMs, 15000));
}

async function clickSohuCoverEntry(page, timeoutMs = 10000) {
  const selectors = [
    ".cover-button",
    ".cover-button:visible",
    ".upload-file.mp-upload:has-text('\u4e0a\u4f20\u56fe\u7247')",
    ".upload-tip:has-text('\u4e0a\u4f20\u56fe\u7247')",
  ];
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    for (const selector of selectors) {
      const entry = page.locator(selector).first();
      const visible = await entry.isVisible?.().catch(() => selector === ".cover-button");
      if (!visible) continue;
      await withSohuActionTimeout(entry.click?.({ force: true }) ?? Promise.resolve(), 5000, undefined).catch(() => undefined);
      return true;
    }
    if (typeof page.waitForTimeout === "function") await page.waitForTimeout(300);
    else await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

export async function configureSohuPublication(page, input = {}, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 60000);
  const expectedInput = { ...input };
  if (input.coverImagePath) {
    const uploadWatcher = watchSohuUploadBlockers(page);
    await options.onProgress?.({ type: "publish_progress", platform: "sohu", step: "cover_entry_open" });
    try {
      const opened = await clickSohuCoverEntry(page, Math.min(timeoutMs, 10000));
      if (!opened) throw new Error("SOHU_COVER_ENTRY_NOT_READY");
      await options.onProgress?.({ type: "publish_progress", platform: "sohu", step: "cover_entry_opened" });
      await page.waitForTimeout?.(800).catch(() => undefined);
      await options.onProgress?.({ type: "publish_progress", platform: "sohu", step: "cover_local_upload_tab" });
      const localUploadReady = await clickSohuLocalUploadTab(page, Math.min(timeoutMs, 10000));
      if (!localUploadReady && await hasSohuLocalUploadTab(page)) throw new Error("SOHU_COVER_LOCAL_UPLOAD_TAB_NOT_READY");
      await page.waitForTimeout?.(500).catch(() => undefined);
      const coverFileSet = await setSohuImageFileInput(page, input.coverImagePath, Math.min(timeoutMs, 15000));
      if (!coverFileSet) {
        const debug = await writeSohuCoverUploadDebugSnapshot(page, "file-input-not-ready").catch(() => ({}));
        await options.onProgress?.({ type: "publish_progress", platform: "sohu", step: "cover_file_input_not_ready", debug });
        throw new Error("SOHU_COVER_FILE_INPUT_NOT_READY");
      }
      await options.onProgress?.({ type: "publish_progress", platform: "sohu", step: "cover_file_selected" });
      const coverState = await confirmSohuCoverUpload(page, Math.min(timeoutMs, 30000), { ...options, uploadWatcher });
      if (coverState.coverSelected !== true) {
        const debug = await writeSohuCoverUploadDebugSnapshot(page, "not-confirmed").catch(() => ({}));
        await options.onProgress?.({
          type: "publish_progress",
          platform: "sohu",
          step: "cover_not_confirmed",
          debug,
          coverState,
        });
        throw new Error("SOHU_COVER_NOT_CONFIRMED");
      }
      if (uploadWatcher.state.blocker) {
        throw new Error("SOHU_MANUAL_ACTION_REQUIRED");
      }
      await options.onProgress?.({ type: "publish_progress", platform: "sohu", step: "cover_confirmed", ...coverState });
    } catch (error) {
      if (uploadWatcher.state.blocker || /SOHU_MANUAL_ACTION_REQUIRED/.test(String(error?.message || error))) {
        // A gate that is visible on the page can be cleared by a person, so wait
        // for it and retry the cover once before giving up. Response-only
        // blockers have nothing to click and keep failing fast.
        const gateInput = options.gateContext?.input;
        const gate = gateInput ? await readSohuVerificationGate(page) : "";
        if (gate && !options.coverGateRetried) {
          const settled = await settleSohuVerificationGate(page, gateInput, {
            startedAt: options.gateContext?.startedAt,
            stage: "cover_upload"
          });
          if (settled === "cleared" && !(await readSohuVerificationGate(page))) {
            uploadWatcher.state.blocker = "";
            return configureSohuPublication(page, input, { ...options, coverGateRetried: true });
          }
        }
        await options.onProgress?.({
          type: "manual_verification_required",
          platform: "sohu",
          step: "cover_upload_blocked",
          message: "Sohu cover upload triggered security verification. Complete the visible verification in the desktop browser, then retry publishing.",
          lastStatus: uploadWatcher.state.lastStatus,
        });
        throw new Error("SOHU_MANUAL_ACTION_REQUIRED");
      }
      throw error;
    } finally {
      uploadWatcher.dispose();
    }
  }
  if (input.category) {
    const selected = await selectSohuCategory(page, input.category);
    if (!selected) expectedInput.category = "";
  }
  if (input.creationStatement) {
    await selectSohuCreationStatement(page, input.creationStatement);
  }
  const config = await waitForSohuPublicationConfig(page, expectedInput, Math.min(timeoutMs, 15000));
  await options.onProgress?.({ type: "publish_progress", platform: "sohu", step: "publication_config_read", ...config });
  return config;
}

async function confirmSohuCoverUpload(page, timeoutMs = 30000, options = {}) {
  const startedAt = Date.now();
  let lastState = await readSohuPublicationConfig(page);
  while (Date.now() - startedAt < timeoutMs) {
    if (options.uploadWatcher?.state?.blocker) throw new Error(options.uploadWatcher.state.blocker);
    if (lastState.coverSelected === true) return lastState;
    const clicked = await clickSohuCoverUploadConfirm(page).catch((error) => ({ clicked: false, reason: String(error) }));
    await options.onProgress?.({
      type: "publish_progress",
      platform: "sohu",
      step: "cover_confirm_click",
      ...clicked,
    });
    if (!clicked?.clicked && !clicked?.pending) await clickSohuPositiveConfirm(page, 5000).catch(() => undefined);
    if (typeof page.waitForTimeout === "function") await page.waitForTimeout(800);
    else await new Promise((resolve) => setTimeout(resolve, 800));
    if (options.uploadWatcher?.state?.blocker) throw new Error(options.uploadWatcher.state.blocker);
    lastState = await readSohuPublicationConfig(page);
    await options.onProgress?.({
      type: "publish_progress",
      platform: "sohu",
      step: "cover_state_check",
      coverSelected: lastState.coverSelected === true,
    });
    if (lastState.coverSelected === true) return lastState;
  }
  return lastState;
}

async function clickSohuCoverUploadConfirm(page) {
  if (typeof page.evaluate !== "function") return { clicked: false };
  return page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const disabled = (element) => {
      const className = String(element.className || "");
      return Boolean(element.disabled)
        || element.getAttribute("aria-disabled") === "true"
        || /(^|[\s_-])(?:disabled?|disable-button|is-disabled)(?:[\s_-]|$)/i.test(className);
    };
    const dialogs = Array.from(document.querySelectorAll(".el-dialog, [role='dialog']")).filter(visible);
    const coverDialog = dialogs.find((dialog) => {
      const text = clean(dialog.innerText || dialog.textContent || "");
      return text.includes("封面图片") && text.includes("本地上传");
    }) || (clean(document.body?.innerText || "").includes("封面图片") && clean(document.body?.innerText || "").includes("本地上传") ? document.body : null);
    if (!coverDialog) return { clicked: false, reason: "dialog_not_found" };
    const boards = Array.from(coverDialog.querySelectorAll(".board, .upload-area, .local-upload, .el-dialog__body"))
      .filter(visible);
    const activeRoot = boards.find((root) => {
      const text = clean(root.innerText || root.textContent || "");
      return text.includes("已选择") || root.querySelector("img.upload-item, img[src*='res.mp.sohu.com'], input[type='file']");
    }) || coverDialog;
    const activeText = clean(activeRoot.innerText || activeRoot.textContent || "");
    if (activeText.includes("上传中") || activeText.includes("已选择0张")) {
      return { clicked: false, pending: true, reason: "upload_pending", text: activeText.slice(0, 500) };
    }
    const candidates = Array.from(activeRoot.querySelectorAll("p.positive-button, .positive-button, button, [role='button']"))
      .filter(visible)
      .filter((element) => !disabled(element))
      .filter((element) => /确定|确认|完成|使用/.test(clean(element.innerText || element.textContent || "")));
    const target = candidates[0];
    if (!target) return { clicked: false, reason: "confirm_not_found", text: clean(activeRoot.innerText || "").slice(0, 500) };
    target.scrollIntoView?.({ block: "center", inline: "center" });
    target.click();
    return { clicked: true, text: clean(target.innerText || target.textContent || ""), className: String(target.className || "") };
  });
}

async function ensureSohuPublicationConfig(page, input = {}, options = {}) {
  if (!input.coverImagePath && !input.category && !input.creationStatement) return {};
  const expectedStatementValue = input.creationStatement ? sohuCreationStatementValue(input.creationStatement) : "";
  const current = await readSohuPublicationConfig(page);
  const categoryOk = !input.category || current.selectedCategory === input.category;
  const statementOk = !input.creationStatement || current.creationStatementValue === expectedStatementValue;
  const coverOk = !input.coverImagePath || current.coverSelected === true;
  if (categoryOk && statementOk && coverOk) return current;
  return configureSohuPublication(page, input, options);
}

function hasSohuPublicationConfigInput(input = {}) {
  return Boolean(input.coverImagePath || input.category || input.creationStatement);
}

function buildSohuPublicationConfigEvidence(input = {}, config = {}) {
  return {
    coverExpected: Boolean(input.coverImagePath),
    coverSelected: config.coverSelected === true,
    selectedCategory: config.selectedCategory || "",
    creationStatementValue: config.creationStatementValue || "",
    creationStatementText: config.creationStatementText || "",
  };
}

function encodeEnvelope(payload) {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function escapeSohuHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function htmlToPlainText(html = "") {
  const text = String(html || "")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|figure|figcaption|blockquote|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r/g, "")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[\t ]{2,}/g, " ")
    .trim();
  return text;
}

function hasStructuredSohuHtml(html = "") {
  return /<\/?(?:p|section|figure|figcaption|img|h[1-6]|ul|ol|li|blockquote|br)\b/i.test(String(html || ""));
}

function selectSohuRichHtml(preferredHtml = "", fallbackHtml = "") {
  const preferred = String(preferredHtml || "").trim();
  if (hasStructuredSohuHtml(preferred)) return preferred;
  const fallback = String(fallbackHtml || "").trim();
  if (hasStructuredSohuHtml(fallback)) return fallback;
  return preferred || fallback;
}

function buildSohuBodyHtml(text = "", richHtml = "") {
  const suppliedHtml = String(richHtml || "").trim();
  if (hasStructuredSohuHtml(suppliedHtml)) return suppliedHtml;
  const paragraphs = String(text || "")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  return paragraphs.length
    ? paragraphs.map((paragraph) => `<p>${escapeSohuHtml(paragraph).replace(/\n/g, "<br>")}</p>`).join("")
    : "<p><br></p>";
}

function contentMarkers(value = "") {
  const text = String(value || "");
  const ascii = text.match(/[A-Za-z0-9][A-Za-z0-9_-]{5,}/g) || [];
  // Chinese content often has zero ASCII tokens; take meaningful CJK chunks too.
  const cjk = text.match(/[\u4e00-\u9fff]{4,16}/g) || [];
  return Array.from(new Set([...ascii, ...cjk]))
    .sort((a, b) => b.length - a.length)
    .slice(0, 8);
}

function normalizeComparableText(value = "") {
  return String(value || "")
    .replace(/[#>*_`~\-\[\]\(\)!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function editorTextLooksCommitted(snapshotText = "", content = "") {
  const text = normalizeComparableText(snapshotText);
  if (!text) return false;
  const expected = normalizeComparableText(content);
  if (!expected) return text.length >= 12;
  const head = expected.slice(0, 24);
  if (head && text.includes(head)) return true;
  const markers = contentMarkers(expected);
  if (markers.some((marker) => text.includes(marker))) return true;
  // Length-based fallback for pure Chinese after Quill rewrites structure.
  const minLen = Math.min(60, Math.max(16, Math.floor(expected.length / 8)));
  return text.length >= minLen;
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
  return !["搜狐号", "首页", "内容管理", "创作中心", "工作台", "消息", "搜狐号账号"].includes(name);
}

function hasValue(cookie = {}) {
  return typeof cookie.value === "string" && cookie.value.trim().length > 0;
}

function matchesAny(patterns = [], value = "") {
  const text = String(value || "");
  return patterns.some((pattern) => pattern.test(text));
}

export function normalizeSohuPublishInput(input = {}) {
  const title = cleanText(input.articleTitle || input.title);
  const content = String(input.contentMarkdown || input.content || input.body || input.markdown || "").trim();
  const summary = cleanText(input.summary || input.description || input.abstract || content.slice(0, 118));
  const platformImageTasks = Array.isArray(input.platformImageTasks) ? input.platformImageTasks : [];
  const contentBlocks = Array.isArray(input.contentBlocks) ? input.contentBlocks : [];
  const inlineImages = Array.isArray(input.inlineImages) ? input.inlineImages : [];
  const boundContentBlocks = bindContentBlocksToImages(contentBlocks, inlineImages);
  const fallbackRichHtml = boundContentBlocks.length ? composeRichArticleHtml(boundContentBlocks, { includeImages: platformImageTasks.length === 0 }) : "";
  const preferredRichHtml = platformImageTasks.length ? input.contentHtmlWithoutImages : input.contentHtml;
  if (!title) throw new Error("SOHU_TITLE_REQUIRED");
  // Sohu UI placeholder says 5-72 chars; keep a small safety margin.
  if (title.length > 72) throw new Error("SOHU_TITLE_TOO_LONG");
  if (!content) throw new Error("SOHU_CONTENT_REQUIRED");
  return {
    title: title.slice(0, 72),
    content,
    richHtml: selectSohuRichHtml(preferredRichHtml, fallbackRichHtml),
    platformImageTasks,
    contentBlocks,
    coverImagePath: cleanText(input.coverImagePath || input.coverPath),
    category: cleanText(input.category || input.articleProperty),
    creationStatement: cleanText(input.creationStatement || input.declaration),
    summary: summary.slice(0, 120),
    confirmPublish: input.confirmPublish === true || input.publishMode === "publish",
    draftTimeoutMs: Number(input.draftTimeoutMs || 30000),
    publishTimeoutMs: Number(input.publishTimeoutMs || 45000)
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

function findSohuNewsId(value) {
  if (!value || typeof value !== "object") return "";
  const direct = value.newsId || value.news_id || value.id || value.contentId || value.articleId;
  if (direct) return String(direct);
  if ((typeof value.data === "string" || typeof value.data === "number") && String(value.data).trim()) {
    return String(value.data);
  }
  for (const item of Object.values(value)) {
    if (item && typeof item === "object") {
      const nested = findSohuNewsId(item);
      if (nested) return nested;
    }
  }
  return "";
}

function sohuDraftUrlFromNewsId(newsId = "") {
  return newsId
    ? `${SOHU_EDITOR_URL}&newsId=${encodeURIComponent(newsId)}`
    : "";
}

function normalizeSohuPublishedUrl(url = "") {
  try {
    const parsed = new URL(String(url || ""), SOHU_ORIGIN);
    if (!/(^|\.)sohu\.com$/i.test(parsed.hostname)) return "";
    if (/\/a\/\d+_/i.test(parsed.pathname)) return parsed.toString().replace(/^http:/, "https:");
    if (/\/mp\/\d+/i.test(parsed.pathname)) return parsed.toString().replace(/^http:/, "https:");
  } catch {
    return "";
  }
  return "";
}

function sohuPublishedUrlFromApiPayload(payload) {
  if (!payload || typeof payload !== "object") return "";
  const direct = payload.url || payload.href || payload.link || payload.newsUrl || payload.articleUrl;
  const normalized = normalizeSohuPublishedUrl(direct);
  if (normalized) return normalized;
  for (const item of Object.values(payload)) {
    if (item && typeof item === "object") {
      const nested = sohuPublishedUrlFromApiPayload(item);
      if (nested) return nested;
    }
  }
  return "";
}

function publishApiHasManualBlocker(payload) {
  if (!payload || typeof payload !== "object") return false;
  const text = JSON.stringify(payload);
  return /3003|captcha|verify|risk|security|manual|sensitive|original|\u9a8c\u8bc1|\u98ce\u63a7|\u5b89\u5168|\u4eba\u5de5|\u654f\u611f|\u539f\u521b|\u4e0a\u9650/.test(text);
}

function sohuPublishPayloadAccepted(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.success === true) return true;
  const code = String(payload.code ?? payload.errno ?? "");
  if (["200", "2000000"].includes(code)) {
    const data = payload.data;
    return typeof data === "string" || typeof data === "number" || Boolean(data?.newsId || data?.news_id);
  }
  return false;
}

function shouldPublishSohuViaApi(input = {}, publishInput = {}) {
  if (!publishInput.confirmPublish) return false;
  const config = input.platformConfig && typeof input.platformConfig === "object" ? input.platformConfig : {};
  return Boolean(input.apiFirst === true || config.accountId);
}

function sohuApiConfig(input = {}) {
  const config = input.platformConfig && typeof input.platformConfig === "object" ? input.platformConfig : {};
  const accountId = cleanText(config.accountId || config.sohuAccountId || config.authorId);
  if (!accountId) throw new Error("SOHU_API_ACCOUNT_ID_REQUIRED");
  return {
    accountId,
    channelId: config.channelId ?? config.channel,
    categoryId: config.categoryId ?? config.category,
    declaration: cleanText(config.declaration || config.creationStatement || ""),
  };
}

function buildSohuApiPublishPayload(publishInput = {}, config = {}) {
  const content = buildSohuBodyHtml(publishInput.content, publishInput.richHtml);
  const payload = {
    accountId: config.accountId,
    id: "",
    title: publishInput.title,
    content,
    brief: publishInput.summary,
    cover: publishInput.coverImageUrl || "",
    attrIds: [],
    columnNewsIds: [],
    customTags: [],
    topicIds: [],
    userLabels: [],
    businessCode: "news",
    categoryId: config.categoryId ?? "",
    channelId: config.channelId ?? "",
    declareOriginal: Boolean(publishInput.creationStatement || config.declaration),
    infoResource: publishInput.creationStatement || config.declaration || "",
    isAd: false,
    reprint: false,
    sourceUrl: "",
    userColumnId: "",
    visibleToLoginedUsers: false,
  };
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => (
    value !== "" && value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)
  )));
}

function sohuApiErrorIsTerminal(error) {
  const message = String(error?.message || error || "");
  return /LOGIN_REQUIRED|MANUAL_ACTION_REQUIRED|VERIFICATION_REQUIRED|ACCOUNT_ID_REQUIRED|AUTH|CAPTCHA|RISK|SECURITY|VERIFY/i.test(message);
}

async function publishSohuViaApi(page, input = {}, publishInput = {}) {
  const config = sohuApiConfig(input);
  const request = async (url, options, stage) => {
    const result = await platformApiFetch(page, url, options);
    if ([401, 403].includes(result.status)) throw new Error("SOHU_LOGIN_REQUIRED");
    if (publishApiHasManualBlocker(result.payload)) throw new Error("SOHU_MANUAL_ACTION_REQUIRED");
    if (!result.ok || !sohuPublishPayloadAccepted(result.payload)) throw new Error(`SOHU_API_${stage}_NOT_ACCEPTED`);
    return result;
  };
  const draft = await request(`${SOHU_ORIGIN}/mpbp/bp/news/v4/news/draft/v2?accountId=${encodeURIComponent(config.accountId)}`, {
    method: "POST",
    json: buildSohuApiPublishPayload(publishInput, config),
    headers: {
      Referer: SOHU_EDITOR_URL,
    },
  }, "draft");
  const newsId = findSohuNewsId(draft.payload);
  if (!newsId) throw new Error("SOHU_API_DRAFT_ID_REQUIRED");
  const { limit, publish } = await publishSohuDraftViaApi(page, config.accountId, newsId);
  const accepted = true;
  const reviewUrl = sohuDraftUrlFromNewsId(newsId);
  return {
    draftUrl: reviewUrl,
    publishedUrl: "",
    reviewUrl,
    platformStatus: "submitted_for_review",
    publiclyVisible: false,
    reviewStatus: "pending_public_visibility",
    title: publishInput.title,
    externalIds: {
      newsId,
    },
    publicationEvidence: {
      source: "api",
      accepted,
      httpStatus: publish.status,
      endpoint: publish.evidence.request.url,
      response: publish.evidence.response.payload,
      stages: [
        { stage: "draft", httpStatus: draft.status },
        { stage: "publish_limit", httpStatus: limit?.status ?? 0 },
        { stage: "publish", httpStatus: publish.status },
      ],
    },
    message: "Sohu accepted the API publish request; public URL still requires management/public-page verification.",
  };
}

function sohuPublishApiAction(url) {
  const match = String(url || "").match(/\/mpbp\/bp\/news\/v4\/news\/(?:\d+\/)?(draft|publish|schedulePublish|publishDirect|publishLimit)(?:\/v2)?(?:[?#]|$)/i);
  return match ? String(match[1] || "").toLowerCase() : "";
}

async function publishSohuDraftViaApi(page, accountId, newsId) {
  const id = String(accountId || "").trim();
  const draftId = String(newsId || "").trim();
  if (!id) throw new Error("SOHU_API_ACCOUNT_ID_REQUIRED");
  if (!draftId) throw new Error("SOHU_API_DRAFT_ID_REQUIRED");
  const encodedAccountId = encodeURIComponent(id);
  const publishStage = async (url, options, stage) => {
    const result = await platformApiFetch(page, url, options);
    if ([401, 403].includes(result.status)) throw new Error("SOHU_LOGIN_REQUIRED");
    if (publishApiHasManualBlocker(result.payload)) throw new Error("SOHU_MANUAL_ACTION_REQUIRED");
    if (!result.ok || !sohuPublishPayloadAccepted(result.payload)) throw new Error(`SOHU_API_${stage}_NOT_ACCEPTED`);
    return result;
  };
  // The console reads the remaining quota before arming the publish button.
  // Treat it as advisory: only the direct publish call decides the outcome.
  const limit = await platformApiFetch(page, `${SOHU_ORIGIN}/mpbp/bp/news/v4/news/publishLimit?accountId=${encodedAccountId}&type=news`, {
    method: "GET",
    headers: { Referer: SOHU_EDITOR_URL },
  }).catch(() => null);
  if (limit && [401, 403].includes(limit.status)) throw new Error("SOHU_LOGIN_REQUIRED");
  if (limit && publishApiHasManualBlocker(limit.payload)) throw new Error("SOHU_MANUAL_ACTION_REQUIRED");
  const publish = await publishStage(`${SOHU_ORIGIN}/mpbp/bp/news/v4/news/${encodeURIComponent(draftId)}/publishDirect?accountId=${encodedAccountId}`, {
    method: "POST",
    form: { accountId: id },
    headers: { Referer: SOHU_EDITOR_URL },
  }, "publish");
  return { limit, publish };
}

function watchSohuPublishApiResponses(page) {
  // Matches the editor's real submission chain: draft/v2 plus every publish
  // flavour the console uses (publish/v2, schedulePublish/v2, publishDirect).
  const state = { draftUrl: "", newsId: "", accountId: "", publishedUrl: "", blocker: "", publishAttempted: false, publishAccepted: false, lastPublishPayload: null };
  const handler = async (response) => {
    const url = typeof response.url === "function" ? response.url() : "";
    const action = sohuPublishApiAction(url);
    if (!action) return;
    const accountIdMatch = url.match(/[?&]accountId=([^&#]+)/i);
    if (accountIdMatch) state.accountId = decodeURIComponent(accountIdMatch[1]);
    const text = await response.text().catch(() => "");
    const payload = parseJsonLikePayload(text);
    if (action !== "draft") {
      state.publishAttempted = true;
      state.lastPublishPayload = payload;
      if (sohuPublishPayloadAccepted(payload)) state.publishAccepted = true;
    }
    const newsId = findSohuNewsId(payload);
    if (newsId) {
      state.newsId = newsId;
      state.draftUrl = sohuDraftUrlFromNewsId(newsId);
    }
    const publishedUrl = sohuPublishedUrlFromApiPayload(payload);
    if (publishedUrl) state.publishedUrl = publishedUrl;
    if (publishApiHasManualBlocker(payload)) state.blocker = "SOHU_MANUAL_ACTION_REQUIRED";
  };
  if (typeof page.on === "function") page.on("response", handler);
  return {
    state,
    dispose() {
      if (typeof page.off === "function") page.off("response", handler);
    }
  };
}

function watchSohuUploadBlockers(page) {
  const state = { blocker: "", lastUrl: "", lastStatus: 0 };
  const handler = async (response) => {
    const url = typeof response.url === "function" ? response.url() : "";
    const status = typeof response.status === "function" ? response.status() : 0;
    if (/turing\.captcha\.qcloud\.com|cap_union/i.test(url) || (/\/outerUpload\/image\/file/i.test(url) && status === 202)) {
      state.blocker = "SOHU_MANUAL_ACTION_REQUIRED";
      state.lastUrl = url;
      state.lastStatus = status;
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

async function waitForSohuDraftUrl(page, publishState, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (publishState?.draftUrl) return publishState.draftUrl;
    if (typeof page.waitForTimeout === "function") await page.waitForTimeout(250).catch(() => undefined);
    else await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return publishState?.draftUrl || "";
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

async function fillSohuTitle(page, title) {
  if (typeof page.evaluate === "function") {
    const filled = await page.evaluate((value) => {
      const visible = (element) => {
        if (!element) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const looksLikeTitle = (element) => {
        const text = `${element.getAttribute("name") || ""} ${element.getAttribute("placeholder") || ""} ${element.getAttribute("class") || ""} ${element.getAttribute("data-field") || ""}`.toLowerCase();
        return /title/.test(text) || text.includes("标题") || text.includes("请输入标题");
      };
      const candidates = Array.from(document.querySelectorAll("textarea, input, [contenteditable='true']"))
        .filter((element) => visible(element) && !element.disabled && !element.readOnly)
        .filter((element) => !element.classList?.contains("ql-editor"))
        .filter(looksLikeTitle);
      const target = candidates[0];
      if (!target) return { ok: false, reason: "visible_title_missing" };
      target.scrollIntoView?.({ block: "center", inline: "center" });
      target.focus?.();
      if ("value" in target) {
        const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(target, String(value || ""));
        else target.value = String(value || "");
      } else {
        target.textContent = String(value || "");
      }
      target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(value || "") }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      target.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Process" }));
      return { ok: true, value: target.value || target.textContent || "" };
    }, title).catch(() => ({ ok: false, reason: "evaluate_error" }));
    if (filled?.ok) return filled;
  }
  return fillFirstLocator(
    page,
    "textarea[name='title'], input[name='title'], textarea[placeholder*='title' i], input[placeholder*='title' i], textarea[placeholder*='\u6807\u9898'], input[placeholder*='\u6807\u9898'], [contenteditable='true'][data-field='title'], [contenteditable='true'][placeholder*='\u6807\u9898']",
    title,
    "SOHU_TITLE_FIELD_NOT_FOUND"
  );
}

function pickMainSohuEditorSelector() {
  // Prefer the main article Quill, not side AI assistant / tiny widgets.
  return ".article-editor .ql-editor, .news-editor .ql-editor, .content-editor .ql-editor, .editor-box .ql-editor, .ql-editor[contenteditable='true'], .ql-editor";
}

export async function fillSohuBody(page, content, richHtml = "") {
  const selector = pickMainSohuEditorSelector();
  const locator = page.locator(`${selector}:visible`).first();
  try {
    await locator.waitFor?.({ state: "visible", timeout: 10000 }).catch(() => undefined);
    await locator.scrollIntoViewIfNeeded?.().catch(() => undefined);
    await locator.click?.({ timeout: 5000 }).catch(() => undefined);
    const html = buildSohuBodyHtml(content, richHtml);
    const plainText = htmlToPlainText(html) || cleanText(content);
    let lastSync = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      lastSync = await syncSohuQuillContent(page, plainText, html);
      if (lastSync?.ok && editorTextLooksCommitted(lastSync.text || "", plainText)) break;
      // Fallback: paste / type after failed Quill sync.
      await page.keyboard?.press?.("Control+A").catch(() => undefined);
      await page.keyboard?.press?.("Backspace").catch(() => undefined);
      const pasted = await pasteRichHtml(locator, html, plainText);
      if (!pasted) {
        await locator.fill?.(plainText).catch(() => undefined);
        // Playwright type is slower but often commits into Quill bindings.
        if (typeof locator.pressSequentially === "function") {
          await locator.pressSequentially(plainText.slice(0, 1200), { delay: 2 }).catch(() => undefined);
        } else if (page.keyboard?.type) {
          await page.keyboard.type(plainText.slice(0, 1200), { delay: 2 }).catch(() => undefined);
        }
        await locator.dispatchEvent?.("input").catch(() => undefined);
        await locator.dispatchEvent?.("change").catch(() => undefined);
      }
      const ready = await waitForSohuEditorContent(page, plainText, 4500);
      if (ready) break;
      if (attempt === 3 && String(richHtml || "").trim() && !lastSync?.ok) {
        throw new Error("SOHU_RICH_BODY_NOT_COMMITTED");
      }
      await page.waitForTimeout?.(400).catch(() => undefined);
    }
    await ensureSohuEditorContent(page, plainText, "SOHU_BODY_NOT_COMMITTED");
    return locator;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Keep original commit errors readable for the UI.
    if (/SOHU_BODY_NOT_COMMITTED|SOHU_RICH_BODY/.test(message)) {
      throw new Error(`SOHU_BODY_FIELD_NOT_FOUND: ${message}`);
    }
    throw new Error(`SOHU_BODY_FIELD_NOT_FOUND: ${message}`);
  }
}

export function writeSohuEditorContentInPage(payload) {
  const visible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const scoreEditor = (element) => {
    const rect = element.getBoundingClientRect();
    const area = Math.max(0, rect.width) * Math.max(0, rect.height);
    const inAside = Boolean(element.closest("aside, .ai-panel, .creation-assistant, .helper, .right-panel, .side-panel"));
    const inMain = Boolean(element.closest("main, .article-editor, .news-editor, .content-editor, .editor-box, .editor-container, .main-content"));
    return area + (inMain ? 50000 : 0) - (inAside ? 100000 : 0);
  };
  const editorCandidates = Array.from(document.querySelectorAll(".ql-editor[contenteditable='true'], .ql-editor"))
    .filter(visible)
    .sort((a, b) => scoreEditor(b) - scoreEditor(a));
  const editor = editorCandidates[0];
  const text = String(payload?.text || "");
  const html = String(payload?.html || "");
  if (!editor) return { ok: false, method: "missing_editor", editorCount: 0 };

  editor.scrollIntoView?.({ block: "center", inline: "nearest" });
  editor.focus?.();

  let quill = editor.__quill
    || editor.closest?.(".ql-container")?.__quill
    || editor.parentElement?.__quill
    || null;
  let quillMethod = "quill_html";
  if (!quill) {
    let ancestor = editor.parentElement;
    for (let depth = 0; ancestor && depth < 12; depth += 1, ancestor = ancestor.parentElement) {
      if (ancestor.__vue__?.quill) {
        quill = ancestor.__vue__.quill;
        quillMethod = "vue_quill_html";
        break;
      }
    }
  }
  if (!quill && globalThis.window?.Quill && typeof globalThis.window.Quill.find === "function") {
    quill = globalThis.window.Quill.find(editor);
  }

  const readBack = () => {
    const quillText = typeof quill?.getText === "function" ? quill.getText() : "";
    return {
      text: String(quillText || editor.innerText || editor.textContent || "").replace(/\s+/g, " ").trim(),
      htmlLength: editor.innerHTML?.length || 0,
      imageCount: editor.querySelectorAll?.("img")?.length || 0,
    };
  };
  const dispatch = (type, options = {}) => {
    try {
      const EventType = type === "input"
        ? globalThis.InputEvent
        : type === "keyup"
          ? globalThis.KeyboardEvent
          : globalThis.Event;
      if (typeof EventType === "function") editor.dispatchEvent(new EventType(type, { bubbles: true, ...options }));
    } catch {
      // Quill's user-source update is authoritative; DOM events are compatibility signals only.
    }
  };
  const fire = ({ preserveHtml = false } = {}) => {
    editor.classList?.remove?.("ql-blank");
    if (preserveHtml) {
      dispatch("input");
    } else {
      dispatch("input", { inputType: "insertFromPaste", data: text });
    }
    dispatch("change");
    dispatch("keyup", { key: "Process" });
    dispatch("blur");
    dispatch("focus");
  };

  if (quill?.clipboard?.dangerouslyPasteHTML) {
    try {
      quill.setText?.("", "silent");
      try {
        quill.clipboard.dangerouslyPasteHTML(0, html || `<p>${text}</p>`, "user");
      } catch {
        quill.clipboard.dangerouslyPasteHTML(html || `<p>${text}</p>`, "user");
      }
      quill.update?.("user");
      const length = typeof quill.getLength === "function" ? Math.max(0, quill.getLength() - 1) : 0;
      quill.setSelection?.(length, 0, "silent");
      fire({ preserveHtml: true });
      const snap = readBack();
      return { ok: snap.text.length > 0, method: quillMethod, ...snap };
    } catch {
      // Fall through to a DOM write only when the platform Quill API rejects the payload.
    }
  }

  if (html) {
    editor.innerHTML = html;
    fire({ preserveHtml: true });
    quill?.update?.("user");
    const snap = readBack();
    return { ok: snap.text.length > 0, method: "dom_html", ...snap };
  }
  if (quill?.setText) {
    quill.setText(text, "user");
    quill.update?.("user");
    fire();
    const snap = readBack();
    return { ok: snap.text.length > 0, method: "quill_text", ...snap };
  }
  editor.innerHTML = text.split(/\n{2,}/).map((paragraph) => `<p>${paragraph}</p>`).join("") || "<p><br></p>";
  fire();
  const snap = readBack();
  return { ok: snap.text.length > 0, method: "dom_text", ...snap };
}

async function syncSohuQuillContent(page, text, html = "") {
  if (typeof page.evaluate !== "function") return { ok: false, method: "unavailable" };
  return page.evaluate(writeSohuEditorContentInPage, { text, html })
    .catch(() => ({ ok: false, method: "evaluate_error" }));
}
async function waitForSohuEditorContent(page, content, timeoutMs = 3000) {
  if (typeof page.waitForFunction !== "function") return false;
  const expected = normalizeComparableText(content);
  const markers = contentMarkers(expected);
  const minLen = Math.min(60, Math.max(16, Math.floor(expected.length / 8)));
  return page.waitForFunction((payload) => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const scoreEditor = (element) => {
      const rect = element.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      const inAside = Boolean(element.closest("aside, .ai-panel, .creation-assistant, .helper, .right-panel, .side-panel"));
      const inMain = Boolean(element.closest("main, .article-editor, .news-editor, .content-editor, .editor-box, .editor-container, .main-content"));
      return area + (inMain ? 50000 : 0) - (inAside ? 100000 : 0);
    };
    const editorCandidates = Array.from(document.querySelectorAll(".ql-editor[contenteditable='true'], .ql-editor"))
      .filter(visible)
      .sort((a, b) => scoreEditor(b) - scoreEditor(a));
    const editor = editorCandidates[0];
    const text = String(editor?.innerText || editor?.textContent || "").replace(/[#>*_`~\-\[\]\(\)!]/g, " ").replace(/\s+/g, " ").trim();
    if (!text.length) return false;
    if (payload.expected && text.includes(payload.expected.slice(0, 24))) return true;
    if (payload.markers.some((marker) => text.includes(marker))) return true;
    return text.length >= payload.minLen;
  }, { expected, markers, minLen }, { timeout: timeoutMs }).then(() => true).catch(() => false);
}

export async function readSohuEditorSnapshot(page) {
  if (typeof page.evaluate !== "function") return {};
  const result = await page.evaluate(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const scoreEditor = (element) => {
      const rect = element.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      const inAside = Boolean(element.closest("aside, .ai-panel, .creation-assistant, .helper, .right-panel, .side-panel"));
      const inMain = Boolean(element.closest("main, .article-editor, .news-editor, .content-editor, .editor-box, .editor-container, .main-content"));
      return area + (inMain ? 50000 : 0) - (inAside ? 100000 : 0);
    };
    const editorCandidates = Array.from(document.querySelectorAll(".ql-editor[contenteditable='true'], .ql-editor"))
      .filter(visible)
      .sort((a, b) => scoreEditor(b) - scoreEditor(a));
    const editor = editorCandidates[0];
    const images = editor ? [...editor.querySelectorAll("img")].map((image) => ({
      src: image.currentSrc || image.src || image.getAttribute("src") || "",
      loaded: image instanceof HTMLImageElement ? image.naturalWidth > 0 || image.complete : true,
    })) : [];
    return {
      text: String(editor?.innerText || editor?.textContent || "").replace(/\s+/g, " ").trim(),
      htmlLength: editor?.innerHTML?.length || 0,
      editorCount: editorCandidates.length,
      visibleEditorCount: editorCandidates.length,
      imageCount: images.filter((image) => /^(?:https?:)?\/\//i.test(image.src)).length,
      loadedImageCount: images.filter((image) => /^(?:https?:)?\/\//i.test(image.src) && image.loaded !== false).length,
    };
  }).catch(() => ({}));
  if (result && typeof result === "object") return result;
  return { text: cleanText(result), htmlLength: String(result || "").length, imageCount: 0, mockEvaluation: true };
}

async function ensureSohuEditorContent(page, content, errorCode = "SOHU_BODY_NOT_READY") {
  const snapshot = await readSohuEditorSnapshot(page);
  if (snapshot.mockEvaluation) return snapshot;
  if (editorTextLooksCommitted(snapshot.text || "", content)) return snapshot;
  throw new Error(errorCode);
}

async function ensureSohuEditorReadyToSave(page, publishInput, uploadedImages = []) {
  const expectedText = htmlToPlainText(publishInput.richHtml || "") || publishInput.content;
  const snapshot = await ensureSohuEditorContent(page, expectedText, "SOHU_BODY_NOT_COMMITTED");
  if (snapshot.mockEvaluation) return snapshot;
  if (publishInput.platformImageTasks.length && snapshot.imageCount < publishInput.platformImageTasks.length) {
    throw new Error("SOHU_INLINE_IMAGES_NOT_COMMITTED");
  }
  if (uploadedImages.length && snapshot.imageCount < uploadedImages.length) {
    throw new Error("SOHU_INLINE_IMAGES_NOT_COMMITTED");
  }
  return snapshot;
}

function buildSohuUploadedImageHtml(publishInput, uploadedImages = []) {
  if (!uploadedImages.length) return "";
  const images = uploadedImages.map((image, index) => ({
    assetId: image.assetId || publishInput.platformImageTasks[index]?.assetId || "",
    sectionId: image.sectionId || publishInput.platformImageTasks[index]?.sectionId || "",
    url: image.platformImageUrl || image.url || image.src || "",
    altText: publishInput.platformImageTasks[index]?.altText || image.altText || "文章插图",
  })).filter((image) => /^https?:\/\//i.test(image.url));
  if (!images.length) return "";
  if (publishInput.contentBlocks.length) {
    const blocks = bindContentBlocksToImages(publishInput.contentBlocks, images);
    return composeRichArticleHtml(blocks, { includeImages: true });
  }
  const bodyHtml = buildSohuBodyHtml(publishInput.content, publishInput.richHtml);
  const figures = images.map((image) => (
    `<figure style="margin: 24px 0; text-align: center;"><img src="${escapeSohuHtml(image.url)}" alt="${escapeSohuHtml(image.altText)}" style="display: block; max-width: 100%; height: auto; margin: 0 auto;"></figure>`
  )).join("");
  return `${bodyHtml}${figures}`;
}

async function pasteSohuCompleteArticleHtml(page, content, html) {
  const normalizedHtml = buildSohuBodyHtml(content, html);
  const plainText = htmlToPlainText(normalizedHtml) || cleanText(content);
  const locator = page.locator(".ql-editor[contenteditable='true']:visible, .ql-editor:visible").first();
  await locator.click?.().catch(() => undefined);
  await page.keyboard?.press?.("Control+A").catch(() => undefined);
  await page.keyboard?.press?.("Backspace").catch(() => undefined);
  const pasted = await pasteRichHtml(locator, normalizedHtml, plainText);
  if (!pasted) return false;
  const ready = await waitForSohuEditorContent(page, plainText, 5000);
  if (!ready) return false;
  await commitSohuCurrentEditorHtml(page);
  return true;
}
async function waitForStableSohuEditorImages(page, publishInput, uploadedImages = [], options = {}) {
  const expectedCount = Math.max(publishInput.platformImageTasks.length || 0, uploadedImages.length || 0);
  const timeoutMs = Number(options.timeoutMs || 12000);
  const pollMs = Number(options.pollMs || 800);
  const requiredStableReads = Number(options.requiredStableReads || 3);
  const initialSettleMs = Number(options.initialSettleMs ?? 1000);
  const maxRewriteAttempts = Number(options.maxRewriteAttempts ?? 3);
  const completeHtml = String(options.completeHtml || "");
  const plainText = String(options.plainText || htmlToPlainText(completeHtml) || publishInput.content || "");
  if (!expectedCount) return ensureSohuEditorReadyToSave(page, publishInput, uploadedImages);

  if (initialSettleMs > 0) {
    if (typeof page.waitForTimeout === "function") await page.waitForTimeout(initialSettleMs).catch(() => undefined);
    else await new Promise((resolve) => setTimeout(resolve, initialSettleMs));
  }
  const startedAt = Date.now();
  let stableReads = 0;
  let rewriteAttempts = 0;
  let lastSnapshot = {};
  let lastError;
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      lastSnapshot = await ensureSohuEditorReadyToSave(page, publishInput, uploadedImages);
      lastError = undefined;
    } catch (error) {
      lastError = error;
      lastSnapshot = await readSohuEditorSnapshot(page);
      stableReads = 0;
      const missingImages = Number(lastSnapshot.imageCount || 0) < expectedCount;
      if (completeHtml && missingImages && rewriteAttempts < maxRewriteAttempts) {
        rewriteAttempts += 1;
        const rewriteResult = await syncSohuQuillContent(page, plainText, completeHtml);
        await options.onProgress?.({
          type: "sohu_inline_images_rewritten",
          attempt: rewriteAttempts,
          expectedCount,
          imageCount: Number(rewriteResult?.imageCount || 0),
          ok: Boolean(rewriteResult?.ok),
        });
      }
      if (typeof page.waitForTimeout === "function") await page.waitForTimeout(pollMs).catch(() => undefined);
      else await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    if ((lastSnapshot.imageCount || 0) >= expectedCount && (lastSnapshot.loadedImageCount || 0) >= expectedCount) {
      stableReads += 1;
      if (stableReads >= requiredStableReads) return lastSnapshot;
    } else {
      stableReads = 0;
    }
    if (typeof page.waitForTimeout === "function") await page.waitForTimeout(pollMs).catch(() => undefined);
    else await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  if (lastSnapshot.imageCount >= expectedCount) return lastSnapshot;
  if (lastError) throw lastError;
  return ensureSohuEditorReadyToSave(page, publishInput, uploadedImages);
}
export async function commitSohuUploadedImagesToEditor(page, publishInput, uploadedImages = [], options = {}) {
  if (!uploadedImages.length) return { committed: false, imageCount: 0, loadedImageCount: 0 };
  const completeHtml = buildSohuUploadedImageHtml(publishInput, uploadedImages);
  if (!completeHtml) throw new Error("SOHU_INLINE_IMAGES_COMPOSE_FAILED");
  const plainText = htmlToPlainText(completeHtml) || publishInput.content;
  const syncResult = await syncSohuQuillContent(page, plainText, completeHtml);
  const expectedCount = publishInput.platformImageTasks.length || uploadedImages.length;
  if (!syncResult?.ok || Number(syncResult.imageCount || 0) < expectedCount) {
    throw new Error("SOHU_INLINE_IMAGES_NOT_COMMITTED");
  }
  const stableSnapshot = await waitForStableSohuEditorImages(page, publishInput, uploadedImages, {
    ...options,
    completeHtml,
    plainText,
  });
  return {
    ...syncResult,
    ...stableSnapshot,
    committed: true,
    richHtmlLength: completeHtml.length,
  };
}
async function reconcileSohuUploadedImages(page, tasks = [], uploadedImages = []) {
  const uploads = uploadedImages
    .map((image, index) => ({
      ...image,
      sectionTitle: String(tasks[index]?.sectionTitle || ""),
      altText: String(tasks[index]?.altText || "文章插图"),
    }))
    .filter((image) => /^https?:\/\//i.test(String(image.platformImageUrl || "")));
  if (!uploads.length || typeof page.evaluate !== "function") return { inserted: 0, expectedCount: uploads.length };
  return page.evaluate((payload) => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const editorCandidates = Array.from(document.querySelectorAll(".ql-editor[contenteditable='true'], .ql-editor"));
    const editor = editorCandidates.find(visible) || editorCandidates[0];
    if (!editor) return { inserted: 0, expectedCount: payload.uploads.length, error: "missing_editor" };
    const currentUrls = new Set(Array.from(editor.querySelectorAll("img")).map((image) => image.currentSrc || image.src || image.getAttribute("src") || ""));
    let inserted = 0;
    for (const upload of payload.uploads) {
      const source = String(upload.platformImageUrl || "");
      if (!source || currentUrls.has(source)) continue;
      const paragraph = document.createElement("p");
      const image = document.createElement("img");
      image.src = source;
      image.alt = String(upload.altText || "文章插图");
      paragraph.appendChild(image);
      const sectionTitle = clean(upload.sectionTitle);
      const candidates = Array.from(editor.querySelectorAll("h1,h2,h3,h4,p,div"));
      const anchor = sectionTitle
        ? candidates.find((element) => clean(element.textContent) === sectionTitle || clean(element.textContent).includes(sectionTitle))
        : null;
      const target = anchor || editor.lastElementChild || editor;
      if (target === editor) editor.appendChild(paragraph);
      else target.insertAdjacentElement("afterend", paragraph);
      currentUrls.add(source);
      inserted += 1;
    }
    if (inserted) {
      editor.classList?.remove?.("ql-blank");
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertHTML", data: "" }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
      editor.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Process" }));
    }
    return {
      inserted,
      expectedCount: payload.uploads.length,
      imageCount: editor.querySelectorAll("img").length,
      text: clean(editor.innerText || editor.textContent).slice(0, 500),
    };
  }, { uploads }).catch((error) => ({ inserted: 0, expectedCount: uploads.length, error: String(error?.message || error) }));
}

async function commitSohuCurrentEditorHtml(page) {
  if (typeof page.evaluate !== "function") return false;
  return page.evaluate(() => {
    const editor = document.querySelector(".ql-editor[contenteditable='true'], .ql-editor");
    if (!editor) return false;
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: editor.innerText || "" }));
    editor.dispatchEvent(new Event("change", { bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Process" }));
    return true;
  }).catch(() => false);
}

async function fillSohuAbstract(page, summary) {
  if (!summary) return null;
  const locator = page.locator("textarea.abstract-main-textarea, textarea[placeholder*='\\u6458\\u8981']").first();
  try {
    await locator.scrollIntoViewIfNeeded?.().catch(() => undefined);
    await locator.click?.().catch(() => undefined);
    await locator.fill(summary);
    await locator.dispatchEvent?.("input").catch(() => undefined);
    await locator.dispatchEvent?.("change").catch(() => undefined);
    return locator;
  } catch {
    return null;
  }
}

async function waitForSohuEditorReady(page, timeoutMs = 30000) {
  if (typeof page.waitForFunction !== "function") return;
  await page.waitForFunction(() => {
    const url = window.location.href || "";
    const hasTitle = Boolean(document.querySelector("input[placeholder*='标题'], textarea[placeholder*='标题'], input[placeholder*='title' i], textarea[placeholder*='title' i]"));
    const hasBody = Boolean(document.querySelector(".ql-editor, [contenteditable='true']"));
    return /contentManagement\/news\/addarticle/i.test(url) && (hasTitle || hasBody);
  }, null, { timeout: timeoutMs }).catch(() => undefined);
}

async function isSohuEditorMounted(page) {
  const title = page.locator("textarea[name='title'], input[name='title'], textarea[placeholder*='\u6807\u9898'], input[placeholder*='\u6807\u9898']").first();
  const body = page.locator(".ql-editor[contenteditable='true'], .ql-editor").first();
  const [titleVisible, bodyVisible] = await Promise.all([
    title.isVisible?.().catch(() => false),
    body.isVisible?.().catch(() => false),
  ]);
  return Boolean(titleVisible || bodyVisible);
}

async function ensureSohuEditorPage(page, timeoutMs = 30000) {
  await waitForSohuEditorReady(page, Math.min(timeoutMs, 8000));
  if (await isSohuEditorMounted(page)) return;
  const publishButton = page.locator("button.publish-btn").first();
  const visible = await publishButton.isVisible?.().catch(() => false);
  const disabled = await publishButton.isDisabled?.().catch(() => false);
  if (visible && !disabled) {
    await publishButton.click();
    await page.waitForLoadState?.("domcontentloaded", { timeout: timeoutMs }).catch(() => undefined);
    await page.waitForLoadState?.("networkidle", { timeout: timeoutMs }).catch(() => undefined);
    await waitForSohuEditorReady(page, timeoutMs);
  }
}

async function ensureSohuDraftEditMode(page, timeoutMs = 15000) {
  if (typeof page.locator !== "function") return;
  await waitForSohuEditorReady(page, Math.min(timeoutMs, 4000));
  const continueButton = page.locator(
    ".draft-block .edit-button:has-text('\u7ee7\u7eed\u7f16\u8f91'), li:has-text('\u7ee7\u7eed\u7f16\u8f91'), button:has-text('\u7ee7\u7eed\u7f16\u8f91'), [role='button']:has-text('\u7ee7\u7eed\u7f16\u8f91'), .positive-button:has-text('\u7ee7\u7eed\u7f16\u8f91')"
  ).first();
  const visible = await withSohuActionTimeout(
    continueButton.isVisible?.({ timeout: Math.min(timeoutMs, 3000) }) ?? Promise.resolve(false),
    Math.min(timeoutMs, 3500),
    false
  ).catch(() => false);
  const disabled = visible
    ? await withSohuActionTimeout(
        continueButton.isDisabled?.({ timeout: 1000 }) ?? Promise.resolve(false),
        1200,
        false
      ).catch(() => false)
    : false;
  if (visible && !disabled) {
    await clickSohuElementWithMouseFallback(page, continueButton, {
      timeoutMs: Math.min(timeoutMs, 7000),
      afterClick: async () => {
        await page.waitForTimeout?.(700).catch(() => undefined);
        const stillVisible = await continueButton.isVisible?.().catch(() => false);
        return !stillVisible;
      }
    });
  }
  await waitForSohuEditorReady(page, Math.min(timeoutMs, 8000));
}

/**
 * New-article publish must NOT "继续编辑" an old draft banner.
 * Close the recovery chip so title/body stay blank and Quill is ready for a fresh write.
 */
async function dismissSohuDraftRecoveryBanner(page, timeoutMs = 5000) {
  if (typeof page.locator !== "function" && typeof page.evaluate !== "function") return { dismissed: false };
  // Prefer DOM close (X) over "继续编辑".
  const closed = await page.evaluate(() => {
    const visible = (element) => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const blocks = Array.from(document.querySelectorAll(".draft-block, .draft-tip, .draft-recover, [class*='draft']"))
      .filter(visible)
      .filter((el) => /草稿|继续编辑|更多草稿/.test(el.innerText || ""));
    if (!blocks.length) return { dismissed: false, reason: "no_banner" };
    for (const block of blocks) {
      const close = Array.from(block.querySelectorAll("button, a, span, i, [role='button'], .close, .el-icon-close"))
        .filter(visible)
        .find((el) => {
          const text = String(el.innerText || el.getAttribute("aria-label") || el.className || "").trim();
          return text === "×" || text === "x" || text === "X" || /close|关闭|icon-close/i.test(text);
        });
      if (close) {
        close.click();
        return { dismissed: true, method: "close_button" };
      }
    }
    // Last resort: hide banner so it does not intercept clicks.
    for (const block of blocks) {
      block.style.display = "none";
      block.remove?.();
    }
    return { dismissed: true, method: "hide_banner" };
  }).catch(() => ({ dismissed: false, reason: "evaluate_error" }));

  if (!closed?.dismissed) {
    const closeLocator = page.locator(
      ".draft-block button:has-text('×'), .draft-block .close, .draft-block [aria-label*='close' i], .draft-block [class*='close']"
    ).first();
    const visible = await closeLocator.isVisible?.({ timeout: Math.min(timeoutMs, 1500) }).catch(() => false);
    if (visible) {
      await closeLocator.click({ timeout: 2000 }).catch(() => undefined);
      return { dismissed: true, method: "locator_close" };
    }
  }
  await page.waitForTimeout?.(300).catch(() => undefined);
  return closed || { dismissed: false };
}

async function waitForDraftSaved(page, timeoutMs) {
  if (typeof page.waitForFunction !== "function") return;
  await page.waitForFunction(() => {
    const text = document.body?.innerText || "";
    return /\u5df2\u4fdd\u5b58|\u4fdd\u5b58\u8349\u7a3f|\u5b58\u8349\u7a3f|\u8349\u7a3f|saved|draft/i.test(text);
  }, null, { timeout: timeoutMs }).catch(() => undefined);
}

async function clickSohuDraftSave(page, timeoutMs) {
  const realDraftButton = page.locator("li.publish-report-btn.normal.negative-button:has-text('\u5b58\u8349\u7a3f'), .publish-report-btn:has-text('\u5b58\u8349\u7a3f')").first();
  const realVisible = await realDraftButton.isVisible?.().catch(() => false);
  const realDisabled = await realDraftButton.isDisabled?.().catch(() => false);
  if (realVisible && !realDisabled) {
    await realDraftButton.scrollIntoViewIfNeeded?.().catch(() => undefined);
    await realDraftButton.click?.().catch(() => undefined);
    await waitForDraftSaved(page, timeoutMs);
    return;
  }
  if (typeof page.getByRole === "function") {
    const saveButton = page.getByRole("button", { name: /^(\u4fdd\u5b58\u8349\u7a3f|\u5b58\u8349\u7a3f|\u8349\u7a3f|save draft|draft)$/i }).first();
    const visible = await saveButton.isVisible?.().catch(() => true);
    const disabled = await saveButton.isDisabled?.().catch(() => false);
    if (visible && !disabled) {
      await saveButton.scrollIntoViewIfNeeded?.().catch(() => undefined);
      await saveButton.click?.().catch(() => undefined);
      await waitForDraftSaved(page, timeoutMs);
      return;
    }
  }
  const fallback = page.locator("button:has-text('\u4fdd\u5b58\u8349\u7a3f'), button:has-text('\u5b58\u8349\u7a3f'), button:has-text('\u8349\u7a3f')").first();
  await fallback.scrollIntoViewIfNeeded?.().catch(() => undefined);
  await fallback.click?.().catch(() => undefined);
  await waitForDraftSaved(page, timeoutMs);
}

async function clickSohuPublish(page, timeoutMs, publishState = null) {
  const realPublishButton = page.locator("li.publish-report-btn.active.positive-button:has-text('\u53d1\u5e03'), .publish-report-btn.positive-button:has-text('\u53d1\u5e03')").first();
  const realVisible = await realPublishButton.isVisible?.().catch(() => false);
  const realDisabled = await realPublishButton.isDisabled?.().catch(() => false);
  if (realVisible && !realDisabled) {
    await clickSohuElementWithMouseFallback(page, realPublishButton, {
      timeoutMs,
      submitOnce: true,
      afterClick: async () => Boolean(publishState?.publishAttempted || publishState?.publishedUrl || normalizeSohuPublishedUrl(page.url?.())),
    });
    return;
  }
  const roleButton = page.getByRole("button", { name: /^(\u53d1\u5e03|publish)$/i }).first();
  if (!(await waitForLocatorEnabled(roleButton, page, timeoutMs))) {
    const fallback = page.locator("button:has-text('\u53d1\u5e03'), [role='button']:has-text('\u53d1\u5e03'), .positive-button:has-text('\u53d1\u5e03')").first();
    const fallbackVisible = await fallback.isVisible?.().catch(() => false);
    const fallbackDisabled = await fallback.isDisabled?.().catch(() => false);
    if (!fallbackVisible || fallbackDisabled) throw new Error(`SOHU_PUBLISH_BUTTON_${(await describeUnavailableButton([realPublishButton, roleButton, fallback])).toUpperCase()}`);
    await clickSohuElementWithMouseFallback(page, fallback, {
      timeoutMs,
      submitOnce: true,
      afterClick: async () => Boolean(publishState?.publishAttempted || publishState?.publishedUrl || normalizeSohuPublishedUrl(page.url?.())),
    });
    return;
  }
  await clickSohuElementWithMouseFallback(page, roleButton, {
    timeoutMs,
    submitOnce: true,
    afterClick: async () => Boolean(publishState?.publishAttempted || publishState?.publishedUrl || normalizeSohuPublishedUrl(page.url?.())),
  });
}

async function clickSohuElementWithMouseFallback(page, locator, options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 7000));
  const afterClick = typeof options.afterClick === "function" ? options.afterClick : async () => false;
  await locator.scrollIntoViewIfNeeded?.().catch(() => undefined);
  if (options.submitOnce) {
    await locator.click({ timeout: Math.min(timeoutMs, 5000) });
    return "locator";
  }
  await withSohuActionTimeout(
    locator.click?.({ timeout: Math.min(timeoutMs, 5000) }) ?? Promise.resolve(),
    Math.min(timeoutMs, 5500),
    undefined
  ).catch(() => undefined);
  if (await waitForSohuCondition(page, afterClick, Math.min(timeoutMs, 1500), 150)) return "locator";

  const box = await locator.boundingBox?.().catch(() => null);
  if (box && typeof page.mouse?.click === "function") {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    if (await waitForSohuCondition(page, afterClick, Math.min(timeoutMs, 1500), 150)) return "mouse";
  }

  await locator.dispatchEvent?.("mousedown").catch(() => undefined);
  await locator.dispatchEvent?.("mouseup").catch(() => undefined);
  await locator.dispatchEvent?.("click").catch(() => undefined);
  return "dispatch";
}

async function waitForSohuCondition(page, predicate, timeoutMs = 1500, pollMs = 150) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (await predicate().catch(() => false)) return true;
    if (typeof page.waitForTimeout === "function") await page.waitForTimeout(pollMs).catch(() => undefined);
    else await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}

async function readSohuDraftEditModeSnapshot(page) {
  if (!page || typeof page.locator !== "function") return {};
  const continueButton = page.locator(
    "li:has-text('\u7ee7\u7eed\u7f16\u8f91'), button:has-text('\u7ee7\u7eed\u7f16\u8f91'), [role='button']:has-text('\u7ee7\u7eed\u7f16\u8f91'), .positive-button:has-text('\u7ee7\u7eed\u7f16\u8f91')"
  ).first();
  return {
    currentUrl: typeof page.url === "function" ? page.url() : "",
    continueEditVisible: await continueButton.isVisible?.().catch(() => false),
    editorMounted: await isSohuEditorMounted(page).catch(() => false),
  };
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

function withSohuActionTimeout(promise, timeoutMs, fallback = undefined) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), Math.max(1, Number(timeoutMs || 1)));
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function confirmSohuPostPublishDialogs(page, timeoutMs = 10000) {
  if (typeof page.locator !== "function") return;
  const selectors = [
    ".el-dialog:visible .positive-button:has-text('\u786e\u5b9a')",
    ".el-dialog:visible button:has-text('\u786e\u5b9a')",
    ".el-dialog:visible .positive-button:has-text('\u786e\u8ba4')",
    ".el-dialog:visible button:has-text('\u786e\u8ba4')",
    ".el-dialog:visible li:has-text('\u786e\u5b9a')",
    ".ant-modal button.ant-btn-primary:has-text('\u786e\u5b9a')",
    ".ant-modal button.ant-btn-primary:has-text('\u786e\u8ba4')",
    ".ant-modal button:has-text('\u7ee7\u7eed\u53d1\u5e03')",
    ".ant-modal button:has-text('\u77e5\u9053\u4e86')",
    ".ant-modal button:has-text('OK')"
  ];
  const startedAt = Date.now();
  for (let round = 0; round < 2; round += 1) {
    if (Date.now() - startedAt >= timeoutMs) break;
    let clicked = false;
    for (const selector of selectors) {
      if (Date.now() - startedAt >= timeoutMs) break;
      const button = page.locator(selector).first();
      const remainingMs = Math.max(250, timeoutMs - (Date.now() - startedAt));
      const visible = await withSohuActionTimeout(
        button.isVisible?.({ timeout: Math.min(remainingMs, 1000) }) ?? Promise.resolve(false),
        Math.min(remainingMs, 1200),
        false
      ).catch(() => false);
      const disabled = await withSohuActionTimeout(
        button.isDisabled?.({ timeout: Math.min(remainingMs, 1000) }) ?? Promise.resolve(false),
        Math.min(remainingMs, 1200),
        true
      ).catch(() => true);
      if (visible && !disabled) {
        await withSohuActionTimeout(
          button.click?.({ timeout: Math.min(remainingMs, 2000) }) ?? Promise.resolve(),
          Math.min(remainingMs, 2200),
          undefined
        ).catch(() => undefined);
        clicked = true;
        if (typeof page.waitForTimeout === "function") await page.waitForTimeout(1000).catch(() => undefined);
        break;
      }
    }
    if (!clicked) break;
  }
}

async function readSohuPublishedUrl(page) {
  const current = typeof page.url === "function" ? page.url() : "";
  const normalizedCurrent = normalizeSohuPublishedUrl(current);
  if (normalizedCurrent) return normalizedCurrent;
  return "";
}

function normalizedMatchText(value = "") {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

function sohuMarkdownEvidenceFragments(value = "", articleTitle = "") {
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

function sohuRenderedBodyMatches(contentMarkdown = "", bodyText = "", articleTitle = "") {
  if (!String(contentMarkdown || "").trim()) return true;
  const normalizedPageBody = normalizedMatchText(bodyText);
  if (!normalizedPageBody) return false;

  const fragments = sohuMarkdownEvidenceFragments(contentMarkdown, articleTitle)
    .map((fragment) => normalizedMatchText(fragment))
    .filter((fragment) => fragment.length >= 8);
  if (!fragments.length) return false;

  const substantial = fragments.filter((fragment) => fragment.length >= 24);
  const probes = (substantial.length ? substantial : fragments).slice(0, 3);
  const matched = probes.filter((fragment) => normalizedPageBody.includes(fragment)).length;
  const required = probes.length >= 2 ? 2 : 1;
  return matched >= required;
}

export async function findSohuPublicationFromManagement(page, input = {}) {
  const evidence = await readSohuManagementArticleEvidence(page, input);
  return normalizeSohuPublishedUrl(evidence.publicUrl || "") || "";
}

export async function readSohuManagementArticleEvidence(page, input = {}, options = {}) {
  const expectedTitle = cleanText(input.articleTitle || input.title || "");
  const shouldNavigate = options.navigate !== false;
  if (shouldNavigate) {
    await page.goto(input.manageUrl || SOHU_MANAGE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
    await page.waitForTimeout?.(2000).catch(() => undefined);
  }

  const search = page.locator(
    "input[placeholder*='\u641c\u7d22'], input[placeholder*='\u5173\u952e\u8bcd'], input[placeholder*='\u8bf7\u8f93\u5165\u6587\u7ae0\u6807\u9898'], input[type='search']"
  ).first();
  if (expectedTitle && await search.isVisible?.().catch(() => false)) {
    await search.fill("").catch(() => undefined);
    await search.fill(expectedTitle).catch(() => undefined);
    await search.press?.("Enter").catch(() => undefined);
    const searchButton = page.locator("button:has-text('\u67e5\u8be2'), button:has-text('\u641c\u7d22')").first();
    if (await searchButton.isVisible?.().catch(() => false)) await searchButton.click().catch(() => undefined);
    await page.waitForTimeout?.(2500).catch(() => undefined);
  }

  const currentUrl = typeof page.url === "function" ? page.url() : "";
  const found = typeof page.evaluate === "function"
    ? await page.evaluate((title) => {
        const normalize = (value) => String(value || "").replace(/\s+/g, "").toLowerCase();
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const wanted = normalize(title);
        const normalizeUrl = (href) => {
          try {
            const url = new URL(href, location.origin).toString().replace(/^http:/, "https:");
            const parsed = new URL(url);
            return /(^|\.)sohu\.com$/i.test(parsed.hostname) && /\/a\/\d+_/i.test(parsed.pathname)
              ? url
              : "";
          } catch {
            return "";
          }
        };
        const readTimestamp = (value) => {
          const match = String(value || "").match(/(20\d{2}[-/.]\d{1,2}[-/.]\d{1,2})\s+(\d{1,2}:\d{2})/);
          if (!match) return Number.NaN;
          return Date.parse(`${match[1].replace(/[/.]/g, "-")}T${match[2]}:00`);
        };
        const makeCandidate = (anchor, row, index) => {
          const rawText = clean(row?.innerText || row?.textContent || anchor?.textContent || "");
          const anchors = row?.querySelectorAll ? [...row.querySelectorAll("a[href]")] : [anchor];
          const publicUrl = anchors
            .map((item) => normalizeUrl(item?.getAttribute?.("href") || ""))
            .find(Boolean) || normalizeUrl(anchor?.getAttribute?.("href") || "");
          return {
            index,
            titleText: normalize(anchor?.textContent || anchor?.getAttribute?.("title") || ""),
            rowText: rawText,
            statusText: rawText,
            publicUrl,
            timestamp: readTimestamp(rawText),
          };
        };
        const titleAnchors = [...document.querySelectorAll(
          "li.content-item h3.title a[href], li.content-item .article-content-info h3 a[href], h3.title a[href], .article-content-info h3 a[href]"
        )];
        let candidates = titleAnchors
          .map((anchor, index) => makeCandidate(
            anchor,
            anchor.closest?.("li.content-item") || anchor.closest?.("tr, .list-item, .table-row, [data-row-key]") || anchor.parentElement,
            index
          ))
          .filter((candidate) => !wanted || candidate.titleText === wanted);
        if (!candidates.length) {
          const rows = [...document.querySelectorAll("li.content-item, tr, .list-item, .table-row, [data-row-key]")];
          candidates = rows
            .map((row, index) => {
              const anchor = [...row.querySelectorAll("a[href]")].find((item) => {
                const anchorTitle = normalize(item.textContent || item.getAttribute?.("title") || "");
                return !wanted || anchorTitle === wanted;
              });
              return anchor ? makeCandidate(anchor, row, index) : null;
            })
            .filter(Boolean);
        }
        candidates.sort((left, right) => {
          const leftHasTime = Number.isFinite(left.timestamp);
          const rightHasTime = Number.isFinite(right.timestamp);
          if (leftHasTime && rightHasTime && left.timestamp !== right.timestamp) return right.timestamp - left.timestamp;
          if (leftHasTime !== rightHasTime) return rightHasTime ? 1 : -1;
          return left.index - right.index;
        });
        const selected = candidates[0];
        if (!selected) return { found: false, articleTitle: title, rowText: "", statusText: "", publicUrl: "" };
        return {
          found: true,
          articleTitle: title,
          rowText: selected.rowText,
          statusText: selected.statusText,
          publicUrl: selected.publicUrl,
        };
      }, expectedTitle).catch(() => ({ found: false, articleTitle: expectedTitle, rowText: "", statusText: "", publicUrl: "" }))
    : { found: false, articleTitle: expectedTitle, rowText: "", statusText: "", publicUrl: "" };
  const evidence = found && typeof found === "object"
    ? found
    : { found: Boolean(found), articleTitle: expectedTitle, rowText: "", statusText: "", publicUrl: String(found || "") };
  return {
    found: evidence.found === true || Boolean(evidence.publicUrl),
    articleTitle: evidence.articleTitle || expectedTitle,
    rowText: cleanText(evidence.rowText || evidence.statusText || "").slice(0, 2000),
    statusText: cleanText(evidence.statusText || evidence.rowText || "").slice(0, 1000),
    publicUrl: normalizeSohuPublishedUrl(evidence.publicUrl || "") || "",
    currentUrl: evidence.currentUrl || currentUrl,
  };
}

function classifySohuManagementEvidence(evidence = {}) {
  if (!evidence.found) return "";
  const text = `${evidence.statusText || ""} ${evidence.rowText || ""}`;
  if (/\u672a\u901a\u8fc7|\u5ba1\u6838\u5931\u8d25|\u5df2\u9a73\u56de|rejected|failed/i.test(text)) return "rejected";
  if (evidence.publicUrl || /\u5df2\u53d1\u5e03|\u9605\u8bfb|\u8bc4\u8bba|published/i.test(text)) return "published";
  if (/\u5ba1\u6838\u4e2d|\u5f85\u5ba1\u6838|\u5df2\u63d0\u4ea4|review|submitted/i.test(text)) return "submitted_for_review";
  if (/\u8349\u7a3f|draft/i.test(text)) return "draft_saved";
  return "";
}

function buildSohuManagementFallbackResult(publishInput = {}, evidence = {}, options = {}) {
  const platformStatus = classifySohuManagementEvidence(evidence);
  if (!["published", "submitted_for_review", "rejected"].includes(platformStatus)) return null;
  if (platformStatus === "rejected") {
    return {
      draftUrl: options.draftUrl || "",
      publishedUrl: "",
      reviewUrl: "",
      platformStatus: "rejected",
      publiclyVisible: false,
      reviewStatus: "rejected",
      message: "搜狐号审核未通过，平台未生成公开文章 URL。",
      title: publishInput.title || publishInput.articleTitle || evidence.articleTitle || "",
      managementEvidence: evidence,
      ...(options.publicationConfigEvidence ? { publicationConfigEvidence: buildSohuPublicationConfigEvidence(publishInput, options.publicationConfigEvidence) } : {}),
      ...(options.draftImageEvidence ? { imagePublicationEvidence: options.draftImageEvidence } : {}),
    };
  }
  const publicUrl = platformStatus === "published" ? evidence.publicUrl || "" : "";
  const reviewUrl = publicUrl || options.draftUrl || evidence.currentUrl || "";
  return {
    draftUrl: options.draftUrl || "",
    publishedUrl: publicUrl,
    reviewUrl,
    platformStatus,
    publiclyVisible: Boolean(publicUrl && platformStatus === "published"),
    reviewStatus: platformStatus === "published" && publicUrl ? "public" : "pending_public_visibility",
    message: platformStatus === "published" && publicUrl
      ? "Sohu management page shows this article as published and exposes a public URL."
      : "Sohu management page shows this article has been submitted and is under review; waiting for public visibility verification.",
    title: publishInput.title || publishInput.articleTitle || evidence.articleTitle || "",
    managementEvidence: evidence,
    ...(options.publicationConfigEvidence ? { publicationConfigEvidence: buildSohuPublicationConfigEvidence(publishInput, options.publicationConfigEvidence) } : {}),
    ...(options.draftImageEvidence ? { imagePublicationEvidence: options.draftImageEvidence } : {}),
  };
}

export async function resolveSohuAcceptedManagementFallback(page, publishInput = {}, options = {}) {
  const currentEvidence = await readSohuManagementArticleEvidence(page, publishInput, { navigate: false }).catch(() => null);
  let result = buildSohuManagementFallbackResult(publishInput, currentEvidence || {}, options);
  if (result) return result;

  const pollAttempts = options.poll === true
    ? Math.max(1, Number(options.pollAttempts || 3))
    : 1;
  const pollDelayMs = Math.max(0, Number(options.pollDelayMs || 1500));
  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    const managedEvidence = await readSohuManagementArticleEvidence(page, publishInput, { navigate: true }).catch(() => null);
    result = buildSohuManagementFallbackResult(publishInput, managedEvidence || {}, options);
    if (result) return result;
    if (attempt + 1 < pollAttempts) {
      await page.waitForTimeout?.(pollDelayMs).catch(() => undefined);
    }
  }
  return null;
}

export async function inspectSohuPublicArticle(page, input = {}) {
  let publicUrl = normalizeSohuPublishedUrl(
    input.publicUrl || input.publishedUrl || input.reviewUrl || ""
  );
  let managementEvidence = null;
  if (!publicUrl) {
    managementEvidence = await readSohuManagementArticleEvidence(page, input).catch(() => null);
    const managementStatus = classifySohuManagementEvidence(managementEvidence || {});
    if (managementStatus === "rejected") {
      return {
        found: false,
        publicUrl: "",
        publishedUrl: "",
        platformStatus: "rejected",
        reviewStatus: "rejected",
        publiclyVisible: false,
        message: "搜狐号审核未通过，平台未生成公开文章 URL。",
        managementEvidence,
      };
    }
    publicUrl = normalizeSohuPublishedUrl(managementEvidence?.publicUrl || "") || "";
  }
  if (!publicUrl) {
    return {
      found: false,
      publicUrl: "",
      publishedUrl: "",
      platformStatus: "pending_public_visibility",
      reviewStatus: "pending_public_visibility",
      publiclyVisible: false,
      message: "搜狐号内容管理中尚未发现本次文章的公开链接，等待平台审核或公开延迟后复验。",
    };
  }

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
    }, { selector: SOHU_PUBLIC_IMAGE_SELECTOR, expectedCount: expected.length }, { timeout: 30000 }).catch(() => undefined);
  }

  const publicStage = expected.length
    ? await verifyPublicImageEvidence({
      tasks: expected,
      readImages: () => readSohuPublicArticleImages(page),
      readBlocker: async () => (
        (await readSohuPlatformBlocker(page))
        || (await readPublicPageBlockerFromPage(page))
      ),
    }).catch(() => ({ images: [], blocker: "SOHU_PUBLIC_IMAGE_VERIFICATION_FAILED" }))
    : { images: [], blocker: "" };
  const publicImages = publicStage.images;
  const publicBlocker = publicStage.blocker;
  const imagePublicationEvidence = expected.length
    ? buildImagePublicationEvidence(
        expected,
        existing.upload?.images || [],
        existing.draft?.images || [],
        publicImages,
        publicBlocker,
      )
    : undefined;

  const pageTitle = await page.title().catch(() => "");
  const bodyText = await page.locator("article, .article-content, .text, .article, body").first().innerText().catch(() => "");
  const pageText = `${pageTitle}\n${bodyText}`.trim().slice(0, 12000);
  const expectedTitle = normalizedMatchText(input.articleTitle || input.title);
  const normalizedPageText = normalizedMatchText(pageText);
  const titleMatched = Boolean(expectedTitle && normalizedPageText.includes(expectedTitle));
  const bodyMatched = sohuRenderedBodyMatches(
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
    ...(imagePublicationEvidence ? { imagePublicationEvidence } : {}),
  };
}

async function readSohuPageTexts(page) {
  if (typeof page?.evaluate !== "function") return { bodyText: "", visibleMessageText: "" };
  const state = await page.evaluate(() => {
    const isVisible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const visibleText = Array.from(document.querySelectorAll(".el-message, .mt-message, .toast, .notice, [role='alert'], .el-dialog, .ant-modal, .modal"))
      .filter(isVisible)
      .map((element) => element.innerText || element.textContent || "")
      .join(" ");
    return {
      bodyText: document.body?.innerText || "",
      visibleMessageText: visibleText
    };
  }).catch(() => ({ bodyText: "", visibleMessageText: "" }));
  if (typeof state === "string") return { bodyText: state, visibleMessageText: "" };
  return { bodyText: state.bodyText || "", visibleMessageText: state.visibleMessageText || "" };
}

// Only gates a person can clear: the clientAuth SMS page and on-page captcha or
// slider dialogs. Content blockers stay in readSohuPlatformBlocker so they keep
// failing fast instead of being waited out.
async function readSohuVerificationGate(page) {
  // The backend can bounce the editor onto the SMS gate mid-flight, long after
  // the login check already passed.
  if (isSohuClientAuthPage({ url: typeof page?.url === "function" ? page.url() : "" })) {
    return "SOHU_MANUAL_ACTION_REQUIRED";
  }
  const { bodyText, visibleMessageText } = await readSohuPageTexts(page);
  const pageText = `${bodyText} ${visibleMessageText}`;
  if (/captcha|security verification|risk control/i.test(pageText)) return "SOHU_MANUAL_ACTION_REQUIRED";
  if (/\u9a8c\u8bc1\u7801|\u5b89\u5168\u9a8c\u8bc1|\u62d6\u52a8\u6ed1\u5757|\u626b\u7801\u9a8c\u8bc1|\u624b\u673a\u9a8c\u8bc1/.test(pageText)) return "SOHU_MANUAL_ACTION_REQUIRED";
  return "";
}

async function readSohuPlatformBlocker(page) {
  const gate = await readSohuVerificationGate(page);
  if (gate) return gate;
  const { visibleMessageText } = await readSohuPageTexts(page);
  if (/manual review|sensitive word|publish quota|publish limit/i.test(visibleMessageText)) return "SOHU_MANUAL_ACTION_REQUIRED";
  if (/\u539f\u521b\u6821\u9a8c|\u53d1\u5e03\u4e0a\u9650|\u4eca\u65e5\u53d1\u5e03|\u654f\u611f\u8bcd|\u8fdd\u89c4|\u5ba1\u6838\u5931\u8d25|\u5ba1\u6838\u672a\u901a\u8fc7|\u672a\u901a\u8fc7\u539f\u56e0/.test(visibleMessageText)) return "SOHU_MANUAL_ACTION_REQUIRED";
  return "";
}

function notifyPublishProgress(input = {}, event = {}) {
  if (typeof input.onProgress !== "function") return;
  input.onProgress(event);
}

function notifySohuStep(input = {}, step, detail = {}) {
  notifyPublishProgress(input, {
    type: "publish_progress",
    platform: "sohu",
    step,
    ...detail
  });
}

// The Sohu publish backend redirects to clientAuth and asks for an SMS code even
// though the passport cookies still validate. That is a human step, so surface it
// as manual verification instead of letting the editor fill time out obscurely.
function sohuClientAuthVerificationError(input = {}, pageState = {}) {
  notifyPublishProgress(input, {
    type: "manual_verification_required",
    platform: "sohu",
    message: "搜狐号发布需要短信验证码：请在弹出的搜狐浏览器窗口完成手机短信验证，验证通过后重新提交发布。",
    currentUrl: cleanText(pageState.url)
  });
  return new Error("SOHU_MANUAL_ACTION_REQUIRED");
}

function isSohuPageAlive(page) {
  if (!page) return false;
  if (typeof page.isClosed === "function") {
    try {
      return !page.isClosed();
    } catch {
      return false;
    }
  }
  return typeof page.evaluate === "function" || typeof page.url === "function";
}

// The Sohu SMS gate can only be cleared by a person, so hold the publish here and
// resume once the gate is gone instead of failing the whole command. Returns
// "cleared", or the reason the gate could not be waited out.
async function settleSohuVerificationGate(page, input = {}, options = {}) {
  const gate = await readSohuVerificationGate(page);
  if (!gate) return "none";
  if (!isSohuPageAlive(page)) return "browser_closed";
  // Nobody can type an SMS code into a browser that has no window.
  if (input.headless === true) return "headless";
  const startedAt = Number(options.startedAt) || Date.now();
  const requestedMs = Number(
    input.manualVerificationTimeoutMs || input.securityVerificationTimeoutMs || SOHU_MANUAL_VERIFICATION_TIMEOUT_MS
  );
  const remainingMs = Number(input.operationTimeoutMs || SOHU_OPERATION_TIMEOUT_MS) - (Date.now() - startedAt);
  const budgetMs = Math.max(1, Math.min(requestedMs, remainingMs));
  const maxPolls = Math.max(1, Math.ceil(budgetMs / SOHU_MANUAL_VERIFICATION_POLL_MS));
  const currentUrl = typeof page.url === "function" ? page.url() : "";
  const smsGate = isSohuClientAuthPage({ url: currentUrl });
  await bringToFrontIfAllowed(page, input);
  const notify = typeof options.onProgress === "function"
    ? options.onProgress
    : (typeof input.onProgress === "function" ? input.onProgress : null);
  notify?.({
    type: "manual_verification_required",
    platform: "sohu",
    ...(options.stage ? { stage: options.stage } : {}),
    message: smsGate
      ? "搜狐号发布需要短信验证码：请在弹出的搜狐浏览器窗口完成手机短信验证，验证通过后会自动继续发布。"
      : "搜狐号发布需要安全验证：请在弹出的搜狐浏览器窗口完成验证码或滑块验证，验证通过后会自动继续发布。",
    currentUrl
  });
  let polls = 0;
  while (true) {
    if (!isSohuPageAlive(page)) return "browser_closed";
    if (!(await readSohuVerificationGate(page))) return "cleared";
    const liveUrl = typeof page.url === "function" ? page.url() : "";
    if (matchesAny(SOHU_LOGIN_PATTERNS, liveUrl)) return "logged_out";
    if (polls >= maxPolls) return "timeout";
    polls += 1;
    await bringToFrontIfAllowed(page, input);
    if (typeof page.waitForTimeout === "function") {
      await page.waitForTimeout(SOHU_MANUAL_VERIFICATION_POLL_MS).catch(() => undefined);
    } else {
      await new Promise((resolve) => setTimeout(resolve, SOHU_MANUAL_VERIFICATION_POLL_MS));
    }
  }
}

// Only safe before the article is filled in; once the draft exists the caller
// resumes on the draft URL instead so the saved work is not thrown away.
async function reopenSohuEditorAfterGate(page, input = {}, publishInput = {}) {
  await page.goto(input.editorUrl || SOHU_EDITOR_URL, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  await bringToFrontIfAllowed(page, input);
  await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
  await ensureSohuEditorPage(page, publishInput.draftTimeoutMs).catch(() => undefined);
}

// Waits out a gate that appears at one of the publish blocker checkpoints, then
// returns to the draft so the flow can continue where it was interrupted.
async function settleSohuPublishBlocker(page, input, publishWatcher, options = {}) {
  const gate = await readSohuVerificationGate(page);
  if (!gate) return "none";
  const settled = await settleSohuVerificationGate(page, input, {
    startedAt: options.startedAt,
    stage: options.stage
  });
  if (settled !== "cleared") return settled;
  const resumeUrl = String(options.resumeUrl || "");
  if (resumeUrl && typeof page.goto === "function") {
    await page.goto(resumeUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
  }
  if (publishWatcher?.state) publishWatcher.state.blocker = "";
  return (await readSohuPlatformBlocker(page)) ? "blocked" : "cleared";
}

function withSohuTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`SOHU_STEP_TIMEOUT:${label}`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const SOHU_LOGIN_PATTERNS = [/\/login/i, /passport\.sohu\.com/i];
const SOHU_LOGIN_TEXT_PATTERNS = [
  /\u8d26\u53f7\u767b\u5f55|\u624b\u673a\u767b\u5f55|\u7528\u6237\u534f\u8bae|\u9690\u79c1\u653f\u7b56|\u4e0b\u6b21\u81ea\u52a8\u767b\u5f55/i
];
// Sohu answers the publish backend with a client-side verification page
// (mp.sohu.com/mpfe/vN/clientAuth) that demands an SMS code while the passport
// cookies are still alive. It is an auth gate, never the creator workspace.
const SOHU_CLIENT_AUTH_URL_PATTERN = /mp\.sohu\.com\/mpfe\/v\d+\/clientAuth/i;
const SOHU_WORKSPACE_URL_PATTERNS = [
  /mp\.sohu\.com\/mpfe\/v\d+\/(main|home|content|publish|article|data)/i,
  /mp\.sohu\.com\/.*(creator|manage|article|publish|content)/i,
  // OAuth (WeChat QR or SMS verification) lands here before the workspace redirect.
  /mp\.sohu\.com\/home(\?|$)/i,
  // clientAuth is an SMS gate, not a workspace: see isSohuClientAuthPage.
];
const SOHU_WORKSPACE_TEXT_PATTERNS = [
  /\b(creator|workspace|dashboard|content management|article management|publish)\b/i,
  /\u521b\u4f5c\u4e2d\u5fc3|\u5185\u5bb9\u7ba1\u7406|\u5de5\u4f5c\u53f0|\u53d1\u5e03|\u6587\u7ae0\u7ba1\u7406/i
];

// Screen the SMS gate before every workspace pattern, because the gate page also
// carries workspace-looking copy and would otherwise read as a healthy session.
export function isSohuClientAuthPage(pageState = {}) {
  const url = cleanText(pageState.url);
  return Boolean(url) && SOHU_CLIENT_AUTH_URL_PATTERN.test(url);
}

export function isSohuCookie(cookie = {}) {
  const domain = String(cookie.domain || "").replace(/^\./, "");
  return domain === "sohu.com" || domain.endsWith(".sohu.com");
}

export function normalizeSohuCookie(cookie = {}) {
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

export async function createSohuCookieInjectedContext(options = {}) {
  const rawCookies = Array.isArray(options.cookies) ? options.cookies : [];
  const cookies = rawCookies.filter(isSohuCookie).map(normalizeSohuCookie);
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
  const page = await context.newPage();
  const url = options.url || "https://mp.sohu.com/mpfe/v4/main";
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await bringToFrontIfAllowed(page, options);
  return { browser, context, page, cookies };
}

export function isSohuLoggedInFromCookies(cookies = []) {
  return hasSohuStrongLoginCookie(cookies);
}

export function hasSohuStrongLoginCookie(cookies = []) {
  const authCookieNames = new Set(["ppinf", "pprdig", "ppmdig", "passport", "sohu_user"]);
  return cookies.some((cookie) => (
    isSohuCookie(cookie)
    && authCookieNames.has(String(cookie.name || ""))
    && hasValue(cookie)
  ));
}

export function isSohuWorkspaceReady(pageState = {}) {
  const url = cleanText(pageState.url);
  const title = cleanText(pageState.title);
  const text = cleanText(pageState.text);
  const pageText = `${url} ${title} ${text}`;
  if (isSohuClientAuthPage(pageState)) return false;
  if (matchesAny(SOHU_LOGIN_PATTERNS, pageText)) return false;
  if (matchesAny(SOHU_LOGIN_TEXT_PATTERNS, pageText)) return false;
  return matchesAny(SOHU_WORKSPACE_URL_PATTERNS, url)
    || matchesAny(SOHU_WORKSPACE_TEXT_PATTERNS, pageText);
}

export function isSohuLoggedIn(cookies = [], pageState = {}) {
  return hasSohuStrongLoginCookie(cookies) && isSohuWorkspaceReady(pageState);
}

export async function readSohuPageState(page) {
  if (!page) return { url: "", title: "", text: "" };
  const url = typeof page.url === "function" ? cleanText(page.url()) : "";
  const title = typeof page.title === "function" ? cleanText(await page.title().catch(() => "")) : "";
  const text = typeof page.evaluate === "function"
    ? cleanText(await page.evaluate(() => document.body?.innerText?.slice(0, 8000) || "").catch(() => ""))
    : "";
  return { url, title, text };
}

function sohuContextPages(context, page) {
  const pages = [];
  if (page) pages.push(page);
  try {
    for (const candidate of context?.pages?.() || []) {
      if (!pages.includes(candidate)) pages.push(candidate);
    }
  } catch {
    // The context teardown is reported by the cookie poll on the next iteration.
  }
  return pages;
}

export function buildSohuAuthArtifact(snapshot, options = {}) {
  const capturedAt = options.capturedAt || new Date().toISOString();
  const normalized = {
    platform: "sohu",
    origin: SOHU_ORIGIN,
    cookies: (snapshot.cookies || []).filter(isSohuCookie).map(normalizeSohuCookie),
    localStorage: snapshot.localStorage || {},
    sessionStorage: snapshot.sessionStorage || {},
    capturedAt
  };
  const fingerprint = fingerprintFor(normalized);

  return {
    cookies: `encrypted-cookie-${encodeEnvelope({ platform: "sohu", cookies: normalized.cookies, capturedAt })}`,
    localStorage: `encrypted-local-storage-${encodeEnvelope({ platform: "sohu", values: normalized.localStorage, capturedAt })}`,
    sessionStorage: `encrypted-session-storage-${encodeEnvelope({ platform: "sohu", values: normalized.sessionStorage, capturedAt })}`,
    fingerprint: `fp-sohu-${fingerprint}`,
    storageVersion: 2,
    capturedAt,
    credentialMetadata: options.credentialMetadata || summarizeCredentialExpiry(
      normalized.cookies,
      ["ppinf", "pprdig", "ppmdig", "passport", "sohu_user"]
    ),
    authorizationEvidence: options.authorizationEvidence || null
  };
}

export async function readSohuProfileFromDom(page) {
  if (!page?.evaluate) return null;
  const result = await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const selectors = [
      "[class*='account'] img[alt]",
      "[class*='avatar'] img[alt]",
      "[class*='user'] img[alt]",
      "[class*='profile'] img[alt]",
      "[class*='account'] [title]",
      "[class*='avatar'] [title]",
      "[class*='user'] [title]",
      "[class*='profile'] [title]",
      "[class*='account-name']",
      "[class*='user-name']",
      "[class*='nickname']",
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

export async function pickSohuAccountName(input = {}, page) {
  if (input.accountName?.trim()) return input.accountName.trim();
  const domProfile = await readSohuProfileFromDom(page);
  if (isUsefulAccountName(domProfile?.accountName)) return domProfile.accountName;
  const title = page ? await page.title().catch(() => "") : "";
  const name = title
    .replace(/\s*-\s*搜狐号\s*$/, "")
    .replace(/\s*搜狐号\s*$/, "")
    .trim();
  return isUsefulAccountName(name) ? name : "搜狐号账号";
}

export class SohuAdapter {
  constructor(options = {}) {
    this.platform = "sohu";
    this.loginUrl = options.loginUrl || SOHU_LOGIN_URL;
    this.fieldNames = ["标题", "正文", "分类", "封面"];
    this.accountLabel = "搜狐号账号";
    this.browser = options.browser;
  }

  profileDir(input = {}) {
    const root = input.profileRoot || path.join(process.cwd(), ".zhixin-ai", "profiles");
    return resolveProfileDir(root, this.platform, input);
  }

  async launchAuthEnvironment(input = {}) {
    let context;
    if (this.browser?.launchPersistentContext) {
      context = await this.browser.launchPersistentContext(this.profileDir(input), {
        headless: Boolean(input.headless),
        viewport: { width: 1360, height: 900 }
      });
    } else {
      const chromium = await importPlaywrightChromium();
      const userDataDir = this.profileDir(input);
      await mkdir(userDataDir, { recursive: true });
      context = await chromium.launchPersistentContext(userDataDir, {
        headless: Boolean(input.headless),
        viewport: { width: 1360, height: 900 },
        locale: "zh-CN",
        args: ["--disable-blink-features=AutomationControlled"]
      });
    }
    await seedPersistentContext(context, {
      cookies: input.cookies,
      localStorage: input.localStorage,
      sessionStorage: input.sessionStorage,
      origins: [SOHU_ORIGIN, SOHU_PASSPORT_ORIGIN]
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

  async waitForLogin(context, page, waitLoginMs = DEFAULT_WAIT_LOGIN_MS, pollMs = 1500) {
    const startedAt = Date.now();
    const intervalMs = Math.max(50, Number(pollMs || 1500));
    while (Date.now() - startedAt < waitLoginMs) {
      let cookies = [];
      try {
        // No URL filter: strong login cookies also live on the .sohu.com domain
        // and on host-only subdomains such as v4.passport.sohu.com.
        cookies = await context.cookies();
      } catch (error) {
        if (isBrowserClosedError(error)) throw error;
        cookies = [];
      }
      // WeChat QR and SMS verification complete in a popup or a second tab, so
      // every open page is a login candidate, not only the tracked one.
      for (const candidate of sohuContextPages(context, page)) {
        const pageState = await readSohuPageState(candidate);
        if (isSohuLoggedIn(cookies, pageState)) return { cookies, page: candidate };
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return null;
  }

  async detectLoggedIn(input = {}) {
    const keepOpen = Boolean(input.keepBrowserOpen);
    let authEnvironment = await this.openLoginPage(input);
    this.context = authEnvironment.context;
    this.page = authEnvironment.page;
    let login;
    try {
      login = await this.waitForLogin(this.context, this.page, Number(input.waitLoginMs || DEFAULT_WAIT_LOGIN_MS));
    } catch (error) {
      if (!isBrowserClosedError(error)) throw error;
      authEnvironment = await this.openLoginPage(input);
      this.context = authEnvironment.context;
      this.page = authEnvironment.page;
      login = await this.waitForLogin(this.context, this.page, Number(input.waitLoginMs || DEFAULT_WAIT_LOGIN_MS));
    }
    if (!login) {
      if (!keepOpen) await this.context.close().catch(() => undefined);
      this.context = null;
      this.page = null;
      return false;
    }
    // Follow the tab that actually reached the workspace so profile reads and
    // artifact capture no longer inspect the stale gateway page.
    this.cookies = login.cookies;
    if (login.page) this.page = login.page;
    return true;
  }

  async readAccountProfile(input = {}) {
    const domProfile = await readSohuProfileFromDom(this.page);
    if (isUsefulAccountName(domProfile?.accountName)) return domProfile;
    return {
      accountName: await pickSohuAccountName(input, this.page),
      avatar: ""
    };
  }

  async collectAuthArtifact(input = {}) {
    const context = this.context || (await this.launchAuthEnvironment(input));
    const page = this.page || context.pages()[0] || await context.newPage();
    if (!page.url().startsWith(SOHU_ORIGIN)) {
      await page.goto(SOHU_ORIGIN, { waitUntil: "domcontentloaded" });
    }
    const cookies = this.cookies || await context.cookies();
    const storage = await collectWebStorage(page);
    const pageState = await readSohuPageState(page);
    const artifact = buildSohuAuthArtifact({ cookies, ...storage }, {
      authorizationEvidence: {
        strongCookiePresent: hasSohuStrongLoginCookie(cookies),
        workspaceReady: isSohuWorkspaceReady(pageState),
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
    const cookies = await context.cookies();
    const pageState = await readSohuPageState(page);
    if (!isSohuLoggedIn(cookies, pageState)) throw new Error("SOHU_LOGIN_REQUIRED");
    const storage = await collectWebStorage(page);
    return buildSohuAuthArtifact({ cookies, ...storage }, {
      authorizationEvidence: {
        strongCookiePresent: hasSohuStrongLoginCookie(cookies),
        workspaceReady: isSohuWorkspaceReady(pageState),
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

  async refreshCredentialAfterOperation(input, context, page, validationUrl = SOHU_EDITOR_URL) {
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
      await page.goto(input.validationUrl || SOHU_EDITOR_URL, { waitUntil: "domcontentloaded" });
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

  async ensureLoggedInForPublish(input, context, page, publishInput = {}, startedAt = Date.now()) {
    let cookies = [];
    try {
      cookies = await context.cookies([SOHU_ORIGIN, SOHU_PASSPORT_ORIGIN]);
    } catch (error) {
      if (isBrowserClosedError(error)) throw error;
      cookies = [];
    }
    let pageState = await readSohuPageState(page);
    if (isSohuClientAuthPage(pageState)) {
      const settled = await settleSohuVerificationGate(page, input, { startedAt, stage: "verify_login" });
      if (settled === "cleared") {
        await reopenSohuEditorAfterGate(page, input, publishInput);
        pageState = await readSohuPageState(page);
      }
      if (isSohuClientAuthPage(pageState)) throw sohuClientAuthVerificationError(input, pageState);
    }
    if (isSohuLoggedIn(cookies, pageState)) return { cookies, pageState, reauthenticated: false };

    notifySohuStep(input, "wait_login", {
      currentUrl: pageState.url,
      pageTitle: pageState.title
    });
    notifyPublishProgress(input, {
      type: "manual_verification_required",
      platform: "sohu",
      message: "搜狐号登录态已失效，请在弹出的搜狐窗口完成登录，登录成功后会自动继续发布。",
      currentUrl: pageState.url
    });
    await bringToFrontIfAllowed(page, input);

    const login = await this.waitForLogin(
      context,
      page,
      Number(input.waitLoginMs || DEFAULT_WAIT_LOGIN_MS),
      Number(input.loginPollMs || 1500)
    );
    if (!login) throw new Error("SOHU_LOGIN_REQUIRED");
    const refreshedCookies = login.cookies;

    await this.reportCredentialRefresh(input, context, page).catch((error) => {
      notifySohuStep(input, "credential_refresh_failed", {
        errorMessage: error instanceof Error ? error.message : String(error)
      });
    });
    notifySohuStep(input, "login_restored", {
      currentUrl: typeof page.url === "function" ? page.url() : ""
    });

    await page.goto(input.editorUrl || SOHU_EDITOR_URL, { waitUntil: "domcontentloaded" });
    await bringToFrontIfAllowed(page, input);
    await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
    await ensureSohuEditorPage(page, publishInput.draftTimeoutMs);
    pageState = await readSohuPageState(page);
    if (isSohuClientAuthPage(pageState)) {
      const settled = await settleSohuVerificationGate(page, input, { startedAt, stage: "verify_login" });
      if (settled === "cleared") {
        await reopenSohuEditorAfterGate(page, input, publishInput);
        pageState = await readSohuPageState(page);
      }
      if (isSohuClientAuthPage(pageState)) throw sohuClientAuthVerificationError(input, pageState);
    }
    return { cookies: refreshedCookies, pageState, reauthenticated: true };
  }
  async publishArticle(input = {}) {
    return withSohuTimeout(this.publishArticleUnsafe(input), Number(input.operationTimeoutMs || 180000), "publish_article");
  }

  async discoverPublication(input = {}) {
    const context = await this.launchAuthEnvironment(input);
    const page = context.pages()[0] || await context.newPage();
    try {
      return await inspectSohuPublicArticle(page, input);
    } finally {
      await this.refreshCredentialAfterOperation(input, context, page, SOHU_MANAGE_URL);
      if (!input.keepBrowserOpen) await context.close().catch(() => undefined);
    }
  }

  async publishArticleUnsafe(input = {}) {
    const publishInput = normalizeSohuPublishInput(input);
    const context = await this.launchAuthEnvironment(input);
    const page = context.pages()[0] || await context.newPage();
    const keepOpen = Boolean(input.keepBrowserOpen);
    const publishWatcher = watchSohuPublishApiResponses(page);
    const publishStartedAt = Date.now();
    try {
      page.setDefaultTimeout?.(15000);
      page.setDefaultNavigationTimeout?.(45000);
      if (shouldPublishSohuViaApi(input, publishInput)) {
        notifySohuStep(input, "api_publish_attempt");
        return await publishSohuViaApi(page, input, publishInput);
      }
      notifySohuStep(input, "open_editor");
      await page.goto(input.editorUrl || SOHU_EDITOR_URL, { waitUntil: "domcontentloaded" });
      await bringToFrontIfAllowed(page, input);
      await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
      const landedUrl = typeof page.url === "function" ? page.url() : "";
      if (isSohuClientAuthPage({ url: landedUrl })) {
        const settled = await settleSohuVerificationGate(page, input, { startedAt: publishStartedAt, stage: "open_editor" });
        if (settled === "cleared") await reopenSohuEditorAfterGate(page, input, publishInput);
        const reopenedUrl = typeof page.url === "function" ? page.url() : "";
        if (isSohuClientAuthPage({ url: reopenedUrl })) throw sohuClientAuthVerificationError(input, { url: reopenedUrl });
      }
      await ensureSohuEditorPage(page, publishInput.draftTimeoutMs);

      notifySohuStep(input, "verify_login", { currentUrl: typeof page.url === "function" ? page.url() : "" });
      await this.ensureLoggedInForPublish(input, context, page, publishInput, publishStartedAt);

      // Close "草稿 / 继续编辑" recovery chip so we write a fresh article, not hang on empty shell.
      const dismissedDraft = await dismissSohuDraftRecoveryBanner(page).catch(() => ({ dismissed: false }));
      notifySohuStep(input, "draft_recovery_dismissed", dismissedDraft || {});
      await page.waitForTimeout?.(500).catch(() => undefined);
      await waitForSohuEditorReady(page, 8000).catch(() => undefined);

      notifySohuStep(input, "fill_article");
      await fillSohuTitle(page, publishInput.title);
      notifySohuStep(input, "title_filled", { title: publishInput.title });
      await fillSohuBody(page, publishInput.content, publishInput.richHtml);
      notifySohuStep(input, "body_filled", await readSohuEditorSnapshot(page));
      let uploadedImages = publishInput.platformImageTasks.length
        ? await uploadSohuInlineImages(page, publishInput.platformImageTasks, { onProgress: input.onProgress })
        : [];
      if (uploadedImages.length) {
        notifySohuStep(input, "inline_images_native_uploaded", {
          expectedCount: uploadedImages.length,
          ...(await readSohuEditorSnapshot(page)),
        });
        let committedImages;
        try {
          committedImages = await commitSohuUploadedImagesToEditor(page, publishInput, uploadedImages, { onProgress: input.onProgress });
        } catch (error) {
          const debug = await writeSohuCoverUploadDebugSnapshot(page, "inline-images-not-committed");
          const editorSnapshot = await readSohuEditorSnapshot(page);
          notifySohuStep(input, "inline_images_commit_failed", {
            errorMessage: String(error?.message || error),
            ...editorSnapshot,
            screenshotPath: debug.screenshotPath,
            jsonPath: debug.jsonPath,
            currentUrl: debug.currentUrl,
          });
          throw error;
        }
        notifySohuStep(input, "inline_images_committed_to_quill", committedImages);
      }
      notifySohuStep(input, "editor_before_save", await readSohuEditorSnapshot(page));
      const preSaveEditorSnapshot = await ensureSohuEditorContent(page, htmlToPlainText(publishInput.richHtml || "") || publishInput.content, "SOHU_BODY_NOT_COMMITTED");
      notifySohuStep(input, "editor_ready_to_save", preSaveEditorSnapshot);
      await fillSohuAbstract(page, publishInput.summary);
      notifySohuStep(input, "configure_publication");
      let publicationConfigEvidence;
      try {
        publicationConfigEvidence = await configureSohuPublication(page, publishInput, {
          timeoutMs: publishInput.draftTimeoutMs,
          onProgress: input.onProgress,
          gateContext: { input, startedAt: publishStartedAt }
        });
      } catch (error) {
        const acceptedFromManagement = await resolveSohuAcceptedManagementFallback(page, publishInput, {});
        if (acceptedFromManagement) {
          notifySohuStep(input, "management_review_accepted", acceptedFromManagement.managementEvidence || {});
          return acceptedFromManagement;
        }
        throw error;
      }
      notifySohuStep(input, "publication_configured", publicationConfigEvidence);
      notifySohuStep(input, "save_draft");
      await clickSohuDraftSave(page, publishInput.draftTimeoutMs);
      const savedDraftUrl = await waitForSohuDraftUrl(page, publishWatcher.state, Math.min(publishInput.draftTimeoutMs, 15000));
      const draftUrl = savedDraftUrl || (typeof page.url === "function" ? page.url() : SOHU_EDITOR_URL);
      notifySohuStep(input, "draft_saved", { draftUrl, newsId: publishWatcher.state.newsId || "" });
      input.evidenceSink?.({
        draftUrl,
        ...(publishWatcher.state.newsId ? { externalIds: { newsId: publishWatcher.state.newsId } } : {}),
        platformStatus: "draft_saved"
      });
      let draftImages = [];
      if (publishInput.platformImageTasks.length) {
        await input.onProgress?.({ type: "verifying_draft_images", total: publishInput.platformImageTasks.length });
        await page.goto(draftUrl, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
        notifySohuStep(input, "draft_edit_mode_before", await readSohuDraftEditModeSnapshot(page));
        await ensureSohuDraftEditMode(page);
        notifySohuStep(input, "draft_edit_mode_after", await readSohuDraftEditModeSnapshot(page));
        try {
          draftImages = await verifyPlatformImages({
            tasks: publishInput.platformImageTasks,
            readImages: () => readLocatorImages(page, ".ql-editor:visible img"),
            stage: "draft",
            timeoutMs: 30000,
            pollMs: 1000,
          });
        } catch (error) {
          if (!/DRAFT_IMAGE_MISSING/.test(String(error?.message || error))) throw error;
          const existingDraftImages = await readLocatorImages(page, ".ql-editor:visible img");
          const existingCount = existingDraftImages.filter((image) => /^https?:\/\//i.test(String(image.platformImageUrl || "")) && image.loaded !== false).length;
          const remainingTasks = publishInput.platformImageTasks.slice(Math.min(existingCount, publishInput.platformImageTasks.length));
          const retryTasks = remainingTasks.length ? remainingTasks : publishInput.platformImageTasks;
          notifySohuStep(input, "draft_images_retry_start", {
            existingCount,
            retryCount: retryTasks.length,
            expectedCount: publishInput.platformImageTasks.length,
          });
          const retryUploadedImages = await uploadSohuInlineImages(page, retryTasks, { onProgress: input.onProgress });
          uploadedImages = [...uploadedImages, ...retryUploadedImages];
          notifySohuStep(input, "draft_images_retry_uploaded", await readSohuEditorSnapshot(page));
          const retryCommittedImages = await commitSohuUploadedImagesToEditor(page, publishInput, uploadedImages, { timeoutMs: 15000 });
          notifySohuStep(input, "draft_images_retry_committed_to_quill", retryCommittedImages);
          await clickSohuDraftSave(page, publishInput.draftTimeoutMs);
          const retryDraftUrl = await waitForSohuDraftUrl(page, publishWatcher.state, Math.min(publishInput.draftTimeoutMs, 15000));
          await page.goto(retryDraftUrl || draftUrl, { waitUntil: "domcontentloaded" });
          await page.waitForLoadState?.("networkidle", { timeout: 15000 }).catch(() => undefined);
          await ensureSohuDraftEditMode(page);
          notifySohuStep(input, "draft_images_retry_saved", await readSohuEditorSnapshot(page));
          draftImages = await verifyPlatformImages({
            tasks: publishInput.platformImageTasks,
            readImages: () => readLocatorImages(page, ".ql-editor:visible img"),
            stage: "draft",
            timeoutMs: 30000,
            pollMs: 1000,
          });
        }
      }
      const draftImageEvidence = publishInput.platformImageTasks.length
        ? buildImagePublicationEvidence(publishInput.platformImageTasks, uploadedImages, draftImages, [], PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED)
        : undefined;

      if (publishInput.confirmPublish && hasSohuPublicationConfigInput(publishInput)) {
        notifySohuStep(input, "configure_publication_before_publish");
        let finalPublicationConfig;
        try {
          finalPublicationConfig = await ensureSohuPublicationConfig(page, publishInput, {
            timeoutMs: 60000,
            gateContext: { input, startedAt: publishStartedAt }
          });
        } catch (error) {
          const acceptedFromManagement = await resolveSohuAcceptedManagementFallback(page, publishInput, {
            draftUrl,
            publicationConfigEvidence,
            draftImageEvidence,
          });
          if (acceptedFromManagement) {
            notifySohuStep(input, "management_review_accepted", acceptedFromManagement.managementEvidence || {});
            return acceptedFromManagement;
          }
          throw error;
        }
        publicationConfigEvidence = {
          ...publicationConfigEvidence,
          ...finalPublicationConfig,
        };
        notifySohuStep(input, "publication_configured", {
          phase: "before_publish",
          ...finalPublicationConfig,
        });
      }

      notifySohuStep(input, "check_draft_blockers", { draftUrl });
      const draftBlocker = await readSohuPlatformBlocker(page);
      if (draftBlocker || publishWatcher.state.blocker) {
        const settled = await settleSohuPublishBlocker(page, input, publishWatcher, {
          startedAt: publishStartedAt,
          stage: "check_draft_blockers",
          resumeUrl: draftUrl
        });
        if (settled !== "cleared") {
          notifyPublishProgress(input, {
            type: "manual_verification_required",
            platform: "sohu",
            message: "搜狐号需要人工处理验证、原创声明、发布上限或敏感词提示。",
            currentUrl: typeof page.url === "function" ? page.url() : ""
          });
          throw new Error(draftBlocker || "SOHU_MANUAL_ACTION_REQUIRED");
        }
      }

      if (!publishInput.confirmPublish) {
        return {
          draftUrl,
          publishedUrl: "",
          platformStatus: "draft_saved",
          title: publishInput.title,
          publicationConfigEvidence: buildSohuPublicationConfigEvidence(publishInput, publicationConfigEvidence),
          ...(draftImageEvidence ? { imagePublicationEvidence: draftImageEvidence } : {}),
        };
      }

      notifySohuStep(input, "click_publish", { draftUrl });
      await clickSohuPublish(page, publishInput.publishTimeoutMs, publishWatcher.state);
      await page.waitForLoadState?.("networkidle", { timeout: publishInput.publishTimeoutMs }).catch(() => undefined);
      await page.waitForTimeout?.(3000).catch(() => undefined);

      notifySohuStep(input, "check_publish_blockers", { currentUrl: typeof page.url === "function" ? page.url() : "" });
      const publishBlocker = await readSohuPlatformBlocker(page);
      if (publishBlocker || publishWatcher.state.blocker) {
        // The publish click already happened, so stay on whatever page Sohu
        // redirected to rather than navigating back and publishing twice.
        const settled = await settleSohuPublishBlocker(page, input, publishWatcher, {
          startedAt: publishStartedAt,
          stage: "check_publish_blockers"
        });
        if (settled !== "cleared") {
          notifyPublishProgress(input, {
            type: "manual_verification_required",
            platform: "sohu",
            message: "搜狐号发布被平台验证或审核提示拦截，请在弹出的浏览器窗口中处理后重试。",
            currentUrl: typeof page.url === "function" ? page.url() : ""
          });
          throw new Error(publishBlocker || "SOHU_MANUAL_ACTION_REQUIRED");
        }
      }
      notifySohuStep(input, "confirm_dialogs");
      await confirmSohuPostPublishDialogs(page, Math.min(publishInput.publishTimeoutMs, 10000));
      notifySohuStep(input, "read_result", { currentUrl: typeof page.url === "function" ? page.url() : "" });
      const confirmedBlocker = await readSohuPlatformBlocker(page);
      if (confirmedBlocker || publishWatcher.state.blocker) {
        const settled = await settleSohuPublishBlocker(page, input, publishWatcher, {
          startedAt: publishStartedAt,
          stage: "confirm_publish_blockers"
        });
        if (settled !== "cleared") {
          notifyPublishProgress(input, {
            type: "manual_verification_required",
            platform: "sohu",
            message: "搜狐号发布确认后仍需要人工处理平台验证、审核或敏感词提示。",
            currentUrl: typeof page.url === "function" ? page.url() : ""
          });
          throw new Error(confirmedBlocker || "SOHU_MANUAL_ACTION_REQUIRED");
        }
      }

      const publishedUrl = publishWatcher.state.publishedUrl || await readSohuPublishedUrl(page);
      if (!publishedUrl) {
        const acceptedFromManagement = await resolveSohuAcceptedManagementFallback(page, publishInput, {
          draftUrl,
          publicationConfigEvidence,
          draftImageEvidence,
          poll: true,
          pollAttempts: 3,
          pollDelayMs: 1500,
        });
        if (acceptedFromManagement) {
          notifySohuStep(input, "management_review_accepted", acceptedFromManagement.managementEvidence || {});
          return acceptedFromManagement;
        }
        if (publishWatcher.state.publishAccepted || draftUrl) {
          const reviewUrl = publishWatcher.state.draftUrl || draftUrl;
          const platformStatus = publishWatcher.state.publishAccepted ? "submitted_for_review" : "draft_saved";
          return {
            draftUrl: reviewUrl,
            publishedUrl: "",
            reviewUrl,
            platformStatus,
            publiclyVisible: false,
            reviewStatus: platformStatus === "submitted_for_review" ? "pending_public_visibility" : "",
            message: platformStatus === "submitted_for_review"
              ? "搜狐号已触发发布，但公开 URL 尚未返回，等待平台审核或公开延迟后复验。"
              : "搜狐号已保存草稿，但本次未捕捉到公开发布确认，等待人工确认或重新发布。",
            title: publishInput.title,
            publicationConfigEvidence: buildSohuPublicationConfigEvidence(publishInput, publicationConfigEvidence),
            ...(draftImageEvidence ? { imagePublicationEvidence: draftImageEvidence } : {}),
          };
        }
        throw new Error(publishWatcher.state.publishAttempted || publishWatcher.state.newsId
          ? "SOHU_PUBLISH_NOT_CONFIRMED"
          : "SOHU_PUBLISHED_URL_NOT_FOUND");
      }
      let publicImages = [];
      let publicBlocker = "";
      if (publishInput.platformImageTasks.length) {
        await input.onProgress?.({ type: "verifying_public_images", total: publishInput.platformImageTasks.length });
        const publicEvidence = await verifyPublicPageImages(
          context,
          publishedUrl,
          publishInput.platformImageTasks,
          "article img, .article-content img, .text img",
        ).catch(() => ({ images: [], blocker: "SOHU_PUBLIC_IMAGE_VERIFICATION_FAILED" }));
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
        title: publishInput.title,
        publicationConfigEvidence: buildSohuPublicationConfigEvidence(publishInput, publicationConfigEvidence),
        ...(imagePublicationEvidence ? { imagePublicationEvidence } : {}),
      };
    } finally {
      publishWatcher.dispose();
      await this.refreshCredentialAfterOperation(input, context, page, SOHU_EDITOR_URL);
      if (!keepOpen) {
        await context.close().catch(() => undefined);
      }
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
