import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PenguinAdapter,
  PENGUIN_BODY_SELECTOR,
  clickPenguinPublish,
  confirmPenguinImageSelection,
  ensurePenguinAiDeclaration,
  findPenguinPublicationFromManagement,
  findPenguinPublicUrlInValue,
  inspectPenguinPublicArticle,
  normalizePenguinPublishedUrl,
  openPenguinImagePicker,
  penguinPublicPageIsUnavailable,
  penguinApiPayloadSucceeded,
  publishApiHasManualBlocker,
  penguinDraftUrlFromArticleId,
  penguinDraftUrlHasArticleId,
  penguinDraftImagesFromUploadedFallback,
  uploadPenguinInlineImages,
  waitForPenguinDraftUrl,
  waitForPenguinEditorImages,
  watchPenguinPublishApiResponses,
  buildPenguinArticlePayload,
  publishPenguinViaCapturedApi,
  pollPenguinArticleStatus,
  deletePenguinArticle,
  resolvePenguinMediaId,
  penguinArticleIdFromDiscoveryInput,
} from "../src/adapters/penguin.mjs";

test("builds the captured Penguin JSON payload with AIGC metadata", () => {
  const payload = buildPenguinArticlePayload({
    title: "Captured Penguin API article",
    richHtml: '<p>Body</p><p><img src="https://inews.gtimg.com/om_bt/body-1/641"></p><p><img src="https://inews.gtimg.com/om_bt/body-2/641"></p>',
    categoryId: "",
    mediaId: "24909112",
    coverUrl: "https://inews.gtimg.com/om_bt/cover-1/641",
    uploadedImages: [
      { platformImageUrl: "https://inews.gtimg.com/om_bt/body-1/641" },
    ],
  });

  assert.equal(payload.articleId, undefined);
  assert.equal(payload.title, "Captured Penguin API article");
  assert.equal(payload.category_id, "");
  assert.equal(payload.needpub, 1);
  assert.deepEqual(JSON.parse(payload.self_declare), { id: 7, desc: "作者声明：该文章由AI辅助创作" });
  assert.deepEqual(JSON.parse(payload.resource_aigc_mark_info)["https://inews.gtimg.com/om_bt/body-1/641"], {
    id: "https://inews.gtimg.com/om_bt/body-1/641",
    resource_type: "image",
    can_modify: 1,
    aigc_user_statement: 2,
  });
  assert.deepEqual(JSON.parse(payload.resource_aigc_mark_info)["https://inews.gtimg.com/om_bt/body-2/641"], {
    id: "https://inews.gtimg.com/om_bt/body-2/641",
    resource_type: "image",
    can_modify: 1,
    aigc_user_statement: 2,
  });
});

test("publishes Penguin through omSave, omSave, omPublish with one article id", async () => {
  const calls = [];
  const page = {
    request: {
      async fetch(url, options = {}) {
        calls.push({ url, options });
        const response = calls.length === 1
          ? { response: { code: 0, msg: "success" }, data: { articleId: "20260805API001" } }
          : { response: { code: 0, msg: "success" }, data: { articleId: "20260805API001" } };
        return { status: () => 200, url: () => url, text: async () => JSON.stringify(response) };
      },
    },
  };

  const result = await publishPenguinViaCapturedApi(page, null, {
    title: "Captured Penguin API article",
    richHtml: "<p>Captured body</p>",
    uploadedImages: [],
    categoryId: "",
    mediaId: "24909112",
    csrfToken: "real-penguin-csrf",
  });

  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    "/marticlepublish/omSave",
    "/marticlepublish/omSave",
    "/marticlepublish/omPublish",
  ]);
  const requestBodies = calls.map((call) => JSON.parse(call.options.data));
  assert.equal(requestBodies[0].articleId, undefined);
  assert.equal(requestBodies[1].articleId, "20260805API001");
  assert.equal(requestBodies[2].articleId, "20260805API001");
  assert.equal(calls[0].options.headers["x-csrf-token"], "real-penguin-csrf");
  assert.equal(calls[1].options.headers["x-csrf-token"], "real-penguin-csrf");
  assert.equal(calls[2].options.headers["x-csrf-token"], "real-penguin-csrf");
  assert.equal(result.externalIds.articleId, "20260805API001");
  assert.equal(result.platformStatus, "submitted_for_review");
  assert.equal(result.publicationEvidence.endpoint, "https://om.qq.com/marticlepublish/omPublish");
  assert.equal(result.publicationEvidence.response.response.code, 0);
  assert.equal(result.publicationEvidence.response.data.articleId, "20260805API001");
});

test("reports the safe Penguin API stage, endpoint, HTTP status, and code on publish rejection", async () => {
  const page = {
    request: {
      async fetch(url) {
        const pathname = new URL(url).pathname;
        const response = pathname.endsWith("/omPublish")
          ? { response: { code: 17, msg: "rejected" }, data: { articleId: "20260805API001" } }
          : { response: { code: 0, msg: "success" }, data: { articleId: "20260805API001" } };
        return { status: () => 200, url: () => url, text: async () => JSON.stringify(response) };
      },
    },
  };

  await assert.rejects(
    () => publishPenguinViaCapturedApi(page, null, {
      title: "Captured Penguin API rejection",
      richHtml: "<p>Captured body</p>",
      mediaId: "24909112",
    }),
    (error) => {
      assert.equal(
        error.message,
        "PENGUIN_API_PUBLISH_NOT_ACCEPTED:stage=publish:endpoint=/marticlepublish/omPublish:http=200:code=17",
      );
      assert.equal(error.httpStatus, 200);
      assert.equal(error.apiStage, "publish");
      assert.equal(error.apiEndpoint, "/marticlepublish/omPublish");
      assert.equal(error.apiCode, "17");
      return true;
    },
  );
});

test("maps Penguin omPublish code -5002 to the daily publish quota error", async () => {
  let calls = 0;
  const page = {
    request: {
      async fetch(url) {
        calls += 1;
        const response = calls === 3
          ? { response: { code: -5002 }, data: { articleId: "20260805API001" } }
          : { response: { code: 0, msg: "success" }, data: { articleId: "20260805API001" } };
        return { status: () => 200, url: () => url, text: async () => JSON.stringify(response) };
      },
    },
  };

  await assert.rejects(
    () => publishPenguinViaCapturedApi(page, null, {
      title: "Captured Penguin quota rejection",
      richHtml: "<p>Captured body</p>",
      mediaId: "24909112",
    }),
    /PENGUIN_DAILY_PUBLISH_QUOTA_EXHAUSTED/,
  );
});

test("reports safe Penguin API stages for account lookup and management polling", async () => {
  const page = {
    request: {
      async fetch(url) {
        return {
          status: () => 503,
          url: () => url,
          text: async () => JSON.stringify({ response: { code: 1004, msg: "temporary failure" } }),
        };
      },
    },
  };

  await assert.rejects(
    () => resolvePenguinMediaId(page),
    /PENGUIN_API_PUBLISH_NOT_ACCEPTED:stage=media-id:endpoint=\/maccountsetting\/account\/getEcUserId:http=503:code=1004/,
  );
  await assert.rejects(
    () => pollPenguinArticleStatus(page, "20260805API001", { timeoutMs: 0 }),
    /PENGUIN_API_PUBLISH_NOT_ACCEPTED:stage=article-status:endpoint=\/marticle\/article\/list:http=503:code=1004/,
  );
});

test("polls Penguin management status and only marks status 1 as a public candidate", async () => {
  const responses = [
    { response: { code: 0, msg: "suc" }, data: { articles: [{ article_id: "a1", status: "7", url: "https://page.om.qq.com/page/pending" }] } },
    { response: { code: 0, msg: "suc" }, data: { articles: [{ article_id: "a1", status: "1", title: "Captured Penguin API article", url: "https://page.om.qq.com/page/public" }] } },
  ];
  let calls = 0;
  const page = {
    request: { async fetch() { return { status: () => 200, url: () => "https://om.qq.com/marticle/article/list", text: async () => JSON.stringify(responses[Math.min(calls++, responses.length - 1)]) }; } },
    waitForTimeout: async () => {},
  };

  const result = await pollPenguinArticleStatus(page, "a1", { pollIntervalMs: 0, timeoutMs: 100 });
  assert.equal(result.status, "1");
  assert.equal(result.publicCandidateUrl, "https://page.om.qq.com/page/public");
  assert.equal(result.previousStatuses[0], "7");
});

test("keeps delayed discovery pending while Penguin management status is 7", async () => {
  let anonymousLaunches = 0;
  const page = {
    request: {
      async fetch(url) {
        return {
          status: () => 200,
          url: () => url,
          text: async () => JSON.stringify({
            response: { code: 0, msg: "suc" },
            data: { articles: [{ article_id: "a1", status: "7", url: "https://page.om.qq.com/page/pending" }] },
          }),
        };
      },
    },
    url: () => "https://om.qq.com/main/management/articleManage",
    waitForTimeout: async () => {},
  };
  const context = { pages: () => [page], newPage: async () => page, close: async () => {} };
  const adapter = new PenguinAdapter({
    browser: {
      launchPersistentContext: async () => context,
      launch: async () => { anonymousLaunches += 1; throw new Error("anonymous verification must not run for status 7"); },
    },
  });

  const result = await adapter.discoverPublication({
    articleId: "a1",
    articleTitle: "Captured Penguin API article",
    contentMarkdown: "Captured Penguin API article body for delayed discovery.",
    reviewPollTimeoutMs: 0,
  });

  assert.equal(result.found, false);
  assert.equal(result.reviewStatus, "pending_public_visibility");
  assert.equal(result.managementStatus, "7");
  assert.equal(anonymousLaunches, 0);
});

