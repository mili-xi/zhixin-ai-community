// Synthetic gateway credentials for isolated contract tests only.
process.env.CSDN_ARTICLE_APP_KEY = "test-article-key";
process.env.CSDN_ARTICLE_APP_SECRET = "test-article-secret";
process.env.CSDN_UPLOAD_APP_KEY = "test-upload-key";
process.env.CSDN_UPLOAD_APP_SECRET = "test-upload-secret";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { CsdnAdapter, csdnBodyHtml, csdnMarkdown, csdnPublicImageBlock, csdnDraftUrlFromArticleId, csdnGatewayFetch } from "../src/adapters/csdn.mjs";
import { getAdapter } from "../src/adapters/index.mjs";
import { PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED } from "../src/platform-images.mjs";

function createCsdnApiHarness({
  articleTitle = "CSDN API contract test article",
  draftStatus = 2,
  draftResponse = null,
  publishResponse = null,
  publicSnapshot = null,
  useDefaultPublicFetcher = false,
  draftReadbackSequence = [],
  postPublishStatus = 0,
  cookies = [{ name: "UserToken", value: "contract-token", domain: ".csdn.net" }],
  accountUsername = "zhixin_ai",
  shareSlug = "zhixin_ai",
  articleList = null,
  failArticleList = false,
} = {}) {
  const articleId = "163500001";
  const content = "Closed loop body marker.";
  const publicUrl = `https://blog.csdn.net/zhixin_ai/article/details/${articleId}`;
  const gatewayCalls = [];
  const progressEvents = [];
  const publicFetchCalls = [];
  const shareDataUrl = `https://blog.csdn.net/${shareSlug}/web/v1/share/download-share-data?articleId=${articleId}`;
  let published = false;
  let draftReadbackIndex = 0;
  const page = {
    _url: "about:blank",
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    async goto(url) { page._url = url; return { status: () => 200 }; },
    async waitForLoadState() {},
    async waitForFunction() {},
    url: () => page._url,
    async title() { return "创作中心-CSDN"; },
    async evaluate(_callback, request) {
      if (!request?.url) return "发布博客 保存草稿";
      gatewayCalls.push(request);
      if (request.url.endsWith("/blog-console-api/v1/user/info")) {
        return { ok: true, status: 200, payload: { code: 200, data: { username: accountUsername } } };
      }
      if (request.url.includes("/mdeditor/saveArticle")) {
        if (request.data.pubStatus === "draft" && draftResponse) return draftResponse;
        if (request.data.pubStatus === "publish" && publishResponse) return publishResponse;
        if (request.data.pubStatus === "publish") published = true;
        return { ok: true, status: 200, payload: { code: 200, data: { id: Number(articleId), url: publicUrl, title: articleTitle } } };
      }
      if (request.url.includes("/editor/getArticle")) {
        const draftReadback = !published && draftReadbackSequence.length
          ? draftReadbackSequence[Math.min(draftReadbackIndex++, draftReadbackSequence.length - 1)]
          : {};
        return {
          ok: true,
          status: 200,
          payload: {
            code: 200,
            data: {
              article_id: Number(articleId),
              title: draftReadback.title ?? articleTitle,
              markdowncontent: draftReadback.markdowncontent ?? content,
              content: draftReadback.content ?? `<p>${content}</p>`,
              status: published ? (postPublishStatus || 1) : (draftReadback.status ?? draftStatus),
              cover_images: [],
            },
          },
        };
      }
      if (request.url.includes("/article/list")) {
        if (failArticleList) {
          return { ok: false, status: 500, payload: { code: 500, message: "article list unavailable" } };
        }
        return {
          ok: true,
          status: 200,
          payload: { code: 200, data: { list: articleList || [{ articleId, title: articleTitle, downloadShareDataUrl: shareDataUrl, status: published ? String(postPublishStatus || "1") : String(draftStatus), coverImage: [] }] } },
        };
      }
      throw new Error(`UNEXPECTED_GATEWAY_CALL:${request.method}:${request.url}`);
    },
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => cookies,
    close: async () => {},
  };
  const adapterOptions = {
    browser: { launchPersistentContext: async () => context },
  };
  if (!useDefaultPublicFetcher) {
    adapterOptions.publicPageFetcher = async (url) => {
      publicFetchCalls.push(url);
      if (typeof publicSnapshot === "function") return publicSnapshot(url);
      return publicSnapshot || {
      status: 200,
      url,
      title: `${articleTitle}-CSDN博客`,
      text: `${articleTitle} ${content}`,
      contentText: content,
      imageUrls: [],
    };
    };
  }
  const adapter = new CsdnAdapter(adapterOptions);
  const input = {
    articleTitle,
    contentMarkdown: content,
    contentHtml: `<p>${content}</p>`,
    draftVerifyAttempts: 1,
    draftVerifyPollMs: 1,
    publicVerifyAttempts: 1,
    publicVerifyPollMs: 1,
    onProgress: (event) => progressEvents.push(event),
  };
  return { adapter, input, gatewayCalls, progressEvents, publicFetchCalls, shareDataUrl };
}

test("builds the current CSDN path-based draft editor URL", () => {
  assert.equal(
    csdnDraftUrlFromArticleId("162851970"),
    "https://mp.csdn.net/mp_blog/creation/editor/162851970"
  );
});

test("signs CSDN article APIs with the capture-compatible header set", async () => {
  let waitForGatewayCalls = 0;
  let request = null;
  const page = {
    async waitForFunction() { waitForGatewayCalls += 1; },
    async evaluate(_callback, value) {
      request = value;
      return { ok: true, status: 200, payload: { code: 200, data: {} } };
    },
  };

  await csdnGatewayFetch(page, "https://bizapi.csdn.net/blog-console-api/v1/user/info", {
    method: "GET",
    nonce: "11111111-2222-4333-8444-555555555555",
  });

  assert.equal(waitForGatewayCalls, 0);
  assert.ok(["test-article-key", "test-upload-key"].includes(request.headers["X-Ca-Key"]));
  assert.equal(request.headers["X-Ca-Nonce"], "11111111-2222-4333-8444-555555555555");
  assert.equal(request.headers["X-Ca-Signature-Headers"], "x-ca-key,x-ca-nonce");
  assert.equal(request.headers["X-Ca-Timestamp"], undefined);
  assert.match(request.headers["X-Ca-Signature"], /^[A-Za-z0-9+/]+={0,2}$/);
});

test("canonicalizes empty CSDN article query values without an equals sign", async () => {
  let request = null;
  const page = {
    async evaluate(_callback, value) {
      request = value;
      return { ok: true, status: 200, payload: { code: 200, data: {} } };
    },
  };

  await csdnGatewayFetch(
    page,
    "https://bizapi.csdn.net/blog-console-api/v3/editor/getArticle?id=163452064&model_type=",
    { method: "GET", nonce: "11111111-2222-4333-8444-555555555555" },
  );

  assert.match(request.headers["X-Ca-Signature"], /^[A-Za-z0-9+/]{43}=$/);
});

