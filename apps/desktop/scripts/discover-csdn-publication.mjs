import { getAdapter } from "../src/adapters/index.mjs";

const title = process.argv.slice(2).join(" ").trim();
if (!title) throw new Error("Expected article title");
const apiBaseUrl = process.env.ZHIXIN_API_BASE_URL || "http://127.0.0.1:8000";
const profileRoot = process.env.ZHIXIN_PROFILE_ROOT || `${process.env.USERPROFILE}\\.zhixin-ai\\profiles`;
const accounts = await fetch(`${apiBaseUrl}/api/media-accounts`).then((response) => response.json());
const account = accounts.find((item) => item.platform === "csdn" && item.status === "active")
  || accounts.find((item) => item.platform === "csdn");
if (!account) throw new Error("No CSDN account is available");

const adapter = getAdapter("csdn");
const context = await adapter.launchAuthEnvironment({
  profileRoot,
  profileKey: account.profileKey || account.id,
  mediaAccountId: account.id,
  headless: true,
});
const page = context.pages()[0] || await context.newPage();

try {
  await page.goto("https://mp.csdn.net/mp_blog/manage/article", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => undefined);
  await page.waitForTimeout(4000);
  const result = await page.evaluate((expectedTitle) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const links = [...document.querySelectorAll("a[href]")].map((element) => ({
      text: clean(element.textContent),
      href: element.href,
    })).filter((item) => item.text && /\/article\/details\/\d+/i.test(item.href));
    const rows = [...document.querySelectorAll("tr, [class*='article-item'], [class*='content-item'], li")]
      .map((element) => ({
        text: clean(element.textContent),
        links: [...element.querySelectorAll("a[href]")].map((link) => ({ text: clean(link.textContent), href: link.href })),
      }))
      .filter((item) => item.text.includes(expectedTitle))
      .slice(0, 10);
    return {
      url: location.href,
      pageTitle: document.title,
      bodyText: clean(document.body?.innerText).slice(0, 500),
      links: links.slice(0, 50),
      rows,
      match: links.find((item) => item.text.includes(expectedTitle))
        || rows.flatMap((item) => item.links).find((item) => /\/article\/details\/\d+/i.test(item.href))
        || null,
    };
  }, title);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await context.close().catch(() => undefined);
}
