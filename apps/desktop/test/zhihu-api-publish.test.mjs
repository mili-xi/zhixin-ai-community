import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ZhihuAdapter,
  buildZhihuOssAuthorization,
  buildZhihuPublishHtml,
  countImagesInHtml,
  createZhihuDraftViaApi,
  extractImageUrlsFromHtml,
  mapDraftImagesToTasks,
  md5Hex,
  resolveZhihuImageUrl,
  transformZhihuContentHtml,
  updateZhihuDraftViaApi,
  uploadZhihuImageTasksViaApi,
  waitForZhihuApiDraftImages,
  zhihuDraftEditUrl,
} from "../src/adapters/zhihu.mjs";

const localFile = fileURLToPath(import.meta.url);

function createApiPage(handlers = {}) {
  const calls = [];
  const page = {
    request: {
      async fetch(url, options = {}) {
        const method = String(options.method || "GET").toUpperCase();
        calls.push({ url, method, options });
        const key = `${method} ${url}`;
        const handler = handlers[key] || handlers[url] || handlers["*"];
        if (!handler) {
          return {
            status: () => 404,
            async text() { return JSON.stringify({ error: "not found", url, method }); },
          };
        }
        const result = typeof handler === "function" ? await handler({ url, method, options, calls }) : handler;
        return {
          status: () => result.status ?? 200,
          async text() {
            if (typeof result.text === "string") return result.text;
            if (result.json !== undefined) return JSON.stringify(result.json);
            return "";
          },
        };
      },
    },
    context() {
      return {
        async cookies() {
          return [{ name: "_xsrf", value: "xsrf-token", domain: ".zhihu.com" }];
        },
      };
    },
  };
  return { page, calls };
}

test("builds Zhihu draft edit URL and counts draft images", () => {
  assert.equal(zhihuDraftEditUrl("123456"), "https://zhuanlan.zhihu.com/p/123456/edit");
  assert.equal(countImagesInHtml('<p>a</p><figure><img src="https://pic4.zhimg.com/a.png"></figure>'), 1);
  assert.deepEqual(
    extractImageUrlsFromHtml('<img src="https://pic1.zhimg.com/a.png"><img src="https://pic2.zhimg.com/b.png">'),
    ["https://pic1.zhimg.com/a.png", "https://pic2.zhimg.com/b.png"],
  );
});

test("transforms rich HTML into Zhihu-friendly draft markup", () => {
  const html = transformZhihuContentHtml(
    '<section data-zhixin-section="s1" style="margin:0"><h2 style="color:red">Title</h2><p style="x:1">Body</p></section><img src="https://pic4.zhimg.com/x.png" alt="图">',
  );
  assert.match(html, /<div/);
  assert.doesNotMatch(html, /<section/);
  assert.doesNotMatch(html, /style=/);
  assert.doesNotMatch(html, /data-zhixin-/);
  assert.match(html, /<figure><img src="https:\/\/pic4\.zhimg\.com\/x\.png"/);
});

test("builds publish HTML from content blocks and uploaded platform images", () => {
  const html = buildZhihuPublishHtml({
    contentBlocks: [
      { type: "section", sectionId: "s1", title: "第一节", content: "段落A" },
      { type: "image", sectionId: "s1", assetId: "asset-a", altText: "插图A" },
      { type: "section", sectionId: "s2", title: "第二节", content: "段落B" },
      { type: "image", sectionId: "s2", assetId: "asset-b", altText: "插图B" },
    ],
  }, [
    { assetId: "asset-a", sectionId: "s1", platformImageUrl: "https://pic4.zhimg.com/a.png" },
    { assetId: "asset-b", sectionId: "s2", platformImageUrl: "https://pic4.zhimg.com/b.png" },
  ]);

  assert.equal(countImagesInHtml(html), 2);
  assert.match(html, /第一节/);
  assert.match(html, /https:\/\/pic4\.zhimg\.com\/a\.png/);
  assert.match(html, /https:\/\/pic4\.zhimg\.com\/b\.png/);
  assert.doesNotMatch(html, /data-zhixin-/);
});

test("maps draft CDN image URLs back onto image tasks", () => {
  const mapped = mapDraftImagesToTasks(
    [
      { assetId: "a", sectionId: "s1", position: 1 },
      { assetId: "b", sectionId: "s2", position: 3 },
    ],
    ["https://pic4.zhimg.com/a.png", "blob:http://local/1", "https://pic4.zhimg.com/b.png"],
  );
  assert.equal(mapped[0].platformImageUrl, "https://pic4.zhimg.com/a.png");
  assert.equal(mapped[0].loaded, true);
  assert.equal(mapped[1].platformImageUrl, "https://pic4.zhimg.com/b.png");
});

