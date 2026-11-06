import { getAdapter } from "../src/adapters/index.mjs";

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
const saveResponses = [];
page.on("response", async (response) => {
  const url = response.url();
  if (response.request().method() !== "POST" || !/csdn\.net\/.*(save|draft|automatic)/i.test(url)) return;
  const payload = await response.json().catch(() => ({}));
  const ids = [];
  const urls = [];
  const statuses = [];
  const collectIds = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(id|articleId|article_id|blogId|blog_id)$/i.test(key) && ["string", "number"].includes(typeof child)) {
        ids.push({ key, value: String(child) });
      } else if (/url|href|link/i.test(key) && typeof child === "string") {
        urls.push({ key, value: child.slice(0, 300) });
      } else if (/status|state|publish/i.test(key) && ["string", "number", "boolean"].includes(typeof child)) {
        statuses.push({ key, value: String(child) });
      } else if (child && typeof child === "object") collectIds(child);
    }
  };
  collectIds(payload);
  saveResponses.push({
    url: url.replace(/[?#].*$/, ""),
    status: response.status(),
    topLevelKeys: Object.keys(payload),
    ids,
    urls,
    statuses,
  });
});

try {
  await page.goto("https://mp.csdn.net/mp_blog/creation/editor", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => undefined);
  await page.waitForTimeout(2500);
  const recent = await page.evaluate(async () => {
    const response = await fetch("https://bizapi.csdn.net/blog/phoenix/console/v1/article/get-recently-edit", {
      credentials: "include",
    });
    const payload = await response.json().catch(() => ({}));
    const collect = (value, output = []) => {
      if (!value || typeof value !== "object") return output;
      if (!Array.isArray(value) && (value.articleId || value.id) && (value.title || value.articleTitle)) {
        output.push({
          articleId: String(value.articleId || value.id),
          title: String(value.title || value.articleTitle),
          status: String(value.status || value.articleStatus || ""),
        });
      }
      for (const child of Object.values(value)) collect(child, output);
      return output;
    };
    return collect(payload).slice(0, 10);
  });
  const links = await page.locator("a[href*='/mp_blog/creation/editor/']").evaluateAll((elements) => elements.map((element) => ({
    title: String(element.textContent || "").replace(/\s+/g, " ").trim(),
    href: element.href,
  })).filter((item) => item.title));
  const candidate = links.find((item) => item.title.includes("正文图片草稿验收修复版"))
    || links.find((item) => item.title.includes("正文图片草稿验收"))
    || links[0];
  if (!candidate) throw new Error("No recent CSDN draft link is visible");

  await page.goto(candidate.href, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => undefined);
  await page.waitForTimeout(3000);
  const editor = await page.evaluate(() => {
    const instance = window.CKEDITOR?.instances ? Object.values(window.CKEDITOR.instances)[0] : null;
    const html = instance?.getData?.() || document.querySelector("iframe.cke_wysiwyg_frame")?.contentDocument?.body?.innerHTML || "";
    return {
      title: document.querySelector("#txtTitle")?.value || "",
      htmlLength: html.length,
      buttons: [...document.querySelectorAll("button,[role=button]")].filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      }).map((element) => String(element.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 80),
      imageUrls: [...html.matchAll(/<img[^>]+src=["']([^"']+)/gi)]
        .map((match) => match[1])
        .filter((url) => /^https:\/\//i.test(url)),
    };
  });
  const saveButton = page.getByRole("button", { name: /保存草稿/ }).first();
  if (await saveButton.isVisible().catch(() => false)) {
    await saveButton.click();
    await page.waitForTimeout(5000);
  }
  console.log(JSON.stringify({ recent, links: links.slice(0, 10), selected: candidate, editor, saveResponses }, null, 2));
} finally {
  await context.close().catch(() => undefined);
}