test("uses the captured upload signing profile for CSDN image authorization", async () => {
  let request = null;
  const page = {
    async evaluate(_callback, value) {
      request = value;
      return { ok: true, status: 200, payload: { code: 200, data: {} } };
    },
  };

  await csdnGatewayFetch(page, "https://bizapi.csdn.net/resource-api/v1/image/direct/upload/signature", {
    method: "POST",
    data: { appName: "direct_blog", imageSuffix: "png", imageTemplate: "" },
    nonce: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    timestamp: 1785686400000,
  });

  assert.ok(["test-article-key", "test-upload-key"].includes(request.headers["X-Ca-Key"]));
  assert.equal(request.headers["X-Ca-Nonce"], "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  assert.equal(request.headers["X-Ca-Timestamp"], "1785686400000");
  assert.equal(request.headers["X-Ca-Signature-Headers"], "x-ca-key,x-ca-nonce,x-ca-timestamp");
  assert.equal(request.headers["Content-Type"], "application/json;charset=UTF-8");
  assert.match(request.headers["X-Ca-Signature"], /^[A-Za-z0-9+/]{43}=$/);
});

test("registers CSDN as a dedicated publishing adapter", () => {
  assert.equal(getAdapter("csdn").platform, "csdn");
  assert.equal(getAdapter("csdn").constructor.name, "CsdnAdapter");
});

test("requires a logged-in CSDN account before calling platform APIs", async () => {
  const { adapter, input, gatewayCalls } = createCsdnApiHarness({ cookies: [] });

  await assert.rejects(
    () => adapter.publishArticle({ ...input, confirmPublish: false }),
    /CSDN_LOGIN_REQUIRED/,
  );
  assert.equal(gatewayCalls.length, 0);
});

test("fails closed when the CSDN draft API rejects the article", async () => {
  const { adapter, input } = createCsdnApiHarness({
    draftResponse: {
      ok: false,
      status: 500,
      payload: { code: 500, message: "service unavailable" },
      error: "Request failed with status code 500",
    },
  });

  await assert.rejects(
    () => adapter.publishArticle({ ...input, confirmPublish: false }),
    /CSDN_API_DRAFT_NOT_ACCEPTED/,
  );
});

test("surfaces the CSDN platform message when the publish API rejects the article", async () => {
  const { adapter, input } = createCsdnApiHarness({
    publishResponse: {
      ok: false,
      status: 400,
      payload: { code: 400, message: "Article category is required" },
      error: "Request failed with status code 400",
    },
  });

  await assert.rejects(
    () => adapter.publishArticle({ ...input, confirmPublish: true }),
    /CSDN_API_PUBLISH_NOT_ACCEPTED:Article category is required/,
  );
});

test("redacts credentials from a rejected CSDN platform message", async () => {
  const { adapter, input } = createCsdnApiHarness({
    publishResponse: {
      ok: false,
      status: 400,
      payload: {
        code: 400,
        message: "Daily quota reached. token=csdn-secret-token Cookie: UserToken=secret-cookie, Authorization: Basic dXNlcjpwYXNz client_secret=client-secret x-api-key: api-key-secret {\"client_secret\":\"json-secret-value\"} appSecret=application-secret-value",
      },
    },
  });

  await assert.rejects(
    () => adapter.publishArticle({ ...input, confirmPublish: true }),
    (error) => {
      assert.match(error.message, /CSDN_API_PUBLISH_NOT_ACCEPTED:Daily quota reached/);
      assert.doesNotMatch(error.message, /csdn-secret-token|secret-cookie|dXNlcjpwYXNz|client-secret|api-key-secret|json-secret-value|application-secret-value/);
      return true;
    },
  );
});

test("rejects a draft readback that is already publicly published", async () => {
  const { adapter, input } = createCsdnApiHarness({ draftStatus: 1 });

  await assert.rejects(
    () => adapter.publishArticle({ ...input, confirmPublish: false }),
    /CSDN_API_DRAFT_STATUS_MISMATCH/,
  );
});

test("waits for an eventually consistent CSDN draft readback", async () => {
  const { adapter, input, gatewayCalls } = createCsdnApiHarness({
    draftReadbackSequence: [
      { markdowncontent: "Stale autosave content.", content: "<p>Stale autosave content.</p>" },
      { markdowncontent: "Closed loop body marker.", content: "<p>Closed loop body marker.</p>" },
    ],
  });

  const result = await adapter.publishArticle({
    ...input,
    confirmPublish: true,
    draftVerifyAttempts: 2,
    draftVerifyPollMs: 1,
  });

  assert.equal(result.platformStatus, "published");
  assert.equal(gatewayCalls.filter((call) => call.url.includes("/editor/getArticle")).length, 3);
});

test("requires every populated CSDN draft representation to contain the content marker", async () => {
  const { adapter, input, gatewayCalls } = createCsdnApiHarness({
    draftReadbackSequence: [
      { markdowncontent: "Closed loop body marker.", content: "<p>Stale autosave content.</p>" },
      { markdowncontent: "Closed loop body marker.", content: "<p>Stale autosave content.</p>" },
    ],
  });

  await assert.rejects(
    () => adapter.publishArticle({
      ...input,
      confirmPublish: true,
      draftVerifyAttempts: 2,
      draftVerifyPollMs: 1,
    }),
    /CSDN_API_DRAFT_CONTENT_MISMATCH/,
  );
  assert.equal(gatewayCalls.filter((call) => call.url.includes("saveArticle")).length, 1);
});

test("accepts a CSDN draft readback whose markdown window crosses a block boundary", async () => {
  // Real 2026-10-13 shape: a short intro section followed by titled sections,
  // so the 80-character html window runs straight into the first section
  // title, where the stored markdown interleaves a "## " heading marker.
  const contentBlocks = [
    {
      type: "section",
      sectionId: "intro",
      title: "写在前面",
      content: "商用监控场景对画质和存储成本的平衡需求始终存在，传统方案往往顾此失彼，而基于大靶面传感器与智能编码的组合方案正在重构这一边界。",
    },
    {
      type: "section",
      sectionId: "s1",
      title: "大靶面传感器如何实现全彩夜视不模糊？",
      content: "传统低端商用摄像头多采用1/4英寸靶面CMOS传感器，单像素面积仅0.5μm左右，夜间光照不足时，传感器无法采集足够的色彩信息。",
    },
  ];
  const sentHtml = csdnBodyHtml({ contentBlocks }, []);
  const sentMarkdown = csdnMarkdown({ contentBlocks }, []);
  const { adapter, input, gatewayCalls } = createCsdnApiHarness({
    draftReadbackSequence: [{ markdowncontent: sentMarkdown, content: sentHtml }],
  });

  const result = await adapter.publishArticle({
    ...input,
    contentBlocks,
    confirmPublish: false,
  });

  assert.equal(result.platformStatus, "draft_saved");
  assert.equal(gatewayCalls.filter((call) => call.url.includes("/editor/getArticle")).length, 1);
});

test("still rejects a CSDN draft whose stored markdown belongs to another article", async () => {
  const { adapter, input, gatewayCalls } = createCsdnApiHarness({
    draftReadbackSequence: [
      { markdowncontent: "Stale autosave content.", content: "<p>Closed loop body marker.</p>" },
      { markdowncontent: "Stale autosave content.", content: "<p>Closed loop body marker.</p>" },
    ],
  });

  await assert.rejects(
    () => adapter.publishArticle({
      ...input,
      confirmPublish: true,
      draftVerifyAttempts: 2,
      draftVerifyPollMs: 1,
    }),
    /CSDN_API_DRAFT_CONTENT_MISMATCH:form=markdown/,
  );
  assert.equal(gatewayCalls.filter((call) => call.url.includes("saveArticle")).length, 1);
});

test("never retries an already published CSDN readback into a draft publish", async () => {
  const { adapter, input, gatewayCalls } = createCsdnApiHarness({
    draftReadbackSequence: [
      { status: 1, title: "Stale title replica" },
      { status: 2 },
    ],
  });

  await assert.rejects(
    () => adapter.publishArticle({
      ...input,
      confirmPublish: true,
      draftVerifyAttempts: 2,
      draftVerifyPollMs: 1,
    }),
    /CSDN_API_DRAFT_STATUS_MISMATCH:actual=1/,
  );
  assert.equal(gatewayCalls.filter((call) => call.url.includes("saveArticle")).length, 1);
});

test("rejects an anonymous page without the CSDN article body", async () => {
  const articleTitle = "CSDN API contract test article";
  const content = "Closed loop body marker.";
  const { adapter, input } = createCsdnApiHarness({
    publicSnapshot: {
      status: 200,
      url: "https://blog.csdn.net/zhixin_ai",
      title: `${articleTitle}-CSDN博客`,
      text: `${articleTitle} ${content}`,
      contentText: "",
      imageUrls: [],
    },
  });

  await assert.rejects(
    () => adapter.publishArticle({ ...input, confirmPublish: true }),
    /CSDN_API_PUBLICATION_NOT_VERIFIED/,
  );
});

test("rejects CSDN public evidence without the exact canonical article URL", async () => {
  const articleTitle = "CSDN exact public URL test";
  const { adapter, input } = createCsdnApiHarness({
    articleTitle,
    publicSnapshot: {
      status: 200,
      url: "",
      title: `${articleTitle}-CSDN Blog`,
      text: `${articleTitle} Closed loop body marker.`,
      contentText: "Closed loop body marker.",
      imageUrls: [],
    },
  });

  await assert.rejects(
    () => adapter.publishArticle({ ...input, confirmPublish: true }),
    /CSDN_API_PUBLICATION_NOT_VERIFIED/,
  );
});

test("does not verify a CSDN article when only the body contains the expected title", async () => {
  const articleTitle = "CSDN strict public title test";
  const { adapter, input } = createCsdnApiHarness({
    articleTitle,
    publicSnapshot: {
      status: 200,
      url: "https://blog.csdn.net/zhixin_ai/article/details/163500001",
      title: "Different article-CSDN Blog",
      text: `${articleTitle} Closed loop body marker.`,
      contentText: `${articleTitle} Closed loop body marker.`,
      imageUrls: [],
    },
  });

  await assert.rejects(
    () => adapter.publishArticle({ ...input, confirmPublish: true }),
    /CSDN_API_PUBLICATION_NOT_VERIFIED/,
  );
});

test("reports a CSDN manual verification blocker before failing", async () => {
  const { adapter, input, progressEvents } = createCsdnApiHarness({
    draftResponse: {
      ok: true,
      status: 200,
      payload: { code: 400, message: "请完成安全验证" },
    },
  });

  await assert.rejects(
    () => adapter.publishArticle({ ...input, confirmPublish: true }),
    /CSDN_MANUAL_ACTION_REQUIRED/,
  );
  assert.deepEqual(progressEvents, [{
    type: "manual_verification_required",
    platform: "csdn",
    stage: "draft",
  }]);
});

test("does not treat verification wording in a successful CSDN title as a blocker", async () => {
  const { adapter, input, progressEvents } = createCsdnApiHarness({
    articleTitle: "CSDN接口验证文章",
  });

  const result = await adapter.publishArticle({ ...input, confirmPublish: false });

  assert.equal(result.platformStatus, "draft_saved");
  assert.deepEqual(progressEvents, []);
});

test("always publishes CSDN through the captured API chain even when legacy apiFirst is false", async () => {
  const gatewayCalls = [];
  const requestCalls = [];
  const publicUrl = "https://blog.csdn.net/zhixin_ai/article/details/163240218";
  const articleTitle = "CSDN API-first publish test";
  const articleMarkdown = "## First paragraph.\n\nSecond paragraph keeps its markdown spacing.";
  let published = false;
  const page = {
    _url: "about:blank",
    request: {
      async fetch(url, options = {}) {
        requestCalls.push({ url, options });
        if (String(url).includes("bizapi.csdn.net")) {
          throw new Error("BIZAPI_MUST_USE_CSDN_SIGNED_GATEWAY");
        }
        throw new Error(`UNEXPECTED_REQUEST_FETCH:${url}`);
      },
    },
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    async goto(url) {
      page._url = url;
      return { status: () => 200 };
    },
    async waitForLoadState() {},
    async waitForTimeout() {},
    async waitForFunction() {},
    url: () => page._url,
    async title() { return "创作中心-CSDN"; },
    async evaluate(_callback, request) {
      if (!request?.url) return "发布博客 保存草稿";
      gatewayCalls.push(request);
      if (request.url.endsWith("/blog-console-api/v1/user/info")) {
        return { ok: true, status: 200, payload: { code: 200, data: { username: "zhixin_ai" }, msg: "success" } };
      }
      if (request.url.includes("/mdeditor/saveArticle")) {
        if (request.data.pubStatus === "publish") published = true;
        return {
          ok: true,
          status: 200,
          payload: { code: 200, data: { id: 163240218, url: publicUrl, title: articleTitle }, msg: "success" },
        };
      }
      if (request.url.includes("/editor/getArticle")) {
        return {
          ok: true,
          status: 200,
          payload: {
            code: 200,
            data: {
              article_id: 163240218,
              title: articleTitle,
              markdowncontent: articleMarkdown,
              content: "<p>First paragraph.</p><p>Second paragraph keeps its markdown spacing.</p>",
              tags: "AISEO,自动发布",
              status: published ? 1 : 2,
              cover_images: [],
            },
            msg: "success",
          },
        };
      }
      if (request.url.includes("/article/list")) {
        return {
          ok: true,
          status: 200,
          payload: {
            code: 200,
            data: {
              list: [{
                articleId: "163240218",
                title: articleTitle,
                downloadShareDataUrl: "https://blog.csdn.net/zhixin_ai/web/v1/share/download-share-data?articleId=163240218",
                status: published ? "1" : "2",
                username: "zhixin_ai",
                coverImage: [],
              }],
            },
            message: "success",
          },
        };
      }
      throw new Error(`UNEXPECTED_GATEWAY_CALL:${request.method}:${request.url}`);
    },
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "UserToken", value: "csdn-secret-token", domain: ".csdn.net" }],
    close: async () => requestCalls.push({ close: true }),
  };
  const adapter = new CsdnAdapter({
    browser: { launchPersistentContext: async () => context },
    publicPageFetcher: async (url) => ({
      status: 200,
      url,
      title: `${articleTitle}-CSDN博客`,
      text: `${articleTitle} First paragraph. Second paragraph keeps its markdown spacing.`,
      contentText: "First paragraph. Second paragraph keeps its markdown spacing.",
      imageUrls: [],
    }),
  });

  const result = await adapter.publishArticle({
    articleTitle,
    contentMarkdown: articleMarkdown,
    contentHtml: "<p>First paragraph.</p><p>Second paragraph keeps its markdown spacing.</p>",
    keywords: ["AISEO", "自动发布"],
    confirmPublish: true,
    apiFirst: false,
    publicVerifyAttempts: 1,
    publicVerifyPollMs: 1,
  });

  assert.equal(result.platformStatus, "published");
  // The reported backlink wears CSDN's traffic query; the page itself was
  // fetched on the clean address.
  assert.equal(result.publishedUrl, `${publicUrl}?spm=1011.2415.3001.5331`);
  assert.equal(result.publiclyVisible, true);
  assert.equal(result.publicationEvidence.source, "api");
  assert.equal(result.publicationEvidence.accepted, true);
  assert.equal(result.externalIds.articleId, "163240218");
  assert.equal(result.externalIds.username, "zhixin_ai");

  const saveCalls = gatewayCalls.filter((call) => call.url.includes("saveArticle"));
  assert.equal(saveCalls.length, 2);
  assert.equal(saveCalls[0].data.status, 2);
  assert.equal(saveCalls[0].data.pubStatus, "draft");
  assert.equal(saveCalls[0].data.markdowncontent, articleMarkdown);
  assert.equal(saveCalls[0].data.tags, "AISEO,自动发布");
  assert.equal(saveCalls[1].data.id, 163240218);
  assert.equal(saveCalls[1].data.status, 0);
  assert.equal(saveCalls[1].data.pubStatus, "publish");
  assert.ok(gatewayCalls.some((call) => call.url.includes("/editor/getArticle?id=163240218")));
  assert.ok(gatewayCalls.some((call) => call.url.includes("/article/list?page=1&status=all_v3&pageSize=20")));
  assert.equal(requestCalls.filter((call) => String(call.url).includes("bizapi.csdn.net")).length, 0);
  assert.doesNotMatch(JSON.stringify(result.publicationEvidence), /csdn-secret-token/);
});

