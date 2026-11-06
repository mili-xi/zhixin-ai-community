import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  ZhihuAdapter,
  buildZhihuAuthArtifact,
  collectWebStorage,
  createZhihuDraftViaApi,
  hasZhihuStrongLoginCookie,
  inspectZhihuPublicArticle,
  isZhihuCookie,
  isZhihuLoggedIn,
  isZhihuLoggedInFromCookies,
  isZhihuWorkspaceReady,
  inspectZhihuDraftPublishState,
  normalizeZhihuCookie,
  pickZhihuAccountName,
  publishZhihuDraftViaApi,
  resolveZhihuImageUrl,
  updateZhihuDraftViaApi,
  uploadZhihuLocalImageViaApi
} from "../src/adapters/zhihu.mjs";

function apiResponse(status, payload) {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  return {
    status: () => status,
    text: async () => body,
  };
}

function rawResponse(status, body) {
  return {
    status: () => status,
    text: async () => body,
  };
}

function draftStateResponse(status, payload) {
  return {
    status: () => status,
    text: async () => (payload === undefined ? "" : JSON.stringify(payload)),
  };
}

function apiPage(handler, extra = {}) {
  return {
    request: { fetch: handler },
    context: () => ({
      cookies: async () => [{ name: "_xsrf", value: "xsrf-token", domain: ".zhihu.com" }],
    }),
    ...extra,
  };
}

test("inspects an existing Zhihu public article and rebuilds verified image evidence", async () => {
  const expected = [
    { assetId: "asset-a", sectionId: "section-a", position: 1, idempotencyKey: "key-a" },
    { assetId: "asset-b", sectionId: "section-b", position: 3, idempotencyKey: "key-b" },
  ];
  const stageImages = expected.map((item, index) => ({
    ...item,
    platformImageUrl: `https://picx.zhimg.com/${index + 1}.png`,
    loaded: true,
  }));
  const images = [
    { src: "https://pic4.zhimg.com/public-a.png", loaded: true },
    { src: "https://pic4.zhimg.com/public-b.png", loaded: true },
  ];
  const page = {
    async goto() {},
    async waitForLoadState() {},
    async waitForFunction() {},
    async title() { return "Verified illustrated article - Zhihu"; },
    locator(selector) {
      if (selector === ".Post-RichText") {
        return { first: () => ({ innerText: async () => "Verified illustrated article body" }) };
      }
      return {
        async count() { return images.length; },
        nth(index) {
          return {
            async getAttribute(name) { return name === "src" ? images[index].src : ""; },
            async evaluate() { return images[index].loaded; },
          };
        },
      };
    },
  };

  const result = await inspectZhihuPublicArticle(page, {
    publicUrl: "https://zhuanlan.zhihu.com/p/123456789",
    articleTitle: "Verified illustrated article",
    imagePublicationEvidence: {
      version: 1,
      status: "review_required",
      expectedCount: 2,
      expected,
      upload: { status: "verified", images: stageImages },
      draft: { status: "verified", images: stageImages },
      public: { status: "failed", images: [] },
    },
  });

  assert.equal(result.found, true);
  assert.equal(result.publicUrl, "https://zhuanlan.zhihu.com/p/123456789");
  assert.equal(result.imagePublicationEvidence.status, "verified");
  assert.equal(result.imagePublicationEvidence.public.verifiedCount, 2);
  assert.match(result.pageText, /Verified illustrated article/);
});