test("maps a private Zhihu draft preview back to its uploaded stable image", () => {
  const mapped = mapDraftImagesToTasks(
    [{ assetId: "asset-a", sectionId: "section-a", position: 1 }],
    ["https://pic-private.zhihu.com/v2-real-hash~resize:1440:q75.jpg?auth_key=temporary"],
    [{
      assetId: "asset-a",
      sectionId: "section-a",
      position: 1,
      platformImageUrl: "https://pic4.zhimg.com/v2-real-hash",
    }],
  );

  assert.equal(mapped[0].loaded, true);
  assert.equal(mapped[0].platformImageUrl, "https://pic4.zhimg.com/v2-real-hash");
});

test("rejects a private Zhihu draft preview that does not match the uploaded image", () => {
  const mapped = mapDraftImagesToTasks(
    [{ assetId: "asset-a", sectionId: "section-a", position: 1 }],
    ["https://pic-private.zhihu.com/v2-other-hash~resize:1440:q75.jpg?auth_key=temporary"],
    [{
      assetId: "asset-a",
      sectionId: "section-a",
      position: 1,
      platformImageUrl: "https://pic4.zhimg.com/v2-real-hash",
    }],
  );

  assert.equal(mapped[0].loaded, false);
  assert.equal(mapped[0].platformImageUrl, "");
});

test("builds OSS authorization with stable signature fields", () => {
  const auth = buildZhihuOssAuthorization({
    access_id: "id",
    access_key: "key",
    access_token: "token",
  }, "path/object", "image/png", "Mon, 01 Jan 2024 00:00:00 GMT");
  assert.match(auth.authorization, /^OSS id:/);
  assert.equal(auth.ossDate, "Mon, 01 Jan 2024 00:00:00 GMT");
  assert.match(auth.stringToSign, /x-oss-security-token:token/);
  assert.match(auth.stringToSign, /\/zhihu-pics\/path\/object/);
});

test("resolves zhimg CDN url from upload metadata", () => {
  assert.equal(
    resolveZhihuImageUrl({ object_key: "abc123" }, { original_hash: "hash999" }),
    "https://pic4.zhimg.com/hash999",
  );
  assert.equal(
    resolveZhihuImageUrl({}, { src: "https://picx.zhimg.com/done.png" }),
    "https://picx.zhimg.com/done.png",
  );
});

test("creates and updates Zhihu drafts through column APIs", async () => {
  const { page, calls } = createApiPage({
    "POST https://zhuanlan.zhihu.com/api/articles/drafts": {
      status: 200,
      json: { id: "9001" },
    },
    "PATCH https://zhuanlan.zhihu.com/api/articles/9001/draft": {
      status: 200,
      json: { id: "9001" },
    },
  });

  const draftId = await createZhihuDraftViaApi(page, "API 草稿标题");
  await updateZhihuDraftViaApi(page, draftId, "<p>body</p><figure><img src=\"https://pic4.zhimg.com/a.png\"></figure>");

  assert.equal(draftId, "9001");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[1].method, "PATCH");
  assert.equal(calls[0].options.headers["x-xsrftoken"], "xsrf-token");
  assert.deepEqual(calls[0].options.data, {
    title: "API 草稿标题",
    delta_time: 0,
    can_reward: false,
  });
  assert.deepEqual(calls[1].options.data, {
    content: '<p>body</p><figure><img src="https://pic4.zhimg.com/a.png"></figure>',
    table_of_contents: false,
    delta_time: 0,
    can_reward: false,
  });
  assert.match(calls[1].options.data.content, /pic4\.zhimg\.com\/a\.png/);
});

test("waits until API draft content contains expected image count", async () => {
  let hits = 0;
  const { page } = createApiPage({
    "GET https://zhuanlan.zhihu.com/api/articles/77/draft": async () => {
      hits += 1;
      if (hits < 2) {
        return { status: 200, json: { content: "<p>no image yet</p>" } };
      }
      return {
        status: 200,
        json: {
          content: '<figure><img src="https://pic4.zhimg.com/a.png"></figure><figure><img src="https://pic4.zhimg.com/b.png"></figure>',
        },
      };
    },
  });

  const verified = await waitForZhihuApiDraftImages(page, "77", 2, 2000, 1);
  assert.equal(verified.imageCount, 2);
  assert.equal(verified.imageUrls.length, 2);
});