test("anonymously verifies a status 1 Penguin management candidate before discovery succeeds", async () => {
  const publicUrl = "https://page.om.qq.com/page/public-a1";
  const authPage = {
    request: {
      async fetch(url) {
        return {
          status: () => 200,
          url: () => url,
          text: async () => JSON.stringify({ response: { code: 0, msg: "suc" }, data: { articles: [{ article_id: "a1", status: "1", url: publicUrl }] } }),
        };
      },
    },
    url: () => "https://om.qq.com/main/management/articleManage",
  };
  const anonymousPage = {
    _url: "about:blank",
    url() { return this._url; },
    async goto(url) { this._url = url; },
    async waitForLoadState() {},
    async title() { return "Captured Penguin API article"; },
    locator() { return { first() { return this; }, async innerText() { return "Captured Penguin API article body for public verification."; } }; },
  };
  const authenticatedContext = { pages: () => [authPage], newPage: async () => authPage, close: async () => {} };
  const anonymousContext = { newPage: async () => anonymousPage, close: async () => {} };
  const adapter = new PenguinAdapter({
    browser: {
      launchPersistentContext: async () => authenticatedContext,
      launch: async () => ({ newContext: async () => anonymousContext, close: async () => {} }),
    },
  });

  const result = await adapter.discoverPublication({
    articleId: "a1",
    articleTitle: "Captured Penguin API article",
    contentMarkdown: "Captured Penguin API article body for public verification.",
    reviewPollTimeoutMs: 0,
  });

  assert.equal(result.found, true);
  assert.equal(result.publicUrl, publicUrl);
  assert.equal(anonymousPage.url(), publicUrl);
});

test("discovers a status 1 Penguin article from the creator review URL, not the internal article id", async () => {
  const listCalls = [];
  const publicUrl = "https://page.om.qq.com/page/OznDMv8uVpUElMcFF-1-BiTw0";
  const authPage = {
    request: {
      async fetch(url) {
        listCalls.push(url);
        return {
          status: () => 200,
          url: () => url,
          text: async () => JSON.stringify({
            response: { code: 0, msg: "suc" },
            data: { articles: [{ article_id: "20261007A00LJX", status: "1", title: "Captured Penguin API article", url: publicUrl }] },
          }),
        };
      },
    },
    url: () => "https://om.qq.com/main/management/articleManage",
  };
  const anonymousPage = {
    _url: "about:blank",
    url() { return this._url; },
    async goto(url) { this._url = url; },
    async waitForLoadState() {},
    async title() { return "Captured Penguin API article"; },
    locator() { return { first() { return this; }, async innerText() { return "Captured Penguin API article body for public verification."; } }; },
  };
  const authenticatedContext = { pages: () => [authPage], newPage: async () => authPage, close: async () => {} };
  const anonymousContext = { newPage: async () => anonymousPage, close: async () => {} };
  const adapter = new PenguinAdapter({
    browser: {
      launchPersistentContext: async () => authenticatedContext,
      launch: async () => ({ newContext: async () => anonymousContext, close: async () => {} }),
    },
  });

  // Mirrors the discover_publication command payload the API builds: ZhiXin's
  // internal article id plus the creator review URL carried in publicUrl.
  const result = await adapter.discoverPublication({
    articleId: "article-899b90b69dfd",
    articleTitle: "Captured Penguin API article",
    contentMarkdown: "Captured Penguin API article body for public verification.",
    publicUrl: "https://om.qq.com/s/article/20261007A00LJX",
    reviewPollTimeoutMs: 0,
  });

  assert.equal(listCalls.length, 1);
  assert.equal(result.found, true);
  assert.equal(result.publicUrl, publicUrl);
  assert.equal(anonymousPage.url(), publicUrl);
});

test("resolves the Penguin discovery article id from URLs before the internal article id", () => {
  assert.equal(
    penguinArticleIdFromDiscoveryInput({ articleId: "article-899b90b69dfd", publicUrl: "https://om.qq.com/s/article/20261007A00LJX" }),
    "20261007A00LJX",
  );
  assert.equal(
    penguinArticleIdFromDiscoveryInput({ articleId: "article-899b90b69dfd", reviewUrl: "https://om.qq.com/s/article/20261007A00LJX" }),
    "20261007A00LJX",
  );
  assert.equal(
    penguinArticleIdFromDiscoveryInput({ articleId: "a1" }),
    "a1",
  );
  // A creator review URL still wins over a public page URL: the platform id it
  // carries lets the management list confirm the record before anything is trusted.
  assert.equal(
    penguinArticleIdFromDiscoveryInput({
      articleId: "article-899b90b69dfd",
      reviewUrl: "https://om.qq.com/s/article/20261007A00LJX",
      publicUrl: "https://page.om.qq.com/page/OznDMv8uVpUElMcFF-1-BiTw0",
    }),
    "20261007A00LJX",
  );
  // Once only the public page URL is left, there is no platform id to poll for and
  // the internal article id must not be substituted: "" routes discovery to the
  // public-page verification branch instead of a list lookup that cannot match.
  assert.equal(
    penguinArticleIdFromDiscoveryInput({ articleId: "article-899b90b69dfd", publicUrl: "https://page.om.qq.com/page/OznDMv8uVpUElMcFF-1-BiTw0" }),
    "",
  );
  assert.equal(penguinArticleIdFromDiscoveryInput({}), "");
});

test("verifies an already-known Penguin public page URL instead of polling the management list", async () => {
  const listCalls = [];
  const publicUrl = "https://page.om.qq.com/page/OznDMv8uVpUElMcFF-1-BiTw0";
  const authPage = {
    _url: "https://om.qq.com/main/management/articleManage",
    url() { return this._url; },
    request: {
      async fetch(url) {
        listCalls.push(url);
        return {
          status: () => 200,
          url: () => url,
          text: async () => JSON.stringify({ response: { code: 0, msg: "suc" }, data: { articles: [] } }),
        };
      },
    },
    async goto(url) { this._url = url; },
    async waitForLoadState() {},
    async title() { return "Captured Penguin API article"; },
    locator() { return { first() { return this; }, async innerText() { return "Captured Penguin API article body for public verification."; } }; },
  };
  const anonymousPage = {
    _url: "about:blank",
    url() { return this._url; },
    async goto(url) { this._url = url; },
    async waitForLoadState() {},
    async title() { return "Captured Penguin API article"; },
    locator() { return { first() { return this; }, async innerText() { return "Captured Penguin API article body for public verification."; } }; },
  };
  const authenticatedContext = { pages: () => [authPage], newPage: async () => authPage, close: async () => {} };
  const anonymousContext = { newPage: async () => anonymousPage, close: async () => {} };
  const adapter = new PenguinAdapter({
    browser: {
      launchPersistentContext: async () => authenticatedContext,
      launch: async () => ({ newContext: async () => anonymousContext, close: async () => {} }),
    },
  });

  // Mirrors an order that already carries the public page URL as its reviewUrl: the
  // API copies it into both publicUrl and reviewUrl of the discover command.
  const result = await adapter.discoverPublication({
    articleId: "article-899b90b69dfd",
    articleTitle: "Captured Penguin API article",
    contentMarkdown: "Captured Penguin API article body for public verification.",
    publicUrl,
    reviewUrl: publicUrl,
    reviewPollTimeoutMs: 0,
  });

  assert.equal(listCalls.length, 0);
  assert.equal(result.found, true);
  assert.equal(result.publicUrl, publicUrl);
  assert.equal(anonymousPage.url(), publicUrl);
});

test("deletes a Penguin article only after deleteV2 confirms success", async () => {
  const calls = [];
  const page = { request: { async fetch(url, options) { calls.push({ url, options }); return { status: () => 200, url: () => url, text: async () => JSON.stringify({ response: { code: 0, msg: "success" }, data: { result: true } }) }; } } };
  const result = await deletePenguinArticle(page, "20260805API001");
  assert.equal(result.deleted, true);
  assert.equal(new URL(calls[0].url).pathname, "/marticlepublish/deleteV2");
  assert.deepEqual(JSON.parse(calls[0].options.data), { articleId: "20260805API001", operation: "user_self_deleted", reason: "全平台分发文章删除", source: 0, subSource: 0, relogin: 1 });
});

test("resolves the current Penguin media id from the authenticated account API", async () => {
  const calls = [];
  const page = { request: { async fetch(url, options) { calls.push({ url, options }); return { status: () => 200, url: () => url, text: async () => JSON.stringify({ response: { code: 0, msg: "suc" }, data: { userId: "24909112" } }) }; } } };
  const mediaId = await resolvePenguinMediaId(page, { csrfToken: "real-penguin-csrf" });
  assert.equal(mediaId, "24909112");
  assert.equal(new URL(calls[0].url).pathname, "/maccountsetting/account/getEcUserId");
  assert.equal(calls[0].options.headers["x-csrf-token"], "real-penguin-csrf");
});

test("extracts a Penguin public page URL from nested management API payloads", () => {
  assert.equal(
    findPenguinPublicUrlInValue({ data: { shareUrl: "https://page.om.qq.com/page/Oz1VIJyvyWEACK6tfAE-1GA0" } }),
    "https://page.om.qq.com/page/Oz1VIJyvyWEACK6tfAE-1GA0",
  );
});

test("reports login required when Penguin management redirects to user auth", async () => {
  const invisible = {
    first() { return this; },
    async isVisible() { return false; },
  };
  const page = {
    _url: "about:blank",
    async goto() { this._url = "https://om.qq.com/userAuth/index"; },
    url() { return this._url; },
    async waitForLoadState() {},
    async waitForTimeout() {},
    async evaluate() { return "登录 腾讯内容开放平台"; },
    locator() { return invisible; },
  };

  await assert.rejects(
    () => findPenguinPublicationFromManagement(page, { articleTitle: "测试文章" }),
    /PENGUIN_LOGIN_REQUIRED/,
  );
});

test("discovers the public URL by clicking mobile open on the matching Penguin article row", async () => {
  const publicUrl = "https://page.om.qq.com/page/Oz1VIJyvyWEACK6tfAE-1GA0";
  let responseHandler = null;
  const invisible = {
    first() { return this; },
    async isVisible() { return false; },
  };
  const mobileOpen = {
    first() { return this; },
    async isVisible() { return true; },
    async click() {
      await responseHandler?.({
        url: () => "https://om.qq.com/api/article/share",
        async json() { return { data: { shareUrl: publicUrl } }; },
        async text() { return JSON.stringify({ data: { shareUrl: publicUrl } }); },
      });
    },
  };
  const row = {
    first() { return this; },
    async isVisible() { return true; },
    locator(selector) {
      return selector.includes("手机打开") ? mobileOpen : invisible;
    },
  };
  const rows = {
    filter({ hasText }) {
      assert.equal(hasText, "怎样充实度过大学生活？可执行行动清单");
      return row;
    },
  };
  const page = {
    _url: "about:blank",
    async goto(url) { this._url = url; },
    url() { return this._url; },
    on(event, handler) { if (event === "response") responseHandler = handler; },
    off(event, handler) { if (event === "response" && responseHandler === handler) responseHandler = null; },
    async waitForLoadState() {},
    async waitForTimeout() {},
    async evaluate(_fn, arg) { return arg ? "" : "内容管理 创作 发布"; },
    locator(selector) {
      if (selector === "tr, .list-item, [class*='article'], [class*='content-item']") return rows;
      return invisible;
    },
  };

  const found = await findPenguinPublicationFromManagement(page, {
    articleTitle: "怎样充实度过大学生活？可执行行动清单",
  });

  assert.equal(found, publicUrl);
});