test("falls back to the bounded cloud snapshot when local CSDN public fetch fails", async () => {
  const articleTitle = "CSDN cloud snapshot fallback test";
  const publicUrl = "https://blog.csdn.net/zhixin_ai/article/details/163500001";
  const snapshotEndpoint = "https://zhixin.example.com/api/public-snapshots/csdn";
  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    if (String(url) === publicUrl) throw new TypeError("fetch failed");
    if (String(url) === snapshotEndpoint) {
      assert.equal(options.method, "POST");
      assert.equal(options.headers["content-type"], "application/json");
      assert.deepEqual(JSON.parse(options.body), { url: publicUrl });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            status: 200,
            url: publicUrl,
            title: articleTitle,
            text: `${articleTitle} Closed loop body marker.`,
            contentText: "Closed loop body marker.",
            imageUrls: [],
          };
        },
      };
    }
    throw new Error(`UNEXPECTED_FETCH:${url}`);
  };

  try {
    const { adapter, input } = createCsdnApiHarness({
      articleTitle,
      useDefaultPublicFetcher: true,
    });
    const result = await adapter.publishArticle({
      ...input,
      confirmPublish: true,
    });

    assert.equal(result.platformStatus, "published");
    assert.equal(result.publishedUrl, `${publicUrl}?spm=1011.2415.3001.5331`);
    assert.deepEqual(fetchCalls.map((call) => call.url), [publicUrl, snapshotEndpoint]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects a cross-origin CSDN redirect before requesting its target", async () => {
  const publicUrl = "https://blog.csdn.net/zhixin_ai/article/details/163500001";
  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push(String(url));
    assert.equal(options.redirect, "manual");
    return {
      status: 302,
      url: String(url),
      headers: new Headers({ location: "https://example.com/private" }),
      async text() { return ""; },
    };
  };

  try {
    const { adapter, input } = createCsdnApiHarness({ useDefaultPublicFetcher: true });
    await assert.rejects(
      () => adapter.publishArticle({ ...input, confirmPublish: true }),
      /CSDN_API_PUBLICATION_NOT_VERIFIED/,
    );
    assert.deepEqual(fetchCalls, [publicUrl]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not use the CSDN cloud fallback for a local HTML parsing error", async () => {
  const publicUrl = "https://blog.csdn.net/zhixin_ai/article/details/163500001";
  const snapshotEndpoint = "https://zhixin.example.com/api/public-snapshots/csdn";
  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    if (String(url) === publicUrl) {
      return {
        status: 200,
        url: publicUrl,
        headers: new Headers(),
        async text() {
          return "<html><title>Broken &#x110000;</title><div id=\"content_views\">Closed loop body marker.</div></html>";
        },
      };
    }
    if (String(url) === snapshotEndpoint) throw new Error("CLOUD_FALLBACK_MUST_NOT_RUN");
    throw new Error(`UNEXPECTED_FETCH:${url}`);
  };

  try {
    const { adapter, input } = createCsdnApiHarness({ useDefaultPublicFetcher: true });
    await assert.rejects(
      () => adapter.publishArticle({ ...input, confirmPublish: true }),
      /CSDN_API_PUBLICATION_NOT_VERIFIED/,
    );
    assert.deepEqual(fetchCalls, [publicUrl]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uses a fresh timeout signal for the cloud snapshot after local fetch aborts", async () => {
  const articleTitle = "CSDN independent snapshot timeout test";
  const publicUrl = "https://blog.csdn.net/zhixin_ai/article/details/163500001";
  const snapshotEndpoint = "https://zhixin.example.com/api/public-snapshots/csdn";
  const originalFetch = globalThis.fetch;
  const OriginalAbortController = globalThis.AbortController;
  globalThis.AbortController = class TestAbortController {
    constructor() {
      this.signal = { aborted: false };
    }

    abort() {
      this.signal.aborted = true;
    }
  };
  globalThis.fetch = async (url, options = {}) => {
    if (String(url) === publicUrl) {
      options.signal.aborted = true;
      throw new DOMException("The operation was aborted", "AbortError");
    }
    if (String(url) === snapshotEndpoint) {
      assert.equal(options.signal.aborted, false);
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            status: 200,
            url: publicUrl,
            title: articleTitle,
            text: `${articleTitle} Closed loop body marker.`,
            contentText: "Closed loop body marker.",
            imageUrls: [],
          };
        },
      };
    }
    throw new Error(`UNEXPECTED_FETCH:${url}`);
  };

  try {
    const { adapter, input } = createCsdnApiHarness({
      articleTitle,
      useDefaultPublicFetcher: true,
    });
    const result = await adapter.publishArticle({ ...input, confirmPublish: true });
    assert.equal(result.platformStatus, "published");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.AbortController = OriginalAbortController;
  }
});

