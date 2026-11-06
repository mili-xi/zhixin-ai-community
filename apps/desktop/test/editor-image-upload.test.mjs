import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  pasteRichHtml,
  pasteRichHtmlWithSystemClipboard,
  pasteImageFile,
  positionCursorAfterSection,
  readLocatorImages,
  uploadPlatformImages,
  verifyPublicPageImages,
  verifyPlatformImages,
} from "../src/editor-image-upload.mjs";

test("pastes structured HTML through the real browser clipboard", async () => {
  const actions = [];
  const editor = {
    async click() { actions.push(["click"]); },
  };
  const context = {
    async grantPermissions(permissions, options) {
      actions.push(["grantPermissions", permissions, options]);
    },
  };
  const page = {
    context() { return context; },
    async evaluate(_callback, payload) {
      actions.push(["writeClipboard", payload]);
      return true;
    },
    keyboard: {
      async press(key) { actions.push(["press", key]); },
    },
  };

  const pasted = await pasteRichHtmlWithSystemClipboard(
    page,
    editor,
    "<h2>Workflow</h2><p>Body</p>",
    "Workflow\nBody",
    { origin: "https://www.jianshu.com" },
  );

  assert.equal(pasted, true);
  assert.deepEqual(actions, [
    ["grantPermissions", ["clipboard-read", "clipboard-write"], { origin: "https://www.jianshu.com" }],
    ["writeClipboard", { html: "<h2>Workflow</h2><p>Body</p>", text: "Workflow\nBody" }],
    ["click"],
    ["press", process.platform === "darwin" ? "Meta+V" : "Control+V"],
  ]);
});

test("pastes structured HTML with a plain text fallback", async () => {
  let payload;
  const editor = {
    async evaluate(_callback, value) {
      payload = value;
      return true;
    },
  };

  const pasted = await pasteRichHtml(editor, "<h2>Workflow</h2><p>Body</p>", "Workflow\nBody");

  assert.equal(pasted, true);
  assert.equal(payload.html, "<h2>Workflow</h2><p>Body</p>");
  assert.equal(payload.text, "Workflow\nBody");
});

test("uploads local images sequentially and binds new persistent urls", async () => {
  const observed = [];
  const selected = [];
  const progress = [];
  const tasks = [
    { assetId: "asset-a", sectionId: "a", position: 1, path: "C:/a.png" },
    { assetId: "asset-b", sectionId: "b", position: 3, path: "C:/b.png" },
  ];

  const uploaded = await uploadPlatformImages({
    tasks,
    readImages: async () => [...observed],
    positionForTask: async (task) => selected.push(["position", task.sectionId]),
    selectFile: async (task) => {
      selected.push(["file", task.path]);
      observed.push({ platformImageUrl: `https://cdn.example.com/${task.sectionId}.png`, loaded: true });
    },
    onProgress: (event) => progress.push(event),
  });

  assert.deepEqual(uploaded.map((item) => item.sectionId), ["a", "b"]);
  assert.deepEqual(uploaded.map((item) => item.platformImageUrl), [
    "https://cdn.example.com/a.png",
    "https://cdn.example.com/b.png",
  ]);
  assert.deepEqual(selected, [
    ["position", "a"], ["file", "C:/a.png"],
    ["position", "b"], ["file", "C:/b.png"],
  ]);
  assert.equal(progress.at(-1).completed, 2);
});

test("fails when a native upload never produces a persistent url", async () => {
  await assert.rejects(() => uploadPlatformImages({
    tasks: [{ assetId: "asset-a", sectionId: "a", position: 1, path: "C:/a.png" }],
    readImages: async () => [{ platformImageUrl: "blob:https://editor.example.com/a", loaded: true }],
    selectFile: async () => {},
    timeoutMs: 10,
    pollMs: 1,
  }), /PLATFORM_IMAGE_UPLOAD_TIMEOUT/);
});

test("maps persistent draft or public images to expected task order", async () => {
  const tasks = [
    { assetId: "asset-a", sectionId: "a", position: 1 },
    { assetId: "asset-b", sectionId: "b", position: 3 },
  ];

  const verified = await verifyPlatformImages({
    tasks,
    readImages: async () => [
      { platformImageUrl: "https://cdn.example.com/a.png", loaded: true },
      { platformImageUrl: "https://cdn.example.com/b.png", loaded: true },
    ],
    stage: "draft",
  });

  assert.deepEqual(verified.map((item) => item.assetId), ["asset-a", "asset-b"]);
  assert.deepEqual(verified.map((item) => item.position), [1, 3]);
});

