import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { SohuAdapter } from "../apps/desktop/src/adapters/sohu.mjs";

const profileKey = process.argv[2];
if (!profileKey) throw new Error("SOHU_PROFILE_KEY_REQUIRED");
const targetUrl = process.argv[3] || "https://mp.sohu.com/mpfe/v4/main#/contentManagement/news/addarticle?contentStatus=1";
const directMode = ["semantic", "save", "readonly", "continue"].includes(process.argv[4]) ? process.argv[4] : "";
const imagePath = directMode ? "" : process.argv[4] || "";
const mediaAccountId = process.env.SOHU_MEDIA_ACCOUNT_ID || "";

function decodeArtifactEnvelope(artifact = {}, fields = [], prefix = "") {
  const envelope = String(fields.map((field) => artifact[field]).find(Boolean) || "");
  if (!envelope.startsWith(prefix)) return prefix.includes("storage") ? {} : [];
  const payload = JSON.parse(Buffer.from(envelope.slice(prefix.length), "base64url").toString("utf8"));
  if (Array.isArray(payload.cookies)) return payload.cookies;
  return payload.values && typeof payload.values === "object" ? payload.values : {};
}

async function loadCurrentAccountArtifact(accountId) {
  if (!accountId) return { cookies: [], localStorage: {}, sessionStorage: {} };
  const statePath = path.join(process.env.USERPROFILE, ".zhixin-ai", "desktop-agent.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const apiBaseUrl = String(state.apiBaseUrl || "http://127.0.0.1:8000").replace(/\/$/, "");
  const response = await fetch(`${apiBaseUrl}/api/desktop-devices/${encodeURIComponent(state.device.id)}/media-accounts/${encodeURIComponent(accountId)}/artifact`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceToken: state.deviceToken }),
  });
  if (!response.ok) throw new Error(`SOHU_ARTIFACT_HTTP_${response.status}`);
  const detail = await response.json();
  const artifact = detail.artifact || {};
  return {
    profileKey: String(detail.profileKey || profileKey),
    cookies: decodeArtifactEnvelope(artifact, ["encryptedCookies", "cookies"], "encrypted-cookie-"),
    localStorage: decodeArtifactEnvelope(artifact, ["encryptedLocalStorage", "localStorage"], "encrypted-local-storage-"),
    sessionStorage: decodeArtifactEnvelope(artifact, ["encryptedSessionStorage", "sessionStorage"], "encrypted-session-storage-"),
  };
}

const outputMode = directMode || process.argv[5] || "full";

const adapter = new SohuAdapter();
const authArtifact = await loadCurrentAccountArtifact(mediaAccountId);
const context = await adapter.launchAuthEnvironment({
  profileRoot: path.join(process.env.USERPROFILE, ".zhixin-ai", "profiles"),
  profileKey: authArtifact.profileKey || profileKey,
  cookies: authArtifact.cookies,
  localStorage: authArtifact.localStorage,
  sessionStorage: authArtifact.sessionStorage,
  headless: process.env.SOHU_PROBE_HEADLESS !== "0",
});
const page = context.pages()[0] || await context.newPage();
const diagnostics = [];
const responseDiagnostics = [];
const requestDiagnostics = [];
page.on("console", (message) => diagnostics.push({ type: "console", text: message.text().slice(0, 500) }));
page.on("pageerror", (error) => diagnostics.push({ type: "pageerror", text: String(error).slice(0, 500) }));
page.on("requestfailed", (request) => diagnostics.push({
  type: "requestfailed",
  url: request.url(),
  text: request.failure()?.errorText || "",
}));
page.on("request", (request) => {
  const url = request.url();
  if (!/mpbp|draft|news|content/i.test(url)) return;
  const postData = request.postData() || "";
  requestDiagnostics.push({ url, method: request.method(), postData: postData.slice(0, 5000) });
});
page.on("response", async (response) => {
  const url = response.url();
  if (!/mpbp|draft|news|content/i.test(url)) return;
  const contentType = response.headers()["content-type"] || "";
  const body = /json|text/i.test(contentType) ? await response.text().catch(() => "") : "";
  responseDiagnostics.push({ url, status: response.status(), body: body.slice(0, 1200) });
});