test("accepts Penguin public page URLs but rejects creator review candidates as final backlinks", () => {
  assert.equal(
    normalizePenguinPublishedUrl("https://page.om.qq.com/page/Oz1VIJyvyWEACK6tfAE-1GA0"),
    "https://page.om.qq.com/page/Oz1VIJyvyWEACK6tfAE-1GA0",
  );
  assert.equal(
    normalizePenguinPublishedUrl("https://om.qq.com/s/article/20260721A08QY2"),
    "",
  );
});

test("promotes a redirected Penguin review candidate to the real public backlink", async () => {
  const publicUrl = "https://page.om.qq.com/page/Oz1VIJyvyWEACK6tfAE-1GA0";
  const articleTitle = "怎样充实度过大学生活？可执行行动清单";
  const articleBody = "找准方向：建立你的充实度标准";
  const bodyLocator = {
    first() { return this; },
    async innerText() { return `${articleTitle}\n${articleBody}`; },
  };
  const page = {
    _url: "about:blank",
    url() { return this._url; },
    async goto(url) {
      this._url = String(url).includes("/s/article/") ? publicUrl : url;
    },
    async waitForLoadState() {},
    async title() { return articleTitle; },
    locator() { return bodyLocator; },
  };

  const result = await inspectPenguinPublicArticle(page, {
    reviewUrl: "https://om.qq.com/s/article/20260721A08QY2",
    articleTitle,
    contentMarkdown: articleBody,
  });

  assert.equal(result.found, true);
  assert.equal(result.publicUrl, publicUrl);
  assert.equal(result.publishedUrl, publicUrl);
});

test("does not accept a redirected Penguin page when the article title does not match", async () => {
  const publicUrl = "https://page.om.qq.com/page/unrelated-public-page";
  const bodyLocator = {
    first() { return this; },
    async innerText() { return "另一篇完全无关的文章"; },
  };
  const page = {
    _url: "about:blank",
    url() { return this._url; },
    async goto() { this._url = publicUrl; },
    async waitForLoadState() {},
    async title() { return "另一篇完全无关的文章"; },
    locator() { return bodyLocator; },
  };

  const result = await inspectPenguinPublicArticle(page, {
    reviewUrl: "https://om.qq.com/s/article/review-candidate",
    articleTitle: "怎样充实度过大学生活？可执行行动清单",
  });

  assert.equal(result.found, false);
  assert.equal(result.publicUrl, publicUrl);
  assert.equal(result.titleMatched, false);
});

test("matches the Penguin public body when the image-module toolbar splits a heading from its paragraph", async () => {
  // Measured on the live platform 2026-10-18: the public page server-renders
  // the editor toolbar ("编辑" / "删除图注") as visible text between a section
  // heading and its paragraph, so a fragment merging the two never appears
  // verbatim even though the whole article is on the page.
  const publicUrl = "https://page.om.qq.com/page/OsN5e2ydtgxSrRDesOHK9xyg0";
  const articleTitle = "收银台正上方的鱼眼镜头，装完就没再挪过";
  const contentMarkdown = [
    "我楼下的社区水果店去年装了这个顶装的鱼眼摄像头，老板说之前试了三个普通枪机，总在收银区留死角，装完这个再也没补装过别的监控。",
    "",
    "### 顶装视角如何抹平收银区监控盲区",
    "常规的固定视角枪机摄像头水平监控角度普遍在90°以内，顶装时要么只能覆盖收银台半侧，要么会把出入口、货架区域漏在画面外，反而增加存储和管理的成本。",
    "",
    "### POE供电与有线连接如何省掉冗余布线",
    "已经装修完成的商铺装监控，最麻烦的就是布线：单独拉电源线要走明线，既影响门店美观，也有安全隐患。",
  ].join("\n");
  const bodyText = [
    articleTitle,
    "bai2bai",
    "2026-10-15",
    "我楼下的社区水果店去年装了这个顶装的鱼眼摄像头，老板说之前试了三个普通枪机，总在收银区留死角，装完这个再也没补装过别的监控。",
    "",
    "顶装视角如何抹平收银区监控盲区",
    "",
    "编辑",
    "删除图注",
    "",
    "常规的固定视角枪机摄像头水平监控角度普遍在90°以内，顶装时要么只能覆盖收银台半侧，要么会把出入口、货架区域漏在画面外，反而增加存储和管理的成本。",
    "",
    "POE供电与有线连接如何省掉冗余布线",
    "",
    "编辑",
    "删除图注",
    "",
    "已经装修完成的商铺装监控，最麻烦的就是布线：单独拉电源线要走明线，既影响门店美观，也有安全隐患。",
  ].join("\n");
  const bodyLocator = {
    first() { return this; },
    async innerText() { return bodyText; },
  };
  const page = {
    _url: publicUrl,
    url() { return this._url; },
    async goto(url) { this._url = url; },
    async waitForLoadState() {},
    async title() { return articleTitle; },
    locator() { return bodyLocator; },
  };

  const result = await inspectPenguinPublicArticle(page, {
    publicUrl,
    articleTitle,
    contentMarkdown,
  });

  assert.equal(result.found, true);
  assert.equal(result.titleMatched, true);
  assert.equal(result.bodyMatched, true);
});

test("still rejects a Penguin public page whose body is not this article", async () => {
  const publicUrl = "https://page.om.qq.com/page/Obe8nyHJ_bQhjOU26snb3VkQ0";
  const articleTitle = "收银台正上方的鱼眼镜头，装完就没再挪过";
  const contentMarkdown = [
    "我楼下的社区水果店去年装了这个顶装的鱼眼摄像头，老板说之前试了三个普通枪机，总在收银区留死角，装完这个再也没补装过别的监控。",
    "",
    "### 顶装视角如何抹平收银区监控盲区",
    "常规的固定视角枪机摄像头水平监控角度普遍在90°以内，顶装时要么只能覆盖收银台半侧，要么会把出入口、货架区域漏在画面外，反而增加存储和管理的成本。",
  ].join("\n");
  const bodyLocator = {
    first() { return this; },
    async innerText() {
      return [
        articleTitle,
        "bai2bai",
        "2026-10-15",
        "这是一篇完全不同的文章正文，没有任何一段来自待复验的稿件。",
        "",
        "某个无关的小标题",
        "",
        "编辑",
        "删除图注",
        "",
        "无关的段落内容，提到了枪机和布线但行文与目标稿件完全不同。",
      ].join("\n");
    },
  };
  const page = {
    _url: publicUrl,
    url() { return this._url; },
    async goto(url) { this._url = url; },
    async waitForLoadState() {},
    async title() { return articleTitle; },
    locator() { return bodyLocator; },
  };

  const result = await inspectPenguinPublicArticle(page, {
    publicUrl,
    articleTitle,
    contentMarkdown,
  });

  assert.equal(result.found, false);
  assert.equal(result.titleMatched, true);
  assert.equal(result.bodyMatched, false);
});

test("detects Penguin soft unavailable public pages", () => {
  assert.equal(
    penguinPublicPageIsUnavailable("内容被删除 这篇文章从地球上消失了"),
    true,
  );
  assert.equal(
    penguinPublicPageIsUnavailable("作为OPC，这些准备工作必须到位 正文内容正常展示"),
    false,
  );
});
test("requires explicit Penguin API success evidence", () => {
  assert.equal(penguinApiPayloadSucceeded(null), false);
  assert.equal(penguinApiPayloadSucceeded({}), false);
  assert.equal(penguinApiPayloadSucceeded({ code: 1001, message: "failed" }), false);
  assert.equal(penguinApiPayloadSucceeded({ code: 0 }), true);
  assert.equal(penguinApiPayloadSucceeded({ success: true }), true);
  assert.equal(penguinApiPayloadSucceeded({ data: { articleId: "article-001" } }), true);
});

test("captures semantic Penguin publish success after final publish click even when endpoint path changes", async () => {
  let responseHandler = null;
  const page = {
    on(event, handler) {
      if (event === "response") responseHandler = handler;
    },
    off(event, handler) {
      if (event === "response" && responseHandler === handler) responseHandler = null;
    },
  };
  const watcher = watchPenguinPublishApiResponses(page);
  watcher.state.publishClickArmed = true;

  await responseHandler({
    url: () => "https://om.qq.com/cgi-bin/content/submitArticle",
    text: async () => JSON.stringify({ code: 0, data: { articleId: "20260728A00SEMANTIC" } }),
  });

  assert.equal(watcher.state.publishAttempted, true);
  assert.equal(watcher.state.publishSucceeded, true);
  assert.equal(watcher.state.articleId, "20260728A00SEMANTIC");
  assert.equal(watcher.state.draftUrl, penguinDraftUrlFromArticleId("20260728A00SEMANTIC"));
  watcher.dispose();
  assert.equal(responseHandler, null);
});

test("captures only safe form fields from Penguin DOM omPublish requests", () => {
  let requestHandler = null;
  const page = {
    on(event, handler) {
      if (event === "request") requestHandler = handler;
    },
    off(event, handler) {
      if (event === "request" && requestHandler === handler) requestHandler = null;
    },
  };
  const watcher = watchPenguinPublishApiResponses(page);

  assert.equal(typeof requestHandler, "function");
  requestHandler({
    url: () => "https://om.qq.com/marticlepublish/omPublish",
    method: () => "POST",
    postData: () => new URLSearchParams({
      title: "must not be retained",
      content: "must not be retained either",
      type: "2",
      category_id: "17",
      cover_type: "0",
      csrfToken: "must-not-leak",
    }).toString(),
  });

  assert.deepEqual(watcher.state.lastPublishRequestFields, {
    type: "2",
    category_id: "17",
    cover_type: "0",
  });
  assert.doesNotMatch(JSON.stringify(watcher.state.lastPublishRequestFields), /must not|csrf/i);
  watcher.dispose();
  assert.equal(requestHandler, null);
});

