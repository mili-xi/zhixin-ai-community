import { getAdapter } from "../src/adapters/index.mjs";

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
const saves = [];
page.on("response", async (response) => {
  const url = response.url();
  if (!/\/pcui\/article\/(save|draft|edit)/i.test(url)) return;
  const payload = await response.json().catch(() => ({}));
  const ids = [];
  const collect = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(id|nid|article_id|articleId|articleid)$/i.test(key) && ["string", "number"].includes(typeof child)) {
        ids.push({ key, value: String(child) });
      } else if (child && typeof child === "object") collect(child);
    }
  };
  collect(payload);
  saves.push({ url: url.replace(/[?#].*$/, ""), status: response.status(), keys: Object.keys(payload), ids });
});

try {
  await page.goto("https://baijiahao.baidu.com/builder/rc/edit?type=news", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => undefined);
  await page.waitForTimeout(3000);
  const readEditor = () => page.evaluate(() => {
    const title = String(document.querySelector("#newsTextArea [contenteditable='true']")?.textContent || "").trim();
    const body = document.querySelector("iframe#ueditor_0")?.contentDocument?.body;
    return {
      url: location.href,
      title,
      htmlLength: body?.innerHTML.length || 0,
      images: [...(body?.querySelectorAll("img") || [])].map((image) => ({
        src: image.getAttribute("src") || "",
        originSrc: image.getAttribute("data-bjh-origin-src") || "",
        loaded: image.complete && image.naturalWidth > 0,
      })),
    };
  });
  const before = await readEditor();
  const saveButton = page.getByRole("button", { name: /存草稿/ }).first();
  if (await saveButton.isVisible().catch(() => false)) {
    await saveButton.click();
    await page.waitForTimeout(5000);
  }
  const after = await readEditor();
  console.log(JSON.stringify({ before, after, saves }, null, 2));
} finally {
  await context.close().catch(() => undefined);
}
