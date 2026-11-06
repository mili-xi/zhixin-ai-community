import { getAdapter } from "../src/adapters/index.mjs";
import { readPenguinEditorImages } from "../src/adapters/penguin.mjs";

const apiBaseUrl = process.env.ZHIXIN_API_BASE_URL || "http://127.0.0.1:8000";
const profileRoot = process.env.ZHIXIN_PROFILE_ROOT
  || `${process.env.USERPROFILE}\\.zhixin-ai\\profiles`;
const accounts = await fetch(`${apiBaseUrl}/api/media-accounts`).then((response) => response.json());
const account = accounts.find((item) => item.platform === "penguin" && item.status === "active")
  || accounts.find((item) => item.platform === "penguin");
if (!account) throw new Error("No Penguin account is available");

const adapter = getAdapter("penguin");
const context = await adapter.launchAuthEnvironment({
  profileRoot,
  profileKey: account.profileKey || account.id,
  mediaAccountId: account.id,
  headless: true,
});
const page = context.pages()[0] || await context.newPage();
try {
  await page.goto("https://om.qq.com/main/creation/article", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout(2500);
  const snapshot = await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const controls = [...document.querySelectorAll("button, [role='button'], a")]
      .filter(visible)
      .map((element) => ({
        tag: element.tagName,
        text: clean(element.textContent || element.getAttribute("aria-label") || element.getAttribute("title") || ""),
        className: clean(element.className),
        disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
      }))
      .filter((item) => item.text || /save|publish|draft|button/i.test(item.className))
      .slice(0, 120);
    const editables = [...document.querySelectorAll("input, textarea, [contenteditable='true']")]
      .filter(visible)
      .map((element) => ({
        tag: element.tagName,
        className: clean(element.className),
        placeholder: clean(element.getAttribute("placeholder") || element.getAttribute("data-placeholder") || element.getAttribute("aria-label") || ""),
        text: clean(element.value || element.textContent || "").slice(0, 160),
      }))
      .slice(0, 80);
    return {
      currentUrl: location.href,
      pageTitle: document.title,
      bodyText: clean(document.body?.innerText || "").slice(0, 3000),
      controls,
      editables,
    };
  });
  const imageReadStartedAt = Date.now();
  const editorImages = await readPenguinEditorImages(page);
  console.log(JSON.stringify({
    ...snapshot,
    imageReadDurationMs: Date.now() - imageReadStartedAt,
    editorImages: editorImages.map((image) => ({
      platformImageUrl: image.platformImageUrl,
      loaded: image.loaded,
    })),
  }, null, 2));
} finally {
  await context.close().catch(() => undefined);
}