test("captures safe nested fields and metadata from Penguin JSON publish requests", () => {
  let requestHandler = null;
  const page = {
    on(event, handler) {
      if (event === "request") requestHandler = handler;
    },
    off() {},
  };
  const watcher = watchPenguinPublishApiResponses(page);
  const body = {
    business: { type: "2" },
    article: {
      category_id: "17",
      title: "must not be retained",
      content: "must not be retained either",
    },
    authorization: "must-not-leak",
  };
  const serialized = JSON.stringify(body);

  requestHandler({
    url: () => "https://om.qq.com/marticlepublish/omPublish",
    method: () => "POST",
    headers: () => ({ "content-type": "application/json; charset=UTF-8" }),
    postData: () => serialized,
    postDataJSON: () => body,
  });

  assert.deepEqual(watcher.state.lastPublishRequestFields, {
    type: "2",
    category_id: "17",
  });
  assert.deepEqual(watcher.state.lastPublishRequestMetadata, {
    contentType: "application/json; charset=UTF-8",
    bodyKind: "json",
    bodyBytes: Buffer.byteLength(serialized),
    topLevelFieldNames: ["business", "article"],
    safeFieldPaths: {
      "business.type": "2",
      "article.category_id": "17",
    },
  });
  assert.doesNotMatch(JSON.stringify({
    fields: watcher.state.lastPublishRequestFields,
    metadata: watcher.state.lastPublishRequestMetadata,
  }), /must not|authorization/i);
});

