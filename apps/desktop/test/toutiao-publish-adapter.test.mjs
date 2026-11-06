import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ToutiaoAdapter,
  completeToutiaoPublishFlow,
  clickReadyToutiaoButton,
  findToutiaoArticleId,
  inspectToutiaoPublicArticle,
  normalizeToutiaoPublishedUrl,
  readToutiaoEditorImages,
  readToutiaoPlatformBlocker,
  toutiaoApiPayloadSucceeded,
  toutiaoPayloadRequiresManualAction,
  toutiaoPublishEndpointIsMutation,
  toutiaoDraftUrlFromArticleId,
  watchToutiaoApiResponses,
  uploadToutiaoInlineImages,
  clickToutiaoDraftSave,
  saveToutiaoDraft,
  toutiaoDraftArticleIdFromUrl,
  verifyToutiaoDraftImages,
  waitForToutiaoDraftUrl,
  waitForToutiaoEditorImages,
  readToutiaoEditorState,
  toutiaoEditorHoldsArticle,
  describeToutiaoDraftImageGap,
  findToutiaoDraftArticleId,
  findToutiaoDraftArticleIdInManagePage,
  toutiaoPgcIdFromUrl,
} from "../src/adapters/toutiao.mjs";
import { getAdapter } from "../src/adapters/index.mjs";
import { fileURLToPath } from "node:url";

test("registers Toutiao as a dedicated publishing adapter", () => {
  assert.equal(getAdapter("toutiao").constructor.name, "ToutiaoAdapter");
});

test("builds Toutiao draft URLs and accepts only real public article URLs", () => {
  assert.equal(
    toutiaoDraftUrlFromArticleId("1234567890"),
    "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=1234567890"
  );
  assert.equal(
    normalizeToutiaoPublishedUrl("https://www.toutiao.com/article/1234567890/"),
    "https://www.toutiao.com/article/1234567890/"
  );
  assert.equal(normalizeToutiaoPublishedUrl("https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=1"), "");
});

test("prefers the exact Toutiao pgc id and rejects failed zero-id responses", () => {
  const valid = {
    data: {
      article_pgc: { id: 7662274535584056000, group_id: 7662274535584056000 },
      pgc_id: "7662274535584055858",
    },
  };
  const failed = { code: 7050, data: { pgc_id: "0" }, message: "保存失败" };

  assert.equal(findToutiaoArticleId(valid), "7662274535584055858");
  assert.equal(findToutiaoArticleId(failed), "");
  assert.equal(toutiaoApiPayloadSucceeded(valid), true);
  assert.equal(toutiaoApiPayloadSucceeded(failed), false);
});

test("ignores Toutiao publish strategy metadata and only flags explicit verification blockers", () => {
  assert.equal(
    toutiaoPublishEndpointIsMutation("https://mp.toutiao.com/mp/agw/diversity/publish/strategy/v1/check/"),
    false,
  );
  assert.equal(
    toutiaoPublishEndpointIsMutation("https://mp.toutiao.com/mp/agw/article/publish"),
    true,
  );
  assert.equal(toutiaoPayloadRequiresManualAction({ authentication: { verify_code: "" } }), false);
  assert.equal(toutiaoPayloadRequiresManualAction({
    code: 0,
    message: "\u4fdd\u5b58\u6210\u529f",
    data: {
      pgc_id: "7664999623483834931",
      content: "An ordinary article may discuss security verification without being blocked.",
    },
  }), false);
  assert.equal(toutiaoPayloadRequiresManualAction({ code: 7050, message: "保存失败" }), false);
  assert.equal(toutiaoPayloadRequiresManualAction({ code: 4001, message: "请完成安全验证后重试" }), true);
});

test("ignores management filters and only treats scoped visible notices as blockers", async () => {
  const managementPage = {
    async evaluate() {
      return {
        pageUrl: "https://mp.toutiao.com/profile_v4/graphic/articles",
        noticeTexts: ["\u5ba1\u6838\u63d0\u9192\uff1a\u7528\u6237\u540d\u4e3a\u9ed8\u8ba4\u7528\u6237\u540d"],
      };
    },
  };
  const verificationPage = {
    async evaluate() {
      return {
        pageUrl: "https://mp.toutiao.com/profile_v4/graphic/publish",
        noticeTexts: ["\u8bf7\u5b8c\u6210\u5b89\u5168\u9a8c\u8bc1\u540e\u91cd\u8bd5"],
      };
    },
  };

  assert.equal(await readToutiaoPlatformBlocker(managementPage), "");
  assert.equal(await readToutiaoPlatformBlocker(verificationPage), "TOUTIAO_MANUAL_ACTION_REQUIRED");
});
test("completes the real Toutiao preview-and-publish confirmation flow", async () => {
  const actions = [];
  let previewClicked = false;
  const makeButton = (name) => ({
    async count() { return 1; },
    async isVisible() { return name === "preview" || previewClicked; },
    async isDisabled() { return false; },
    async scrollIntoViewIfNeeded() {},
    async click() {
      actions.push(name);
      if (name === "preview") previewClicked = true;
    },
  });
  const previewButton = makeButton("preview");
  const confirmButton = makeButton("confirm");
  const page = {
    async goto() {},
    async evaluate() { return { aBogus: "fresh-runtime-signature" }; },
    getByRole(_role, options = {}) {
      if (options.name === "\u9884\u89c8\u5e76\u53d1\u5e03") return previewButton;
      if (options.name === "\u786e\u8ba4\u53d1\u5e03") return confirmButton;
      return makeButton("other");
    },
    locator() { return makeButton("fallback"); },
    async waitForTimeout() {},
  };

  const result = await completeToutiaoPublishFlow(page, 100);

  assert.deepEqual(actions, ["preview", "confirm"]);
  assert.deepEqual(result, { previewClicked: true, confirmClicked: true });
});

test("waits for Toutiao draft URL and asynchronous editor images", async () => {
  const state = { draftUrl: "" };
  let waits = 0;
  const image = {
    async getAttribute(name) {
      return name === "src" ? "https://p3-sign.toutiaoimg.com/draft-inline.png" : "draft image";
    },
    async evaluate() { return true; },
  };
  const page = {
    url: () => "https://mp.toutiao.com/profile_v4/graphic/publish",
    async waitForTimeout() {
      waits += 1;
      if (waits === 2) {
        state.draftUrl = "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=1234567890";
      }
    },
    locator() {
      return {
        async count() { return waits >= 3 ? 1 : 0; },
        nth() { return image; },
      };
    },
  };

  const draftUrl = await waitForToutiaoDraftUrl(state, page, 100, 1);
  const images = await waitForToutiaoEditorImages(page, 1, 100, 1);
  assert.equal(draftUrl, state.draftUrl);
  assert.equal(images[0].platformImageUrl, "https://p3-sign.toutiaoimg.com/draft-inline.png");
});