test("uploads CSDN images with the captured OBS form and verifies draft and public image evidence", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "zhixin-csdn-api-"));
  const imagePath = path.join(tempDirectory, "inline.png");
  const gifPath = path.join(tempDirectory, "inline.gif");
  const coverPath = path.join(tempDirectory, "cover.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(gifPath, Buffer.from("GIF89a", "ascii"));
  await writeFile(coverPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
  const articleId = "163452064";
  const articleTitle = "CSDN API image closed-loop test";
  const publicUrl = `https://blog.csdn.net/zhixin_ai/article/details/${articleId}`;
  const platformImageUrl = "https://i-blog.csdnimg.cn/direct/csdn-api-inline.png";
  const platformGifUrl = "https://i-blog.csdnimg.cn/direct/csdn-api-inline.gif";
  const platformCoverUrl = "https://i-blog.csdnimg.cn/direct/csdn-api-cover.png";
  const gatewayCalls = [];
  const uploadCalls = [];
  let published = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    status: 200,
    url: String(url),
    async text() {
      return `<!doctype html><html><head><title>${articleTitle}-CSDN博客</title></head><body><article><div id="content_views"><p>Image&#32;body&#32;marker.</p><img src="${platformImageUrl}#pic_center" alt="inline"><img src="${platformGifUrl}#pic_center" alt="gif"></div></article></body></html>`;
    },
  });
  const page = {
    _url: "about:blank",
    request: {
      async fetch(url, options = {}) {
        uploadCalls.push({ url, options });
        const uploadedUrl = options.multipart?.key?.includes("cover")
          ? platformCoverUrl
          : options.multipart?.key?.includes("gif") ? platformGifUrl : platformImageUrl;
        return {
          status: () => 200,
          url: () => url,
          text: async () => JSON.stringify({ code: 200, data: uploadedUrl }),
        };
      },
    },
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    async goto(url) { page._url = url; return { status: () => 200 }; },
    async waitForLoadState() {},
    async waitForTimeout() {},
    async waitForFunction() {},
    url: () => page._url,
    async title() { return "创作中心-CSDN"; },
    async evaluate(_callback, request) {
      if (!request?.url) return "发布博客 保存草稿";
      gatewayCalls.push(request);
      if (request.url.endsWith("/blog-console-api/v1/user/info")) {
        return { ok: true, status: 200, payload: { code: 200, data: { username: "zhixin_ai" }, msg: "success" } };
      }
      if (request.url.endsWith("/resource-api/v1/image/direct/upload/signature")) {
        const cover = request.data.appName === "direct_blog_coverimage";
        const filePath = cover ? "direct/csdn-api-cover.png" : `direct/csdn-api-inline.${request.data.imageSuffix}`;
        return {
          ok: true,
          status: 200,
          payload: {
            code: 200,
            data: {
              provider: "obs",
              accessId: "public-temporary-access-id",
              policy: "temporary-policy",
              signature: "temporary-signature",
              host: "https://csdn-img-blog.obs.cn-north-4.myhuaweicloud.com",
              callbackUrl: "https://cb-api.csdn.net/resource-api/v1/image/obs/callback",
              callbackBody: "callback-body",
              callbackBodyType: "application/json",
              filePath,
              customParam: {
                rtype: cover ? "coverImage" : "blog_picture",
                filePath,
                isAudit: 1,
                "x-image-app": request.data.appName,
                type: "blog",
                "x-image-suffix": request.data.imageSuffix,
                username: "zhixin_ai",
              },
            },
            msg: "success",
          },
        };
      }
      if (request.url.includes("/mdeditor/saveArticle")) {
        if (request.data.pubStatus === "publish") published = true;
        return { ok: true, status: 200, payload: { code: 200, data: { id: Number(articleId), url: publicUrl, title: articleTitle }, msg: "success" } };
      }
      if (request.url.includes("/editor/getArticle")) {
        return {
          ok: true,
          status: 200,
          payload: {
            code: 200,
            data: {
              article_id: Number(articleId),
              title: articleTitle,
              markdowncontent: `Image body marker.\n\n![inline](${platformImageUrl}#pic_center)\n\n![gif](${platformGifUrl}#pic_center)`,
              content: `<p>Image body marker.</p><p><img src="${platformImageUrl}#pic_center"></p><p><img src="${platformGifUrl}#pic_center"></p>`,
              status: published ? 1 : 2,
              cover_images: [platformCoverUrl],
            },
            msg: "success",
          },
        };
      }
      if (request.url.includes("/article/list")) {
        return {
          ok: true,
          status: 200,
          payload: {
            code: 200,
            data: {
              list: [{
                articleId,
                title: articleTitle,
                downloadShareDataUrl: `https://blog.csdn.net/zhixin_ai/web/v1/share/download-share-data?articleId=${articleId}`,
                status: published ? "1" : "2",
                username: "zhixin_ai",
                coverImage: [platformCoverUrl],
              }],
            },
            message: "success",
          },
        };
      }
      throw new Error(`UNEXPECTED_GATEWAY_CALL:${request.method}:${request.url}`);
    },
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "UserToken", value: "csdn-image-token", domain: ".csdn.net" }],
    close: async () => {},
  };
  const adapter = new CsdnAdapter({
    browser: { launchPersistentContext: async () => context },
  });

  try {
    const result = await adapter.publishArticle({
      articleTitle,
      contentMarkdown: "Image body marker.",
      contentHtml: "<p>Image body marker.</p>",
      platformImageTasks: [{
        assetId: "asset-inline",
        sectionId: "body",
        position: 1,
        path: imagePath,
        altText: "inline",
      }, {
        assetId: "asset-gif",
        sectionId: "body-gif",
        position: 2,
        path: gifPath,
        altText: "gif",
      }],
      coverImagePath: coverPath,
      confirmPublish: true,
      publicVerifyAttempts: 1,
      publicVerifyPollMs: 1,
    });

    assert.equal(uploadCalls.length, 3);
    const multipart = uploadCalls.find((call) => call.options.multipart?.key?.includes("inline"))?.options.multipart;
    assert.equal(multipart.key, "direct/csdn-api-inline.png");
    assert.equal(multipart.AccessKeyId, "public-temporary-access-id");
    assert.equal(multipart.callbackUrl, "https://cb-api.csdn.net/resource-api/v1/image/obs/callback");
    assert.equal(multipart.callbackBody, "callback-body");
    assert.equal(multipart.callbackBodyType, "application/json");
    assert.equal(multipart["x:rtype"], "blog_picture");
    assert.equal(multipart["x:filePath"], "direct/csdn-api-inline.png");
    assert.equal(multipart["x:x-image-app"], "direct_blog");
    assert.equal(multipart.file.name, "inline.png");
    assert.equal(multipart.file.mimeType, "image/png");
    assert.ok(Buffer.isBuffer(multipart.file.buffer));
    const gifMultipart = uploadCalls.find((call) => call.options.multipart?.key?.endsWith(".gif"))?.options.multipart;
    assert.equal(gifMultipart.file.name, "inline.gif");
    assert.equal(gifMultipart.file.mimeType, "image/gif");
    const signatureCall = gatewayCalls.find((call) => call.url.includes("/direct/upload/signature"));
    assert.deepEqual(signatureCall.data, { imageTemplate: "", appName: "direct_blog", imageSuffix: "png" });
    const gifSignatureCall = gatewayCalls.find((call) => (
      call.url.includes("/direct/upload/signature")
      && call.data.imageSuffix === "gif"
    ));
    assert.deepEqual(gifSignatureCall.data, { imageTemplate: "", appName: "direct_blog", imageSuffix: "gif" });
    const coverSignatureCall = gatewayCalls.find((call) => (
      call.url.includes("/direct/upload/signature")
      && call.data.appName === "direct_blog_coverimage"
    ));
    assert.deepEqual(coverSignatureCall.data, { imageTemplate: "", appName: "direct_blog_coverimage", imageSuffix: "png" });
    const saveCalls = gatewayCalls.filter((call) => call.url.includes("saveArticle"));
    assert.deepEqual(saveCalls[0].data.cover_images, [platformCoverUrl]);
    assert.deepEqual(saveCalls[1].data.cover_images, [platformCoverUrl]);
    assert.equal(result.coverImageEvidence.status, "verified");
    assert.equal(result.coverImageEvidence.platformImageUrl, platformCoverUrl);
    assert.equal(result.imagePublicationEvidence.status, "verified");
    assert.equal(result.imagePublicationEvidence.upload.images[0].platformImageUrl, platformImageUrl);
    assert.equal(result.imagePublicationEvidence.upload.images[1].platformImageUrl, platformGifUrl);
    assert.equal(result.imagePublicationEvidence.draft.images[0].platformImageUrl, platformImageUrl);
    assert.equal(result.imagePublicationEvidence.public.images[0].platformImageUrl, platformImageUrl);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

// The device materializes every inline image into a local data URL before any
// adapter runs. On 2026-10-11 that blob reached CSDN as a 1.4 MB body and the
// platform answered "正文字数太多，请分成几篇博文发布", so the saved body has to
// reference the uploaded platform URL instead of the materialized bytes.
test("keeps materialized inline image bytes out of the CSDN draft body", async () => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "zhixin-csdn-materialized-"));
  const imagePath = path.join(tempDirectory, "inline.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const articleId = "163500777";
  const articleTitle = "CSDN materialized image regression";
  const platformImageUrl = "https://i-blog.csdnimg.cn/direct/csdn-materialized-inline.png";
  const bodyText = "Materialized image regression marker for the CSDN draft body, long enough to outgrow the eighty character content marker window.";
  const materializedDataUrl = `data:image/png;base64,${"A".repeat(8192)}`;
  const gatewayCalls = [];
  let published = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    status: 200,
    url: String(url),
    async text() {
      return `<!doctype html><html><head><title>${articleTitle}-CSDN博客</title></head><body><article><div id="content_views"><p>${bodyText}</p><img src="${platformImageUrl}#pic_center" alt="inline"></div></article></body></html>`;
    },
  });
  const page = {
    _url: "about:blank",
    request: {
      async fetch(url, options = {}) {
        return {
          status: () => 200,
          url: () => url,
          text: async () => JSON.stringify({ code: 200, data: platformImageUrl }),
        };
      },
    },
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    async goto(url) { page._url = url; return { status: () => 200 }; },
    async waitForLoadState() {},
    async waitForTimeout() {},
    async waitForFunction() {},
    url: () => page._url,
    async title() { return "创作中心-CSDN"; },
    async evaluate(_callback, request) {
      if (!request?.url) return "发布博客 保存草稿";
      gatewayCalls.push(request);
      if (request.url.endsWith("/blog-console-api/v1/user/info")) {
        return { ok: true, status: 200, payload: { code: 200, data: { username: "zhixin_ai" }, msg: "success" } };
      }
      if (request.url.includes("/resource-api/v1/image/direct/upload/signature")) {
        return {
          ok: true,
          status: 200,
          payload: {
            code: 200,
            data: {
              provider: "obs",
              accessId: "public-temporary-access-id",
              policy: "temporary-policy",
              signature: "temporary-signature",
              host: "https://csdn-img-blog.obs.cn-north-4.myhuaweicloud.com",
              callbackUrl: "https://cb-api.csdn.net/resource-api/v1/image/obs/callback",
              callbackBody: "callback-body",
              callbackBodyType: "application/json",
              filePath: "direct/csdn-materialized-inline.png",
              customParam: {
                rtype: "blog_picture",
                filePath: "direct/csdn-materialized-inline.png",
                isAudit: 1,
                "x-image-app": "direct_blog",
                type: "blog",
                "x-image-suffix": "png",
                username: "zhixin_ai",
              },
            },
            msg: "success",
          },
        };
      }
      if (request.url.includes("/mdeditor/saveArticle")) {
        if (request.data.pubStatus === "publish") published = true;
        return {
          ok: true,
          status: 200,
          payload: {
            code: 200,
            data: { id: Number(articleId), url: `https://blog.csdn.net/zhixin_ai/article/details/${articleId}`, title: articleTitle },
            msg: "success",
          },
        };
      }
      if (request.url.includes("/editor/getArticle")) {
        return {
          ok: true,
          status: 200,
          payload: {
            code: 200,
            data: {
              article_id: Number(articleId),
              title: articleTitle,
              markdowncontent: `${bodyText}\n\n![inline](${platformImageUrl}#pic_center)`,
              content: `<p>${bodyText}</p><p><img src="${platformImageUrl}#pic_center"></p>`,
              status: published ? 1 : 2,
              cover_images: [],
            },
            msg: "success",
          },
        };
      }
      if (request.url.includes("/article/list")) {
        return {
          ok: true,
          status: 200,
          payload: {
            code: 200,
            data: {
              list: [{
                articleId,
                title: articleTitle,
                downloadShareDataUrl: `https://blog.csdn.net/zhixin_ai/web/v1/share/download-share-data?articleId=${articleId}`,
                status: published ? "1" : "2",
                username: "zhixin_ai",
                coverImage: [],
              }],
            },
            message: "success",
          },
        };
      }
      throw new Error(`UNEXPECTED_GATEWAY_CALL:${request.method}:${request.url}`);
    },
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "UserToken", value: "csdn-materialized-token", domain: ".csdn.net" }],
    close: async () => {},
  };
  const adapter = new CsdnAdapter({
    browser: { launchPersistentContext: async () => context },
  });

  try {
    const result = await adapter.publishArticle({
      articleTitle,
      contentMarkdown: bodyText,
      contentBlocks: [
        { type: "section", sectionId: "body", title: "", content: bodyText },
        {
          type: "image",
          assetId: "asset-inline",
          sectionId: "body",
          position: 1,
          url: "/uploads/materialized-inline.png",
          path: imagePath,
          dataUrl: materializedDataUrl,
          altText: "inline",
        },
      ],
      platformImageTasks: [{
        assetId: "asset-inline",
        sectionId: "body",
        position: 1,
        path: imagePath,
        altText: "inline",
      }],
      confirmPublish: true,
      publicVerifyAttempts: 1,
      publicVerifyPollMs: 1,
    });

    const saveCalls = gatewayCalls.filter((call) => call.url.includes("saveArticle"));
    assert.equal(saveCalls.length, 2);
    for (const saveCall of saveCalls) {
      const content = saveCall.data.content;
      assert.ok(content.includes(platformImageUrl), "saved body must reference the uploaded platform image");
      assert.doesNotMatch(content, /data:image/i);
      assert.doesNotMatch(content, /\/uploads\//i);
      assert.ok(content.length < 200000);
      assert.match(content, /<img src="https:\/\/i-blog\.csdnimg\.cn\/direct\/csdn-materialized-inline\.png/);
    }
    assert.doesNotMatch(saveCalls[0].data.markdowncontent, /data:image/i);
    assert.equal(result.imagePublicationEvidence.status, "verified");
    assert.equal(result.imagePublicationEvidence.upload.images[0].platformImageUrl, platformImageUrl);
    assert.equal(result.imagePublicationEvidence.draft.images[0].platformImageUrl, platformImageUrl);
    assert.equal(result.imagePublicationEvidence.public.images[0].platformImageUrl, platformImageUrl);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("refuses a CSDN body that still embeds local image bytes", () => {
  const dataUrl = "data:image/png;base64,AAAA";
  assert.throws(
    () => csdnBodyHtml({
      content: "本地图片回归。".repeat(20),
      richHtml: `<p><img src="${dataUrl}"></p>`,
    }),
    /CSDN_API_CONTENT_EMBEDS_LOCAL_IMAGE/,
  );
  // An image block whose upload never produced a platform URL degrades to
  // nothing instead of shipping the materialized bytes.
  const html = csdnBodyHtml({
    content: "本地图片回归。".repeat(20),
    contentBlocks: [{
      type: "image",
      assetId: "asset-inline",
      sectionId: "body",
      dataUrl,
      url: "/uploads/materialized-inline.png",
      path: "C:/images/materialized-inline.png",
      altText: "inline",
    }],
  }, []);
  assert.doesNotMatch(html, /<img|data:image|\/uploads\//i);
  const markdown = csdnMarkdown({
    content: "本地图片回归。".repeat(20),
    contentBlocks: [{
      type: "image",
      assetId: "asset-inline",
      sectionId: "body",
      dataUrl,
      url: "/uploads/materialized-inline.png",
      altText: "inline",
    }],
  }, []);
  assert.doesNotMatch(markdown, /data:image|\/uploads\//i);
  assert.throws(
    () => csdnBodyHtml({ content: "x".repeat(200001) }),
    /CSDN_API_CONTENT_TOO_LARGE:html:\d+/,
  );
});

// The adapter hot update ships without rich-content.mjs, so a device still
// running the composer from its install reads `block.dataUrl || block.url`.
// The sanitized block has to survive that older expression too.
test("keeps the hot-updated CSDN adapter working with the pre-MSI composer", () => {
  const platformImageUrl = "https://i-blog.csdnimg.cn/direct/csdn-hot-contract.png";
  const sanitized = csdnPublicImageBlock({
    type: "image",
    assetId: "asset-inline",
    sectionId: "body",
    url: "/uploads/materialized-inline.png",
    path: "C:/images/materialized-inline.png",
    dataUrl: "data:image/png;base64,AAAA",
    platformImageUrl,
    altText: "inline",
  });
  assert.equal(sanitized.dataUrl, "");
  assert.equal(sanitized.path, "");
  assert.equal(String(sanitized.dataUrl || sanitized.url || ""), platformImageUrl);
  const withoutUpload = csdnPublicImageBlock({
    type: "image",
    assetId: "asset-inline",
    sectionId: "body",
    url: "/uploads/materialized-inline.png",
    dataUrl: "data:image/png;base64,AAAA",
    altText: "inline",
  });
  assert.equal(String(withoutUpload.dataUrl || withoutUpload.url || ""), "");
  assert.equal(csdnPublicImageBlock({ type: "section", content: "untouched" }).content, "untouched");
});

// csdn.mjs declares PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED locally instead of importing
// it, so a hot update still imports cleanly on an install whose
// platform-images.mjs predates that export. The two values have to stay equal or
// the stage label the adapter reports would drift from the one the rest of the
// pipeline reads.
test("keeps the locally declared public-image stage label equal to the shared one", async () => {
  const adapterPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "adapters", "csdn.mjs");
  const adapterSource = await readFile(adapterPath, "utf8");
  const declared = /const PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED = "([^"]*)";/.exec(adapterSource);
  assert.ok(declared, "csdn.mjs must keep declaring the stage label locally for hot-update compatibility");
  assert.equal(declared[1], PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED);
  assert.equal(PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED, "PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED");
});

test("cleans up an explicitly marked CSDN gate article through recycle-bin and permanent deletion", async () => {
  const articleId = "163500001";
  const articleTitle = "CSDN cleanup closed-loop test";
  const publicUrl = `https://blog.csdn.net/zhixin_ai/article/details/${articleId}`;
  const gatewayCalls = [];
  let published = false;
  let cleanupStage = "active";
  const page = {
    _url: "about:blank",
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    async goto(url) { page._url = url; return { status: () => 200 }; },
    async waitForLoadState() {},
    async waitForTimeout() {},
    async waitForFunction() {},
    url: () => page._url,
    async title() { return "CSDN creator center"; },
    async evaluate(_callback, request) {
      if (!request?.url) return "Publish blog Save draft";
      gatewayCalls.push(request);
      if (request.url.endsWith("/blog-console-api/v1/user/info")) {
        return { ok: true, status: 200, payload: { code: 200, data: { username: "zhixin_ai" }, msg: "success" } };
      }
      if (request.url.includes("/mdeditor/saveArticle")) {
        if (request.data.pubStatus === "publish") published = true;
        return { ok: true, status: 200, payload: { code: 200, data: { id: Number(articleId), url: publicUrl }, msg: "success" } };
      }
      if (request.url.includes("/editor/getArticle")) {
        return {
          ok: true,
          status: 200,
          payload: {
            code: 200,
            data: {
              article_id: Number(articleId),
              title: articleTitle,
              markdowncontent: "Cleanup body marker.",
              content: "<p>Cleanup body marker.</p>",
              status: published ? 1 : 2,
              cover_images: [],
            },
            msg: "success",
          },
        };
      }
      if (request.url.endsWith("/blog/phoenix/console/v1/article/del")) {
        if (request.data.deep === false) cleanupStage = "recycled";
        if (request.data.deep === true) {
          assert.equal(cleanupStage, "recycled");
          cleanupStage = "deleted";
        }
        return { ok: true, status: 200, payload: { code: 200, message: "success", data: true } };
      }
      if (request.url.includes("/article/list")) {
        const list = cleanupStage === "deleted"
          ? []
          : [{
              articleId,
              title: articleTitle,
              status: cleanupStage === "recycled" ? "32" : (published ? "1" : "2"),
              username: "zhixin_ai",
              coverImage: [],
            }];
        return { ok: true, status: 200, payload: { code: 200, data: { list }, message: "success" } };
      }
      throw new Error(`UNEXPECTED_GATEWAY_CALL:${request.method}:${request.url}`);
    },
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "UserToken", value: "csdn-cleanup-token", domain: ".csdn.net" }],
    close: async () => {},
  };
  const adapter = new CsdnAdapter({
    browser: { launchPersistentContext: async () => context },
    publicPageFetcher: async (url) => ({
      status: 200,
      url,
      title: `${articleTitle}-CSDN Blog`,
      text: `${articleTitle} Cleanup body marker.`,
      contentText: "Cleanup body marker.",
      imageUrls: [],
    }),
  });

  const result = await adapter.publishArticle({
    articleTitle,
    contentMarkdown: "Cleanup body marker.",
    contentHtml: "<p>Cleanup body marker.</p>",
    confirmPublish: true,
    cleanupTestArticle: true,
    publicVerifyAttempts: 1,
    publicVerifyPollMs: 1,
    cleanupVerifyAttempts: 1,
    cleanupVerifyPollMs: 1,
  });

  const deleteCalls = gatewayCalls.filter((call) => call.url.endsWith("/blog/phoenix/console/v1/article/del"));
  assert.deepEqual(deleteCalls.map((call) => call.data), [
    { articleId, deep: false },
    { articleId, deep: true },
  ]);
  assert.equal(result.testCleanup.deleted, true);
  assert.equal(result.testCleanup.articleId, articleId);
  assert.equal(result.testCleanup.softDeleted, true);
  assert.equal(result.testCleanup.permanentlyDeleted, true);
  assert.equal(result.testCleanup.listVerified, true);
  assert.equal(cleanupStage, "deleted");
});

