// Intercepted UI contract test: does not create real credentials or posts.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseURL = process.env.MCP_WEB_URL || "http://127.0.0.1:3018";
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  await context.addCookies([{ name: "zhixin_session", value: "mock-ui-session", url: baseURL }]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const tokens = [];
  let created;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const send = (data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (path === "/api/mcp/tokens" && request.method() === "POST") {
      created = request.postDataJSON();
      tokens.push({ id: "mcp-test", ...created, createdAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00Z", revokedAt: "" });
      return send({ ...tokens[0], token: "fixture-secret-once-only" }, 201);
    }
    if (path === "/api/mcp/tokens/mcp-test" && request.method() === "DELETE") {
      tokens[0].revokedAt = new Date().toISOString();
      return route.fulfill({ status: 204 });
    }
    if (path === "/api/mcp/tokens") return send(tokens);
    if (path === "/api/auth/me") return send({ authenticated: true, user: { id: "ui", displayName: "测试用户" } });
    return send([]);
  });
  await page.goto(`${baseURL}/agent-access`);
  await page.getByRole("heading", { name: "自动化接入", exact: true }).waitFor();
  assert.equal(await page.locator("[data-agent-access]").evaluate((element) => getComputedStyle(element).display), "grid", "Tailwind layout must be rendered");
  await page.getByText("尚未创建接入凭据。", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("允许上传和发布视频").isChecked(), false);
  assert.equal(await page.getByLabel("允许上传和发布文章").isChecked(), false);
  await page.getByLabel("凭据名称", { exact: true }).fill("My Codex");
  await page.getByLabel("允许上传和发布视频").check();
  await page.getByLabel("允许上传和发布文章").check();
  await page.getByRole("button", { name: "创建凭据", exact: true }).click();
  const secret = page.getByLabel("新建接入凭据", { exact: true });
  await secret.waitFor();
  assert.deepEqual(created.scopes, ["publish:read", "publish:write", "article:write"]);
  assert.equal(created.expiresInDays, 30);
  assert.equal(await secret.inputValue(), "fixture-secret-once-only");
  assert.ok((await page.getByLabel("MCP 连接配置").innerText()).includes('bearer_token_env_var = "ZHIXIN_MCP_TOKEN"'));
  await page.getByRole("button", { name: "Claude Code", exact: true }).click();
  const config = await page.getByLabel("MCP 连接配置").innerText();
  assert.ok(config.includes("Bearer ${ZHIXIN_MCP_TOKEN}"));
  assert.ok(!config.includes("fixture-secret"));
  await page.getByRole("button", { name: "我已保存，关闭展示", exact: true }).click();
  assert.equal(await secret.count(), 0);
  await page.reload();
  await page.getByRole("button", { name: "撤销 My Codex", exact: true }).waitFor();
  assert.equal(await secret.count(), 0, "reload must never redisplay the secret");
  await page.getByRole("button", { name: "撤销 My Codex", exact: true }).click();
  await page.getByRole("cell", { name: "已撤销", exact: true }).waitFor();
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: ".codex-tmp/mcp-agent-access-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector("aside").getBoundingClientRect().right <= 1);
  await page.evaluate(() => scrollTo(0, 0));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok(await page.locator('[data-agent-access] > section').evaluateAll((cards) => cards.every((card) => card.getBoundingClientRect().right <= innerWidth)), 'mobile cards must fit the viewport, not be clipped by the app shell');
  await page.screenshot({ path: process.env.MCP_UI_SCREENSHOT || ".codex-tmp/mcp-agent-access-mobile.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log("PASS: create scoped credential, one-time secret, Codex/Claude configs, reload secrecy, revoke, mobile layout");
} finally { await browser.close(); }