test("selects the uploaded Toutiao material before confirming body insertion", async () => {
  const actions = [];
  const images = [];
  let selected = false;
  const localFile = fileURLToPath(import.meta.url);
  const imageLocator = {
    async count() { return images.length; },
    nth(index) {
      return {
        async getAttribute(name) { return name === "src" ? images[index] : "正文图"; },
        async evaluate() { return true; },
      };
    },
  };
  const editor = {
    async evaluate() { return true; },
  };
  const create = (name, options = {}) => ({
    first() { return this; },
    last() { return this; },
    async count() { return options.count ?? 0; },
    async isVisible() { return options.visible ?? true; },
    async scrollIntoViewIfNeeded() {},
    async waitFor() {},
    async click() {
      actions.push(name);
      if (name === "material") selected = true;
      if (name === "confirm" && selected) images.push("https://image-tt-private.toutiao.com/body.png");
    },
    async setInputFiles() { actions.push("file"); },
  });
  const page = {
    locator(selector) {
      if (selector === ".ProseMirror img") return imageLocator;
      if (selector.includes("ProseMirror")) return { first: () => editor };
      if (selector.includes("syl-toolbar-tool.image") && selector.includes("button")) return create("toolbar");
      if (selector.includes("upload-image-panel input")) return create("input", { count: 1 });
      if (selector.includes("upload-image-wrapper img")) return create("material");
      if (selector.includes("upload-image-panel button")) return create("confirm");
      return create("missing", { visible: false });
    },
    waitForEvent() {
      actions.push("listen");
      return Promise.resolve(null);
    },
    async waitForTimeout() {},
  };

  const uploaded = await uploadToutiaoInlineImages(page, [{
    assetId: "asset-inline",
    sectionId: "workflow",
    position: 2,
    path: localFile,
  }], { timeoutMs: 50 });

  assert.equal(uploaded[0].platformImageUrl, "https://image-tt-private.toutiao.com/body.png");
  assert.ok(actions.indexOf("listen") < actions.indexOf("toolbar"));
  assert.deepEqual(actions.filter((action) => ["file", "material", "confirm"].includes(action)), ["file", "material", "confirm"]);
});

test("deduplicates Toutiao editor image clones by persistent URL", async () => {
  const image = {
    async getAttribute(name) {
      return name === "src" ? "https://image-tt-private.toutiao.com/body.png" : "正文图";
    },
    async evaluate() { return true; },
  };
  const page = {
    locator() {
      return {
        async count() { return 2; },
        nth() { return image; },
      };
    },
  };

  const images = await readToutiaoEditorImages(page);

  assert.equal(images.length, 1);
});