test("reports a CSDN review queued article as submitted_for_review instead of failing", async () => {
  const { adapter, input, publicFetchCalls } = createCsdnApiHarness({
    postPublishStatus: 6,
  });

  const result = await adapter.publishArticle({
    ...input,
    confirmPublish: true,
    publicVerifyAttempts: 2,
    publicVerifyPollMs: 1,
  });

  assert.equal(result.platformStatus, "submitted_for_review");
  assert.equal(result.reviewStatus, "pending_review");
  assert.equal(result.publiclyVisible, false);
  assert.equal(result.publishedUrl, "");
  // The review link is the address a visitor opens once CSDN approves it, so it
  // carries the traffic query as well.
  assert.equal(result.reviewUrl, "https://blog.csdn.net/zhixin_ai/article/details/163500001?spm=1011.2415.3001.5331");
  assert.equal(result.candidateUrl, result.reviewUrl);
  assert.equal(result.externalIds.articleId, "163500001");
  assert.equal(result.externalIds.slug, "zhixin_ai");
  assert.deepEqual(publicFetchCalls, []);
  assert.ok(result.publicationEvidence.steps.some((step) => step.stage === "review_queued" && step.status === 6));
  assert.match(result.message, /review/i);
});

test("discovers a CSDN public article and repairs the review URL slug from the console", async () => {
  const { adapter, input, publicFetchCalls } = createCsdnApiHarness({ draftStatus: 1 });

  const result = await adapter.discoverPublication({
    articleTitle: input.articleTitle,
    contentMarkdown: input.contentMarkdown,
    contentHtml: input.contentHtml,
    // The stored link carries the platformConfig template slug, which belongs to a
    // different author, so discovery has to re-derive the real one from the console.
    reviewUrl: "https://blog.csdn.net/phoenix/article/details/163500001",
    publicVerifyAttempts: 1,
  });

  assert.equal(result.found, true);
  assert.equal(result.publicUrl, "https://blog.csdn.net/zhixin_ai/article/details/163500001?spm=1011.2415.3001.5331");
  assert.equal(result.publishedUrl, result.publicUrl);
  assert.equal(result.reviewUrl, result.publicUrl);
  assert.equal(result.platformStatus, "published");
  assert.equal(result.reviewStatus, "public");
  assert.equal(result.publiclyVisible, true);
  assert.equal(result.externalIds.articleId, "163500001");
  assert.equal(result.externalIds.slug, "zhixin_ai");
  assert.ok(result.pageText.includes(input.articleTitle));
  // The page is fetched and asserted on the clean address; only the report
  // carries the traffic query.
  assert.deepEqual(publicFetchCalls, ["https://blog.csdn.net/zhixin_ai/article/details/163500001"]);
  assert.ok(publicFetchCalls.every((url) => !url.includes("spm=")));
});

