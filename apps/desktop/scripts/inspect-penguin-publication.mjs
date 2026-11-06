import { getAdapter } from "../src/adapters/index.mjs";
import { findPenguinPublicationFromManagement } from "../src/adapters/penguin.mjs";

const expectedTitle = process.argv.slice(2).join(" ").trim();
if (!expectedTitle) throw new Error("Expected article title");

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
  const publicUrl = await findPenguinPublicationFromManagement(page, {
    articleTitle: expectedTitle,
  });
  const snapshot = await page.evaluate((title) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const wanted = clean(title).replace(/\s+/g, "").toLowerCase();
    const rows = [...document.querySelectorAll("tr, .list-item, [class*='article'], [class*='content-item']")]
      .map((row) => ({
        text: clean(row.textContent || "").slice(0, 500),
        links: [...row.querySelectorAll("a[href]")].map((link) => ({
          text: clean(link.textContent || link.getAttribute("title") || ""),
          href: link.href || link.getAttribute("href") || "",
        })).slice(0, 8),
      }))
      .filter((row) => {
        const normalized = row.text.replace(/\s+/g, "").toLowerCase();
        return wanted && (normalized.includes(wanted) || wanted.includes(normalized.slice(0, 16)));
      })
      .slice(0, 10);
    return {
      currentUrl: location.href,
      pageTitle: document.title,
      pageText: clean(document.body?.innerText || "").slice(0, 2000),
      matchingRows: rows,
    };
  }, expectedTitle);
  console.log(JSON.stringify({ publicUrl, ...snapshot }, null, 2));
} finally {
  await context.close().catch(() => undefined);
}