test("waits for delayed draft images before failing verification", async () => {
  let reads = 0;
  const verified = await verifyPlatformImages({
    tasks: [{ assetId: "asset-a", sectionId: "a", position: 1 }],
    readImages: async () => {
      reads += 1;
      return reads < 2 ? [] : [{ platformImageUrl: "https://cdn.example.com/a.png", loaded: true }];
    },
    stage: "draft",
    timeoutMs: 50,
    pollMs: 1,
  });

  assert.equal(verified[0].assetId, "asset-a");
  assert.equal(reads, 2);
});

test("still fails when delayed draft images never appear", async () => {
  await assert.rejects(() => verifyPlatformImages({
    tasks: [{ assetId: "asset-a", sectionId: "a", position: 1 }],
    readImages: async () => [],
    stage: "draft",
    timeoutMs: 5,
    pollMs: 1,
  }), /DRAFT_IMAGE_MISSING/);
});

test("reads image urls and load state from a scoped editor locator", async () => {
  const values = [
    { src: "https://cdn.example.com/a.png", alt: "A", loaded: true },
    { src: "blob:https://example.com/b", alt: "B", loaded: false },
  ];
  const surface = {
    locator() {
      return {
        async count() { return values.length; },
        nth(index) {
          return {
            async getAttribute(name) { return name === "src" ? values[index].src : values[index].alt; },
            async evaluate() { return values[index].loaded; },
          };
        },
      };
    },
  };

  const images = await readLocatorImages(surface, ".editor img");

  assert.equal(images[0].platformImageUrl, "https://cdn.example.com/a.png");
  assert.equal(images[1].loaded, false);
});

test("prefers the browser-resolved currentSrc for protocol-relative editor images", async () => {
  const surface = {
    locator() {
      return {
        async count() { return 1; },
        nth() {
          return {
            async getAttribute(name) {
              return name === "src" ? "//res.mp.sohu.com/article-image" : "Sohu image";
            },
            async evaluate() {
              return {
                currentSrc: "https://res.mp.sohu.com/article-image",
                loaded: true,
              };
            },
          };
        },
      };
    },
  };

  const images = await readLocatorImages(surface, ".ql-editor img");

  assert.equal(images[0].platformImageUrl, "https://res.mp.sohu.com/article-image");
  assert.equal(images[0].loaded, true);
});

test("reads lazy public image urls from data attributes and srcset candidates", async () => {
  const values = [
    {
      src: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
      alt: "lazy",
      currentSrc: "",
      dataSrc: "https://img-blog.csdnimg.cn/public-body.png?x-oss-process=image/resize",
      dataOriginal: "",
      srcset: "",
      loaded: true,
    },
    {
      src: "",
      alt: "srcset",
      currentSrc: "",
      dataSrc: "",
      dataOriginal: "",
      srcset: "https://img-blog.csdnimg.cn/body-small.png 1x, https://img-blog.csdnimg.cn/body-large.png 2x",
      loaded: true,
    },
  ];
  const surface = {
    locator() {
      return {
        async count() { return values.length; },
        nth(index) {
          return {
            async getAttribute(name) {
              const item = values[index];
              if (name === "src") return item.src;
              if (name === "alt") return item.alt;
              if (name === "data-src") return item.dataSrc;
              if (name === "data-original") return item.dataOriginal;
              if (name === "srcset") return item.srcset;
              return "";
            },
            async evaluate() {
              return {
                currentSrc: values[index].currentSrc,
                loaded: values[index].loaded,
              };
            },
          };
        },
      };
    },
  };

  const images = await readLocatorImages(surface, "#content_views img");

  assert.equal(images[0].platformImageUrl, "https://img-blog.csdnimg.cn/public-body.png?x-oss-process=image/resize");
  assert.equal(images[1].platformImageUrl, "https://img-blog.csdnimg.cn/body-large.png");
});