test("discovers a reviewed Toutiao article and verifies public platform images", async () => {
  const publicImage = {
    async getAttribute(name) {
      if (name === "src") return "https://p3-sign.toutiaoimg.com/public-inline.png";
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
    async innerText() { return "The authenticated toutiao public body is available."; },
  };
  const page = {
    async goto() {},
    async waitForLoadState() {},
    async waitForFunction(_fn, payload) {
      assert.ok(String(payload.selector).includes("toutiaoimg.com"));
      assert.equal(payload.expectedCount, 1);
    },
    async title() { return "Toutiao reviewed illustrated article"; },
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
    platformImageUrl: "https://p3-sign.toutiaoimg.com/draft-inline.png",
    loaded: true,
  };

  const result = await inspectToutiaoPublicArticle(page, {
    publicUrl: "https://www.toutiao.com/article/1234567890/",
    articleTitle: "Toutiao reviewed illustrated article",
    contentMarkdown: "The authenticated toutiao public body is available.",
    imagePublicationEvidence: {
      expectedCount: 1,
      expected,
      upload: { images: [priorImage] },
      draft: { images: [priorImage] },
    },
  });

  assert.equal(result.found, true);
  assert.equal(result.imagePublicationEvidence.status, "verified");
  assert.equal(result.imagePublicationEvidence.public.verifiedCount, 1);
});

test("keeps Toutiao discovery non-terminal when public candidate has no persistent images", async () => {
  const emptyImageLocator = {
    async count() { return 0; },
    nth() { return emptyImageLocator; },
  };
  const bodyLocator = {
    first() { return bodyLocator; },
    async innerText() { return ""; },
  };
  const page = {
    async goto() {},
    async waitForLoadState() {},
    async waitForFunction() {},
    async title() { return ""; },
    locator(selector) {
      if (String(selector).includes("img")) return emptyImageLocator;
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
    platformImageUrl: "https://p3-sign.toutiaoimg.com/draft-inline.png",
    loaded: true,
  };

  const result = await inspectToutiaoPublicArticle(page, {
    publicUrl: "https://www.toutiao.com/article/1234567890/",
    articleTitle: "Toutiao reviewed illustrated article",
    contentMarkdown: "The authenticated toutiao public body is available.",
    imagePublicationEvidence: {
      expectedCount: 1,
      expected,
      upload: { images: [priorImage] },
      draft: { images: [priorImage] },
    },
  });

  assert.equal(result.found, false);
  assert.equal(result.imagePublicationEvidence.status, "review_required");
  assert.deepEqual(result.imagePublicationEvidence.issues, ["PUBLIC_IMAGE_MISSING"]);
});

test("draft-mode publish does not invent a public Toutiao URL", async () => {
  const actions = [];
  const page = {
    _url: "https://mp.toutiao.com/profile_v4/graphic/publish",
    on() {},
    off() {},
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    async goto(url) {
      actions.push(["goto", url]);
      page._url = url;
    },
    async bringToFront() {},
    async waitForLoadState() {},
    async waitForTimeout() {},
    async waitForFunction() {},
    url() { return page._url; },
    async evaluate(_fn, arg) {
      if (typeof arg === "string" && arg.includes("toast")) {
        return [{ text: "\u4fdd\u5b58\u6210\u529f", insideButton: false }];
      }
      return "headline draft workspace content management publish article editor";
    },
    locator(selector) {
      const locator = {
        first() { return locator; },
        async isVisible() {
          return /title|placeholder|ProseMirror|contenteditable|草稿|存草稿/i.test(selector);
        },
        async isDisabled() { return false; },
        async click() {
          actions.push(["click", selector]);
          if (/草稿|存草稿|Save Draft/i.test(selector)) {
            page._url = "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=1234567890";
          }
        },
        async fill(value) { actions.push(["fill", selector, value]); },
        async dispatchEvent() {},
        async scrollIntoViewIfNeeded() {},
        async setInputFiles() {},
      };
      return locator;
    },
  };
  const context = {
    pages() { return [page]; },
    async newPage() { return page; },
    async cookies() {
      return [{ name: "sessionid", value: "toutiao-session", domain: ".toutiao.com" }];
    },
    async close() { actions.push(["close"]); },
  };
  const adapter = new ToutiaoAdapter({
    browser: {
      async launchPersistentContext() { return context; },
    },
  });

  const result = await adapter.publishArticle({
    articleTitle: "Toutiao draft only illustrated article",
    contentMarkdown: "This is a controlled Toutiao draft automation body with enough content.",
    confirmPublish: false,
    draftTimeoutMs: 300,
  });

  assert.equal(result.platformStatus, "draft_saved");
  assert.equal(result.publishedUrl, "");
  // The editor URL only ever carries the account pgc id, which reopens an empty
  // article, so a save that never exposed an article-scoped id reports no draft
  // URL and names the miss instead of handing back a known-invalid candidate.
  assert.equal(result.draftUrl, "");
  assert.equal(result.message, "TOUTIAO_DRAFT_URL_MISSING");
});

test("publishes straight from the filled Toutiao editor without a draft stage", async () => {
  const actions = [];
  const progress = [];
  let previewClicked = false;
  const makeButton = (name) => ({
    async count() { return 1; },
    async isVisible() { return name === "preview" || previewClicked; },
    async isDisabled() { return false; },
    async scrollIntoViewIfNeeded() {},
    async click() {
      actions.push(["click-button", name]);
      if (name === "preview") previewClicked = true;
      if (name === "confirm") page._url = "https://www.toutiao.com/article/7654321098765432/";
    },
  });
  const page = {
    _url: "https://mp.toutiao.com/profile_v4/graphic/publish",
    on() {},
    off() {},
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    async goto(url) {
      actions.push(["goto", url]);
      page._url = url;
    },
    async bringToFront() {},
    async waitForLoadState() {},
    async waitForTimeout() {},
    url() { return page._url; },
    async evaluate(_fn, arg) {
      if (typeof arg === "string" && arg.includes("toast")) {
        return [{ text: "\u4fdd\u5b58\u6210\u529f", insideButton: false }];
      }
      return "headline draft workspace content management publish article editor";
    },
    getByRole(_role, options = {}) {
      if (options.name === "\u9884\u89c8\u5e76\u53d1\u5e03") return makeButton("preview");
      if (options.name === "\u786e\u8ba4\u53d1\u5e03") return makeButton("confirm");
      return makeButton("other");
    },
    locator(selector) {
      const locator = {
        first() { return locator; },
        async isVisible() { return /title|placeholder|ProseMirror|contenteditable/i.test(selector); },
        async isDisabled() { return false; },
        async click() { actions.push(["click", selector]); },
        async fill(value) { actions.push(["fill", selector, value]); },
        async dispatchEvent() {},
        async scrollIntoViewIfNeeded() {},
        async setInputFiles() {},
      };
      return locator;
    },
  };
  const context = {
    pages() { return [page]; },
    async newPage() { return page; },
    async cookies() {
      return [{ name: "sessionid", value: "toutiao-session", domain: ".toutiao.com" }];
    },
    async close() { actions.push(["close"]); },
  };
  const adapter = new ToutiaoAdapter({
    browser: {
      async launchPersistentContext() { return context; },
    },
  });

  const result = await adapter.publishArticle({
    articleTitle: "Toutiao direct publish article",
    contentMarkdown: "This is a controlled Toutiao direct-publish body with enough content.",
    confirmPublish: true,
    onProgress: (event) => progress.push(event),
  });

  assert.equal(result.platformStatus, "published");
  assert.equal(result.publishedUrl, "https://www.toutiao.com/article/7654321098765432/");
  assert.equal(result.publiclyVisible, true);
  assert.equal(result.reviewStatus, "public");
  // The only navigation is the editor itself: no save detour, no manage-page
  // lookup and no draft reopen ever ran on the publish path.
  assert.deepEqual(
    actions.filter(([kind]) => kind === "goto"),
    [["goto", "https://mp.toutiao.com/profile_v4/graphic/publish"]],
  );
  // Preview-and-publish then confirm, straight from the editor that was filled.
  assert.deepEqual(
    actions.filter(([kind]) => kind === "click-button").map(([, name]) => name),
    ["preview", "confirm"],
  );
  // No draft-save control was clicked on the way out either.
  assert.ok(!actions.some(([kind, selector]) => kind === "click" && /草稿|存草稿|draft/i.test(String(selector))));
  assert.equal(result.draftUrl, "");
  assert.ok(progress.some((event) => event.type === "toutiao_publishing_from_editor"));
  assert.ok(!progress.some((event) => event.type === "verifying_draft_images"));
});

test("verifies Toutiao publish images on the public page instead of reopening a draft", async () => {
  const actions = [];
  const progress = [];
  let previewClicked = false;
  const editorImages = [];
  const publicImages = ["https://p3-sign.toutiaoimg.com/public-inline.png"];
  const makeButton = (name) => ({
    async count() { return 1; },
    async isVisible() { return name === "preview" || previewClicked; },
    async isDisabled() { return false; },
    async scrollIntoViewIfNeeded() {},
    async click() {
      actions.push(["click-button", name]);
      if (name === "preview") previewClicked = true;
      if (name === "confirm") page._url = "https://www.toutiao.com/article/7654321098765432/";
    },
  });
  const makeImage = (src) => ({
    async getAttribute(name) { return name === "src" ? src : "正文图"; },
    async evaluate() { return true; },
  });
  const imageCollection = (bucket) => ({
    async count() { return bucket.length; },
    nth(index) { return makeImage(bucket[index]); },
  });
  // Every control that is neither the title field nor the editor fails its
  // click, which is what forces the paste fallback for the inline image.
  const failing = (name) => ({
    first() { return failing(name); },
    last() { return failing(name); },
    async count() { return 1; },
    async isVisible() { return false; },
    async isDisabled() { return false; },
    async click() { throw new Error(`${name}_click_failed`); },
    async fill() {},
    async dispatchEvent() {},
    async setInputFiles() {},
  });
  // positionCursorAfterSection sends {sectionId, sectionTitle}; pasteImageFile
  // sends {base64, ...}, so only the paste inserts the image.
  const editor = {
    async evaluate(_fn, payload) {
      if (payload?.base64) editorImages.push("https://image-tt-private.toutiao.com/body.png");
      return true;
    },
  };
  const page = {
    _url: "https://mp.toutiao.com/profile_v4/graphic/publish",
    on() {},
    off() {},
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    async goto(url) {
      actions.push(["goto", url]);
      page._url = url;
    },
    async bringToFront() {},
    async waitForLoadState() {},
    async waitForTimeout() {},
    async waitForFunction() {},
    url() { return page._url; },
    async evaluate(_fn, arg) {
      if (typeof arg === "string" && arg.includes("toast")) {
        return [{ text: "\u4fdd\u5b58\u6210\u529f", insideButton: false }];
      }
      return "headline draft workspace content management publish article editor";
    },
    getByRole(_role, options = {}) {
      if (options.name === "\u9884\u89c8\u5e76\u53d1\u5e03") return makeButton("preview");
      if (options.name === "\u786e\u8ba4\u53d1\u5e03") return makeButton("confirm");
      return makeButton("other");
    },
    waitForEvent() { return Promise.resolve(null); },
    locator(selector) {
      if (selector === ".ProseMirror img") return imageCollection(editorImages);
      if (String(selector).includes("ProseMirror")) return { first: () => editor };
      if (String(selector).includes("img")) return imageCollection(publicImages);
      if (/title|placeholder|contenteditable/i.test(String(selector))) {
        const locator = {
          first() { return locator; },
          async isVisible() { return true; },
          async isDisabled() { return false; },
          async click() { actions.push(["click", selector]); },
          async fill(value) { actions.push(["fill", selector, value]); },
          async dispatchEvent() {},
          async scrollIntoViewIfNeeded() {},
          async setInputFiles() {},
        };
        return locator;
      }
      return failing(String(selector).slice(0, 24));
    },
  };
  const context = {
    pages() { return [page]; },
    async newPage() { return page; },
    async cookies() {
      return [{ name: "sessionid", value: "toutiao-session", domain: ".toutiao.com" }];
    },
    async close() { actions.push(["close"]); },
  };
  const adapter = new ToutiaoAdapter({
    browser: {
      async launchPersistentContext() { return context; },
    },
  });

  const result = await adapter.publishArticle({
    articleTitle: "Toutiao direct publish illustrated",
    contentMarkdown: "This is a controlled Toutiao direct-publish body with enough content.",
    confirmPublish: true,
    platformImageTasks: [{
      assetId: "asset-inline",
      sectionId: "workflow",
      position: 2,
      idempotencyKey: "asset-inline:workflow:hash",
      path: fileURLToPath(import.meta.url),
    }],
    onProgress: (event) => progress.push(event),
  });

  assert.equal(result.platformStatus, "published");
  assert.equal(result.publishedUrl, "https://www.toutiao.com/article/7654321098765432/");
  // The image was verified on the public page after publishing, never by
  // reopening a draft, and the evidence records that path.
  assert.equal(result.imagePublicationEvidence.status, "verified");
  assert.equal(result.imagePublicationEvidence.public.verifiedCount, 1);
  assert.equal(result.imagePublicationEvidence.upload.verifiedCount, 1);
  assert.ok(progress.some((event) => event.type === "verifying_public_images"));
  assert.ok(!progress.some((event) => event.type === "verifying_draft_images"));
  assert.deepEqual(
    actions.filter(([kind]) => kind === "goto"),
    [["goto", "https://mp.toutiao.com/profile_v4/graphic/publish"]],
  );
  assert.ok(!actions.some(([kind, selector]) => kind === "click" && /草稿|存草稿|draft/i.test(String(selector))));
});

test("rejects a captured Toutiao dynamic publish URL without current-session signing fields", async () => {
  const calls = [];
  const page = {
    request: {
      async fetch(url, options = {}) {
        calls.push({ url, options });
        return {
          status: () => 200,
          url: () => url,
          text: async () => JSON.stringify({ code: 0, data: { pgc_id: "7667055285747368482" } }),
        };
      },
    },
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    close: async () => undefined,
  };
  const adapter = new ToutiaoAdapter({
    browser: { launchPersistentContext: async () => context },
  });

  await assert.rejects(
    () => adapter.publishArticle({
      articleTitle: "Toutiao runtime signing guard",
      contentMarkdown: "This confirms captured dynamic query values cannot be reused by an API-first publication run.",
      confirmPublish: true,
      apiFirst: true,
      platformConfig: {
        publishApiUrl: "https://mp.toutiao.com/mp/agw/article/publish?msToken=captured&a_bogus=captured",
      },
    }),
    /TOUTIAO_RUNTIME_SIGNATURE_REQUIRED/,
  );
  assert.equal(calls.length, 0);
});

test("publishes Toutiao through a captured browser API endpoint without inventing a public URL", async () => {
  const calls = [];
  const page = {
    async goto() {},
    async evaluate() { return { aBogus: "fresh-runtime-signature" }; },
    request: {
      async fetch(url, options = {}) {
        calls.push({ url, options });
        return {
          status: () => 200,
          url: () => url,
          text: async () => JSON.stringify({ code: 0, data: { pgc_id: "7667055285747368482" }, message: "saved" }),
        };
      },
    },
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [
      { name: "sessionid", value: "toutiao-session", domain: ".toutiao.com" },
      { name: "msToken", value: "fresh-runtime-token", domain: ".toutiao.com" },
    ],
    close: async () => calls.push({ close: true }),
  };
  const adapter = new ToutiaoAdapter({
    browser: { launchPersistentContext: async () => context },
  });

  const result = await adapter.publishArticle({
    articleTitle: "Toutiao API-first publish test",
    contentMarkdown: "This verifies Toutiao API evidence keeps the URL empty until the public page is verified.",
    contentHtml: "<p>This verifies Toutiao API evidence keeps the URL empty until the public page is verified.</p>",
    confirmPublish: true,
    apiFirst: true,
    platformConfig: {
      userId: "user-api-1",
    },
  });

  assert.equal(result.platformStatus, "submitted_for_review");
  assert.equal(result.publishedUrl, "");
  assert.equal(result.externalIds.articleId, "7667055285747368482");
  assert.match(result.reviewUrl, /7667055285747368482/);
  assert.equal(result.publicationEvidence.source, "api");
  assert.equal(result.publicationEvidence.accepted, true);
  assert.ok(calls.some((call) => String(call.url || "").includes("/mp/agw/article/publish")));
  assert.doesNotMatch(JSON.stringify(result.publicationEvidence), /toutiao-session|fresh-runtime-token|fresh-runtime-signature/);
});

test("distinguishes a draft article id from the account pgc id", () => {
  const accountPgcId = "7665000156680471050";
  const draftPayload = { data: { article_id: "7667000000000000001", pgc_id: accountPgcId } };

  assert.equal(findToutiaoDraftArticleId(draftPayload, accountPgcId), "7667000000000000001");
  assert.equal(findToutiaoDraftArticleId({ data: { pgc_id: accountPgcId } }, accountPgcId), "");
  assert.equal(findToutiaoDraftArticleId({ data: { pgc_id: "0" } }, accountPgcId), "");
  assert.equal(findToutiaoDraftArticleId({ code: 7050, message: "\u4fdd\u5b58\u5931\u8d25" }, accountPgcId), "");
  assert.equal(
    toutiaoPgcIdFromUrl(`https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=${accountPgcId}`),
    accountPgcId
  );
  assert.equal(toutiaoPgcIdFromUrl("https://mp.toutiao.com/profile_v4/graphic/publish"), "");
});

test("waits for an article-scoped draft URL instead of the account-only editor URL", async () => {
  const accountPgcId = "7665000156680471050";
  const articleId = "7667000000000000001";
  const scopedUrl = `https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=${accountPgcId}&article_id=${articleId}`;
  const accountOnlyUrl = `https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=${accountPgcId}`;
  const state = {};
  const page = {
    url: () => scopedUrl,
    async waitForTimeout() {},
  };

  const draftUrl = await waitForToutiaoDraftUrl(state, page, 100, { accountPgcId, pollMs: 1 });

  assert.equal(draftUrl, scopedUrl);
  assert.equal(state.draftUrlAccountOnly, undefined);

  const accountOnlyPage = {
    url: () => accountOnlyUrl,
    async waitForTimeout() {},
  };
  // The editor URL carries the account pgc id from the moment it loads, so
  // settling for it would hand back a candidate known to reopen an empty
  // article. The miss is reported instead and flagged as account-only.
  const accountOnlyState = {};
  const accepted = await waitForToutiaoDraftUrl(accountOnlyState, accountOnlyPage, 100, { accountPgcId, pollMs: 1, scopedWaitMs: 0 });

  assert.equal(accepted, "");
  assert.equal(accountOnlyState.draftUrlAccountOnly, true);
});

test("keeps only ids in the Toutiao response watcher and never signing tokens", async () => {
  const handlers = [];
  const page = {
    on(event, handler) {
      if (event === "response") handlers.push(handler);
    },
    off(event, handler) {
      const index = handlers.indexOf(handler);
      if (index >= 0) handlers.splice(index, 1);
    },
  };
  const watcher = watchToutiaoApiResponses(page);
  watcher.setAccountPgcId("7665000156680471050");

  const response = {
    url: () => "https://mp.toutiao.com/mp/agw/article/edit?msToken=captured-token&a_bogus=captured-signature",
    text: async () => JSON.stringify({
      code: 0,
      message: "\u4fdd\u5b58\u6210\u529f",
      msToken: "captured-token",
      a_bogus: "captured-signature",
      data: { article_id: "7667000000000000001", pgc_id: "7665000156680471050" },
    }),
  };
  for (const handler of handlers) await handler(response);

  assert.equal(watcher.state.draftArticleId, "7667000000000000001");
  assert.equal(watcher.state.mutationCount, 1);
  assert.equal(
    watcher.state.draftUrl,
    "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=7667000000000000001"
  );
  assert.equal(watcher.state.draftUrlAccountOnly, false);
  assert.doesNotMatch(JSON.stringify(watcher.state), /captured-token|captured-signature|msToken|a_bogus/);

  watcher.dispose();
  assert.equal(handlers.length, 0);
});

const toutiaoTitle = "\u667a\u5fc3\u81ea\u52a8\u5316\u6d4b\u8bd5\u7a3f";
const toutiaoBody = "\u6b63\u6587\u7b2c\u4e00\u6bb5\u843d\u5185\u5bb9\uff0c\u5305\u542b\u8db3\u591f\u957f\u5ea6\u7684\u63cf\u8ff0\u3002";

const makeToutiaoEditorPage = (state = {}) => ({
  locator(selector) {
    const value = String(selector);
    if (value === ".ProseMirror, .ql-editor, [contenteditable='true']") {
      const surface = {
        async count() { return state.editorPresent ? 1 : 0; },
        async isVisible() { return state.editorPresent === true; },
      };
      return { first: () => surface };
    }
    if (value.includes("img")) {
      const images = Array.isArray(state.images) ? state.images : [];
      return {
        async count() { return images.length; },
        nth(index) {
          return {
            async getAttribute(name) {
              if (name === "src") return images[index].url;
              if (name === "alt") return images[index].alt || "\u6b63\u6587\u56fe";
              return "";
            },
            async evaluate() {
              return { currentSrc: images[index].url, loaded: images[index].loaded !== false };
            },
          };
        },
      };
    }
    const isTitleField = /textarea|input|title-container/i.test(value);
    const text = isTitleField ? state.titleText : state.editorText;
    const locator = {
      async count() { return text ? 1 : 0; },
      async isVisible() { return Boolean(text); },
      async inputValue() { return text; },
      async innerText() { return text; },
    };
    return { first: () => locator };
  },
});

test("tells an emptied reopened editor apart from missing images", async () => {
  const publishInput = { title: toutiaoTitle, content: toutiaoBody };
  const intact = await readToutiaoEditorState(makeToutiaoEditorPage({
    editorPresent: true,
    titleText: toutiaoTitle,
    editorText: toutiaoBody,
    images: [{ url: "https://p3-sign.toutiaoimg.com/draft-inline.png", loaded: true }],
  }));

  assert.equal(intact.editorPresent, true);
  assert.equal(toutiaoEditorHoldsArticle(intact, publishInput), true);
  assert.equal(intact.images.length, 1);

  const emptied = await readToutiaoEditorState(makeToutiaoEditorPage({
    editorPresent: true,
    titleText: "",
    editorText: "",
    images: [],
  }));

  assert.equal(emptied.editorPresent, true);
  assert.equal(toutiaoEditorHoldsArticle(emptied, publishInput), false);
  assert.equal(
    describeToutiaoDraftImageGap(2, emptied),
    "DRAFT_IMAGE_MISSING:expected=2:actual=0:editorImages=0:editor=true:titleField=empty:bodyTextLen=0:images=none"
  );
  assert.match(describeToutiaoDraftImageGap(2, intact), /actual=1:editorImages=1/);
});

test("reads the Toutiao draft article id out of the editor URL and never the account pgc id", () => {
  const accountPgcId = "7665000156680471050";
  const articleId = "7667000000000000001";
  const editorUrl = `https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=${accountPgcId}`;

  for (const param of ["article_id", "pgc_article_id", "group_id", "item_id"]) {
    assert.equal(toutiaoDraftArticleIdFromUrl(`${editorUrl}&${param}=${articleId}`, accountPgcId), articleId);
  }
  // pgc_id names the account, so an editor URL carrying only it has no article id.
  assert.equal(toutiaoDraftArticleIdFromUrl(editorUrl, accountPgcId), "");
  assert.equal(toutiaoDraftArticleIdFromUrl(`${editorUrl}&article_id=${accountPgcId}`, accountPgcId), "");
  assert.equal(toutiaoDraftArticleIdFromUrl(`${editorUrl}&article_id=0`), "");
  assert.equal(toutiaoDraftArticleIdFromUrl(""), "");
});

test("re-clicks an unconfirmed Toutiao draft save exactly once and keeps its verdict", async () => {
  const makeSavePage = (toastText) => {
    const clicks = [];
    const page = {
      _url: "https://mp.toutiao.com/profile_v4/graphic/publish",
      url() { return page._url; },
      async evaluate() {
        return toastText ? [{ text: toastText, insideButton: false }] : [];
      },
      async waitForTimeout() {},
      locator(selector) {
        const button = {
          first() { return button; },
          async isVisible() { return /\u8349\u7a3f/.test(selector); },
          async isDisabled() { return false; },
          async click() {
            clicks.push(selector);
            page._url = "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=1234567890";
          },
        };
        return button;
      },
    };
    return { page, clicks };
  };

  // No toast and no save response: the click is repeated once, and the caller
  // still learns that nothing was confirmed and which URL the editor sits on.
  const silent = makeSavePage("");
  const unconfirmed = await clickToutiaoDraftSave(silent.page, 60, { state: { mutationCount: 0 } });

  assert.equal(unconfirmed.saved, false);
  assert.equal(unconfirmed.signal, "timeout");
  assert.equal(silent.clicks.length, 2);
  assert.ok(String(unconfirmed.url).includes("pgc_id=1234567890"));

  // A confirmed save returns on the first click and reports the toast signal.
  const confirmed = makeSavePage("\u4fdd\u5b58\u6210\u529f");
  const saved = await clickToutiaoDraftSave(confirmed.page, 2000, { state: { mutationCount: 0 } });

  assert.equal(saved.saved, true);
  assert.equal(saved.signal, "save_toast");
  assert.equal(confirmed.clicks.length, 1);
  assert.ok(String(saved.url).includes("pgc_id=1234567890"));
});

// A page whose only "草稿" control is a navigation target. Every save lookup has
// to name an exact label, so this page must never be clicked at all.
const makeToutiaoDraftBoxOnlyPage = (clicks, queried) => ({
  _url: "https://mp.toutiao.com/profile_v4/graphic/publish",
  url() { return this._url; },
  async evaluate() { return []; },
  async waitForTimeout(ms) { await new Promise((resolve) => setTimeout(resolve, Number(ms) || 0)); },
  getByRole(role, options) {
    queried.push({ role, name: String(options?.name || ""), exact: options?.exact === true });
    return {
      first() { return this; },
      async isVisible() { return false; },
      async isDisabled() { return false; },
      async click() { clicks.push(String(options?.name || "")); },
    };
  },
});

const makeToutiaoAutoSavePage = (clicks) => ({
  _url: "https://mp.toutiao.com/profile_v4/graphic/publish",
  url() { return this._url; },
  async evaluate() { return []; },
  async waitForTimeout(ms) { await new Promise((resolve) => setTimeout(resolve, Number(ms) || 0)); },
  locator() {
    return {
      first() { return this; },
      async isVisible() { return true; },
      async isDisabled() { return false; },
      async click() { clicks.push("locator"); },
    };
  },
});

test("skips the Toutiao save button when the platform already autosaved", async () => {
  const clicks = [];
  const watcher = { state: { mutationCount: 0 } };
  const page = makeToutiaoAutoSavePage(clicks);
  // The platform answers the filled editor with its own save request, which is
  // the only evidence that makes the button click unnecessary.
  setTimeout(() => { watcher.state.mutationCount = 1; }, 60);

  const saved = await saveToutiaoDraft(page, 2000, watcher, {
    baselineMutations: 0,
    probeMs: 2000,
  });

  assert.equal(saved.saved, true);
  assert.equal(saved.signal, "platform_save_response");
  assert.equal(saved.strategy, "autosave");
  assert.equal(clicks.length, 0);
});

test("clicks the Toutiao save button only when the platform never autosaved", async () => {
  const clicks = [];
  const watcher = { state: { mutationCount: 0 } };
  const page = makeToutiaoAutoSavePage(clicks);

  const saved = await saveToutiaoDraft(page, 200, watcher, {
    baselineMutations: 0,
    probeMs: 200,
  });

  assert.equal(saved.saved, false);
  assert.equal(saved.strategy, "button");
  // Still the one re-click for a click that landed before the editor hydrated.
  assert.equal(clicks.length, 2);
});

test("does not read a toast left over from an earlier save as proof of a new one", async () => {
  const clicks = [];
  const watcher = { state: { mutationCount: 0 } };
  const page = {
    ...makeToutiaoAutoSavePage(clicks),
    async evaluate() { return [{ text: "保存成功", insideButton: false }]; },
  };

  // The probe must not accept the stale toast, so it falls through to the button;
  // the click path then reads the same toast as its confirmation.
  const saved = await saveToutiaoDraft(page, 400, watcher, {
    baselineMutations: 0,
    probeMs: 200,
  });

  assert.equal(saved.saved, true);
  assert.equal(saved.signal, "save_toast");
  assert.equal(saved.strategy, "button");
  assert.equal(clicks.length, 1);
});

test("never clicks a Toutiao control that merely mentions 草稿", async () => {
  const clicks = [];
  const queried = [];
  const page = makeToutiaoDraftBoxOnlyPage(clicks, queried);

  const saved = await saveToutiaoDraft(page, 200, { state: { mutationCount: 0 } }, { probeMs: 200 });

  assert.equal(saved.saved, false);
  assert.equal(saved.strategy, "none");
  assert.equal(clicks.length, 0);
  assert.ok(queried.length > 0);
  // 草稿箱 can only resolve to a lookup that asked for an exact save label.
  assert.ok(queried.every((query) => query.exact === true));
  assert.ok(queried.every((query) => ["存草稿", "保存草稿", "Save Draft"].includes(query.name)));
});

const makeToutiaoDraftVerifyPage = (editor, startUrl) => {
  const page = {
    _url: startUrl,
    async goto(url) { page._url = url; },
    async waitForLoadState() {},
    async waitForTimeout() {},
    url() { return page._url; },
    locator: makeToutiaoEditorPage(editor).locator,
  };
  return page;
};

const toutiaoDraftPublishInput = {
  title: toutiaoTitle,
  content: toutiaoBody,
  platformImageTasks: [{ path: "C:/images/inline.png" }],
  draftEditorSettleMs: 1000,
};

test("tells a Toutiao draft that was never identified apart from one the editor lost", async () => {
  const accountPgcId = "1234567890";
  const accountOnlyUrl = `https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=${accountPgcId}`;
  const missing = await verifyToutiaoDraftImages({
    page: makeToutiaoDraftVerifyPage({ editorPresent: true, titleText: "", editorText: "" }, accountOnlyUrl),
    publishInput: toutiaoDraftPublishInput,
    watcher: { state: { draftUrlAccountOnly: true } },
    draftUrl: accountOnlyUrl,
    accountPgcId,
  });

  assert.equal(missing.status, "draft_url_missing");
  assert.equal(missing.images.length, 0);
  // The account-only URL is a known-invalid candidate, so the gate drops it and
  // nothing is left to reopen.
  assert.equal(missing.reload.candidates.length, 0);
  assert.equal(missing.reload.attempts.length, 0);
  assert.match(missing.gap, /never exposed an article-scoped draft URL/);

  const articleId = "7667000000000000001";
  const articleScopedUrl = `${accountOnlyUrl}&article_id=${articleId}`;
  const lost = await verifyToutiaoDraftImages({
    page: makeToutiaoDraftVerifyPage({
      editorPresent: true,
      titleText: "another draft title",
      editorText: "another draft body long enough to count as real editor content",
    }, articleScopedUrl),
    publishInput: toutiaoDraftPublishInput,
    watcher: {
      state: {
        draftArticleId: articleId,
        draftUrl: `https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=${articleId}`,
        draftUrlAccountOnly: false,
      },
    },
    draftUrl: articleScopedUrl,
    accountPgcId,
  });

  assert.equal(lost.status, "editor_lost");
  assert.equal(lost.images.length, 0);
  assert.equal(lost.reload.candidates.length, 2);
  assert.equal(lost.reload.attempts.length, 2);
  assert.ok(lost.reload.attempts.every((attempt) => attempt.holdsArticle === false));
});

test("never retries a Toutiao account-only URL as a draft candidate", async () => {
  const accountPgcId = "1234567890";
  const articleId = "7667000000000000001";
  const accountOnlyUrl = `https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=${accountPgcId}`;
  const report = await verifyToutiaoDraftImages({
    page: makeToutiaoDraftVerifyPage({ editorPresent: true, titleText: "", editorText: "" }, accountOnlyUrl),
    publishInput: toutiaoDraftPublishInput,
    watcher: {
      state: {
        draftArticleId: articleId,
        draftUrl: accountOnlyUrl,
        draftUrlAccountOnly: false,
      },
    },
    draftUrl: accountOnlyUrl,
    accountPgcId,
  });

  // The article id yields the two article-scoped guesses; the account-only URL is
  // dropped even though a draft id is known, because it names the account.
  assert.deepEqual(report.reload.candidates, [
    `https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=${articleId}`,
    `https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=${accountPgcId}&article_id=${articleId}`,
  ]);
  assert.equal(report.status, "editor_lost");
});

test("never mines a Toutiao account id or a nested author id as the draft article id", () => {
  const accountPgcId = "7665000156680471050";
  // pgc_id appears at several depths and unrelated objects carry their own ids.
  const payload = {
    code: 0,
    data: {
      pgc_id: accountPgcId,
      article_pgc: { id: accountPgcId, pgc_id: accountPgcId },
      author: { id: "12345", name: "author" },
      comments: [{ id: "999" }],
    },
  };

  assert.equal(findToutiaoDraftArticleId(payload, accountPgcId), "");
  // An article-scoped id still wins, even next to an author object.
  assert.equal(
    findToutiaoDraftArticleId({ data: { article_id: "7667000000000000001", author: { id: "12345" } } }, accountPgcId),
    "7667000000000000001",
  );
});

test("prefers article-scoped Toutiao ids over the account pgc id", () => {
  assert.equal(
    findToutiaoArticleId({ data: { pgc_id: "7665000156680471050", article_id: "7667000000000000001" } }),
    "7667000000000000001",
  );
  // pgc_id remains the last resort for payloads that carry nothing else.
  assert.equal(findToutiaoArticleId({ data: { pgc_id: "7665000156680471050" } }), "7665000156680471050");
});

test("captures the Toutiao article id from save-form endpoints and remembers which endpoints the save hit", async () => {
  const handlers = [];
  const page = {
    on(event, handler) {
      if (event === "response") handlers.push(handler);
    },
    off() {},
  };
  const watcher = watchToutiaoApiResponses(page);
  watcher.setAccountPgcId("7665000156680471050");

  const saveResponse = {
    url: () => "https://mp.toutiao.com/mp/agw/article/save?msToken=captured-token&a_bogus=captured-signature",
    text: async () => JSON.stringify({
      code: 0,
      data: { article_id: "7667000000000000002", pgc_id: "7665000156680471050" },
    }),
  };
  for (const handler of handlers) await handler(saveResponse);

  assert.equal(watcher.state.draftArticleId, "7667000000000000002");
  assert.equal(
    watcher.state.draftUrl,
    "https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=7667000000000000002"
  );
  // A save-form endpoint is not a strict mutation, so it must not masquerade as
  // the save-confirmation signal; the endpoint itself is still remembered.
  assert.equal(watcher.state.mutationCount, 0);
  assert.deepEqual(watcher.state.mutationEndpoints, ["https://mp.toutiao.com/mp/agw/article/save"]);
  assert.ok(
    watcher.state.idCandidates.some((candidate) => candidate.key === "pgc_id" && candidate.id === "7665000156680471050")
  );

  // A later id-less autosave ping must not un-identify the draft an earlier
  // response already named.
  const idlessResponse = {
    url: () => "https://mp.toutiao.com/mp/agw/article/draft",
    text: async () => JSON.stringify({ code: 0, data: { pgc_id: "7665000156680471050" } }),
  };
  for (const handler of handlers) await handler(idlessResponse);

  assert.equal(watcher.state.draftArticleId, "7667000000000000002");
  assert.equal(watcher.state.draftUrlAccountOnly, false);
  assert.deepEqual(watcher.state.mutationEndpoints, [
    "https://mp.toutiao.com/mp/agw/article/save",
    "https://mp.toutiao.com/mp/agw/article/draft",
  ]);
  assert.doesNotMatch(JSON.stringify(watcher.state), /captured-token|captured-signature/);
});

test("surfaces the Toutiao toolbar upload failure instead of swallowing it", async () => {
  const events = [];
  const localFile = fileURLToPath(import.meta.url);
  const imageLocator = {
    async count() { return 0; },
    nth() {
      return {
        async getAttribute() { return ""; },
        async evaluate() { return true; },
      };
    },
  };
  const failing = (name) => ({
    first() { return this; },
    last() { return this; },
    async count() { return 1; },
    async isVisible() { return true; },
    async scrollIntoViewIfNeeded() {},
    async waitFor() {},
    async click() { throw new Error(`${name}_click_failed`); },
    async setInputFiles() {},
  });
  const page = {
    locator(selector) {
      if (selector === ".ProseMirror img") return imageLocator;
      // No evaluate on the editor, so the paste fallback cannot dispatch either.
      if (selector.includes("ProseMirror")) {
        return { first: () => ({ async click() { throw new Error("editor_click_failed"); } }) };
      }
      return failing(String(selector).slice(0, 20));
    },
    waitForEvent() { return Promise.resolve(null); },
    async waitForTimeout() {},
  };

  await assert.rejects(
    () => uploadToutiaoInlineImages(page, [{
      assetId: "asset-inline",
      sectionId: "workflow",
      path: localFile,
    }], {
      timeoutMs: 50,
      onProgress: (event) => events.push(event),
    }),
    /TOUTIAO_IMAGE_UPLOAD_FAILED/,
  );

  const fallback = events.find((event) => event.type === "uploading_image_fallback");
  assert.ok(fallback);
  const failed = events.find((event) => event.type === "uploading_image_failed");
  assert.ok(failed);
  assert.match(failed.reason, /click_failed/);
  assert.equal(failed.assetId, "asset-inline");
});

test("falls back to paste with a visible reason when the Toutiao toolbar upload fails", async () => {
  const events = [];
  const images = [];
  const localFile = fileURLToPath(import.meta.url);
  const imageLocator = {
    async count() { return images.length; },
    nth(index) {
      return {
        async getAttribute(name) { return name === "src" ? images[index] : "正文图"; },
        async evaluate() { return true; },
      };
    },
  };
  const failing = (name) => ({
    first() { return this; },
    last() { return this; },
    async count() { return 1; },
    async isVisible() { return true; },
    async scrollIntoViewIfNeeded() {},
    async waitFor() {},
    async click() { throw new Error(`${name}_click_failed`); },
    async setInputFiles() {},
  });
  // positionCursorAfterSection sends {sectionId, sectionTitle}; pasteImageFile
  // sends {base64, ...}, so only the paste inserts the image.
  const editor = {
    async evaluate(_fn, payload) {
      if (payload?.base64) images.push("https://image-tt-private.toutiao.com/body.png");
      return true;
    },
  };
  const page = {
    locator(selector) {
      if (selector === ".ProseMirror img") return imageLocator;
      if (selector.includes("ProseMirror")) return { first: () => editor };
      return failing(String(selector).slice(0, 20));
    },
    waitForEvent() { return Promise.resolve(null); },
    async waitForTimeout() {},
  };

  const uploaded = await uploadToutiaoInlineImages(page, [{
    assetId: "asset-inline",
    sectionId: "workflow",
    path: localFile,
  }], {
    timeoutMs: 2000,
    onProgress: (event) => events.push(event),
  });

  assert.equal(uploaded[0].platformImageUrl, "https://image-tt-private.toutiao.com/body.png");
  const fallback = events.find((event) => event.type === "uploading_image_fallback");
  assert.ok(fallback);
  assert.match(fallback.toolbarFailure, /click_failed/);
  assert.ok(!events.some((event) => event.type === "uploading_image_failed"));
});

// The manage-page lookup reads ids out of live DOM, so the fake page runs the
// real page.evaluate callback against a stubbed document.
const makeToutiaoManageAnchor = (href, rowText) => ({
  getAttribute: (name) => (name === "href" ? href : ""),
  href,
  closest: () => ({ textContent: rowText }),
});

const makeToutiaoManagePage = (anchors) => ({
  async goto() {},
  async waitForLoadState() {},
  async waitForTimeout() {},
  async evaluate(callback, ...args) {
    const previous = globalThis.document;
    globalThis.document = { querySelectorAll: () => anchors };
    try {
      return await callback(...args);
    } finally {
      globalThis.document = previous;
    }
  },
});

test("never reads the Toutiao account pgc id out of the management page", async () => {
  const accountPgcId = "1234567890";
  const articleId = "7667000000000000001";
  const title = toutiaoTitle;

  // The management list links a draft with the account id as often as with an
  // article id, and an account id is not a draft: it reopens a brand new empty
  // article. This lookup used to accept pgc_id alongside the article params.
  const accountOnly = await findToutiaoDraftArticleIdInManagePage(
    makeToutiaoManagePage([
      makeToutiaoManageAnchor(
        `https://mp.toutiao.com/profile_v4/manage/content/all?pgc_id=${accountPgcId}`,
        title,
      ),
    ]),
    title,
    1,
    accountPgcId,
  );
  assert.equal(accountOnly, "");

  // A real edit link still names the article, even next to the account id.
  const scoped = await findToutiaoDraftArticleIdInManagePage(
    makeToutiaoManagePage([
      makeToutiaoManageAnchor(
        `https://mp.toutiao.com/profile_v4/manage/content/all?pgc_id=${accountPgcId}&article_id=${articleId}`,
        title,
      ),
    ]),
    title,
    1,
    accountPgcId,
  );
  assert.equal(scoped, articleId);

  // Without a known account there is nothing to exclude, so a link carrying only
  // the article id still resolves.
  const noAccount = await findToutiaoDraftArticleIdInManagePage(
    makeToutiaoManagePage([
      makeToutiaoManageAnchor(
        `https://mp.toutiao.com/profile_v4/manage/content/all?article_id=${articleId}`,
        title,
      ),
    ]),
    title,
    1,
  );
  assert.equal(noAccount, articleId);
});

test("reports a missing Toutiao draft URL instead of an editor loss when the recorded id names the account", async () => {
  const accountPgcId = "1234567890";
  const accountOnlyUrl = `https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=${accountPgcId}`;
  const report = await verifyToutiaoDraftImages({
    page: makeToutiaoDraftVerifyPage({ editorPresent: true, titleText: "", editorText: "" }, accountOnlyUrl),
    publishInput: toutiaoDraftPublishInput,
    watcher: {
      state: {
        // What the management page used to hand over when its regex accepted
        // pgc_id: the account id recorded as the draft article id, with the
        // account-only flag cleared so the second gate was disarmed too.
        draftArticleId: accountPgcId,
        draftUrl: accountOnlyUrl,
        draftUrlAccountOnly: false,
      },
    },
    draftUrl: accountOnlyUrl,
    accountPgcId,
  });

  // Before the fix this surfaced as editor_lost carrying one bogus ?article_id=
  // candidate, which reads as "the platform dropped our draft" when the truth is
  // that no article id was ever captured at all.
  assert.equal(report.status, "draft_url_missing");
  assert.equal(report.reload.candidates.length, 0);
  assert.equal(report.reload.attempts.length, 0);
  assert.match(report.gap, /never exposed an article-scoped draft URL/);
});


test("public readback rejects an article with its opening intact but its ending missing", async () => {
  const opening = "开头内容".repeat(30);
  const ending = "不可缺少的结尾内容".repeat(12);
  let body = opening;
  const locator = { first() { return this; }, async innerText() { return body; } };
  const page = {
    async goto() {}, async waitForLoadState() {},
    async title() { return "完整文章"; },
    locator() { return locator; },
  };
  const input = { publicUrl: "https://www.toutiao.com/article/1234567890/", title: "完整文章", content: opening + ending };
  assert.equal((await inspectToutiaoPublicArticle(page, input)).found, false);
  body += ending;
  assert.equal((await inspectToutiaoPublicArticle(page, input)).found, true);
});

for (const [reason, count, visible, disabled] of [
  ["NOT_FOUND", 0, false, false],
  ["NOT_VISIBLE", 1, false, false],
  ["DISABLED", 1, true, true],
]) {
  test(`Toutiao reports button ${reason} with bounded safe evidence`, async () => {
    const page = {
      getByRole: () => ({
        count: async () => count, isVisible: async () => visible,
        isDisabled: async () => disabled,
        click: async () => assert.fail("unready button must not be clicked"),
      }),
      waitForTimeout: async () => new Promise(resolve => setTimeout(resolve, 5)),
    };
    await assert.rejects(clickReadyToutiaoButton(page, "确认发布", 2, "TOUTIAO_CONFIRM_PUBLISH_BUTTON_NOT_READY"), error => {
      assert.equal(error.code, `TOUTIAO_CONFIRM_PUBLISH_BUTTON_${reason}`);
      assert.deepEqual(error.buttonState, { count, visible, disabled: visible ? disabled : null });
      return true;
    });
  });
}
