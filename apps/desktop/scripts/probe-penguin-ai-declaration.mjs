import { getAdapter } from "../src/adapters/index.mjs";

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
  await page.waitForTimeout(2000);
  const trigger = page.locator("a:has-text('点这里'), a:has-text('进行补充'), button:has-text('添加内容自主声明')").first();
  await trigger.click({ timeout: 10000 });
  await page.waitForTimeout(1500);
  const snapshot = await page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const overlays = [...document.querySelectorAll("[role='dialog'], .omui-dialog-wrapper, .ant-modal, [class*='drawer'], [class*='modal']")]
      .filter(visible)
      .map((element) => clean(element.textContent || "").slice(0, 1800));
    const options = [...document.querySelectorAll("label, input, button, [role='radio'], [role='checkbox']")]
      .filter(visible)
      .map((element) => ({
        tag: element.tagName,
        type: element.getAttribute("type") || "",
        text: clean(element.textContent || element.getAttribute("aria-label") || element.getAttribute("value") || ""),
        checked: Boolean(element.checked || element.getAttribute("aria-checked") === "true"),
        className: clean(element.className),
      }))
      .filter((item) => item.text || item.type)
      .slice(-100);
    return { overlays, options };
  });
  console.log(JSON.stringify(snapshot, null, 2));
} finally {
  await context.close().catch(() => undefined);
}