test("scopes Penguin body writes away from the contenteditable title", () => {
  assert.match(PENGUIN_BODY_SELECTOR, /ProseMirror/);
  assert.doesNotMatch(PENGUIN_BODY_SELECTOR, /:not\(\[data-field/);
  assert.doesNotMatch(PENGUIN_BODY_SELECTOR, /^\[contenteditable/);
  assert.doesNotMatch(PENGUIN_BODY_SELECTOR, /,\s*\[contenteditable/);
});

test("selects the Penguin AI-generated declaration before publishing", async () => {
  const actions = [];
  const create = (name, visible = true) => ({
    first() { return this; },
    async isVisible() { return visible; },
    async click() { actions.push(name); },
    async isChecked() { return name === "ai-option" && actions.includes("ai-option"); },
  });
  const page = {
    locator(selector) {
      if (selector.includes("点这里")) return create("trigger");
      if (selector.includes("该文章由AI生成")) return create("ai-option");
      if (selector.includes("确认")) return create("confirm");
      return create("missing", false);
    },
    async waitForTimeout() {},
  };

  await ensurePenguinAiDeclaration(page);

  assert.deepEqual(actions, ["trigger", "ai-option", "confirm"]);
});

test("selects the Penguin AI declaration with real Chinese labels", async () => {
  const actions = [];
  let dialogOpen = false;
  const create = (name, visible = true) => ({
    first() { return this; },
    async isVisible() { return visible; },
    async click() {
      actions.push(name);
      if (name === "trigger") dialogOpen = true;
    },
    async isChecked() { return name === "ai-option" && actions.includes("ai-option"); },
    async scrollIntoViewIfNeeded() {},
    async isDisabled() { return false; },
  });
  const page = {
    locator(selector) {
      if (selector.includes("点击这里")) return create("trigger");
      if (selector.includes("该文章由AI生成")) return create("ai-option", dialogOpen);
      if (selector.includes("确认")) return create("confirm", dialogOpen);
      if (selector.includes("发布内容自主声明")) return create("dialog", dialogOpen);
      return create("missing", false);
    },
    async waitForTimeout() {},
  };

  await ensurePenguinAiDeclaration(page);

  assert.deepEqual(actions, ["trigger", "ai-option", "confirm"]);
});

test("submits the current Penguin AI generation declaration when no legacy option is shown", async () => {
  const actions = [];
  const create = (name, visible = true) => ({
    first() { return this; },
    async isVisible() { return visible; },
    async click() { actions.push(name); },
  });
  const page = {
    locator(selector) {
      if (selector.includes("\u8be5\u6587\u7ae0\u7531AI\u751f\u6210")) return create("missing", false);
      if (selector.includes("\u56fe\u7247\u7d20\u6750")) return create("missing", false);
      if (selector.includes("\u63d0\u4ea4")) return create("submit");
      if (selector.includes("AI\u751f\u6210\u58f0\u660e")) return create("dialog");
      return create("missing", false);
    },
    async waitForTimeout() {},
  };

  await ensurePenguinAiDeclaration(page);
  assert.deepEqual(actions, ["submit"]);
});

test("completes Penguin AI material declaration from the inline supplement link", async () => {
  const actions = [];
  let dialogOpen = false;
  const create = (name, visible = true) => ({
    first() { return this; },
    async isVisible() { return visible; },
    async isDisabled() { return false; },
    async scrollIntoViewIfNeeded() {},
    async click() {
      actions.push(name);
      if (name === "supplement") dialogOpen = true;
    },
  });
  const page = {
    locator(selector) {
      if (selector === "text=\u8fdb\u884c\u8865\u5145") return create("supplement");
      if (selector.includes("\u56fe\u7247\u7d20\u6750")) return create("image-material", dialogOpen);
      if (selector.includes("\u63d0\u4ea4")) return create("submit", dialogOpen);
      if (selector.includes("AI\u751f\u6210\u58f0\u660e")) return create("dialog", dialogOpen);
      return create("missing", false);
    },
    async waitForTimeout() {},
  };

  await ensurePenguinAiDeclaration(page);

  assert.deepEqual(actions, ["supplement", "image-material", "submit"]);
});

test("selects the first visible Penguin declaration choice when the legacy label changed", async () => {
  const actions = [];
  const create = (name, visible = true) => ({
    first() { return this; },
    async isVisible() { return visible; },
    async isDisabled() { return false; },
    async click() { actions.push(name); },
    async scrollIntoViewIfNeeded() {},
  });
  const page = {
    locator(selector) {
      if (selector.includes("label:has-text")) return create("legacy-missing", false);
      if (!selector.includes("has-text('发布内容自主声明')")) return create("missing", false);
      if (selector.includes("input[type='radio']") || selector.includes("input[type='checkbox']")) return create("first-choice");
      if (selector.includes("button:has-text('确认')")) return create("confirm");
      if (selector.includes(".omui-dialog-wrapper.open")) return create("dialog");
      return create("missing", false);
    },
    async waitForTimeout() {},
  };

  await ensurePenguinAiDeclaration(page);
  assert.deepEqual(actions, ["first-choice", "confirm"]);
});

test("uses an already-open Penguin declaration dialog without clicking the covered trigger", async () => {
  const actions = [];
  const create = (name, visible = true) => ({
    first() { return this; },
    locator(selector) {
      if (selector.includes("该文章由AI生成")) return create("ai-option");
      if (selector.includes("确认")) return create("confirm");
      return create("missing", false);
    },
    async isVisible() { return visible; },
    async click() { actions.push(name); },
  });
  const page = {
    locator(selector) {
      if (selector.includes("该文章由AI生成")) return create("ai-option");
      if (selector.includes("确认")) return create("confirm");
      if (selector.includes("发布内容自主声明")) return create("dialog");
      if (selector.includes("点这里")) return create("trigger");
      return create("missing", false);
    },
    async waitForTimeout() {},
  };

  await ensurePenguinAiDeclaration(page);

  assert.deepEqual(actions, ["ai-option", "confirm"]);
});

test("does not mistake another open Penguin dialog for the AI declaration", async () => {
  const actions = [];
  const create = (name, visible = true) => ({
    first() { return this; },
    async isVisible() { return visible; },
    async click() { actions.push(name); },
  });
  const page = {
    locator(selector) {
      if (selector === ".omui-dialog-wrapper.open, [role='dialog']") return create("unrelated-dialog");
      if (selector.includes("点这里")) return create("trigger");
      if (selector.includes("该文章由AI生成")) return create("ai-option");
      if (selector.includes("确认")) return create("confirm");
      return create("missing", false);
    },
    async waitForTimeout() {},
  };

  await ensurePenguinAiDeclaration(page);

  assert.deepEqual(actions, ["trigger", "ai-option", "confirm"]);
});
import { getAdapter } from "../src/adapters/index.mjs";
import { fileURLToPath } from "node:url";

function createLocator(actions, selector, { visible = true, disabled = false, onClick = null, attr = "" } = {}) {
  const locator = {
    count: async () => 1,
    nth: () => locator,
    first: () => locator,
    last: () => locator,
    fill: async (value) => actions.push(["fill", selector, value]),
    click: async () => {
      actions.push(["click", selector]);
      await onClick?.();
    },
    press: async (key) => actions.push(["press", selector, key]),
    isVisible: async () => visible,
    isDisabled: async () => disabled,
    isChecked: async () => false,
    getAttribute: async () => attr,
    scrollIntoViewIfNeeded: async () => actions.push(["scroll", selector]),
    dispatchEvent: async (eventName) => actions.push(["dispatch", selector, eventName]),
    setInputFiles: async (filePath) => actions.push(["file", selector, filePath])
  };
  return locator;
}

function createPenguinHarness({
  pageText = "creator dashboard content management publish article editor draft saved",
  publishPayload = null,
  publishRequestForm = null,
  savePayload = { code: 0, data: { articleId: "penguin-draft-001" } },
  saveUrl = "https://om.qq.com/api/article/save",
  currentUrl = "about:blank",
} = {}) {
  const actions = [];
  let requestHandler = null;
  let responseHandler = null;
  const emitPublishRequest = async () => requestHandler?.({
    url: () => "https://om.qq.com/marticlepublish/omPublish",
    method: () => "POST",
    postData: () => publishRequestForm ? new URLSearchParams(publishRequestForm).toString() : "",
  });
  const isPublicArticlePage = () => page._url.includes("/article/") || page._url.includes("page.om.qq.com/page/");
  const page = {
    _url: currentUrl,
    on: (event, handler) => {
      if (event === "request") requestHandler = handler;
      if (event === "response") responseHandler = handler;
    },
    off: (event, handler) => {
      if (event === "request" && requestHandler === handler) requestHandler = null;
      if (event === "response" && responseHandler === handler) responseHandler = null;
    },
    goto: async (url) => {
      actions.push(["goto", url]);
      page._url = url;
    },
    bringToFront: async () => actions.push(["bringToFront"]),
    setDefaultTimeout: async (ms) => actions.push(["setDefaultTimeout", ms]),
    setDefaultNavigationTimeout: async (ms) => actions.push(["setDefaultNavigationTimeout", ms]),
    waitForLoadState: async (state) => actions.push(["waitForLoadState", state]),
    waitForTimeout: async (ms) => actions.push(["waitForTimeout", ms]),
    waitForFunction: async () => actions.push(["waitForFunction"]),
    url: () => page._url,
    title: async () => isPublicArticlePage()
      ? page._publishedTitle || "Penguin published article"
      : "\u4f01\u9e45\u53f7\u521b\u4f5c\u4e2d\u5fc3",
    evaluate: async (...args) => {
      if (args.length > 1) {
        actions.push(["evaluateWithArg", args[1]]);
        return true;
      }
      return isPublicArticlePage()
        ? `${page._publishedTitle || ""} ${pageText}`
        : pageText;
    },
    locator: (selector) => {
      if (selector.includes("ProseMirror") || selector.includes("contenteditable") || selector.includes("omui-inputautogrowing")) {
        return createLocator(actions, selector, { visible: true });
      }
      if (selector.includes("\u53d1\u5e03") || selector.includes("publish")) {
        return createLocator(actions, selector, {
          onClick: async () => {
            await emitPublishRequest();
            if (publishPayload?.url) page._url = publishPayload.url;
            await responseHandler?.({
              url: () => "https://om.qq.com/api/article/publish",
              text: async () => JSON.stringify(publishPayload || {})
            });
          }
        });
      }
      if (selector.includes("\u4fdd\u5b58") || selector.includes("draft")) {
        return createLocator(actions, selector, {
          onClick: async () => responseHandler?.({
            url: () => saveUrl,
            text: async () => JSON.stringify(savePayload)
          })
        });
      }
      return createLocator(actions, selector);
    },
    getByRole: (role, options = {}) => {
      const name = options.name?.toString?.() || String(options.name || "");
      return createLocator(actions, `role=${role}:${name}`, {
        onClick: async () => {
          if (/publish|\\u53d1\\u5e03/i.test(name)) {
            await emitPublishRequest();
            if (publishPayload?.url) page._url = publishPayload.url;
            await responseHandler?.({
              url: () => "https://om.qq.com/api/article/publish",
              text: async () => JSON.stringify(publishPayload || {})
            });
          }
        }
      });
    }
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [
      { name: "omaccesstoken", value: "penguin-access-token", domain: ".om.qq.com" },
      { name: "omtoken", value: "penguin-session-token", domain: ".om.qq.com" },
      { name: "userid", value: "penguin-user-id", domain: ".om.qq.com" }
    ],
    close: async () => actions.push(["close"])
  };
  const adapter = new PenguinAdapter({
    browser: {
      launchPersistentContext: async () => context
    }
  });
  return { actions, adapter, page, context };
}

test("registers Penguin as a dedicated publishing adapter", () => {
  assert.equal(getAdapter("penguin").platform, "penguin");
  assert.equal(getAdapter("penguin").constructor.name, "PenguinAdapter");
});

test("does not report a Penguin draft when the save API has no success evidence", async () => {
  const { adapter } = createPenguinHarness({ savePayload: null });

  await assert.rejects(() => adapter.publishArticle({
    articleTitle: "Zhixin AI Penguin draft evidence test",
    contentMarkdown: "This draft must not succeed when the platform save response has no structured success evidence.",
    confirmPublish: false,
    draftTimeoutMs: 5,
  }), /PENGUIN_SAVE_NOT_CONFIRMED/);
});

test("recognizes Penguin editorCache update as a real draft save", async () => {
  const { adapter } = createPenguinHarness({
    saveUrl: "https://om.qq.com/editorCache/update",
    savePayload: { response: { code: "0", msg: "success" }, data: null },
  });

  const result = await adapter.publishArticle({
    articleTitle: "Zhixin AI Penguin cache save test",
    contentMarkdown: "This draft uses the real Penguin editorCache update response contract for save confirmation.",
    confirmPublish: false,
    draftTimeoutMs: 10,
  });

  assert.equal(result.platformStatus, "draft_saved");
});

test("replaces Penguin body once when rich HTML is supplied", async () => {
  const { actions, adapter } = createPenguinHarness();

  await adapter.publishArticle({
    articleTitle: "Zhixin AI Penguin rich body test",
    contentMarkdown: "Plain text body must not be filled before the structured HTML paste because that duplicates content.",
    contentHtml: "<p>Structured body is inserted once.</p>",
    confirmPublish: false,
    draftTimeoutMs: 10,
  });

  const bodyFills = actions.filter((item) => item[0] === "fill" && item[1] === PENGUIN_BODY_SELECTOR);
  assert.ok(bodyFills.some((item) => item[2] === ""));
  assert.ok(!bodyFills.some((item) => String(item[2]).includes("Plain text body")));
});

test("seeds Penguin credentials into the stable persistent auth profile", async () => {
  const { actions, page } = createPenguinHarness();
  let persistentLaunches = 0;
  let temporaryLaunches = 0;
  let injectedCookies = [];
  let storageInit = null;
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "omaccesstoken", value: "penguin-access-token", domain: ".om.qq.com" }],
    addCookies: async (cookies) => {
      injectedCookies = cookies;
    },
    addInitScript: async (script, arg) => {
      storageInit = { script, arg };
    },
    close: async () => actions.push(["close"])
  };
  const adapter = new PenguinAdapter({
    browser: {
      launch: async () => {
        temporaryLaunches += 1;
        throw new Error("TEMPORARY_BROWSER_SHOULD_NOT_OPEN");
      },
      launchPersistentContext: async () => {
        persistentLaunches += 1;
        return context;
      }
    }
  });

  const result = await adapter.publishArticle({
    articleTitle: "Zhixin AI Penguin injected cookie test",
    contentMarkdown: "This test verifies Penguin cookie injected publishing without opening the persistent auth profile.",
    cookies: [{ name: "omaccesstoken", value: "penguin-access-token", domain: ".om.qq.com", path: "/" }],
    localStorage: { creatorAccountId: "penguin-local-account" },
    sessionStorage: { editorDraftKey: "penguin-session-draft" }
  });

  assert.equal(result.platformStatus, "draft_saved");
  assert.equal(persistentLaunches, 1);
  assert.equal(temporaryLaunches, 0);
  assert.equal(injectedCookies.length, 1);
  assert.deepEqual(storageInit.arg.origins, ["https://om.qq.com", "https://graph.qq.com", "https://xui.ptlogin2.qq.com"]);
  assert.deepEqual(storageInit.arg.localStorageValues, { creatorAccountId: "penguin-local-account" });
  assert.deepEqual(storageInit.arg.sessionStorageValues, { editorDraftKey: "penguin-session-draft" });
});

test("publishes Penguin through the captured JSON API chain after editor image preparation", async () => {
  const { adapter, page, actions } = createPenguinHarness();
  const apiCalls = [];
  page.request = {
    async fetch(url, options = {}) {
      apiCalls.push({ url, options });
      const payload = url.includes("/marticle/article/list")
        ? {
            response: { code: 0, msg: "suc" },
            data: { articles: [{ article_id: "20260728A095U7", status: "7", url: "https://page.om.qq.com/page/not-public-yet" }] },
          }
        : {
            response: { code: 0, msg: "success" },
            data: { articleId: "20260728A095U7" },
          };
      return {
        status: () => 200,
        url: () => url,
        text: async () => JSON.stringify(payload),
      };
    },
  };
  const evaluate = page.evaluate;
  page.evaluate = async (...args) => {
    if (args[1]?.mode === "read-penguin-editor-html") {
      return [
        "<p>Prepared Penguin API publish body with enough useful content.</p>",
        '<img src="https://inews.gtimg.com/om_bt/penguin-cover/641">',
      ].join("");
    }
    return evaluate(...args);
  };

  const result = await adapter.publishArticle({
    articleTitle: "Zhixin AI Penguin omPublish Test",
    contentMarkdown: "This article verifies the captured Penguin omPublish form API is used after editor preparation.",
    confirmPublish: true,
    mediaId: "24909112",
    reviewPollTimeoutMs: 0,
  });

  assert.equal(result.platformStatus, "submitted_for_review");
  assert.equal(result.publishedUrl, "");
  assert.equal(result.reviewUrl, "https://om.qq.com/s/article/20260728A095U7");
  assert.equal(result.externalIds.articleId, "20260728A095U7");
  assert.deepEqual(apiCalls.map((call) => new URL(call.url).pathname), [
    "/marticlepublish/omSave",
    "/marticlepublish/omSave",
    "/marticlepublish/omPublish",
    "/marticle/article/list",
  ]);
  const payloads = apiCalls.slice(0, 3).map((call) => JSON.parse(call.options.data));
  assert.equal(payloads[0].articleId, undefined);
  assert.equal(payloads[1].articleId, "20260728A095U7");
  assert.equal(payloads[2].articleId, "20260728A095U7");
  assert.equal(payloads[0].category_id, "");
  assert.equal(payloads[0].cover_type, "1");
  assert.deepEqual(JSON.parse(payloads[0].self_declare), { id: 7, desc: "作者声明：该文章由AI辅助创作" });
  assert.match(payloads[0].content, /inews\.gtimg\.com\/om_bt\/penguin-cover\/641/);
  assert.equal(actions.some((item) => item[0] === "click" && [
    "button.omui-button--primary:has-text('发布')",
    "button:has-text('发布')",
    "[role='button']:has-text('发布')",
  ].includes(item[1])), false);
  assert.doesNotMatch(
    JSON.stringify(result.publicationEvidence),
    /Zhixin AI Penguin omPublish Test|Prepared Penguin API publish body/
  );

  const cover = JSON.parse(payloads[0].imgurl_ext);
  assert.equal(cover[0].src, "https://inews.gtimg.com/om_bt/penguin-cover/641");
  assert.equal(cover[0]["150120"], "https://inews.gtimg.com/om_bt/penguin-cover_150120/0");
});

test("cleans up a Penguin test article only after anonymous public verification", async () => {
  const { adapter, page } = createPenguinHarness();
  const apiCalls = [];
  const articleId = "20260805CLEANUP001";
  const publicUrl = "https://page.om.qq.com/page/20260805CLEANUP001";
  const title = "Zhixin AI Penguin cleanup gate test";
  const body = "This article is deleted only after the anonymous public page is verified.";
  page.request = {
    async fetch(url, options = {}) {
      apiCalls.push({ url, options });
      const pathname = new URL(url).pathname;
      const payload = pathname === "/marticle/article/list"
        ? { response: { code: 0, msg: "suc" }, data: { articles: [{ article_id: articleId, status: "1", url: publicUrl }] } }
        : pathname === "/marticlepublish/deleteV2"
          ? { response: { code: 0, msg: "success" }, data: { result: true } }
          : { response: { code: 0, msg: "success" }, data: { articleId } };
      return { status: () => 200, url: () => url, text: async () => JSON.stringify(payload) };
    },
  };
  const anonymousPage = {
    _url: "about:blank",
    url() { return this._url; },
    async goto(url) { this._url = url; },
    async waitForLoadState() {},
    async title() { return title; },
    locator() {
      return { first() { return this; }, async innerText() { return `${title}\n${body}`; } };
    },
  };
  adapter.browser.launch = async () => ({
    async newContext() { return { async newPage() { return anonymousPage; }, async close() {} }; },
    async close() {},
  });

  const result = await adapter.publishArticle({
    articleTitle: title,
    contentMarkdown: body,
    confirmPublish: true,
    cleanupTestArticle: true,
    mediaId: "24909112",
    reviewPollTimeoutMs: 0,
  });

  assert.equal(result.platformStatus, "published");
  assert.equal(result.publishedUrl, publicUrl);
  assert.equal(result.publicationEvidence.public?.endpoint, publicUrl);
  assert.equal(result.publicationEvidence.public?.titleMatched, true);
  assert.equal(result.publicationEvidence.public?.bodyMatched, true);
  assert.equal(result.testCleanup?.deleted, true);
  assert.equal(result.testCleanup?.articleId, articleId);
  assert.equal(result.testCleanup?.publicationEvidence?.response?.payload?.response?.code, 0);
  assert.equal(result.testCleanup?.publicationEvidence?.response?.payload?.data?.result, true);
  assert.deepEqual(apiCalls.map((call) => new URL(call.url).pathname), [
    "/marticlepublish/omSave",
    "/marticlepublish/omSave",
    "/marticlepublish/omPublish",
    "/marticle/article/list",
    "/marticlepublish/deleteV2",
  ]);
  assert.equal(JSON.parse(apiCalls.at(-1).options.data).articleId, articleId);
});

test("reports Penguin platform verification blockers as manual action", async () => {
  const progress = [];
  const { adapter } = createPenguinHarness({
    pageText: "\u4f01\u9e45\u53f7 \u5b89\u5168\u9a8c\u8bc1 \u8bf7\u5b8c\u6210\u9a8c\u8bc1\u540e\u7ee7\u7eed\u64cd\u4f5c"
  });

  await assert.rejects(() => adapter.publishArticle({
    articleTitle: "Zhixin AI Penguin Verification Blocked",
    contentMarkdown: "This article verifies Penguin manual verification is reported back to the desktop command.",
    confirmPublish: true,
    onProgress: (event) => progress.push(event)
  }), /PENGUIN_MANUAL_ACTION_REQUIRED/);

  assert.equal(progress.find((event) => event.type === "manual_verification_required")?.platform, "penguin");
});

test("builds Penguin draft URLs from save response article ids", () => {
  assert.equal(
    penguinDraftUrlFromArticleId("penguin-draft-001"),
    "https://om.qq.com/main/creation/article?articleId=penguin-draft-001"
  );
});

test("waits for Penguin draft URL and asynchronous editor images", async () => {
  const state = { draftUrl: "" };
  let waits = 0;
  const image = {
    async getAttribute(name) {
      return name === "src" ? "https://inews.gtimg.com/draft-inline.png" : "draft image";
    },
    async evaluate() { return true; },
  };
  const page = {
    url: () => "https://om.qq.com/article/create",
    async waitForTimeout() {
      waits += 1;
      if (waits === 2) state.draftUrl = "https://om.qq.com/article/create?id=penguin-draft-001";
    },
    locator() {
      return {
        async count() { return waits >= 3 ? 1 : 0; },
        nth() { return image; },
      };
    },
  };

  const draftUrl = await waitForPenguinDraftUrl(state, page, 100, 1);
  const images = await waitForPenguinEditorImages(page, 1, 100, 1);
  assert.equal(draftUrl, state.draftUrl);
  assert.equal(images[0].platformImageUrl, "https://inews.gtimg.com/draft-inline.png");
});

test("detects Penguin draft URLs that are safe to reload", () => {
  assert.equal(penguinDraftUrlHasArticleId("https://om.qq.com/main/creation/article?articleId=123"), true);
  assert.equal(penguinDraftUrlHasArticleId("https://om.qq.com/main/creation/article"), false);
});

test("opens the Penguin image picker left of the video toolbar control", async () => {
  const actions = [];
  const page = {
    locator(selector) {
      return {
        first() {
          return {
            async isVisible() {
              return String(selector).includes("exeditor-menu-basic-video")
                || String(selector).includes("input[type='file']");
            },
            async click() { actions.push(["click", selector]); },
            async boundingBox() {
              if (String(selector).includes("video")) return { x: 370, y: 162, width: 30, height: 30 };
              return null;
            },
            async waitFor() { actions.push(["waitFor", selector]); },
            async count() {
              return String(selector).includes("input[type='file']") ? 1 : 0;
            },
          };
        },
      };
    },
    mouse: {
      async click(x, y) { actions.push(["mouse", x, y]); },
    },
  };

  await openPenguinImagePicker(page);
  assert.ok(actions.some((item) => item[0] === "mouse" && item[1] < 370));
  assert.ok(actions.some((item) => item[0] === "waitFor" && String(item[1]).includes("input[type='file']")));
});

test("opens the Penguin image picker through the live custom toolbar element", async () => {
  const actions = [];
  const missing = {
    first() { return this; },
    async isVisible() { return false; },
    async count() { return 0; },
  };
  const page = {
    locator(selector) {
      if (String(selector).includes("exeditor-toolbar-button[data-toolbar-item-of='imagePlugin']")) {
        return {
          first() { return this; },
          async isVisible() { return true; },
          async click() { actions.push(["toolbar", selector]); },
        };
      }
      if (String(selector).includes("input[type='file']")) {
        return {
          first() { return this; },
          async waitFor() { actions.push(["waitFor", selector]); },
          async count() { return 1; },
        };
      }
      return missing;
    },
    mouse: {
      async click(x, y) { actions.push(["mouse", x, y]); },
    },
  };

  await openPenguinImagePicker(page);

  assert.ok(actions.some((item) => item[0] === "toolbar"));
  assert.equal(actions.some((item) => item[0] === "mouse"), false);
});

test("only treats explicit Penguin verification errors as manual blockers", () => {
  assert.equal(publishApiHasManualBlocker({
    code: 1001,
    message: "request failed",
    data: { securityLevel: "normal", manualReview: true },
  }), false);
  assert.equal(publishApiHasManualBlocker({
    code: 1001,
    message: "\u8bf7\u5b8c\u6210\u5b89\u5168\u9a8c\u8bc1\u540e\u91cd\u8bd5",
  }), true);
});

test("confirms the visible Penguin image selection when an earlier matching button is hidden", async () => {
  const actions = [];
  const hidden = {
    async isVisible() { return false; },
    async isDisabled() { return false; },
    async click() { actions.push("hidden"); },
  };
  const visible = {
    async isVisible() { return true; },
    async isDisabled() { return false; },
    async click() { actions.push("visible-confirm"); },
  };
  const empty = {
    async count() { return 0; },
    first() { return hidden; },
    nth() { return hidden; },
  };
  const matches = {
    async count() { return 2; },
    first() { return hidden; },
    nth(index) { return index === 0 ? hidden : visible; },
  };
  const page = {
    locator(selector) {
      return selector.includes("button") && selector.includes("\u786e\u8ba4") ? matches : empty;
    },
    async waitForTimeout() {},
  };

  const confirmed = await confirmPenguinImageSelection(page);

  assert.equal(confirmed, true);
  assert.deepEqual(actions, ["visible-confirm"]);
});


test("waits for the asynchronous Penguin image confirmation button to become ready", async () => {
  const actions = [];
  let attempts = 0;
  const confirm = {
    async isVisible() { return true; },
    async isDisabled() { return false; },
    async scrollIntoViewIfNeeded() {},
    async click() { actions.push("confirm"); },
  };
  const hidden = {
    async isVisible() { return false; },
    async isDisabled() { return false; },
  };
  const delayed = {
    async count() {
      attempts += 1;
      return attempts >= 2 ? 1 : 0;
    },
    first() { return confirm; },
    nth() { return confirm; },
  };
  const empty = {
    async count() { return 0; },
    first() { return hidden; },
    nth() { return hidden; },
  };
  const page = {
    locator(selector) {
      return selector.startsWith(".omui-dialog-wrapper") && selector.includes("\u786e\u8ba4") ? delayed : empty;
    },
    async waitForTimeout() {},
  };
  const confirmed = await confirmPenguinImageSelection(page, { timeoutMs: 100, pollMs: 1 });
  assert.equal(confirmed, true);
  assert.deepEqual(actions, ["confirm"]);
  assert.equal(attempts, 2);
});
test("keeps handling delayed Penguin publish confirmation until network evidence appears", async () => {
  const actions = [];
  const watcherState = { publishAttempted: false, publishSucceeded: false, blocker: "" };
  let dialogOpen = false;
  let waits = 0;
  const missing = {
    first() { return this; },
    async count() { return 0; },
    async isVisible() { return false; },
    async isDisabled() { return false; },
  };
  const publishButton = {
    first() { return this; },
    async count() { return 1; },
    nth() { return this; },
    async isVisible() { return true; },
    async isDisabled() { return false; },
    async scrollIntoViewIfNeeded() {},
    async click() {
      actions.push("publish");
      dialogOpen = true;
    },
  };
  const dialogMask = {
    first() { return this; },
    async isVisible() { return dialogOpen; },
  };
  const confirmButton = {
    first() { return this; },
    async count() { return dialogOpen ? 1 : 0; },
    nth() { return this; },
    async isVisible() { return dialogOpen; },
    async isDisabled() { return false; },
    async click() {
      actions.push("confirm");
      dialogOpen = false;
      watcherState.publishAttempted = true;
    },
  };
  const page = {
    locator(selector) {
      if (selector.startsWith(".omui-dialog-mask")) return dialogMask;
      if (selector.includes("\u786e\u8ba4") || selector.includes("\u7ee7\u7eed\u53d1\u5e03") || selector.includes("\u53d1\u5e03") && selector.includes("dialog")) return confirmButton;
      if (selector.includes("\u53d1\u5e03") && !selector.includes("\u7ee7\u7eed") || selector.includes("Publish")) return publishButton;
      return missing;
    },
    keyboard: { async press() {} },
    async waitForTimeout() {
      waits += 1;
      if (waits === 1) dialogOpen = true;
    },
  };

  await clickPenguinPublish(page, 100, watcherState);

  assert.deepEqual(actions, ["publish", "confirm"]);
  assert.equal(watcherState.publishAttempted, true);
});

test("retries Penguin publish after submitting the required AI declaration", async () => {
  const actions = [];
  const watcherState = { publishAttempted: false, publishSucceeded: false, blocker: "" };
  let dialogOpen = false;
  let publishClicks = 0;
  const missing = {
    first() { return this; },
    async count() { return 0; },
    async isVisible() { return false; },
    async isDisabled() { return false; },
  };
  const publishButton = {
    first() { return this; },
    async count() { return 1; },
    nth() { return this; },
    async isVisible() { return !dialogOpen; },
    async isDisabled() { return false; },
    async scrollIntoViewIfNeeded() {},
    async click() {
      publishClicks += 1;
      actions.push("publish");
      if (publishClicks === 1) dialogOpen = true;
      else watcherState.publishAttempted = true;
    },
  };
  const dialogMask = {
    first() { return this; },
    async isVisible() { return dialogOpen; },
  };
  const declarationSubmit = {
    first() { return this; },
    async count() { return dialogOpen ? 1 : 0; },
    nth() { return this; },
    async isVisible() { return dialogOpen; },
    async isDisabled() { return false; },
    async click() {
      actions.push("submit-declaration");
      dialogOpen = false;
    },
  };
  const page = {
    locator(selector) {
      if (selector.startsWith(".omui-dialog-mask")) return dialogMask;
      if (selector.includes(".omui-dialog-wrapper.open button.omui-button--primary")) return declarationSubmit;
      if (selector === "button.omui-button--primary:has-text('\u53d1\u5e03')"
        || selector === "button:has-text('\u53d1\u5e03')"
        || selector === "[role='button']:has-text('\u53d1\u5e03')"
        || selector === "button:has-text('Publish')") return publishButton;
      return missing;
    },
    keyboard: { async press() {} },
    async waitForTimeout() {},
  };

  await clickPenguinPublish(page, 100, watcherState);

  assert.deepEqual(actions, ["publish", "submit-declaration", "publish"]);
  assert.equal(watcherState.publishAttempted, true);
});

test("submits the current Penguin AI declaration dialog without relying on the legacy open class", async () => {
  const actions = [];
  const watcherState = { publishAttempted: false, publishSucceeded: false, blocker: "" };
  let dialogOpen = false;
  let publishClicks = 0;
  const missing = {
    first() { return this; },
    async count() { return 0; },
    async isVisible() { return false; },
    async isDisabled() { return false; },
  };
  const publishButton = {
    first() { return this; },
    async count() { return 1; },
    nth() { return this; },
    async isVisible() { return !dialogOpen; },
    async isDisabled() { return false; },
    async scrollIntoViewIfNeeded() {},
    async click() {
      publishClicks += 1;
      actions.push("publish");
      if (publishClicks === 1) dialogOpen = true;
      else watcherState.publishAttempted = true;
    },
  };
  const dialogMask = {
    first() { return this; },
    async isVisible() { return dialogOpen; },
  };
  const declarationSubmit = {
    first() { return this; },
    async count() { return dialogOpen ? 1 : 0; },
    nth() { return this; },
    async isVisible() { return dialogOpen; },
    async isDisabled() { return false; },
    async click() {
      actions.push("submit-ai-declaration");
      dialogOpen = false;
    },
  };
  const page = {
    locator(selector) {
      if (selector.startsWith(".omui-dialog-mask")) return dialogMask;
      if (selector.includes(".omui-dialog-wrapper button:has-text('\u63d0\u4ea4')")) return declarationSubmit;
      if (selector === "button.omui-button--primary:has-text('\u53d1\u5e03')"
        || selector === "button:has-text('\u53d1\u5e03')"
        || selector === "[role='button']:has-text('\u53d1\u5e03')"
        || selector === "button:has-text('Publish')") return publishButton;
      return missing;
    },
    keyboard: { async press() {} },
    async waitForTimeout() {},
  };

  await clickPenguinPublish(page, 100, watcherState);

  assert.deepEqual(actions, ["publish", "submit-ai-declaration", "publish"]);
  assert.equal(watcherState.publishAttempted, true);
});

test("dismisses Penguin diagnostic assistant before retrying publish", async () => {
  const actions = [];
  const watcherState = { publishAttempted: false, publishSucceeded: false, blocker: "" };
  let diagnosticOpen = false;
  let publishClicks = 0;
  const missing = {
    first() { return this; },
    async count() { return 0; },
    async isVisible() { return false; },
    async isDisabled() { return false; },
  };
  const publishButton = {
    first() { return this; },
    async count() { return 1; },
    nth() { return this; },
    async isVisible() { return !diagnosticOpen; },
    async isDisabled() { return false; },
    async scrollIntoViewIfNeeded() {},
    async click() {
      publishClicks += 1;
      actions.push("publish");
      if (publishClicks === 1) diagnosticOpen = true;
      else watcherState.publishAttempted = true;
    },
  };
  const ignoreButton = {
    first() { return this; },
    async count() { return diagnosticOpen ? 1 : 0; },
    nth() { return this; },
    async isVisible() { return diagnosticOpen; },
    async isDisabled() { return false; },
    async scrollIntoViewIfNeeded() {},
    async click() {
      actions.push("ignore-diagnostic");
      diagnosticOpen = false;
    },
  };
  const page = {
    locator(selector) {
      if (selector.includes("\u5ffd\u7565")) return ignoreButton;
      if (selector === "button.omui-button--primary:has-text('\u53d1\u5e03')"
        || selector === "button:has-text('\u53d1\u5e03')"
        || selector === "[role='button']:has-text('\u53d1\u5e03')"
        || selector === "button:has-text('Publish')") return publishButton;
      return missing;
    },
    keyboard: { async press() {} },
    async waitForTimeout() {},
  };

  await clickPenguinPublish(page, 300, watcherState);

  assert.deepEqual(actions, ["publish", "ignore-diagnostic", "publish"]);
  assert.equal(watcherState.publishAttempted, true);
});

test("uploads Penguin body images through the image file input and waits for CDN urls", async () => {
  const actions = [];
  const images = [];
  const localFile = fileURLToPath(import.meta.url);
  const editor = {
    async click() { actions.push(["clickEditor"]); },
    async evaluate() { return true; },
  };
  const page = {
    locator(selector) {
      if (selector.includes("ProseMirror") && selector.includes("img")) {
        return {
          async count() { return images.length; },
          nth(index) {
            return {
              async getAttribute(name) {
                return name === "src" ? images[index].src : images[index].alt;
              },
              async evaluate() { return true; },
            };
          },
        };
      }
      if (selector.includes("ProseMirror")) {
        return { first: () => editor };
      }
      return {
        first() {
          return {
            async isVisible() {
              return String(selector).includes("video") || String(selector).includes("input[type='file']");
            },
            async click() { actions.push(["click", selector]); },
            async boundingBox() {
              if (String(selector).includes("video")) return { x: 370, y: 162, width: 30, height: 30 };
              return null;
            },
            async waitFor() { actions.push(["waitFor", selector]); },
            async count() {
              return String(selector).includes("input[type='file']") ? 1 : 0;
            },
            async setInputFiles(filePath) {
              actions.push(["file", filePath]);
              images.push({
                src: "https://inews.gtimg.com/om_bt/penguin-inline/641",
                alt: "正文图",
              });
            },
            async isVisible() { return false; },
          };
        },
      };
    },
    mouse: {
      async click(x, y) { actions.push(["mouse", x, y]); },
    },
    keyboard: {
      async press(key) { actions.push(["key", key]); },
    },
    async waitForTimeout() {},
  };

  const uploaded = await uploadPenguinInlineImages(page, [{
    assetId: "asset-inline",
    sectionId: "workflow",
    position: 2,
    path: localFile,
  }]);

  assert.equal(uploaded[0].platformImageUrl, "https://inews.gtimg.com/om_bt/penguin-inline/641");
  assert.ok(actions.some((item) => item[0] === "file" && item[1] === localFile));
  assert.ok(actions.some((item) => item[0] === "key" && item[1] === "Escape"));
});

test("uses uploaded Penguin CDN images as draft fallback only when complete", () => {
  const tasks = [
    { assetId: "asset-1", sectionId: "s1", position: 2 },
    { assetId: "asset-2", sectionId: "s2", position: 4 },
  ];
  const uploaded = [
    { assetId: "asset-1", sectionId: "s1", position: 2, platformImageUrl: "https://inews.gtimg.com/om/a.png", loaded: true },
    { assetId: "asset-2", sectionId: "s2", position: 4, platformImageUrl: "https://inews.gtimg.com/om/b.png", loaded: true },
  ];

  assert.deepEqual(penguinDraftImagesFromUploadedFallback(tasks, uploaded), uploaded);
  assert.deepEqual(penguinDraftImagesFromUploadedFallback(tasks, uploaded.slice(0, 1)), []);
});

test("does not confirm again when Penguin auto-inserts the uploaded image", async () => {
  const actions = [];
  const images = [];
  const localFile = fileURLToPath(import.meta.url);
  const editor = {
    async click() {},
    async evaluate() { return true; },
  };
  const missing = {
    first() { return this; },
    nth() { return this; },
    async count() { return 0; },
    async isVisible() { return false; },
    async isDisabled() { return false; },
  };
  const page = {
    locator(selector) {
      const value = String(selector);
      if (value.includes("ProseMirror") && value.includes("img")) {
        return {
          async count() { return images.length; },
          nth(index) {
            return {
              async getAttribute(name) {
                return name === "src" ? images[index].src : images[index].alt;
              },
              async evaluate() { return true; },
            };
          },
        };
      }
      if (value.includes("ProseMirror")) return { first: () => editor };
      if (value.includes("exeditor-toolbar-button[data-toolbar-item-of='imagePlugin']")) {
        return {
          first() { return this; },
          async isVisible() { return true; },
          async click() { actions.push("open-picker"); },
        };
      }
      if (value.includes("input[type='file']")) {
        return {
          first() { return this; },
          async waitFor() {},
          async count() { return 1; },
          async setInputFiles() {
            actions.push("upload");
            images.push({ src: "https://inews.gtimg.com/om_bt/auto-insert/641", alt: "\u6b63\u6587\u56fe" });
          },
        };
      }
      if (value.includes("??")) {
        return {
          first() { return this; },
          nth() { return this; },
          async count() { return 1; },
          async isVisible() { return true; },
          async isDisabled() { return false; },
          async click() {
            actions.push("confirm");
            images.push({ src: "https://inews.gtimg.com/om_bt/duplicate/641", alt: "\u91cd\u590d\u6b63\u6587\u56fe" });
          },
        };
      }
      return missing;
    },
    keyboard: { async press() { actions.push("escape"); } },
    async waitForTimeout() {},
  };

  const uploaded = await uploadPenguinInlineImages(page, [{
    assetId: "asset-auto-insert",
    sectionId: "workflow",
    position: 1,
    path: localFile,
  }]);

  assert.equal(uploaded.length, 1);
  assert.equal(images.length, 1);
  assert.equal(actions.includes("confirm"), false);
});

test("verifies a discovered Penguin public page in a clean anonymous browser context", async () => {
  const publicUrl = "https://page.om.qq.com/page/penguin-anonymous-public-001";
  let anonymousLaunchCount = 0;
  const createPage = () => ({
    _url: "about:blank",
    url() { return this._url; },
    async goto(url) { this._url = url; },
    async waitForLoadState() {},
    async title() { return "Penguin anonymous verification article"; },
    locator() {
      return {
        first() { return this; },
        async innerText() { return "Penguin anonymous verification body is publicly visible."; },
      };
    },
  });
  const authenticatedPage = createPage();
  const anonymousPage = createPage();
  const authenticatedContext = {
    pages: () => [authenticatedPage],
    async close() {},
  };
  const anonymousContext = {
    async newPage() { return anonymousPage; },
    async close() {},
  };
  const anonymousBrowser = {
    async newContext() { return anonymousContext; },
    async close() {},
  };
  const adapter = new PenguinAdapter({
    browser: {
      async launchPersistentContext() { return authenticatedContext; },
      async launch() {
        anonymousLaunchCount += 1;
        return anonymousBrowser;
      },
    },
  });

  const result = await adapter.discoverPublication({
    publicUrl,
    articleTitle: "Penguin anonymous verification article",
    contentMarkdown: "Penguin anonymous verification body is publicly visible.",
  });

  assert.equal(result.found, true);
  assert.equal(result.publicUrl, publicUrl);
  assert.equal(anonymousLaunchCount, 1);
  assert.equal(anonymousPage.url(), publicUrl);
});
test("discovers a reviewed Penguin article and verifies public platform images", async () => {
  const publicImage = {
    async getAttribute(name) {
      if (name === "src") return "https://inews.gtimg.com/public-inline.png";
      if (name === "alt") return "workflow image";
      return "";
    },
    async evaluate() { return true; },
  };
  const imageLocator = {
    async count() { return 1; },
    nth() { return publicImage; },
  };
  const bodyLocator = {
    first() { return bodyLocator; },
    async innerText() { return "The authenticated penguin public body is available."; },
  };
  const page = {
    _url: "about:blank",
    url() { return page._url; },
    async goto(url) { page._url = url; },
    async waitForLoadState() {},
    async waitForFunction(_fn, payload) {
      assert.ok(String(payload.selector).includes("inews.gtimg.com"));
      assert.equal(payload.expectedCount, 1);
    },
    async title() { return "Penguin reviewed illustrated article"; },
    locator(selector) {
      if (String(selector).includes("img")) return imageLocator;
      return bodyLocator;
    },
  };
  const expected = [{
    assetId: "asset-inline",
    sectionId: "workflow",
    position: 2,
    idempotencyKey: "asset-inline:workflow:hash",
  }];
  const priorImage = {
    ...expected[0],
    platformImageUrl: "https://inews.gtimg.com/draft-inline.png",
    loaded: true,
  };

  const result = await inspectPenguinPublicArticle(page, {
    publicUrl: "https://page.om.qq.com/page/penguin-public-illustrated-001",
    articleTitle: "Penguin reviewed illustrated article",
    contentMarkdown: "The authenticated penguin public body is available.",
    imagePublicationEvidence: {
      expectedCount: 1,
      expected,
      upload: { images: [priorImage] },
      draft: { images: [priorImage] },
    },
  });

  assert.equal(result.found, true);
  assert.equal(result.publicUrl, "https://page.om.qq.com/page/penguin-public-illustrated-001");
  assert.equal(result.imagePublicationEvidence.status, "verified");
  assert.equal(result.imagePublicationEvidence.public.verifiedCount, 1);
});

test("matches Penguin public body after Markdown headings and image syntax are rendered away", async () => {
  const publicUrl = "https://page.om.qq.com/page/penguin-rendered-markdown-001";
  const page = {
    _url: "about:blank",
    url() { return this._url; },
    async goto(url) { this._url = url; },
    async waitForLoadState() {},
    async title() {
      return "\u600e\u6837\u5145\u5b9e\u5ea6\u8fc7\u5927\u5b66\u751f\u6d3b\uff1f\u53ef\u6267\u884c\u884c\u52a8\u6e05\u5355_\u817e\u8baf\u65b0\u95fb";
    },
    locator() {
      return {
        first() { return this; },
        async innerText() {
          return "\u5efa\u7acb\u6e05\u6670\u76ee\u6807\n\u5927\u5b66\u751f\u6d3b\u771f\u6b63\u7684\u5145\u5b9e\uff0c\u6765\u81ea\u76ee\u6807\u3001\u884c\u52a8\u548c\u6301\u7eed\u590d\u76d8\u3002\n\u4ece\u4eca\u5929\u5f00\u59cb\u884c\u52a8";
        },
      };
    },
  };

  const result = await inspectPenguinPublicArticle(page, {
    publicUrl,
    articleTitle: "\u600e\u6837\u5145\u5b9e\u5ea6\u8fc7\u5927\u5b66\u751f\u6d3b\uff1f\u53ef\u6267\u884c\u884c\u52a8\u6e05\u5355",
    contentMarkdown: [
      "# \u600e\u6837\u5145\u5b9e\u5ea6\u8fc7\u5927\u5b66\u751f\u6d3b\uff1f\u53ef\u6267\u884c\u884c\u52a8\u6e05\u5355",
      "",
      "## \u5efa\u7acb\u6e05\u6670\u76ee\u6807",
      "",
      "\u5927\u5b66\u751f\u6d3b\u771f\u6b63\u7684\u5145\u5b9e\uff0c\u6765\u81ea\u76ee\u6807\u3001\u884c\u52a8\u548c\u6301\u7eed\u590d\u76d8\u3002",
      "",
      "![\u884c\u52a8\u6e05\u5355](/uploads/assets/inline.png)",
      "",
      "## \u4ece\u4eca\u5929\u5f00\u59cb\u884c\u52a8",
    ].join("\n"),
  });

  assert.equal(result.titleMatched, true);
  assert.equal(result.bodyMatched, true);
  assert.equal(result.found, true);
});

test("does not replay an uncertain Penguin publish click", async () => {
  let clicks = 0;
  const missing = { first() { return this; }, count: async () => 0, isVisible: async () => false };
  const button = { first() { return this; }, nth() { return this; }, count: async () => 1,
    isVisible: async () => true, isDisabled: async () => false,
    click: async () => { clicks += 1; throw new Error("connection lost after dispatch"); } };
  const page = { locator(selector) {
    return selector.includes("dialog") || selector.includes("modal") || selector.includes("继续") || selector.includes("知道") ? missing : button;
  }, waitForTimeout: async () => {} };
  await assert.rejects(clickPenguinPublish(page, 20), /CLICK_UNCERTAIN/);
  assert.equal(clicks, 1);
});

for (const platform of ["netease", "jianshu", "penguin", "sohu"]) {
  test(`${platform} distinguishes missing, hidden, disabled and unknown button evidence`, async () => {
    const { describeUnavailableButton } = await import(`../src/adapters/${platform}.mjs`);
    for (const [expected, count, visible, disabled] of [
      ["missing", 0, false, false], ["hidden", 1, false, false],
      ["disabled", 1, true, true], ["unknown", 1, true, undefined],
    ]) {
      assert.equal(await describeUnavailableButton([{
        count: async () => count, isVisible: async () => visible,
        isDisabled: async () => disabled,
      }]), expected);
    }
    assert.equal(await describeUnavailableButton([{
      count: async () => 1, isVisible: async () => true,
      isDisabled: async () => { throw new Error("detached"); },
    }]), "unknown");
  });
}