test("uploads local image tasks through token + reused CDN path", async () => {
  const hash = md5Hex(await import("node:fs/promises").then((fs) => fs.readFile(localFile)));
  const { page, calls } = createApiPage({
    "POST https://api.zhihu.com/images": async ({ options }) => {
      assert.equal(options.data.image_hash, hash);
      assert.equal(options.data.source, "article");
      return {
        status: 200,
        json: {
          upload_file: { state: 1, image_id: "img-1", object_key: "obj-1" },
          upload_token: {},
        },
      };
    },
    "GET https://api.zhihu.com/images/img-1": {
      status: 200,
      json: { status: "success", original_hash: "cdn-hash-1" },
    },
  });

  const uploaded = await uploadZhihuImageTasksViaApi(page, [{
    assetId: "asset-a",
    sectionId: "section-a",
    position: 1,
    path: localFile,
    altText: "图",
  }], { timeoutMs: 3000 });

  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].platformImageUrl, "https://pic4.zhimg.com/cdn-hash-1");
  assert.ok(calls.some((call) => call.method === "POST" && call.url.includes("/images")));
});

test("publishArticle prefers API transport and returns draft_saved with evidence", async () => {
  const progress = [];
  const adapter = new ZhihuAdapter({
    browser: {
      async launchPersistentContext() {
        const page = {
          async goto() {},
          async bringToFront() {},
          async waitForLoadState() {},
          url: () => "https://zhuanlan.zhihu.com/write",
          async title() { return "写文章 - 知乎"; },
          async evaluate() { return "创作中心 写文章"; },
          request: {
            async get(url) {
              if (String(url).includes("/api/v4/me")) {
                return {
                  ok: () => true,
                  async json() { return { id: "u1", name: "测试作者", avatar_url: "" }; },
                };
              }
              return { ok: () => false, async json() { return {}; } };
            },
            async fetch(url, options = {}) {
              const method = String(options.method || "GET").toUpperCase();
              if (method === "POST" && String(url).endsWith("/api/articles/drafts")) {
                return { status: () => 200, async text() { return JSON.stringify({ id: "555" }); } };
              }
              if (method === "PATCH" && String(url).includes("/api/articles/555/draft")) {
                return { status: () => 200, async text() { return "{}"; } };
              }
              if (method === "GET" && String(url).includes("/api/articles/555/draft")) {
                return {
                  status: () => 200,
                  async text() {
                    return JSON.stringify({
                      content: '<p>body</p><figure><img src="https://pic4.zhimg.com/a.png"></figure>',
                    });
                  },
                };
              }
              if (method === "POST" && String(url) === "https://api.zhihu.com/images") {
                return {
                  status: () => 200,
                  async text() {
                    return JSON.stringify({
                      upload_file: { state: 1, image_id: "img-a", object_key: "obj-a" },
                      upload_token: {},
                    });
                  },
                };
              }
              if (method === "GET" && String(url) === "https://api.zhihu.com/images/img-a") {
                return {
                  status: () => 200,
                  async text() {
                    return JSON.stringify({ status: "success", original_hash: "a-hash" });
                  },
                };
              }
              return { status: () => 404, async text() { return ""; } };
            },
          },
          context() {
            return {
              async cookies() {
                return [
                  { name: "z_c0", value: "token", domain: ".zhihu.com" },
                  { name: "_xsrf", value: "xsrf", domain: ".zhihu.com" },
                ];
              },
            };
          },
        };
        return {
          pages: () => [page],
          async newPage() { return page; },
          async cookies() {
            return [
              { name: "z_c0", value: "token", domain: ".zhihu.com" },
              { name: "_xsrf", value: "xsrf", domain: ".zhihu.com" },
            ];
          },
          async close() {},
          async addCookies() {},
          async addInitScript() {},
        };
      },
    },
  });

  // Avoid real credential refresh network.
  adapter.refreshCredentialAfterOperation = async () => undefined;

  const result = await adapter.publishArticle({
    title: "知乎 API 草稿",
    content: "正文内容足够长",
    contentBlocks: [
      { type: "section", sectionId: "s1", title: "章节", content: "正文内容足够长" },
      { type: "image", sectionId: "s1", assetId: "asset-a", altText: "图" },
    ],
    platformImageTasks: [{
      assetId: "asset-a",
      sectionId: "s1",
      position: 1,
      path: localFile,
      altText: "图",
    }],
    confirmPublish: false,
    onProgress: (event) => progress.push(event),
  });

  assert.equal(result.platformStatus, "draft_saved");
  assert.equal(result.transport, "api");
  assert.equal(result.draftUrl, "https://zhuanlan.zhihu.com/p/555/edit");
  assert.equal(result.imagePublicationEvidence?.draft?.verifiedCount, 1);
  assert.ok(progress.some((event) => event.type === "publish_transport" && event.transport === "api"));
});
