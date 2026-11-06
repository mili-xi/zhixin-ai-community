import { getAdapter } from "../src/adapters/index.mjs";

const publicUrl = process.argv[2];
const expectedTitle = process.argv.slice(3).join(" ").trim();
if (!publicUrl) throw new Error("Expected public URL");
const apiBaseUrl = process.env.ZHIXIN_API_BASE_URL || "http://127.0.0.1:8000";
const profileRoot = process.env.ZHIXIN_PROFILE_ROOT || `${process.env.USERPROFILE}\\.zhixin-ai\\profiles`;
const accounts = await fetch(`${apiBaseUrl}/api/media-accounts`).then((response) => response.json());
const account = accounts.find((item) => item.platform === "baijiahao" && item.status === "active")
  || accounts.find((item) => item.platform === "baijiahao");
if (!account) throw new Error("No Baijiahao account is available");

const adapter = getAdapter("baijiahao");
const context = await adapter.launchAuthEnvironment({
  profileRoot,
  profileKey: account.profileKey || account.id,
  mediaAccountId: account.id,
  headless: true,
});
const page = context.pages()[0] || await context.newPage();
try {
  const response = await page.goto(publicUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null);
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => undefined);
  await page.waitForTimeout(5000);
  const result = await page.evaluate((title) => {
    const bodyText = String(document.body?.innerText || "").replace(/\s+/g, " ").trim();
    return {
      url: location.href,
      pageTitle: document.title,
      titleMatched: Boolean(title && (document.title.includes(title) || bodyText.includes(title))),
      bodyText: bodyText.slice(0, 1200),
      images: [...document.querySelectorAll("article img, .article-content img, .content img, img")].map((image) => ({
        src: image.getAttribute("src") || "",
        dataSrc: image.getAttribute("data-src") || "",
        loaded: image.complete && image.naturalWidth > 0,
        width: image.naturalWidth,
      })).filter((image) => /baidu|bdstatic|picproxy/i.test(`${image.src} ${image.dataSrc}`)).slice(0, 30),
    };
  }, expectedTitle);
  console.log(JSON.stringify({ httpStatus: response?.status?.() || 0, ...result }, null, 2));
} finally {
  await context.close().catch(() => undefined);
}