test("positions the browser selection after a matching section", async () => {
  let payload;
  const editor = {
    async evaluate(_callback, value) {
      payload = value;
      return true;
    },
  };

  const positioned = await positionCursorAfterSection(editor, { sectionId: "workflow", sectionTitle: "实施流程" });

  assert.equal(positioned, true);
  assert.deepEqual(payload, { sectionId: "workflow", sectionTitle: "实施流程" });
});

test("pastes a local image through the editor native clipboard handler", async () => {
  let payload;
  const editor = {
    async evaluate(_callback, value) {
      payload = value;
      return true;
    },
  };

  const pasted = await pasteImageFile(editor, fileURLToPath(import.meta.url), "image/png");

  assert.equal(pasted, true);
  assert.equal(payload.mimeType, "image/png");
  assert.ok(payload.base64.length > 20);
});

test("verifies and closes a fresh public article page", async () => {
  let closed = false;
  let waitedForImages = false;
  const surface = {
    locator() {
      return {
        async count() { return 1; },
        nth() {
          return {
            async getAttribute(name) { return name === "src" ? "https://cdn.example.com/a.png" : "A"; },
            async evaluate() { return true; },
          };
        },
      };
    },
    async goto() {},
    async waitForLoadState() {},
    async waitForFunction(_callback, payload) {
      waitedForImages = true;
      assert.equal(payload.expectedCount, 1);
      assert.equal(payload.selector, "article img");
    },
    async close() { closed = true; },
  };
  const context = { async newPage() { return surface; } };

  const publicEvidence = await verifyPublicPageImages(context, "https://example.com/article", [
    { assetId: "asset-a", sectionId: "a", position: 1 },
  ], "article img");

  assert.equal(publicEvidence.blocker, "");
  assert.equal(publicEvidence.images[0].platformImageUrl, "https://cdn.example.com/a.png");
  assert.equal(waitedForImages, true);
  assert.equal(closed, true);
});

// Playwright validates the target when a locator call is dispatched, not when it
// is invoked, so a page closed while the evidence read is still in flight rejects
// that pending call instead of answering it. The closed check therefore sits one
// microtask after `count()` is entered, which is exactly the window a
// `return <promise>` inside `try` loses to the `finally { page.close() }`.
test("finishes reading public image evidence before closing the page", async () => {
  const events = [];
  let closed = false;
  const surface = {
    locator() {
      return {
        async count() {
          await Promise.resolve();
          if (closed) throw new Error("Target page, context or browser has been closed");
          return 1;
        },
        nth() {
          return {
            async getAttribute(name) { return name === "src" ? "https://cdn.example.com/a.png" : "A"; },
            async evaluate() {
              events.push("read");
              return { currentSrc: "https://cdn.example.com/a.png", loaded: true };
            },
          };
        },
      };
    },
    async goto() {},
    async waitForLoadState() {},
    async waitForFunction() {},
    async close() { closed = true; events.push("close"); },
  };
  const context = { async newPage() { return surface; } };

  const publicEvidence = await verifyPublicPageImages(context, "https://example.com/article", [
    { assetId: "asset-a", sectionId: "a", position: 1 },
  ], "article img");

  assert.equal(publicEvidence.blocker, "");
  assert.equal(publicEvidence.images.length, 1);
  assert.equal(publicEvidence.images[0].platformImageUrl, "https://cdn.example.com/a.png");
  // The read has to complete first: a page closed ahead of it turns every locator
  // call into a rejection that readLocatorImages swallows into zero images.
  assert.deepEqual(events, ["read", "close"]);
  // Guard the mock itself, so this case cannot silently stop modelling a real
  // closed page and pass against the broken ordering as well.
  await assert.rejects(() => surface.locator("article img").count(), /has been closed/);
});

test("accepts an image observed by the final timeout snapshot", async () => {
  let reads = 0;
  const image = { src: "https://upload-images.jianshu.io/upload_images/final.png", loaded: true };
  const result = await uploadPlatformImages({
    tasks: [{ assetId: "final" }], timeoutMs: 5, pollMs: 10, onProgress: async () => {},
    selectFile: async () => {},
    readImages: async () => ++reads >= 4 ? [image] : [],
  });
  assert.equal(result[0].platformImageUrl, image.src);
});