// CSDN states the review verdict only in the console article list, and the 2026-10-22
// capture measured what an in_review verdict means for the link: that article's public
// URL answered 404 while every published one answered 200. So a page that happens to
// read back at the address is not evidence the platform let the article out. The
// recheck has to stay pending instead of reporting a public link.
test("keeps a CSDN article pending when the console still reports it in review even though the page reads back", async () => {
  const { adapter, input } = createCsdnApiHarness({ draftStatus: 6 });

  const result = await adapter.discoverPublication({
    articleTitle: input.articleTitle,
    contentMarkdown: input.contentMarkdown,
    reviewUrl: "https://blog.csdn.net/phoenix/article/details/163500001",
    publicVerifyAttempts: 1,
  });

  assert.equal(result.found, false);
  assert.equal(result.publicUrl, "");
  assert.equal(result.publiclyVisible, false);
  assert.equal(result.platformStatus, "submitted_for_review");
  assert.equal(result.reviewStatus, "pending_public_visibility");
  assert.equal(result.managementStatus, "6");
  assert.match(result.message, /still holds this article in review/);
  assert.match(result.message, /console reports status 6/);
});

test("keeps a review queued CSDN article pending while still repairing the review URL slug", async () => {
  const { adapter, input, publicFetchCalls } = createCsdnApiHarness({
    draftStatus: 6,
    publicSnapshot: {
      status: 200,
      url: "https://blog.csdn.net/zhixin_ai/article/details/163500001",
      title: "内容还在审核中-CSDN博客",
      text: "内容还在审核中",
      contentText: "",
      imageUrls: [],
    },
  });

  const result = await adapter.discoverPublication({
    articleTitle: input.articleTitle,
    contentMarkdown: input.contentMarkdown,
    reviewUrl: "https://blog.csdn.net/phoenix/article/details/163500001",
    publicVerifyAttempts: 1,
  });

  assert.equal(result.found, false);
  assert.equal(result.publicUrl, "");
  // publishedUrl carries the corrected candidate so the backend can rewrite reviewUrl.
  assert.equal(result.publishedUrl, "https://blog.csdn.net/zhixin_ai/article/details/163500001?spm=1011.2415.3001.5331");
  assert.equal(result.platformStatus, "submitted_for_review");
  assert.equal(result.reviewStatus, "pending_public_visibility");
  assert.equal(result.managementStatus, "6");
  assert.match(result.message, /console reports status 6/);
  assert.deepEqual(publicFetchCalls, [
    "https://blog.csdn.net/zhixin_ai/article/details/163500001",
    "https://blog.csdn.net/phoenix/article/details/163500001",
  ]);
});