try {
  const navigation = await page.goto(targetUrl, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(12000);
  const before = await snapshot(page);
  const entry = page.locator("button.publish-btn").first();
  if (!(await hasEditor(page)) && await entry.isVisible().catch(() => false)) {
    await entry.click();
    await page.waitForTimeout(8000);
  }
  const after = await snapshot(page);
  let imageDialog = null;
  let uploadedImageDialog = null;
  let coverDialog = null;
  let uploadedCoverDialog = null;
  const imageButton = page.locator("button.ql-image, .ql-toolbar .ql-image").first();
  if (!["cover", "save", "readonly", "continue"].includes(outputMode) && await imageButton.isVisible().catch(() => false)) {
    await imageButton.click();
    await page.waitForTimeout(1200);
    imageDialog = await dialogSnapshot(page);
    if (imagePath) {
      await page.locator("input[type='file'][accept*='image'], input[type='file']").last().setInputFiles(imagePath);
      await page.waitForTimeout(5000);
      uploadedImageDialog = await dialogSnapshot(page);
    }
  }
  if (outputMode === "cover") {
    await page.locator(".cover-button").first().click();
    await page.waitForTimeout(1000);
    coverDialog = await dialogSnapshot(page);
    if (imagePath) {
      await page.getByText("\u672c\u5730\u4e0a\u4f20", { exact: true }).last().click();
      await page.waitForTimeout(500);
      await page.locator("input[type='file']").last().setInputFiles(imagePath);
      await page.waitForTimeout(5000);
      uploadedCoverDialog = await dialogSnapshot(page);
    }
  }
  if (outputMode === "save") {
    await page.locator("input[placeholder*='\u6807\u9898']").first().fill("\u667a\u5fc3AI\u641c\u72d0\u8349\u7a3f\u63a5\u53e3\u63a2\u9488 2026-07-14");
    await page.locator(".ql-editor[contenteditable='true']").first().fill("\u8fd9\u662f\u641c\u72d0\u53f7\u8349\u7a3f\u4fdd\u5b58\u63a5\u53e3\u7684\u53ea\u8bfb\u8bc1\u636e\u63a2\u9488\uff0c\u4e0d\u4f1a\u6267\u884c\u516c\u5f00\u53d1\u5e03\u3002");
    responseDiagnostics.length = 0;
    await page.locator("li.publish-report-btn.normal.negative-button:has-text('\u5b58\u8349\u7a3f')").first().click();
    await page.waitForTimeout(6000);
  }
  if (outputMode === "continue") {
    const continueButton = page.locator("li:has-text('继续编辑'), button:has-text('继续编辑'), [role='button']:has-text('继续编辑'), .positive-button:has-text('继续编辑')").first();
    if (await continueButton.isVisible().catch(() => false)) {
      await continueButton.click().catch(() => undefined);
      await page.waitForTimeout(5000);
    }
  }
  const outputDir = path.join(process.cwd(), "docs", "verification", "artifacts");
  await mkdir(outputDir, { recursive: true });
  const screenshotPath = path.join(outputDir, "sohu-editor-probe.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const result = {
    navigationStatus: navigation?.status() || 0,
    before,
    after,
    imageDialog,
    uploadedImageDialog,
    coverDialog,
    uploadedCoverDialog,
    diagnostics: diagnostics.slice(0, 80),
    requestDiagnostics,
    responseDiagnostics,
    screenshotPath,
  };
  console.log(JSON.stringify(outputMode === "semantic" ? {
    navigationStatus: result.navigationStatus,
    url: after.url,
    semanticTargets: after.semanticTargets,
    fileInputs: after.controls.filter((control) => control.type === "file"),
  } : outputMode === "save" ? {
    url: page.url(),
    requestDiagnostics,
    responseDiagnostics,
  } : outputMode === "readonly" ? {
    navigationStatus: result.navigationStatus,
    before,
    after,
    diagnostics: diagnostics.slice(0, 80),
    requestDiagnostics,
    responseDiagnostics,
    screenshotPath,
  } : outputMode === "continue" ? {
    navigationStatus: result.navigationStatus,
    before,
    after: await snapshot(page),
    diagnostics: diagnostics.slice(0, 80),
    requestDiagnostics,
    responseDiagnostics,
    screenshotPath,
  } : result, null, 2));
} finally {
  await context.close();
}

async function dialogSnapshot(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const dialogs = Array.from(document.querySelectorAll(".el-dialog, .el-drawer, [role='dialog']"))
      .filter(visible);
    const roots = dialogs.length ? dialogs : [document.body];
    return {
      text: roots.map((root) => root.innerText || "").join("\n").slice(0, 4000),
      controls: roots.flatMap((root) => Array.from(root.querySelectorAll([
        "input",
        "button",
        "[role='button']",
        "a",
        "li",
        "span[class*='button']",
        "div[class*='button']",
        "span[class*='btn']",
        "div[class*='btn']",
        ".positive-button",
        ".negative-button",
        ".el-button",
        ".confirm-button",
        ".confirm-btn",
        ".primary",
        ".btn-primary"
      ].join(","))))
        .filter(visible)
        .filter((element, index, list) => list.indexOf(element) === index)
        .map((element) => ({
          tag: element.tagName,
          type: element.getAttribute("type") || "",
          accept: element.getAttribute("accept") || "",
          role: element.getAttribute("role") || "",
          ariaLabel: element.getAttribute("aria-label") || "",
          className: String(element.className || ""),
          text: (element.innerText || element.textContent || "").trim().slice(0, 120),
          rect: (() => {
            const rect = element.getBoundingClientRect();
            return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
          })(),
        })),
      images: roots.flatMap((root) => Array.from(root.querySelectorAll("img")))
        .filter(visible)
        .map((element) => ({ src: element.currentSrc || element.src || "", className: String(element.className || "") })),
    };
  });
}

