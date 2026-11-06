// Run with a local Next dev server: VIDEO_WEB_URL=http://127.0.0.1:3018 node apps/web/tests/video-publish.smoke.mjs
// Browser/API contract smoke only. All API requests are intercepted; no real publication occurs.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseURL = process.env.VIDEO_WEB_URL || "http://127.0.0.1:3018";
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ timezoneId: "America/Los_Angeles" });
  await context.addCookies([{ name: "zhixin_session", value: "mock-ui-session", url: baseURL }]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let publications = [];
  let supportsScheduled = false;
  const scheduledWallTime = new Date(Date.now() + 11 * 60 * 60 * 1000).toISOString().slice(0, 16);
  const submissions = [];
  let uploadCount = 0;
  let discoveryCount = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const send = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathname === "/api/media-accounts") return send([{ id: "account-1", platform: "douyin", name: "测试抖音", accountName: "测试抖音", status: "active", credentialStatus: "active", fields: [], cookies: "", createdAt: "2026-10-26T00:00:00Z" }]);
    if (pathname === "/api/video-publications/capabilities") return send({ maxVideoBytes: 524288000, maxCoverBytes: 10485760, accounts: [{ mediaAccountId: "account-1", deviceId: "device-1", ready: true, supportsScheduled }] });
    if (pathname === "/api/video-assets/upload") {
      uploadCount++;
      if (request.postDataBuffer()?.includes(Buffer.from('filename="cover.png"'))) return send({ id: "cover-1", filename: "cover.png", sizeBytes: 32, sha256: "b".repeat(64), kind: "cover" });
      return send({ id: "video-1", filename: "sample.mp4", sizeBytes: 32, sha256: "a".repeat(64), kind: "video" });
    }
    if (pathname === "/api/video-publications" && request.method() === "POST") {
      submissions.push(request.postDataJSON());
      if (submissions.length === 1) return send({ detail: "DOUYIN_ACCOUNT_ID_REQUIRED" }, 409);
      if (submissions.length === 2) return route.abort("failed");
      const input = submissions.at(-1);
      const status = input.publishMode === "scheduled" ? "scheduled" : "submitted_for_review";
      const publication = { id: "pub-1", assetId: "video-1", mediaAccountId: "account-1", title:input.title, caption:input.caption, publishMode:input.publishMode, scheduledAt:input.scheduledAt, status, platformStatus:status, itemId: "1234567890123456789", createdAt: "2026-10-26T00:00:00Z" };
      publications = [publication];
      return send({ publication, command: { id: "command-1" }, deduplicated: true });
    }
    if (pathname === "/api/video-publications") return send(publications);
    if (pathname.endsWith("/discover")) { discoveryCount++; return send({ publication: publications[0], command: { id: "discovery-1" } }); }
    return send([]);
  });
  await page.goto(`${baseURL}/video-publish`, { waitUntil: "networkidle", timeout: 120000 });
  await page.getByRole("heading", { name: "抖音视频发布", exact: true }).waitFor();
  assert.equal(await page.getByLabel("封面来源", { exact: true }).inputValue(), "ai");
  assert.equal(await page.getByLabel("自定义封面", { exact: true }).count(), 0);
  if (process.env.VIDEO_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.VIDEO_SMOKE_SCREENSHOT, fullPage: true });
  await page.getByLabel("视频文件", { exact: true }).setInputFiles({ name: "sample.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(32) });
  await page.getByText("已就绪：sample.mp4", { exact: false }).waitFor();
  await page.getByLabel("抖音账号", { exact: true }).selectOption("account-1");
  await page.getByLabel("作品标题", { exact: true }).fill("独立视频标题");
  await page.getByLabel("作品简介", { exact: true }).fill("网页发布流程测试 #监控布线");
  assert.equal(await page.getByLabel("发布方式", { exact:true }).inputValue(), "immediate");
  await page.getByLabel("发布方式", { exact:true }).selectOption("scheduled");
  assert.equal(await page.getByRole("button", {name:"提交定时发布",exact:true}).isDisabled(), true, "legacy client must not receive a scheduled job");
  await page.getByLabel("发布方式", { exact:true }).selectOption("immediate");
  await page.getByRole("button", { name: "立即发布", exact: true }).click();
  await page.getByText("尚未读取到抖音账号身份，请在桌面端重新授权。", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("作品简介", { exact: true }).isDisabled(), false, "definite first rejection must allow correction");
  assert.equal("coverAssetId" in submissions[0], false, "default AI must not send a custom cover");
  assert.equal(submissions[0].title, "独立视频标题");
  assert.equal(submissions[0].caption, "网页发布流程测试 #监控布线");
  assert.equal(submissions[0].publishMode, "immediate");
  assert.equal("scheduledAt" in submissions[0], false);
  await page.getByLabel("封面来源", { exact: true }).selectOption("custom");
  assert.equal(await page.getByRole("button", {name:"立即发布",exact:true}).isDisabled(), true, "custom source requires a cover");
  await page.getByLabel("自定义封面", { exact: true }).setInputFiles({name:"cover.png",mimeType:"image/png",buffer:Buffer.alloc(32)});
  await page.getByText("封面已上传并通过校验。", {exact:true}).waitFor();
  await page.getByLabel("封面来源", { exact: true }).selectOption("ai");
  assert.equal(await page.getByLabel("自定义封面", { exact: true }).count(), 0);
  await page.getByLabel("封面来源", { exact: true }).selectOption("custom");
  await page.getByText("cover.png", {exact:true}).waitFor();
  await page.getByLabel("封面来源", { exact: true }).selectOption("ai");
  supportsScheduled = true;
  await page.getByRole("button", { name:"刷新账号",exact:true }).click();
  await page.getByLabel("发布方式", { exact:true }).selectOption("scheduled");
  await page.getByLabel("计划时间（北京时间）", { exact:true }).fill(scheduledWallTime);
  if (process.env.VIDEO_SMOKE_SCHEDULE_SCREENSHOT) await page.screenshot({ path:process.env.VIDEO_SMOKE_SCHEDULE_SCREENSHOT,fullPage:true });
  await page.getByRole("button", { name: "提交定时发布", exact: true }).click();
  await page.getByRole("button", { name: "重查本次提交", exact: true }).waitFor();
  assert.equal(await page.getByLabel("作品简介", { exact: true }).isDisabled(), true);
  for (const label of ["作品标题", "发布方式", "计划时间（北京时间）"]) assert.equal(await page.getByLabel(label, {exact:true}).isDisabled(), true, `${label} must freeze after response loss`);
  assert.equal(await page.getByLabel("封面来源", { exact: true }).isDisabled(), true, "cover source cannot change on ambiguous response");
  await page.getByRole("button", { name: "重查本次提交", exact: true }).click();
  await page.getByText("已定时，等待计划时间", { exact: true }).waitFor();
  assert.equal(submissions.length, 3);
  assert.deepEqual(submissions[1], submissions[2], "response loss must retain identical intent and content");
  assert.equal(submissions[1].publishMode, "scheduled");
  assert.equal(submissions[1].scheduledAt, `${scheduledWallTime}:00+08:00`, "Los Angeles browser must submit Beijing wall time with explicit offset");
  await page.getByText(`计划发布时间：${scheduledWallTime.replace("T", " ")} 北京时间`, {exact:true}).waitFor();
  assert.equal(uploadCount, 2);
  assert.equal("coverAssetId" in submissions[1], false, "switching back to AI must omit the retained custom asset");
  assert.equal(await page.getByRole("button", { name: "已创建发布任务", exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("link", { name: "查看公开作品 ↗" }).count(), 0);
  await page.getByRole("button", { name: "回查状态", exact: true }).click();
  await page.getByText("已请求回查作品状态，此操作不会重新发布视频。", { exact: true }).waitFor();
  assert.equal(discoveryCount, 1);
  assert.equal(submissions.length, 3, "discovery must never submit another video");
  assert.deepEqual(errors, []);
  console.log("PASS: independent title/caption, native schedule +08:00 from LA timezone, legacy-client gate, frozen intent, default AI cover, retained custom-to-AI switch, upload, capability-ready selection, lost-response same-intent retry, pending-not-public, read-only discovery; no page errors");
} finally { await browser.close(); }