test("inspects Zhihu public images with a broad article selector", async () => {
  const expected = [
    { assetId: "asset-a", sectionId: "section-a", position: 1 },
    { assetId: "asset-b", sectionId: "section-b", position: 2 },
  ];
  const page = {
    async goto() {},
    async waitForLoadState() {},
    async waitForFunction(_predicate, payload) {
      assert.match(payload.selector, /RichText img/);
      assert.match(payload.selector, /ztext img/);
      assert.match(payload.selector, /article img/);
      assert.doesNotMatch(payload.selector, /img\[src/);
    },
    async title() { return "Published title"; },
    async evaluate() { return "Published title body"; },
    locator(selector) {
      if (selector === ".Post-RichText") {
        return { first: () => ({ innerText: async () => "Published title body" }) };
      }
      assert.match(selector, /RichText img/);
      assert.match(selector, /ztext img/);
      assert.match(selector, /article img/);
      assert.doesNotMatch(selector, /img\[src/);
      return {
        async count() { return expected.length; },
        nth(index) {
          return {
            async getAttribute(name) { return name === "src" ? `https://picx.zhimg.com/public-${index + 1}.png` : ""; },
            async evaluate() { return true; },
          };
        },
      };
    },
  };

  const result = await inspectZhihuPublicArticle(page, {
    publicUrl: "https://zhuanlan.zhihu.com/p/123456789",
    articleTitle: "Published title",
    imagePublicationEvidence: { expected },
  });

  assert.equal(result.imagePublicationEvidence.public.status, "verified");
  assert.equal(result.imagePublicationEvidence.public.verifiedCount, 2);
});

test("retries a transient 403 before verifying a Zhihu public article", async () => {
  let navigations = 0;
  const page = {
    async goto() {
      navigations += 1;
      return { status: () => navigations === 1 ? 403 : 200 };
    },
    async waitForLoadState() {},
    async title() { return navigations > 1 ? "已发布标题 - 知乎" : "访问受限"; },
    locator(selector) {
      return {
        first: () => ({
          innerText: async () => navigations > 1
            ? (selector.includes("Title") ? "已发布标题" : "已发布正文")
            : "",
        }),
      };
    },
  };

  const result = await inspectZhihuPublicArticle(page, {
    publicUrl: "https://zhuanlan.zhihu.com/p/2067041076666541507",
    articleTitle: "已发布标题",
    publicVerifyAttempts: 3,
    publicVerifyPollMs: 1,
  });

  assert.equal(navigations, 2);
  assert.equal(result.found, true);
});

test("does not verify a Zhihu article when only the body contains the expected title", async () => {
  const page = {
    async goto() { return { status: () => 200 }; },
    async waitForLoadState() {},
    async title() { return "另一篇文章 - 知乎"; },
    locator(selector) {
      return {
        first: () => ({
          innerText: async () => selector.includes("Post-RichText")
            ? "正文引用了预期文章标题"
            : "另一篇文章",
        }),
      };
    },
  };

  const result = await inspectZhihuPublicArticle(page, {
    publicUrl: "https://zhuanlan.zhihu.com/p/2067041076666541507",
    articleTitle: "预期文章标题",
  });

  assert.equal(result.found, false);
});

test("creates and updates a Zhihu draft with the captured API payloads", async () => {
  const calls = [];
  const responses = [
    apiResponse(200, { id: "2067041076666541507" }),
    apiResponse(200, { id: "2067041076666541507" }),
  ];
  const page = apiPage(async (url, options) => {
    calls.push({ url, options });
    return responses.shift();
  });

  const draftId = await createZhihuDraftViaApi(page, "真实 API 标题");
  await updateZhihuDraftViaApi(page, draftId, "<p>真实 API 正文</p>");

  assert.equal(draftId, "2067041076666541507");
  assert.equal(calls[0].url, "https://zhuanlan.zhihu.com/api/articles/drafts");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(calls[0].options.data, {
    title: "真实 API 标题",
    delta_time: 0,
    can_reward: false,
  });
  assert.equal(calls[1].url, "https://zhuanlan.zhihu.com/api/articles/2067041076666541507/draft");
  assert.equal(calls[1].options.method, "PATCH");
  assert.deepEqual(calls[1].options.data, {
    content: "<p>真实 API 正文</p>",
    table_of_contents: false,
    delta_time: 0,
    can_reward: false,
  });
});

test("publishes a Zhihu draft through api/v4/content/publish", async () => {
  const calls = [];
  const draftId = "2067041076666541507";
  const page = apiPage(async (url, options) => {
    calls.push({ url, options });
    return apiResponse(200, {
      code: 0,
      message: "success",
      data: { result: JSON.stringify({ publish: { id: draftId } }) },
    });
  });

  const result = await publishZhihuDraftViaApi(
    page,
    draftId,
    "真实 API 标题",
    "<h2>章节</h2><p>正文</p>",
    { traceId: "1785600984566,00000000-0000-4000-8000-000000000000", textLength: 6 },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://www.zhihu.com/api/v4/content/publish");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Referer, `https://zhuanlan.zhihu.com/p/${draftId}/edit`);
  assert.equal(calls[0].options.data.action, "article");
  assert.deepEqual(calls[0].options.data.data.draft, {
    disabled: 1,
    id: draftId,
    isPublished: false,
  });
  assert.deepEqual(calls[0].options.data.data.hybrid, {
    html: "<h2>章节</h2><p>正文</p>",
    textLength: 6,
  });
  assert.deepEqual(JSON.parse(calls[0].options.data.data.extra_info.pc_business_params), {
    commentPermission: "anyone",
    disclaimer_type: "none",
    disclaimer_status: "close",
    table_of_contents_enabled: false,
    content: "<h2>章节</h2><p>正文</p>",
    title: "真实 API 标题",
    commercial_report_info: { commercial_types: [] },
    commercial_zhitask_bind_info: null,
    canReward: false,
  });
  assert.equal(result.publishedUrl, `https://zhuanlan.zhihu.com/p/${draftId}`);
});

test("rejects a Zhihu publish response for a different article id", async () => {
  const page = apiPage(async () => apiResponse(200, {
    code: 0,
    message: "success",
    data: { result: JSON.stringify({ publish: { id: "different-id" } }) },
  }));

  await assert.rejects(
    publishZhihuDraftViaApi(page, "expected-id", "标题", "<p>正文</p>", { textLength: 2 }),
    /ZHIHU_PUBLISH_ARTICLE_ID_MISMATCH/,
  );
});

test("recovers a Zhihu publish that answered ambiguously but deleted the draft", async () => {
  const draftId = "2090113203183284966";
  const calls = [];
  const page = apiPage(async (url) => {
    calls.push(url);
    if (String(url).endsWith("/api/v4/content/publish")) {
      // 2xx with a non-canonical body: Zhihu published, but the envelope is not code/message.
      return rawResponse(200, JSON.stringify({ code: 0, message: "OK" }));
    }
    return draftStateResponse(404, {
      error: { message: "无权访问", code: 4042, name: "DraftAlreadyPublishedException" },
    });
  });

  const result = await publishZhihuDraftViaApi(page, draftId, "标题", "<p>正文</p>", { textLength: 2 });

  assert.equal(result.publishedUrl, `https://zhuanlan.zhihu.com/p/${draftId}`);
  assert.equal(result.publishedId, draftId);
  assert.equal(result.publishResponseAmbiguous, true);
  assert.equal(calls.length, 2);
  assert.match(String(calls[1]), /\/api\/articles\/2090113203183284966\/draft$/);
});

test("treats an empty Zhihu publish body with a surviving draft as an unreadable response", async () => {
  const page = apiPage(async (url) => (
    String(url).endsWith("/api/v4/content/publish")
      ? rawResponse(200, "")
      : draftStateResponse(200, { id: "draft-1", title: "标题", content: "<p>正文</p>" })
  ));

  await assert.rejects(
    publishZhihuDraftViaApi(page, "draft-1", "标题", "<p>正文</p>", { textLength: 2 }),
    /ZHIHU_PUBLISH_API_UNREADABLE:200:empty:0b:draft=draft/,
  );
});

test("keeps a genuine Zhihu rejection when the article never left the draft box", async () => {
  const page = apiPage(async (url) => (
    String(url).endsWith("/api/v4/content/publish")
      ? apiResponse(200, { code: 10003, message: "请求参数异常" })
      : draftStateResponse(200, { id: "draft-2", title: "标题", content: "<p>正文</p>" })
  ));

  await assert.rejects(
    publishZhihuDraftViaApi(page, "draft-2", "标题", "<p>正文</p>", { textLength: 2 }),
    /ZHIHU_PUBLISH_API_REJECTED:10003:请求参数异常:draft=draft/,
  );
});

test("reports an undetermined Zhihu publish outcome instead of a false rejection", async () => {
  const page = apiPage(async (url) => (
    String(url).endsWith("/api/v4/content/publish")
      ? rawResponse(200, "")
      : draftStateResponse(502, "<html>gateway</html>")
  ));

  await assert.rejects(
    publishZhihuDraftViaApi(page, "draft-3", "标题", "<p>正文</p>", { textLength: 2 }),
    /ZHIHU_PUBLISH_OUTCOME_UNKNOWN:.*:probe=.*:draftStatus=502/,
  );
});

test("maps the Zhihu draft endpoint to a publish state", async () => {
  const draftPage = (status, payload) => apiPage(async () => draftStateResponse(status, payload));

  const published = await inspectZhihuDraftPublishState(draftPage(404, {
    error: { message: "无权访问", code: 4042, name: "DraftAlreadyPublishedException" },
  }), "draft-4");
  assert.equal(published.state, "published");

  const missing = await inspectZhihuDraftPublishState(draftPage(404, {
    error: { message: "资源不存在", code: 4041, name: "ResourceNotFoundException" },
  }), "draft-4");
  assert.equal(missing.state, "missing");

  const stillDraft = await inspectZhihuDraftPublishState(draftPage(200, {
    id: "draft-4",
    title: "标题",
    content: "<p>正文</p>",
  }), "draft-4");
  assert.equal(stillDraft.state, "draft");

  const unknown = await inspectZhihuDraftPublishState(draftPage(403, {
    error: { message: "请求参数异常", code: 10003 },
  }), "draft-4");
  assert.equal(unknown.state, "unknown");
});

test("completes a cold Zhihu OSS upload before accepting exact success status", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "zhihu-upload-"));
  const imagePath = path.join(tempDir, "capture.png");
  await writeFile(imagePath, Buffer.from("captured-image-bytes"));
  const calls = [];
  let imageReads = 0;
  const page = apiPage(async (url, options) => {
    calls.push({ url, options });
    if (url === "https://api.zhihu.com/images" && options.method === "POST") {
      return apiResponse(200, {
        upload_file: {
          image_id: "image-123",
          state: 2,
          publish_state: 0,
          object_key: "v2-stable-hash",
        },
        upload_token: {
          access_id: "access-id",
          access_key: "access-key",
          access_token: "security-token",
        },
      });
    }
    if (url === "https://zhihu-pics-upload.zhimg.com/v2-stable-hash") {
      return apiResponse(200);
    }
    if (url === "https://api.zhihu.com/images/image-123/uploading_status") {
      return apiResponse(200);
    }
    if (url === "https://api.zhihu.com/images/image-123") {
      imageReads += 1;
      return apiResponse(200, imageReads === 1
        ? { status: "completed", original_hash: "v2-stable-hash" }
        : { status: "success", original_hash: "v2-stable-hash" });
    }
    throw new Error(`Unexpected request: ${options.method} ${url}`);
  });

  try {
    const result = await uploadZhihuLocalImageViaApi(page, imagePath, { timeoutMs: 20000, pollMs: 1 });

    const completion = calls.find((call) => call.url.endsWith("/uploading_status"));
    const ossUpload = calls.find((call) => call.url === "https://zhihu-pics-upload.zhimg.com/v2-stable-hash");
    assert.equal(Buffer.isBuffer(ossUpload?.options?.data), true);
    assert.ok(completion);
    assert.equal(completion.options.method, "PUT");
    assert.deepEqual(completion.options.data, { upload_result: "success" });
    assert.equal(imageReads, 2);
    assert.equal(result.platformImageUrl, "https://pic4.zhimg.com/v2-stable-hash");
    assert.equal(result.reused, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("prefers a stable Zhihu image hash over an expiring private URL", () => {
  const url = resolveZhihuImageUrl(
    { object_key: "fallback-key" },
    {
      src: "https://pic-private.zhihu.com/private.png?auth_key=expires",
      original_hash: "v2-stable-hash",
    },
  );

  assert.equal(url, "https://pic4.zhimg.com/v2-stable-hash");
  assert.equal(resolveZhihuImageUrl({}, {
    src: "https://pic-private.zhihu.com/private.png?auth_key=expires",
  }), "");
  assert.equal(resolveZhihuImageUrl({
    object_key: "https://pic-private.zhihu.com/private.png?auth_key=expires",
  }), "");
});

test("detects Zhihu login from a real auth cookie signal", () => {
  const cookies = [
    { name: "_xsrf", value: "csrf-only", domain: ".zhihu.com" },
    { name: "z_c0", value: "auth-token", domain: ".zhihu.com" }
  ];

  assert.equal(isZhihuLoggedInFromCookies(cookies), true);
  assert.equal(hasZhihuStrongLoginCookie(cookies), true);
});

test("does not treat csrf-only Zhihu cookies as logged in", () => {
  const cookies = [
    { name: "_xsrf", value: "csrf-only", domain: ".zhihu.com" },
    { name: "SESSIONID", value: "", domain: ".zhihu.com" }
  ];

  assert.equal(isZhihuLoggedInFromCookies(cookies), false);
});

test("Zhihu requires a creator workspace and z_c0 cookie before active authorization", () => {
  assert.equal(isZhihuWorkspaceReady({
    url: "https://www.zhihu.com/creator",
    title: "Zhihu creator center",
    text: "write article"
  }), true);
  assert.equal(isZhihuLoggedIn([
    { name: "z_c0", value: "auth-token", domain: ".zhihu.com" }
  ], {
    url: "https://www.zhihu.com/",
    title: "Zhihu home",
    text: "feed"
  }), false);
  assert.equal(isZhihuLoggedIn([
    { name: "z_c0", value: "auth-token", domain: ".zhihu.com" }
  ], {
    url: "https://www.zhihu.com/creator",
    title: "Zhihu creator center",
    text: "write article"
  }), true);
});

test("keeps only Zhihu cookies and strips browser-only fields before artifact creation", () => {
  const cookie = normalizeZhihuCookie({
    name: "z_c0",
    value: "auth-token",
    domain: ".zhihu.com",
    path: "/",
    expires: 1893456000,
    httpOnly: true,
    sameSite: "Lax",
    secure: true,
    size: 42
  });

  assert.deepEqual(cookie, {
    name: "z_c0",
    value: "auth-token",
    domain: ".zhihu.com",
    path: "/",
    expires: 1893456000,
    httpOnly: true,
    sameSite: "Lax",
    secure: true
  });

  assert.equal(isZhihuCookie({ name: "z_c0", domain: ".not-zhihu.com" }), false);
  assert.equal(isZhihuCookie({ name: "z_c0", domain: "www.zhihu.com" }), true);
});

test("builds a stable Zhihu auth artifact from captured browser storage", () => {
  const capturedAt = "2026-07-04T00:00:00.000Z";
  const snapshot = {
    cookies: [
      { name: "z_c0", value: "auth-token", domain: ".zhihu.com", path: "/", httpOnly: true, secure: true },
      { name: "_xsrf", value: "csrf", domain: ".zhihu.com", path: "/", httpOnly: false, secure: true }
    ],
    localStorage: { theme: "light" },
    sessionStorage: { draft: "1" }
  };

  const artifact = buildZhihuAuthArtifact(snapshot, { capturedAt });

  assert.match(artifact.cookies, /^encrypted-cookie-/);
  assert.match(artifact.localStorage, /^encrypted-local-storage-/);
  assert.match(artifact.sessionStorage, /^encrypted-session-storage-/);
  assert.match(artifact.fingerprint, /^fp-zhihu-[a-f0-9]{16}$/);
  assert.equal(artifact.storageVersion, 2);
  assert.equal(artifact.capturedAt, capturedAt);
});

test("collects localStorage and sessionStorage from a page-like object", async () => {
  const page = {
    evaluate: async (fn) => fn()
  };
  globalThis.window = {};
  globalThis.window.localStorage = {
    length: 1,
    key: () => "local-key",
    getItem: () => "local-value"
  };
  globalThis.window.sessionStorage = {
    length: 1,
    key: () => "session-key",
    getItem: () => "session-value"
  };

  try {
    assert.deepEqual(await collectWebStorage(page), {
      localStorage: { "local-key": "local-value" },
      sessionStorage: { "session-key": "session-value" }
    });
  } finally {
    delete globalThis.window;
  }
});

test("picks a useful Zhihu account label from page title or explicit input", async () => {
  assert.equal(await pickZhihuAccountName({ accountName: "知乎增长号" }, null), "知乎增长号");
  assert.equal(await pickZhihuAccountName({}, { title: async () => "李雷 - 知乎" }), "李雷");
  assert.equal(await pickZhihuAccountName({}, { title: async () => "知乎" }), "知乎账号");
});

test("prefers Zhihu profile API name over generic home page title", async () => {
  const page = {
    title: async () => "首页 - 知乎",
    evaluate: async (fn) => fn(),
    request: {
      get: async (url) => ({
        ok: () => url.includes("/api/v4/me"),
        json: async () => ({ name: "真实知乎昵称", url_token: "real-profile" })
      })
    }
  };

  assert.equal(await pickZhihuAccountName({}, page), "真实知乎昵称");
});

test("falls back to url token when Zhihu profile API has no display name", async () => {
  const page = {
    title: async () => "首页 - 知乎",
    evaluate: async (fn) => fn(),
    request: {
      get: async () => ({
        ok: () => true,
        json: async () => ({ name: "", url_token: "real-profile" })
      })
    }
  };

  assert.equal(await pickZhihuAccountName({}, page), "real-profile");
});

test("reopens the Zhihu auth browser once if the first context is closed", async () => {
  let launchCount = 0;
  const closedContext = {
    pages: () => [{ goto: async () => {}, bringToFront: async () => {} }],
    cookies: async () => {
      throw new Error("browserContext.cookies: Target page, context or browser has been closed");
    },
    close: async () => {}
  };
  const loggedInContext = {
    pages: () => [{
      goto: async () => {},
      bringToFront: async () => {},
      url: () => "https://www.zhihu.com/creator",
      title: async () => "Zhihu creator center",
      evaluate: async () => "write article"
    }],
    cookies: async () => [{ name: "z_c0", value: "auth-token", domain: ".zhihu.com" }],
    close: async () => {}
  };
  const adapter = new ZhihuAdapter({
    browser: {
      launchPersistentContext: async () => {
        launchCount += 1;
        return launchCount === 1 ? closedContext : loggedInContext;
      }
    }
  });

  assert.equal(await adapter.detectLoggedIn({ waitLoginMs: 10 }), true);
  assert.equal(launchCount, 2);
});

test("always uses the Zhihu API transport and never falls back to DOM", async () => {
  const calls = [];
  const page = {};
  const context = {
    pages: () => [page],
    newPage: async () => page,
    close: async () => calls.push("close"),
  };
  const adapter = new ZhihuAdapter();
  adapter.launchAuthEnvironment = async () => context;
  adapter.refreshCredentialAfterOperation = async () => undefined;
  adapter.publishArticleViaApi = async () => {
    calls.push("api");
    return { platformStatus: "published", transport: "api" };
  };
  adapter.publishArticleViaDom = async () => {
    calls.push("dom");
    throw new Error("DOM transport must not run");
  };

  const result = await adapter.publishArticle({
    articleTitle: "真实 API 发布测试",
    contentMarkdown: "正文",
    confirmPublish: true,
    publishTransport: "dom",
    allowDomFallback: true,
  });

  assert.equal(result.transport, "api");
  assert.deepEqual(calls, ["api", "close"]);
});

test("Zhihu profile path prefers the stable media account profile key", () => {
  const adapter = new ZhihuAdapter();

  assert.match(adapter.profileDir({
    profileRoot: "C:\\profiles",
    profileKey: "stable-account",
    sessionId: "legacy-session"
  }), /[\\/]zhihu[\\/]stable-account$/);
});

test("Zhihu validates a persistent session and rotates captured credentials", async () => {
  const seededCookies = [];
  const initScripts = [];
  const refreshed = [];
  const page = {
    _url: "about:blank",
    goto: async (url) => { page._url = url; },
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    url: () => page._url,
    title: async () => "Zhihu creator center",
    evaluate: async (fn) => String(fn).includes("readStorage")
      ? { localStorage: { theme: "dark" }, sessionStorage: { draft: "1" } }
      : "write article publish"
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    addCookies: async (cookies) => seededCookies.push(...cookies),
    addInitScript: async (...args) => initScripts.push(args),
    cookies: async () => [{ name: "z_c0", value: "auth-token", domain: ".zhihu.com", path: "/" }],
    close: async () => {}
  };
  const adapter = new ZhihuAdapter({
    browser: { launchPersistentContext: async () => context }
  });

  const result = await adapter.validateSession({
    cookies: [{ name: "z_c0", value: "seed-token", domain: ".zhihu.com", path: "/" }],
    localStorage: { theme: "dark" },
    profileKey: "stable-account",
    onCredentialRefresh: async (artifact) => refreshed.push(artifact)
  });

  assert.equal(result.valid, true);
  assert.equal(seededCookies[0].value, "seed-token");
  assert.equal(initScripts.length, 1);
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0].credentialMetadata.hasSessionCredentials, true);
});