async function hasEditor(page) {
  return page.locator("textarea, input, [contenteditable='true']").count().then((count) => count > 0);
}

async function snapshot(page) {
  return page.evaluate(() => ({
    url: location.href,
    title: document.title,
    bodyText: (document.body?.innerText || "").slice(0, 3000),
    titleFields: Array.from(document.querySelectorAll("input, textarea, [contenteditable='true']"))
      .filter((element) => /标题|title/i.test(`${element.getAttribute("placeholder") || ""} ${element.getAttribute("name") || ""} ${element.getAttribute("class") || ""}`))
      .map((element) => ({
        tag: element.tagName,
        className: String(element.className || ""),
        placeholder: element.getAttribute("placeholder") || "",
        value: element.value || element.textContent || "",
      })).slice(0, 10),
    editors: Array.from(document.querySelectorAll(".ql-editor, [contenteditable='true']"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          tag: element.tagName,
          className: String(element.className || ""),
          visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0,
          rect: { width: Math.round(rect.width), height: Math.round(rect.height) },
          text: (element.innerText || element.textContent || "").slice(0, 1000),
          html: (element.innerHTML || "").slice(0, 2000),
          images: Array.from(element.querySelectorAll("img")).map((image) => ({
            src: image.currentSrc || image.src || image.getAttribute("src") || "",
            alt: image.getAttribute("alt") || "",
            complete: image instanceof HTMLImageElement ? image.complete : true,
            naturalWidth: image instanceof HTMLImageElement ? image.naturalWidth : 0,
          })).slice(0, 20),
        };
      }).slice(0, 20),
    pageImages: Array.from(document.querySelectorAll("img"))
      .map((image) => ({
        src: image.currentSrc || image.src || image.getAttribute("src") || "",
        alt: image.getAttribute("alt") || "",
        className: String(image.className || ""),
        text: (image.closest("div,li,section")?.innerText || "").slice(0, 200),
        complete: image instanceof HTMLImageElement ? image.complete : true,
        naturalWidth: image instanceof HTMLImageElement ? image.naturalWidth : 0,
      })).slice(0, 60),
    controls: Array.from(document.querySelectorAll("input, textarea, [contenteditable='true'], button, [role='button']"))
      .slice(0, 120)
      .map((element) => ({
        tag: element.tagName,
        type: element.getAttribute("type") || "",
        name: element.getAttribute("name") || "",
        placeholder: element.getAttribute("placeholder") || "",
        className: String(element.className || ""),
        role: element.getAttribute("role") || "",
        text: (element.innerText || element.textContent || "").trim().slice(0, 120),
      })),
    semanticTargets: Array.from(document.querySelectorAll("body *"))
      .filter((element) => ["\u4e0a\u4f20\u56fe\u7247", "\u5305\u542bAI\u521b\u4f5c\u5185\u5bb9", "\u65e0\u7279\u522b\u58f0\u660e", "\u672a\u9009\u62e9", "\u5173\u8054\u680f\u76ee", "\u53d1\u5e03", "\u5b58\u8349\u7a3f"].includes((element.textContent || "").trim()))
      .slice(0, 40)
      .map((element) => ({
        tag: element.tagName,
        className: String(element.className || ""),
        text: (element.textContent || "").trim(),
        html: (element.parentElement?.outerHTML || element.outerHTML || "").slice(0, 1200),
      })),
  }));
}
