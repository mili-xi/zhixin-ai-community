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
const responses = [];
page.on("response", async (response) => {
  const url = response.url();
  if (!/qq\.com|gtimg\.com/i.test(url)) return;
  const request = response.request();
  if (!/POST|PUT|PATCH/i.test(request.method())) return;
  const contentType = response.headers()["content-type"] || "";
  let shape = null;
  if (/json|text/i.test(contentType)) {
    const payload = await response.json().catch(() => null);
    if (payload && typeof payload === "object") {
      shape = {
        keys: Object.keys(payload).slice(0, 30),
        code: payload.code ?? payload.ret ?? payload.errCode ?? payload.errno ?? null,
        dataKeys: payload.data && typeof payload.data === "object"
          ? Object.keys(payload.data).slice(0, 30)
          : [],
        dataType: payload.data === null ? "null" : typeof payload.data,
        dataScalar: ["boolean", "number"].includes(typeof payload.data) ? payload.data : null,
        responseKeys: payload.response && typeof payload.response === "object"
          ? Object.keys(payload.response).slice(0, 30)
          : [],
        responseCode: payload.response && typeof payload.response === "object"
          ? payload.response.code ?? payload.response.ret ?? payload.response.errCode ?? null
          : null,
      };
    }
  }
  responses.push({
    method: request.method(),
    url,
    status: response.status(),
    contentType,
    shape,
  });
});

try {
  await page.goto("https://om.qq.com/main/creation/article", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout(2000);
  const save = page.getByRole("button", { name: "存草稿", exact: true }).first();
  await save.click({ timeout: 10000 });
  await page.waitForTimeout(8000);
  console.log(JSON.stringify({
    currentUrl: page.url(),
    pageText: String(await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 800),
    responses,
  }, null, 2));
} finally {
  await context.close().catch(() => undefined);
}