test("discovers a CSDN public page under the account username when the share-data URL keeps the template slug", async () => {
  const articleTitle = "CSDN discovery template slug article";
  // Production shape: the share-data URL and the stored link both carry CSDN's
  // template slug (phoenix), which belongs to no author, while the console
  // account API reports the real blog slug. Only the account-slug page answers,
  // so discovery has to probe it instead of stopping at the first slug source.
  const { adapter, input, publicFetchCalls } = createCsdnApiHarness({
    articleTitle,
    accountUsername: "example_author",
    shareSlug: "phoenix",
    draftStatus: 1,
    publicSnapshot: (url) => (url.startsWith("https://blog.csdn.net/example_author/")
      ? {
        status: 200,
        url,
        title: `${articleTitle}-CSDN Blog`,
        text: `${articleTitle} Closed loop body marker.`,
        contentText: "Closed loop body marker.",
        imageUrls: [],
      }
      : { status: 404, url, title: "404", text: "404", contentText: "", imageUrls: [] }),
  });

  const result = await adapter.discoverPublication({
    articleTitle: input.articleTitle,
    contentMarkdown: input.contentMarkdown,
    reviewUrl: "https://blog.csdn.net/phoenix/article/details/163500001",
    publicVerifyAttempts: 1,
  });

  assert.equal(result.found, true);
  assert.equal(result.publicUrl, "https://blog.csdn.net/example_author/article/details/163500001?spm=1011.2415.3001.5331");
  assert.equal(result.publishedUrl, result.publicUrl);
  assert.equal(result.reviewUrl, result.publicUrl);
  assert.equal(result.externalIds.articleId, "163500001");
  assert.equal(result.externalIds.slug, "example_author");
  assert.deepEqual(publicFetchCalls, ["https://blog.csdn.net/example_author/article/details/163500001"]);
  assert.ok(publicFetchCalls.every((url) => !url.includes("spm=")));
});

test("keeps a CSDN review-queued article pending with the account-slug candidate when the share-data URL keeps the template slug", async () => {
  const articleTitle = "CSDN discovery template slug pending article";
  const { adapter, input, publicFetchCalls } = createCsdnApiHarness({
    articleTitle,
    accountUsername: "example_author",
    shareSlug: "phoenix",
    draftStatus: 6,
    publicSnapshot: (url) => ({ status: 404, url, title: "404", text: "404", contentText: "", imageUrls: [] }),
  });

  const result = await adapter.discoverPublication({
    articleTitle: input.articleTitle,
    contentMarkdown: input.contentMarkdown,
    reviewUrl: "https://blog.csdn.net/phoenix/article/details/163500001",
    publicVerifyAttempts: 1,
  });

  assert.equal(result.found, false);
  assert.equal(result.publicUrl, "");
  // publishedUrl and reviewUrl carry the account-slug candidate so the backend
  // rewrites the stored review URL away from the template slug.
  assert.equal(result.publishedUrl, "https://blog.csdn.net/example_author/article/details/163500001?spm=1011.2415.3001.5331");
  assert.equal(result.reviewUrl, result.publishedUrl);
  assert.equal(result.externalIds.slug, "example_author");
  assert.equal(result.managementStatus, "6");
  assert.deepEqual(publicFetchCalls, [
    "https://blog.csdn.net/example_author/article/details/163500001",
    "https://blog.csdn.net/phoenix/article/details/163500001",
  ]);
});

test("matches the CSDN article list by exact article id before falling back to the title", async () => {
  const articleTitle = "CSDN discovery list match article";
  const { adapter, input } = createCsdnApiHarness({
    articleTitle,
    accountUsername: "example_author",
    shareSlug: "phoenix",
    draftStatus: 1,
    // A different article shares the title; only the stored id names this order.
    articleList: [
      { articleId: "163999999", title: articleTitle, status: "1", downloadShareDataUrl: "https://blog.csdn.net/phoenix/web/v1/share/download-share-data?articleId=163999999" },
      { articleId: "163500001", title: articleTitle, status: "1", downloadShareDataUrl: "https://blog.csdn.net/example_author/web/v1/share/download-share-data?articleId=163500001" },
    ],
    publicSnapshot: (url) => (url === "https://blog.csdn.net/example_author/article/details/163500001"
      ? {
        status: 200,
        url,
        title: `${articleTitle}-CSDN Blog`,
        text: `${articleTitle} Closed loop body marker.`,
        contentText: "Closed loop body marker.",
        imageUrls: [],
      }
      : { status: 404, url, title: "404", text: "404", contentText: "", imageUrls: [] }),
  });

  const result = await adapter.discoverPublication({
    articleTitle: input.articleTitle,
    contentMarkdown: input.contentMarkdown,
    reviewUrl: "https://blog.csdn.net/phoenix/article/details/163500001",
    publicVerifyAttempts: 1,
  });

  assert.equal(result.found, true);
  assert.equal(result.externalIds.articleId, "163500001");
  assert.equal(result.publicUrl, "https://blog.csdn.net/example_author/article/details/163500001?spm=1011.2415.3001.5331");
});

test("takes the CSDN blog slug from the console list entry before any derived guess", async () => {
  const articleTitle = "CSDN discovery list username slug article";
  // The 2026-10-22 capture shows every list entry carries the author's real blog
  // slug, while the share-data URL on the very same record still carries CSDN's
  // template slug (phoenix). The list username is the platform's own record, so
  // it has to lead the candidate chain ahead of the account endpoint.
  const { adapter, input, publicFetchCalls } = createCsdnApiHarness({
    articleTitle,
    accountUsername: "stale-account-slug",
    shareSlug: "phoenix",
    draftStatus: 1,
    articleList: [{
      articleId: "163500001",
      title: articleTitle,
      status: "1",
      username: "example_author",
      downloadShareDataUrl: "https://blog.csdn.net/phoenix/web/v1/share/download-share-data?articleId=163500001",
    }],
    publicSnapshot: (url) => (url === "https://blog.csdn.net/example_author/article/details/163500001"
      ? {
        status: 200,
        url,
        title: `${articleTitle}-CSDN Blog`,
        text: `${articleTitle} Closed loop body marker.`,
        contentText: "Closed loop body marker.",
        imageUrls: [],
      }
      : { status: 404, url, title: "404", text: "404", contentText: "", imageUrls: [] }),
  });

  const result = await adapter.discoverPublication({
    articleTitle: input.articleTitle,
    contentMarkdown: input.contentMarkdown,
    reviewUrl: "https://blog.csdn.net/phoenix/article/details/163500001",
    publicVerifyAttempts: 1,
  });

  assert.equal(result.found, true);
  assert.equal(result.externalIds.slug, "example_author");
  assert.equal(result.publicUrl, "https://blog.csdn.net/example_author/article/details/163500001?spm=1011.2415.3001.5331");
  assert.deepEqual(publicFetchCalls, ["https://blog.csdn.net/example_author/article/details/163500001"]);
  assert.ok(publicFetchCalls.every((url) => !url.includes("spm=")));
});

test("still settles a CSDN recheck on the public page alone when the console returns no verdict", async () => {
  const { adapter, input } = createCsdnApiHarness({
    draftStatus: 1,
    failArticleList: true,
  });

  const result = await adapter.discoverPublication({
    articleTitle: input.articleTitle,
    contentMarkdown: input.contentMarkdown,
    reviewUrl: "https://blog.csdn.net/phoenix/article/details/163500001",
    publicVerifyAttempts: 1,
  });

  // A console that answered nothing is missing evidence, not an in_review verdict,
  // so the gate must not block a page that really is this article.
  assert.equal(result.found, true);
  assert.equal(result.publicUrl, "https://blog.csdn.net/zhixin_ai/article/details/163500001?spm=1011.2415.3001.5331");
  assert.equal(result.platformStatus, "published");
});

test("re-verifies CSDN public images off the page during a discovery recheck", async () => {
  const imageUrl = "https://i-blog.csdnimg.cn/direct/abc123.jpg";
  const articleTitle = "CSDN discovery image recheck article";
  const { adapter, input } = createCsdnApiHarness({
    articleTitle,
    draftStatus: 1,
    publicSnapshot: {
      status: 200,
      url: "https://blog.csdn.net/zhixin_ai/article/details/163500001",
      title: `${articleTitle}-CSDN博客`,
      text: `${articleTitle} Closed loop body marker.`,
      contentText: "Closed loop body marker.",
      imageUrls: [imageUrl],
    },
  });
  const uploadStage = {
    stage: "upload",
    expectedCount: 1,
    observedCount: 1,
    verifiedCount: 1,
    status: "verified",
    images: [{
      assetId: "asset-1",
      sectionId: "section-1",
      position: 0,
      platformImageId: "abc123",
      platformImageUrl: imageUrl,
      loaded: true,
    }],
  };

  const result = await adapter.discoverPublication({
    articleTitle: input.articleTitle,
    contentMarkdown: input.contentMarkdown,
    reviewUrl: "https://blog.csdn.net/phoenix/article/details/163500001",
    imagePublicationEvidence: {
      version: 1,
      status: "review_required",
      expectedCount: 1,
      expected: [{ assetId: "asset-1", sectionId: "section-1", position: 0, idempotencyKey: "asset-1:section-1:hash" }],
      upload: uploadStage,
      draft: { ...uploadStage, stage: "draft" },
      public: {
        stage: "public",
        expectedCount: 1,
        observedCount: 0,
        verifiedCount: 0,
        status: "unverifiable",
        blocker: PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED,
        images: [],
      },
      issues: ["PUBLIC_IMAGE_UNVERIFIABLE"],
    },
    publicVerifyAttempts: 1,
  });

  assert.equal(result.found, true);
  assert.equal(result.imagePublicationEvidence.public.status, "verified");
  assert.equal(result.imagePublicationEvidence.public.verifiedCount, 1);
  assert.equal(result.imagePublicationEvidence.upload.status, "verified");
  assert.equal(result.imagePublicationEvidence.draft.status, "verified");
  assert.equal(result.imagePublicationEvidence.status, "verified");
  assert.deepEqual(result.imagePublicationEvidence.issues, []);
});

test("keeps the public image stage unverifiable when a CSDN discovery finds no page", async () => {
  const { adapter, input } = createCsdnApiHarness({
    draftStatus: 6,
    publicSnapshot: {
      status: 404,
      url: "https://blog.csdn.net/zhixin_ai/article/details/163500001",
      title: "404",
      text: "404",
      contentText: "",
      imageUrls: [],
    },
  });

  const result = await adapter.discoverPublication({
    articleTitle: input.articleTitle,
    contentMarkdown: input.contentMarkdown,
    reviewUrl: "https://blog.csdn.net/phoenix/article/details/163500001",
    imagePublicationEvidence: {
      version: 1,
      status: "review_required",
      expectedCount: 1,
      expected: [{ assetId: "asset-1", sectionId: "section-1", position: 0, idempotencyKey: "asset-1:section-1:hash" }],
      upload: { stage: "upload", expectedCount: 1, observedCount: 1, verifiedCount: 1, status: "verified", images: [{ assetId: "asset-1", sectionId: "section-1", position: 0, platformImageId: "abc123", platformImageUrl: "https://i-blog.csdnimg.cn/direct/abc123.jpg", loaded: true }] },
      draft: { stage: "draft", expectedCount: 1, observedCount: 1, verifiedCount: 1, status: "verified", images: [{ assetId: "asset-1", sectionId: "section-1", position: 0, platformImageId: "abc123", platformImageUrl: "https://i-blog.csdnimg.cn/direct/abc123.jpg", loaded: true }] },
      public: { stage: "public", expectedCount: 1, observedCount: 0, verifiedCount: 0, status: "unverifiable", blocker: PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED, images: [] },
      issues: ["PUBLIC_IMAGE_UNVERIFIABLE"],
    },
    publicVerifyAttempts: 1,
  });

  assert.equal(result.found, false);
  assert.equal(result.imagePublicationEvidence.public.status, "unverifiable");
  assert.equal(result.imagePublicationEvidence.public.blocker, PUBLIC_IMAGE_STAGE_NOT_ATTEMPTED);
  assert.deepEqual(result.imagePublicationEvidence.issues, ["PUBLIC_IMAGE_UNVERIFIABLE"]);
});

test("reports the CSDN publish backlink under the real blog slug with the traffic query", async () => {
  const articleTitle = "CSDN publish real slug backlink article";
  // Production shape: the share-data URL and the console API path both carry
  // CSDN's template slug (phoenix), while the list entry's own username and the
  // account endpoint carry the real blog slug. The link handed back must use the
  // real slug and wear the traffic query a visitor's address carries.
  const { adapter, input, publicFetchCalls } = createCsdnApiHarness({
    articleTitle,
    accountUsername: "example_author",
    shareSlug: "phoenix",
    articleList: [{
      articleId: "163500001",
      title: articleTitle,
      status: "1",
      username: "example_author",
      downloadShareDataUrl: "https://blog.csdn.net/phoenix/web/v1/share/download-share-data?articleId=163500001",
    }],
  });

  const result = await adapter.publishArticle({
    ...input,
    confirmPublish: true,
  });

  const backlink = "https://blog.csdn.net/example_author/article/details/163500001?spm=1011.2415.3001.5331";
  assert.equal(result.platformStatus, "published");
  assert.equal(result.publishedUrl, backlink);
  assert.equal(result.externalIds.slug, "example_author");
  // The page is fetched and asserted on the clean address, and the evidence
  // names that same address: a query string is what normalizeCsdnPublishedUrl
  // rejects, so putting the traffic query there would fail a real public page.
  assert.deepEqual(publicFetchCalls, ["https://blog.csdn.net/example_author/article/details/163500001"]);
  assert.ok(publicFetchCalls.every((url) => !url.includes("spm=")));
  assert.ok(result.publicationEvidence.steps.some((step) => step.stage === "public_page"
    && step.endpoint === "https://blog.csdn.net/example_author/article/details/163500001"));
});

test("reports a review-queued CSDN publish under the real blog slug with the traffic query", async () => {
  const articleTitle = "CSDN publish review queued real slug article";
  const { adapter, input, publicFetchCalls } = createCsdnApiHarness({
    articleTitle,
    accountUsername: "example_author",
    shareSlug: "phoenix",
    postPublishStatus: 6,
    articleList: [{
      articleId: "163500001",
      title: articleTitle,
      status: "6",
      username: "example_author",
      downloadShareDataUrl: "https://blog.csdn.net/phoenix/web/v1/share/download-share-data?articleId=163500001",
    }],
  });

  const result = await adapter.publishArticle({
    ...input,
    confirmPublish: true,
    publicVerifyAttempts: 2,
    publicVerifyPollMs: 1,
  });

  // No public page exists yet, so nothing is fetched; the review link is still
  // the real-slug address with the traffic query, ready for the visitor once
  // the platform approves the article.
  assert.equal(result.platformStatus, "submitted_for_review");
  assert.equal(result.publishedUrl, "");
  assert.equal(result.reviewUrl, "https://blog.csdn.net/example_author/article/details/163500001?spm=1011.2415.3001.5331");
  assert.equal(result.externalIds.slug, "example_author");
  assert.deepEqual(publicFetchCalls, []);
});

test("reads a CSDN stored backlink that already carries the traffic query", async () => {
  const articleTitle = "CSDN discovery spm round trip article";
  // A backlink this adapter reported earlier carries ?spm=..., and the console
  // list is down, so the stored URL is the only source of the article id. The
  // tracking query has to be dropped before the URL is normalized, or the
  // recheck loses the id and reports nothing at all.
  const { adapter, input } = createCsdnApiHarness({
    articleTitle,
    accountUsername: "example_author",
    shareSlug: "phoenix",
    draftStatus: 1,
    failArticleList: true,
  });

  const result = await adapter.discoverPublication({
    articleTitle: input.articleTitle,
    contentMarkdown: input.contentMarkdown,
    reviewUrl: "https://blog.csdn.net/example_author/article/details/163500001?spm=1011.2415.3001.5331",
    publicVerifyAttempts: 1,
  });

  assert.equal(result.found, true);
  assert.equal(result.externalIds.articleId, "163500001");
  assert.equal(result.publicUrl, "https://blog.csdn.net/example_author/article/details/163500001?spm=1011.2415.3001.5331");
});

test("prefers the CSDN account username over the template slug when the list entry carries none", async () => {
  const articleTitle = "CSDN publish account username slug article";
  // The list entry can arrive without a username field; the account endpoint
  // still reports the real blog slug, which has to beat the template slug the
  // console API path carries.
  const { adapter, input } = createCsdnApiHarness({
    articleTitle,
    accountUsername: "example_author",
    shareSlug: "phoenix",
    articleList: [{
      articleId: "163500001",
      title: articleTitle,
      status: "1",
      downloadShareDataUrl: "https://blog.csdn.net/phoenix/web/v1/share/download-share-data?articleId=163500001",
    }],
  });

  const result = await adapter.publishArticle({
    ...input,
    confirmPublish: true,
  });

  // The published backlink is publishedUrl; the backend derives reviewUrl from it.
  assert.equal(result.publishedUrl, "https://blog.csdn.net/example_author/article/details/163500001?spm=1011.2415.3001.5331");
  assert.equal(result.externalIds.slug, "example_author");
});

test('community gateway requires deployment configuration', async()=>{
 const saved=process.env.CSDN_ARTICLE_APP_SECRET;
 delete process.env.CSDN_ARTICLE_APP_SECRET;
 try { await assert.rejects(()=>csdnGatewayFetch({evaluate:async()=>{throw new Error('network should not run');}},'https://bizapi.csdn.net/blog-console-api/v3/article/list',{}),/CSDN_GATEWAY_CONFIG_REQUIRED/); }
 finally { process.env.CSDN_ARTICLE_APP_SECRET=saved; }
});
