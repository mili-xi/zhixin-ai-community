import assert from "node:assert/strict";
import { test } from "node:test";

import {
  JianshuAdapter,
  JIANSHU_PUBLIC_IMAGE_SELECTOR,
  buildJianshuBodyHtml,
  clickJianshuPublish,
  clearJianshuEditorBody,
  confirmJianshuDialogs,
  ensureJianshuEditableNote,
  fillJianshuBody,
  formatJianshuHeadingParagraphs,
  inspectJianshuPublicArticle,
  jianshuDraftUrlFromNoteId,
  normalizeJianshuPublishedUrl,
  normalizeJianshuSectionHeading,
  positionJianshuNativeCursorAfterSection,
  positionJianshuCursorAfterSection,
  jianshuPayloadRequiresManualAction,
  jianshuPayloadManualActionCode,
  jianshuPublishEndpointIsMutation,
  openJianshuPublishedArticleFromNoteMenu,
  readJianshuPlatformBlocker,
  readJianshuPublishUiState,
  reloadJianshuDraftForVerification,
  uploadJianshuInlineImages,
  waitForJianshuDraftUrl,
  waitForJianshuEditorImages,
} from "../src/adapters/jianshu.mjs";
import { getAdapter } from "../src/adapters/index.mjs";

test("registers Jianshu as a dedicated publishing adapter", () => {
  assert.equal(getAdapter("jianshu").constructor.name, "JianshuAdapter");
});

test("builds Jianshu draft URLs and normalizes public article links", () => {
  assert.equal(
    jianshuDraftUrlFromNoteId("note-123"),
    "https://www.jianshu.com/writer"
  );
  assert.equal(
    jianshuDraftUrlFromNoteId("note-123", "notebook-456"),
    "https://www.jianshu.com/writer#/notebooks/notebook-456/notes/note-123"
  );
  assert.equal(
    normalizeJianshuPublishedUrl("https://www.jianshu.com/p/abcdef123456"),
    "https://www.jianshu.com/p/abcdef123456"
  );
  assert.equal(normalizeJianshuPublishedUrl("https://www.jianshu.com/writer"), "");
});

test("prefers the complete live Jianshu note URL over an inferred draft id", async () => {
  const liveUrl = "https://www.jianshu.com/writer#/notebooks/57148354/notes/140124465";
  const page = {
    url: () => liveUrl,
    async waitForTimeout() {},
  };

  const draftUrl = await waitForJianshuDraftUrl({
    draftId: "140124465",
    draftUrl: "https://www.jianshu.com/writer#/notebooks/140124465",
  }, page, 100, 1);

  assert.equal(draftUrl, liveUrl);
});

test("does not treat ordinary Jianshu article content as a verification blocker", () => {
  assert.equal(
    jianshuPublishEndpointIsMutation("https://www.jianshu.com/author/notes/140124465/content"),
    false,
  );
  assert.equal(
    jianshuPublishEndpointIsMutation("https://www.jianshu.com/author/notes/140124465/publicize"),
    true,
  );
  assert.equal(jianshuPayloadRequiresManualAction({ content: "这篇文章用于验证自动发布闭环。" }), false);
  assert.equal(jianshuPayloadRequiresManualAction({ message: "请完成安全验证后继续发布" }), true);
  assert.equal(
    jianshuPayloadManualActionCode({ error: [{ message: "需要绑定手机号后才能发布文章哟~" }] }),
    "JIANSHU_PHONE_BINDING_REQUIRED",
  );
});

test("ignores blocker words in the Jianshu article body outside visible error surfaces", async () => {
  const articlePage = {
    async evaluate() { return "文章正文讨论违规内容和频繁发布的行业现象。"; },
  };
  const blockedPage = {
    async evaluate() { return ["请完成安全验证后继续发布"]; },
  };
  const phoneBindingPage = {
    async evaluate() { return ["绑定手机 发送验证码 确认"]; },
  };

  assert.equal(await readJianshuPlatformBlocker(articlePage), "");
  assert.equal(await readJianshuPlatformBlocker(blockedPage), "JIANSHU_MANUAL_ACTION_REQUIRED");
  assert.equal(await readJianshuPlatformBlocker(phoneBindingPage), "JIANSHU_PHONE_BINDING_REQUIRED");
});

test("chooses direct publish from the Jianshu two-stage publish menu", async () => {
  const actions = [];
  const create = (name, visible = true) => ({
    first() { return this; },
    async isVisible() { return visible; },
    async isDisabled() { return false; },
    async scrollIntoViewIfNeeded() {},
    async click() { actions.push(name); },
  });
  const page = {
    locator(selector) {
      if (selector === "a[data-action='publicize']") return create("publish-menu");
      if (selector === "li:has(i.fa-share):visible") return create("direct-publish");
      return create("missing", false);
    },
    async waitForTimeout() {},
  };

  await clickJianshuPublish(page, 100);

  assert.deepEqual(actions, ["publish-menu", "direct-publish"]);
});

test("uses the live Jianshu compile action before choosing direct publish", async () => {
  const actions = [];
  const create = (name, visible = true) => ({
    first() { return this; },
    async isVisible() { return visible; },
    async isDisabled() { return false; },
    async scrollIntoViewIfNeeded() {},
    async click() { actions.push(name); },
  });
  const page = {
    locator(selector) {
      if (selector === "a[data-action='compile']") return create("compile");
      if (selector === "li:has(i.fa-share):visible") return create("direct-publish");
      return create("missing", false);
    },
    async waitForTimeout() {},
  };

  await clickJianshuPublish(page, 100);

  assert.deepEqual(actions, ["compile", "direct-publish"]);
});

test("continues to the Jianshu publicize action when compile does not expose direct publish", async () => {
  const actions = [];
  const create = (name, visible = true) => ({
    first() { return this; },
    async isVisible() { return visible; },
    async isDisabled() { return false; },
    async scrollIntoViewIfNeeded() {},
    async click() { actions.push(name); },
  });
  const page = {
    locator(selector) {
      if (selector === "a[data-action='compile']") return create("compile");
      if (selector === "a[data-action='publicize']") return create("publicize");
      if (selector === "li:has(i.fa-share):visible") return create("direct-publish", false);
      return create("missing", false);
    },
    async waitForTimeout() {},
  };

  await clickJianshuPublish(page, 100);

  assert.deepEqual(actions, ["compile", "publicize"]);
});

test("confirms Jianshu publish dialogs rendered as links or role buttons", async () => {
  const actions = [];
  const visibility = new Map([
    ["a:has-text('确认发布')", true],
    ["[role='button']:has-text('确认发布')", false],
  ]);
  const create = (selector, name) => ({
    first() { return this; },
    async isVisible() { return visibility.get(selector) === true; },
    async isDisabled() { return false; },
    async click() {
      actions.push(name);
      visibility.set(selector, false);
    },
  });
  const page = {
    locator(selector) {
      if (selector === "a:has-text('确认发布')") return create(selector, "confirm-link");
      if (selector === "[role='button']:has-text('确认发布')") return create(selector, "confirm-role");
      return {
        first() { return this; },
        async isVisible() { return false; },
        async isDisabled() { return false; },
        async click() {},
      };
    },
    async waitForTimeout() {},
  };

  await confirmJianshuDialogs(page);

  assert.deepEqual(actions, ["confirm-link"]);
});

test("confirms real Chinese Jianshu publish dialogs", async () => {
  const actions = [];
  const visibleSelectors = new Set(["button:has-text('确认发布')"]);
  const page = {
    locator(selector) {
      return {
        first() { return this; },
        async isVisible() { return visibleSelectors.has(selector); },
        async isDisabled() { return false; },
        async click() {
          actions.push(selector);
          visibleSelectors.delete(selector);
        },
      };
    },
    async waitForTimeout() {},
  };

  await confirmJianshuDialogs(page);

  assert.deepEqual(actions, ["button:has-text('确认发布')"]);
});

test("reads visible Jianshu publish controls for failure diagnostics", async () => {
  const page = {
    url() { return "https://www.jianshu.com/writer#/notebooks/n/notes/m"; },
    async title() { return "简书 - 写文章"; },
    async evaluate(callback) {
      const makeElement = (tagName, textContent, attrs = {}, visible = true) => ({
        tagName,
        textContent,
        getAttribute(name) { return attrs[name] || ""; },
        getBoundingClientRect() {
          return visible ? { width: 80, height: 32 } : { width: 0, height: 0 };
        },
      });
      const previousDocument = globalThis.document;
      const previousGetComputedStyle = globalThis.getComputedStyle;
      globalThis.document = {
        body: { innerText: "发布文章 保存成功" },
        querySelectorAll(selector) {
          if (selector.includes("button")) {
            return [
              makeElement("A", "发布文章", { "data-action": "publicize" }),
              makeElement("LI", "直接发布", {}),
              makeElement("BUTTON", "隐藏按钮", {}, false),
            ];
          }
          return [];
        },
      };
      globalThis.getComputedStyle = (element) => ({
        display: element.getBoundingClientRect().width ? "block" : "none",
        visibility: "visible",
      });
      try {
        return callback();
      } finally {
        globalThis.document = previousDocument;
        globalThis.getComputedStyle = previousGetComputedStyle;
      }
    },
  };

  const state = await readJianshuPublishUiState(page);

  assert.equal(state.url.includes("/writer#"), true);
  assert.deepEqual(state.controls.map((item) => item.text), ["发布文章", "直接发布"]);
  assert.equal(state.controls[0].dataAction, "publicize");
});

test("opens an already-published Jianshu note from the note menu to recover its public URL", async () => {
  const clicks = [];
  let evaluateCount = 0;
  const page = {
    async evaluate() {
      evaluateCount += 1;
      if (evaluateCount === 1) return true;
      return { x: 395, y: 333, width: 145, height: 40 };
    },
    mouse: {
      async click(x, y) { clicks.push([x, y]); },
    },
    async waitForTimeout() {},
    async waitForEvent(eventName) {
      assert.equal(eventName, "popup");
      return {
        async waitForLoadState() {},
        url() { return "https://www.jianshu.com/p/3d628c37f59b?v=1785000365940"; },
      };
    },
    url() { return "https://www.jianshu.com/writer#/notebooks/57148354/notes/140124465"; },
  };

  const url = await openJianshuPublishedArticleFromNoteMenu(page, "2025年最火大模型速览：从零上手全能AI指南", 1000);

  assert.equal(url, "https://www.jianshu.com/p/3d628c37f59b?v=1785000365940");
  assert.deepEqual(clicks, [[467.5, 353]]);
});

test("falls back to the visible Jianshu note-menu row when DOM text resolves to the whole note item", async () => {
  const clicks = [];
  let evaluateCount = 0;
  let popupResolver = null;
  const page = {
    async evaluate() {
      evaluateCount += 1;
      if (evaluateCount === 1) {
        return {
          opened: true,
          gearBox: { x: 516, y: 97, width: 14, height: 16 },
        };
      }
      return {
        x: 228,
        y: 61,
        width: 325,
        height: 90,
        text: "已发布设置发布样式置顶文章分享文章移动文章在新窗口打开设为私密",
      };
    },
    mouse: {
      async move() {},
      async click(x, y) {
        clicks.push([x, y]);
        const isFallbackMenuRow = x > 430 && x < 540 && y > 330 && y < 370;
        if (popupResolver) {
          popupResolver(isFallbackMenuRow
            ? {
                async waitForLoadState() {},
                url() { return "https://www.jianshu.com/p/3d628c37f59b?v=1785001303332"; },
              }
            : null);
          popupResolver = null;
        }
      },
    },
    async waitForTimeout() {},
    async waitForEvent(eventName) {
      assert.equal(eventName, "popup");
      return new Promise((resolve) => {
        popupResolver = resolve;
      });
    },
    url() { return "https://www.jianshu.com/writer#/notebooks/57148354/notes/140124465"; },
  };

  const url = await openJianshuPublishedArticleFromNoteMenu(page, "2025年最火大模型速览：从零上手全能AI指南", 1000);

  assert.equal(url, "https://www.jianshu.com/p/3d628c37f59b?v=1785001303332");
  assert.deepEqual(clicks, [[481, 352]]);
});

test("positions a Jianshu image after the matching Markdown-style section body", async () => {
  const nodes = [
    { tagName: "P", textContent: "## Introduction" },
    { tagName: "P", textContent: "First paragraph" },
    { tagName: "P", textContent: "Second paragraph" },
    { tagName: "P", textContent: "## Next section" },
    { tagName: "P", textContent: "Next paragraph" },
  ];
  let selectedTarget = null;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = {
    getSelection() {
      return { removeAllRanges() {}, addRange() {} };
    },
  };
  globalThis.document = {
    createRange() {
      return {
        selectNodeContents(target) { selectedTarget = target; },
        collapse() {},
      };
    },
  };
  const editor = {
    children: nodes,
    lastElementChild: nodes.at(-1),
    focus() {},
  };
  const editorLocator = {
    async evaluate(callback, payload) { return callback(editor, payload); },
  };

  try {
    const positioned = await positionJianshuCursorAfterSection(editorLocator, {
      sectionTitle: "Introduction",
    });
    assert.equal(positioned, true);
    assert.equal(selectedTarget, nodes[2]);
    assert.equal(normalizeJianshuSectionHeading("  ## Introduction  "), "Introduction");
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});

test("rejects a named Jianshu section when the heading cannot be matched", async () => {
  const nodes = [
    { tagName: "P", textContent: "## Introduction" },
    { tagName: "P", textContent: "First paragraph" },
    { tagName: "P", textContent: "Final paragraph" },
  ];
  let selectedTarget = null;
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = {
    getSelection() {
      return { removeAllRanges() {}, addRange() {} };
    },
  };
  globalThis.document = {
    createRange() {
      return {
        selectNodeContents(target) { selectedTarget = target; },
        collapse() {},
      };
    },
  };
  const editor = {
    children: nodes,
    lastElementChild: nodes.at(-1),
    focus() {},
  };
  const editorLocator = {
    async evaluate(callback, payload) { return callback(editor, payload); },
  };

  try {
    const positioned = await positionJianshuCursorAfterSection(editorLocator, {
      sectionTitle: "Missing section",
    });
    assert.equal(positioned, false);
    assert.equal(selectedTarget, null);
  } finally {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});

test("positions the native Jianshu cursor with a real click at the end of the matched section", async () => {
  const actions = [];
  const targetBlock = {
    async scrollIntoViewIfNeeded() { actions.push("scroll"); },
    async boundingBox() {
      actions.push("box");
      return { x: 20, y: 30, width: 400, height: 80 };
    },
    async click(options) { actions.push(["click", options]); },
  };
  let evaluation = 0;
  const editor = {
    async evaluate() {
      evaluation += 1;
      if (evaluation === 1) {
        return { targetIndex: 2, headingIndex: 0, nextHeadingIndex: 3 };
      }
      return true;
    },
    locator(selector) {
      assert.equal(selector, ":scope > *");
      return {
        nth(index) {
          assert.equal(index, 2);
          return targetBlock;
        },
      };
    },
  };
  const page = {
    keyboard: {
      async press(key) { actions.push(["press", key]); },
    },
  };

  const positioned = await positionJianshuNativeCursorAfterSection(page, editor, {
    sectionId: "intro",
    sectionTitle: "Introduction",
  });

  assert.equal(positioned, true);
  assert.deepEqual(actions, [
    "scroll",
    "box",
    ["click", { position: { x: 396, y: 40 } }],
    ["press", "End"],
  ]);
});

test("positions the native Jianshu cursor inside an API section wrapper", async () => {
  const actions = [];
  const heading = { tagName: "H2", textContent: "API Closure", children: [] };
  const paragraph = {
    tagName: "P",
    textContent: "The API draft body is hydrated.",
    children: [],
  };
  const section = {
    tagName: "SECTION",
    textContent: `${heading.textContent}${paragraph.textContent}`,
    children: [heading, paragraph],
  };
  const editorNode = {
    children: [section],
    querySelectorAll(selector) {
      assert.equal(selector, "h1, h2, h3, h4, h5, h6");
      return [heading];
    },
  };
  heading.parentElement = section;
  paragraph.parentElement = section;
  section.parentElement = editorNode;

  const locatorFor = (node) => ({
    locator(selector) {
      assert.equal(selector, ":scope > *");
      return {
        nth(index) {
          assert.ok(node.children[index]);
          return locatorFor(node.children[index]);
        },
      };
    },
    async scrollIntoViewIfNeeded() {
      if (node === paragraph) actions.push("scroll");
    },
    async boundingBox() {
      return node === paragraph ? { x: 20, y: 30, width: 400, height: 80 } : null;
    },
    async click(options) {
      if (node === paragraph) actions.push(["click", options]);
    },
  });
  let evaluation = 0;
  const editor = {
    ...locatorFor(editorNode),
    async evaluate(callback, payload) {
      evaluation += 1;
      return evaluation === 1 ? callback(editorNode, payload) : true;
    },
  };
  const page = {
    keyboard: {
      async press(key) { actions.push(["press", key]); },
    },
  };

  const positioned = await positionJianshuNativeCursorAfterSection(page, editor, {
    sectionId: "api-closure",
    sectionTitle: "API Closure",
  });

  assert.equal(positioned, true);
  assert.deepEqual(actions, [
    "scroll",
    ["click", { position: { x: 396, y: 40 } }],
    ["press", "End"],
  ]);
});

test("rejects native Jianshu cursor positioning when the target block has no layout box", async () => {
  let clicked = false;
  const editor = {
    async evaluate() { return { targetIndex: 1, headingIndex: 0, nextHeadingIndex: 2 }; },
    locator() {
      return {
        nth() {
          return {
            async scrollIntoViewIfNeeded() {},
            async boundingBox() { return null; },
            async click() { clicked = true; },
          };
        },
      };
    },
  };

  const positioned = await positionJianshuNativeCursorAfterSection({ keyboard: { async press() {} } }, editor, {
    sectionTitle: "Introduction",
  });

  assert.equal(positioned, false);
  assert.equal(clicked, false);
});

test("waits for Jianshu draft URL and asynchronous editor images", async () => {
  const state = { draftId: "", draftUrl: "" };
  let waits = 0;
  const image = {
    async getAttribute(name) {
      return name === "src" ? "https://upload-images.jianshu.io/draft-inline.png" : "draft image";
    },
    async evaluate() { return true; },
  };
  const page = {
    url: () => "https://www.jianshu.com/writer",
    async waitForTimeout() {
      waits += 1;
      if (waits === 2) {
        state.draftId = "note-123";
        state.draftUrl = "https://www.jianshu.com/writer#/notebooks/notebook-456/notes/note-123";
      }
    },
    locator() {
      return {
        async count() { return waits >= 3 ? 1 : 0; },
        nth() { return image; },
      };
    },
  };

  const draftUrl = await waitForJianshuDraftUrl(state, page, 100, 1);
  const images = await waitForJianshuEditorImages(page, 1, 100, 1);
  assert.equal(draftUrl, state.draftUrl);
  assert.equal(images[0].platformImageUrl, "https://upload-images.jianshu.io/draft-inline.png");
});

test("waits for the Jianshu API draft editor body to hydrate after reload", async () => {
  const actions = [];
  let bodyReads = 0;
  const editor = {
    async isVisible() { return true; },
    async evaluate() {
      bodyReads += 1;
      return bodyReads < 2
        ? { text: "", headings: [] }
        : { text: "Workflow\nA hydrated paragraph.", headings: ["Workflow"] };
    },
  };
  const page = {
    url: () => "https://www.jianshu.com/writer#/notebooks/notebook-456/notes/note-123",
    async reload() { actions.push("reload"); },
    async waitForLoadState() { actions.push("load"); },
    async waitForTimeout() { actions.push("wait"); },
    locator(selector) {
      assert.equal(selector, ".kalamu-area[contenteditable='true'], .kalamu-area");
      return { first() { return editor; } };
    },
  };

  const hydrated = await reloadJianshuDraftForVerification(
    page,
    "https://www.jianshu.com/writer#/notebooks/notebook-456/notes/note-123",
    { text: "Workflow\nA hydrated paragraph.", headings: ["Workflow"] },
    { timeoutMs: 100, pollMs: 1 },
  );

  assert.equal(hydrated, editor);
  assert.deepEqual(actions, ["reload", "load", "wait"]);
  assert.equal(bodyReads, 2);
});

test("keeps the current Jianshu note when its title editor is already mounted", async () => {
  const actions = [];
  const create = (name, visible = true) => ({
    first() { return this; },
    async isVisible() { return visible; },
    async click() { actions.push(name); },
  });
  const page = {
    locator(selector) {
      if (selector.includes("input._24i7u")) return create("title");
      if (selector.includes("无标题文章")) return create("existing-note");
      if (selector.includes("新建文章")) return create("create-note");
      return create("missing", false);
    },
    async waitForTimeout() {},
    async waitForSelector() {},
  };

  await ensureJianshuEditableNote(page);

  assert.deepEqual(actions, []);
});

test("writes Jianshu body through the real browser clipboard", async () => {
  const actions = [];
  let editorText = "";
  const editor = {
    first() { return this; },
    async isVisible() { return true; },
    async click() { actions.push("click"); },
    async press(key) { actions.push(key); },
    async evaluate() {
      actions.push("readState");
      return { text: editorText, headings: [] };
    },
    async innerText() { return editorText; },
  };
  const context = {
    async grantPermissions() { actions.push("grantPermissions"); },
  };
  const page = {
    context() { return context; },
    locator(selector) {
      if (selector.includes("kalamu-area")) return editor;
      return { first() { return this; }, async isVisible() { return false; } };
    },
    async evaluate(_callback, payload) {
      actions.push("writeClipboard");
      editorText = payload.text;
      return true;
    },
    keyboard: {
      async press(key) { actions.push(key); },
    },
    async waitForTimeout() {},
  };

  await fillJianshuBody(page, "Jianshu Kalamu native paste body");

  assert.deepEqual(actions, [
    "click",
    "Control+A",
    "readState",
    "Backspace",
    "readState",
    "grantPermissions",
    "writeClipboard",
    "click",
    process.platform === "darwin" ? "Meta+V" : "Control+V",
    "readState",
  ]);
});

test("clears the complete Jianshu body from a text block so atomic images are selected", async () => {
  const actions = [];
  let evaluateCount = 0;
  const textBlock = {
    first() { return this; },
    async isVisible() { return true; },
    async click() { actions.push("text.click"); },
  };
  const editor = {
    locator(selector) {
      actions.push(`locator:${selector}`);
      return textBlock;
    },
    async evaluate() {
      evaluateCount += 1;
      actions.push(`evaluate:${evaluateCount}`);
      if (evaluateCount === 1) {
        return { imageCount: 3, selectedImageCount: 3, selectedTextLength: 120 };
      }
      return { imageCount: 0, text: "" };
    },
  };
  const page = {
    keyboard: {
      async press(key) { actions.push(`keyboard:${key}`); },
    },
    async waitForTimeout(ms) { actions.push(`wait:${ms}`); },
  };

  await clearJianshuEditorBody(page, editor);

  assert.equal(actions[0].startsWith("locator:"), true);
  assert.deepEqual(actions.slice(1), [
    "text.click",
    "keyboard:Control+A",
    "evaluate:1",
    "keyboard:Backspace",
    "wait:100",
    "evaluate:2",
  ]);
});

test("refuses to downgrade a structured Jianshu article when rich paste fails", async () => {
  let evaluateCount = 0;
  const editor = {
    first() { return this; },
    async isVisible() { return true; },
    async click() {},
    async press() {},
    async evaluate() {
      evaluateCount += 1;
      if (evaluateCount === 1 || evaluateCount === 4) {
        return { imageCount: 0, selectedImageCount: 0, selectedTextLength: 20, textLength: 20 };
      }
      if (evaluateCount === 2 || evaluateCount === 5) return { imageCount: 0, text: "" };
      return false;
    },
    async innerText() { return ""; },
  };
  const paragraphCollection = {
    filter() {
      return {
        async count() { return 0; },
        nth() { throw new Error("unexpected paragraph lookup"); },
      };
    },
  };
  const page = {
    locator(selector) {
      if (selector === ".kalamu-area > p, .kalamu-area > div") return paragraphCollection;
      if (String(selector).includes("kalamu-area")) return editor;
      return {
        first() { return this; },
        async isVisible() { return false; },
      };
    },
    async evaluate() { return true; },
    async waitForTimeout() {},
  };

  await assert.rejects(
    fillJianshuBody(page, {
      contentMarkdown: "## Workflow\n\nA structured paragraph.",
      contentBlocks: [
        { type: "section", sectionId: "workflow", title: "Workflow", content: "A structured paragraph." },
        { type: "image", sectionId: "workflow", assetId: "asset-workflow" },
      ],
    }),
    /JIANSHU_RICH_BODY_SYNC_FAILED/,
  );
});

test("formats each exact Jianshu section paragraph through the native H2 menu", async () => {
  const actions = [];
  const headings = ["First section", "Second section"];
  const formatted = [];
  let selectedHeading = "";
  const editor = {
    async evaluate() {
      return { text: headings.join(" "), headings: [...formatted] };
    },
  };
  const paragraphCollection = {
    filter({ hasText }) {
      return {
        async count() { return headings.includes(hasText) ? 1 : 0; },
        nth() {
          return {
            async innerText() { return hasText; },
            async click() {
              selectedHeading = hasText;
              actions.push(`paragraph.click:${hasText}`);
            },
          };
        },
      };
    },
  };
  const headingMenu = {
    first() { return this; },
    async hover() { actions.push("heading.hover"); },
  };
  const headingAction = {
    first() { return this; },
    async isVisible() { return true; },
    async click() {
      formatted.push(selectedHeading);
      actions.push(`heading.click:${selectedHeading}`);
    },
  };
  const page = {
    locator(selector) {
      if (selector === ".kalamu-area > p, .kalamu-area > div") return paragraphCollection;
      if (String(selector).includes("li[data-index='2']")) return headingMenu;
      if (String(selector).includes("insertTitle")) return headingAction;
      throw new Error(`Unexpected selector: ${selector}`);
    },
    async waitForTimeout() {},
  };

  const result = await formatJianshuHeadingParagraphs(page, editor, headings);

  assert.equal(result, true);
  assert.deepEqual(formatted, headings);
  assert.deepEqual(actions, [
    "paragraph.click:First section",
    "heading.hover",
    "heading.click:First section",
    "paragraph.click:Second section",
    "heading.hover",
    "heading.click:Second section",
  ]);
});

test("formats Jianshu section headings when the editor emits direct div blocks", async () => {
  const formatted = ["First section"];
  let selectedHeading = "";
  const editor = {
    async evaluate() {
      return {
        text: "First section First body Second section Second body",
        headings: [...formatted],
      };
    },
  };
  const blockCollection = {
    filter({ hasText }) {
      return {
        async count() { return hasText === "Second section" ? 1 : 0; },
        nth() {
          return {
            async innerText() { return hasText; },
            async click() { selectedHeading = hasText; },
          };
        },
      };
    },
  };
  const page = {
    locator(selector) {
      if (selector === ".kalamu-area > p, .kalamu-area > div") return blockCollection;
      if (String(selector).includes("li[data-index='2']")) {
        return { first() { return this; }, async hover() {} };
      }
      if (String(selector).includes("insertTitle")) {
        return {
          first() { return this; },
          async isVisible() { return true; },
          async click() { formatted.push(selectedHeading); },
        };
      }
      return {
        filter() {
          return { async count() { return 0; }, nth() { throw new Error("unexpected block lookup"); } };
        },
      };
    },
    async waitForTimeout() {},
  };

  const result = await formatJianshuHeadingParagraphs(page, editor, ["First section", "Second section"]);

  assert.equal(result, true);
  assert.deepEqual(formatted, ["First section", "Second section"]);
});

test("waits for delayed Jianshu blocks before applying native heading format", async () => {
  const formatted = ["First section"];
  let selectedHeading = "";
  let lookupCount = 0;
  const editor = {
    async evaluate() {
      return {
        text: "First section First body Second section Second body",
        headings: [...formatted],
      };
    },
  };
  const blockCollection = {
    filter({ hasText }) {
      return {
        async count() {
          lookupCount += 1;
          return lookupCount >= 3 && hasText === "Second section" ? 1 : 0;
        },
        nth() {
          return {
            async innerText() { return hasText; },
            async click() { selectedHeading = hasText; },
          };
        },
      };
    },
  };
  const page = {
    locator(selector) {
      if (selector === ".kalamu-area > p, .kalamu-area > div") return blockCollection;
      if (String(selector).includes("li[data-index='2']")) {
        return { first() { return this; }, async hover() {} };
      }
      if (String(selector).includes("insertTitle")) {
        return {
          first() { return this; },
          async isVisible() { return true; },
          async click() { formatted.push(selectedHeading); },
        };
      }
      throw new Error(`Unexpected selector: ${selector}`);
    },
    async waitForTimeout() {},
  };

  const result = await formatJianshuHeadingParagraphs(page, editor, ["First section", "Second section"]);

  assert.equal(result, true);
  assert.ok(lookupCount >= 3);
  assert.deepEqual(formatted, ["First section", "Second section"]);
});

test("retries the native Jianshu heading action when the first click is ignored", async () => {
  const formatted = ["First section"];
  let selectedHeading = "";
  let actionClicks = 0;
  const editor = {
    async evaluate() {
      return {
        text: "First section First body Second section Second body",
        headings: [...formatted],
      };
    },
  };
  const blockCollection = {
    filter({ hasText }) {
      return {
        async count() { return hasText === "Second section" ? 1 : 0; },
        nth() {
          return {
            async innerText() { return hasText; },
            async click() { selectedHeading = hasText; },
          };
        },
      };
    },
  };
  const page = {
    locator(selector) {
      if (selector === ".kalamu-area > p, .kalamu-area > div") return blockCollection;
      if (String(selector).includes("li[data-index='2']")) {
        return { first() { return this; }, async hover() {} };
      }
      if (String(selector).includes("insertTitle")) {
        return {
          first() { return this; },
          async isVisible() { return true; },
          async click() {
            actionClicks += 1;
            if (actionClicks >= 2) formatted.push(selectedHeading);
          },
        };
      }
      throw new Error(`Unexpected selector: ${selector}`);
    },
    async waitForTimeout() {},
  };

  const result = await formatJianshuHeadingParagraphs(page, editor, ["First section", "Second section"]);

  assert.equal(result, true);
  assert.equal(actionClicks, 2);
  assert.deepEqual(formatted, ["First section", "Second section"]);
});

test("uses the native Jianshu heading toolbar when rich paste strips section structure", async () => {
  const actions = [];
  const headings = ["First section", "Second section"];
  const formatted = [];
  let selectedHeading = "";
  let evaluateCount = 0;
  const editor = {
    first() { return this; },
    async isVisible() { return true; },
    async click() { actions.push("editor.click"); },
    async press(key) { actions.push(`editor.press:${key}`); },
    async evaluate() {
      evaluateCount += 1;
      if (evaluateCount === 1 || evaluateCount === 4) {
        return { imageCount: 0, selectedImageCount: 0, selectedTextLength: 48, textLength: 48 };
      }
      if (evaluateCount === 2 || evaluateCount === 5) return { imageCount: 0, text: "" };
      return {
        text: "First section First body Second section Second body",
        headings: [...formatted],
      };
    },
  };
  const paragraphCollection = {
    filter({ hasText }) {
      return {
        async count() { return headings.includes(hasText) ? 1 : 0; },
        nth() {
          return {
            async innerText() { return hasText; },
            async click() {
              selectedHeading = hasText;
              actions.push(`paragraph.click:${hasText}`);
            },
          };
        },
      };
    },
  };
  const headingMenu = {
    first() { return this; },
    async hover() { actions.push("heading.hover"); },
  };
  const headingAction = {
    first() { return this; },
    async isVisible() { return true; },
    async click() {
      formatted.push(selectedHeading);
      actions.push("heading.click");
    },
  };
  const page = {
    context() {
      return { async grantPermissions() { actions.push("clipboard.grant"); } };
    },
    locator(selector) {
      if (selector === ".kalamu-area > p, .kalamu-area > div") return paragraphCollection;
      if (String(selector).includes("kalamu-area")) return editor;
      if (String(selector).includes("li[data-index='2']")) return headingMenu;
      if (String(selector).includes("insertTitle")) return headingAction;
      return { first() { return this; }, async isVisible() { return false; } };
    },
    async evaluate() { actions.push("clipboard.write"); return true; },
    keyboard: {
      async press(key) { actions.push(`keyboard.press:${key}`); },
      async insertText(text) { actions.push(`keyboard.text:${text}`); },
    },
    async waitForTimeout() {},
  };

  await fillJianshuBody(page, {
    contentMarkdown: "## First section\n\nFirst body\n\n## Second section\n\nSecond body",
    contentBlocks: [
      { type: "section", sectionId: "first", title: "First section", content: "First body" },
      { type: "section", sectionId: "second", title: "Second section", content: "Second body" },
    ],
  });

  assert.equal(actions.filter((action) => action === "heading.click").length, 2);
  assert.deepEqual(actions.filter((action) => action.startsWith("keyboard.text:")), [
    "keyboard.text:First section",
    "keyboard.text:First body",
    "keyboard.text:Second section",
    "keyboard.text:Second body",
  ]);
});
test("reloads a stable Jianshu draft and rejects lost heading structure", async () => {
  const actions = [];
  const editor = {
    first() { return this; },
    async isVisible() { return true; },
    async evaluate() {
      return { text: "First section First body", headings: [] };
    },
  };
  const page = {
    url() { return "https://www.jianshu.com/writer#/notebooks/notebook-1/notes/note-1"; },
    async goto(url) { actions.push(["goto", url]); },
    async reload(options) { actions.push(["reload", options?.waitUntil || ""]); },
    async waitForLoadState(state) { actions.push(["load", state]); },
    async waitForTimeout(ms) { actions.push(["wait", ms]); },
    locator(selector) {
      assert.match(String(selector), /kalamu-area/);
      return editor;
    },
  };
  const body = buildJianshuBodyHtml({
    contentBlocks: [
      { type: "section", sectionId: "first", title: "First section", content: "First body" },
    ],
  });

  await assert.rejects(
    reloadJianshuDraftForVerification(
      page,
      "https://www.jianshu.com/writer#/notebooks/notebook-1/notes/note-1",
      body,
      { timeoutMs: 10, pollMs: 1 },
    ),
    /JIANSHU_RICH_BODY_RELOAD_FAILED/,
  );
  assert.deepEqual(actions.slice(0, 2), [
    ["reload", "domcontentloaded"],
    ["load", "networkidle"],
  ]);
});

 test("waits for the real Jianshu draft mutation before reloading", async () => {
  const module = await import("../src/adapters/jianshu.mjs");
  assert.equal(typeof module.saveJianshuDraftAndWait, "function");
  const actions = [];
  const response = {
    url() { return "https://www.jianshu.com/author/notes/note-1"; },
    status() { return 200; },
    request() { return { method() { return "PUT"; } }; },
  };
  const page = {
    keyboard: { async press(key) { actions.push(["press", key]); } },
    async waitForResponse(predicate, options) {
      actions.push(["wait-response", options?.timeout || 0]);
      assert.equal(predicate(response), true);
      return response;
    },
    async waitForTimeout() {},
  };

  await module.saveJianshuDraftAndWait(page, 1234);

  assert.deepEqual(actions, [
    ["wait-response", 1234],
    ["press", "Control+s"],
  ]);
});

 test("binds Jianshu draft images only to their actual section", async () => {
  const module = await import("../src/adapters/jianshu.mjs");
  assert.equal(typeof module.bindJianshuSectionImages, "function");
  const tasks = [
    { assetId: "asset-first", sectionId: "first", sectionTitle: "First section", position: 2 },
    { assetId: "asset-second", sectionId: "second", sectionTitle: "Second section", position: 4 },
  ];
  const observed = [
    { sectionTitle: "First section", platformImageUrl: "https://upload-images.jianshu.io/upload_images/first.png", loaded: true },
    { sectionTitle: "Last section", platformImageUrl: "https://upload-images.jianshu.io/upload_images/grouped.png", loaded: true },
  ];

  assert.deepEqual(module.bindJianshuSectionImages(tasks, observed), [{
    assetId: "asset-first",
    sectionId: "first",
    position: 2,
    platformImageId: "",
    platformImageUrl: "https://upload-images.jianshu.io/upload_images/first.png",
    loaded: true,
  }]);
});

 test("does not open the Jianshu image picker when section positioning fails", async () => {
  let pickerOpened = false;
  const editor = {
    first() { return this; },
    async evaluate() { return false; },
  };
  const page = {
    async waitForFunction() {},
    async waitForTimeout() {},
    locator(selector) {
      if (selector.includes(".kalamu-area")) return editor;
      return {
        first() { return this; },
        async click() { pickerOpened = true; },
        async setInputFiles() { pickerOpened = true; },
        async count() { return 0; },
      };
    },
  };

  await assert.rejects(
    uploadJianshuInlineImages(page, [{
      assetId: "asset-inline",
      sectionId: "missing",
      sectionTitle: "Missing section",
      position: 2,
      path: "C:\\temp\\inline.png",
    }], { timeoutMs: 10 }),
    /JIANSHU_SECTION_POSITION_FAILED/,
  );
  assert.equal(pickerOpened, false);
});
test("waits for the Jianshu body draft to save before uploading the first image", async () => {
  const actions = [];
  const images = [];
  let draftSaved = false;
  const imageLocator = {
    async count() { return images.length; },
    nth(index) {
      return {
        async getAttribute(name) {
          if (name === "src") return images[index]?.src || "";
          if (name === "alt") return "section image";
          return "";
        },
        async evaluate() { return true; },
      };
    },
  };
  let cursorEvaluation = 0;
  const editor = {
    first() { return editor; },
    async evaluate() {
      cursorEvaluation += 1;
      return cursorEvaluation === 1
        ? { targetIndex: 1, headingIndex: 0, nextHeadingIndex: 2 }
        : true;
    },
    locator(selector) {
      assert.equal(selector, ":scope > *");
      return {
        nth(index) {
          assert.equal(index, 1);
          return {
            async scrollIntoViewIfNeeded() { actions.push("scroll-section"); },
            async boundingBox() { return { x: 0, y: 0, width: 320, height: 60 }; },
            async click() { actions.push("click-section"); },
          };
        },
      };
    },
  };
  const createActionLocator = (name) => ({
    first() { return this; },
    async click() { actions.push(name); },
    async setInputFiles() {
      actions.push("upload");
      if (draftSaved) {
        images.push({ src: "https://upload-images.jianshu.io/upload_images/31306077-inline.png?imageMogr2/auto-orient" });
      }
    },
  });
  const page = {
    keyboard: {
      async press(key) { actions.push(`keyboard:${key}`); },
    },
    async waitForFunction() {
      actions.push("wait-saved");
      draftSaved = true;
    },
    async waitForTimeout(ms) { actions.push(`wait:${ms}`); },
    locator(selector) {
      if (selector === ".kalamu-area img") return imageLocator;
      if (selector.includes(".kalamu-area")) return editor;
      if (selector === "a[data-action='openImageModal']") return createActionLocator("open-image");
      if (selector === "#kalamu-upload-image[type='file']") return createActionLocator("file-input");
      return createActionLocator(`other:${selector}`);
    },
  };

  const uploaded = await uploadJianshuInlineImages(page, [{
    assetId: "asset-inline",
    sectionId: "intro",
    sectionTitle: "Introduction",
    position: 2,
    path: "C:\\temp\\inline.png",
  }], { timeoutMs: 10, imageSettleMs: 25 });

  assert.equal(uploaded[0].platformImageUrl, images[0].src);
  assert.ok(actions.indexOf("wait-saved") < actions.indexOf("upload"));
  assert.ok(actions.lastIndexOf("wait:25") > actions.indexOf("upload"));
});

test("builds section-aware Jianshu HTML without embedding local or Markdown images", () => {
  const body = buildJianshuBodyHtml({
    content: "First section\n\n![legacy image](/uploads/legacy.png)\n\nSecond section",
    contentBlocks: [
      { type: "title", content: "Title" },
      { type: "section", sectionId: "intro", title: "Introduction", content: "First paragraph" },
      { type: "image", sectionId: "intro", dataUrl: "data:image/png;base64,abc", altText: "Intro image" },
      { type: "section", sectionId: "steps", title: "Steps", content: "Second paragraph" },
      { type: "image", sectionId: "steps", url: "/uploads/steps.png", altText: "Steps image" },
    ],
  });

  assert.match(body.html, /data-zhixin-section="intro"/);
  assert.match(body.html, /data-zhixin-section="steps"/);
  assert.doesNotMatch(body.html, /<img\b/i);
  assert.doesNotMatch(body.html, /!\[[^\]]*\]\([^)]+\)/);
});

test("derives structured Jianshu body text from editor blocks instead of the separate article title", () => {
  const body = buildJianshuBodyHtml({
    contentMarkdown: "# Separate article title\n\n## First section\n\nFirst body",
    contentBlocks: [
      { type: "section", sectionId: "first", title: "First section", content: "First body" },
    ],
  });

  assert.equal(body.text, "First section\n\nFirst body");
  assert.equal(body.text.includes("Separate article title"), false);
});
test("removes Markdown image syntax from the Jianshu plain-text fallback", () => {
  const body = buildJianshuBodyHtml({
    content: "# Main title\n\n## Workflow\n\nParagraph one\n\n![inline](/uploads/inline.png)\n\nParagraph two",
  });

  assert.match(body.html, /<h1[^>]*>Main title<\/h1>/);
  assert.match(body.html, /<h2[^>]*>Workflow<\/h2>/);
  assert.match(body.html, /Paragraph one/);
  assert.match(body.html, /Paragraph two/);
  assert.doesNotMatch(body.html, /!\[inline\]/);
  assert.doesNotMatch(body.text, /!\[inline\]/);
  assert.doesNotMatch(body.text, /^\s*#{1,6}\s+/m);
});

test("limits Jianshu public image verification to persistent article-body uploads", () => {
  assert.match(JIANSHU_PUBLIC_IMAGE_SELECTOR, /article img\[src\*=['\"]upload-images\.jianshu\.io\/upload_images\//);
  assert.doesNotMatch(JIANSHU_PUBLIC_IMAGE_SELECTOR, /upload_avatars/);
  assert.doesNotMatch(JIANSHU_PUBLIC_IMAGE_SELECTOR, /(^|,\s*)article img(,|$)/);
});

test("discovers a reviewed Jianshu article and verifies public platform images", async () => {
  const publicImage = {
    async getAttribute(name) {
      if (name === "src") return "https://upload-images.jianshu.io/public-inline.png";
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
    async innerText() { return "The authenticated jianshu public body is available."; },
  };
  const page = {
    async goto() {},
    async waitForLoadState() {},
    async waitForFunction(_fn, payload) {
      assert.ok(String(payload.selector).includes("jianshu"));
      assert.equal(payload.expectedCount, 1);
    },
    async title() { return "Jianshu reviewed illustrated article"; },
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
    platformImageUrl: "https://upload-images.jianshu.io/draft-inline.png",
    loaded: true,
  };

  const result = await inspectJianshuPublicArticle(page, {
    publicUrl: "https://www.jianshu.com/p/abcdef123456",
    articleTitle: "Jianshu reviewed illustrated article",
    contentMarkdown: "The authenticated jianshu public body is available.",
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

test("draft-mode publish keeps Jianshu publishedUrl empty", async () => {
  const actions = [];
  let bodyEvaluationCount = 0;
  const page = {
    _url: "https://www.jianshu.com/writer",
    request: {
      async fetch(url, options = {}) {
        const text = String(url);
        if (text.endsWith("/author/current_user")) {
          return { status: () => 200, url: () => url, text: async () => JSON.stringify({ id: 31306077 }) };
        }
        if (text.endsWith("/author/notebooks")) {
          return { status: () => 200, url: () => url, text: async () => JSON.stringify([{ id: 57148354, name: "Daily" }]) };
        }
        if (text.endsWith("/author/notes") && options.method === "POST") {
          return {
            status: () => 200,
            url: () => url,
            text: async () => JSON.stringify({
              id: 141684195,
              slug: "8d78c57a6cc6",
              notebook_id: 57148354,
              autosave_control: 0,
              shared: false,
            }),
          };
        }
        if (text.endsWith("/author/notes/141684195") && options.method === "PUT") {
          return {
            status: () => 200,
            url: () => url,
            text: async () => JSON.stringify({ id: 141684195, content_updated_at: 1785686938, last_compiled_at: 0 }),
          };
        }
        if (text.endsWith("/author/notes/141684195/content")) {
          return {
            status: () => 200,
            url: () => url,
            text: async () => JSON.stringify({ content: "<p>This is a controlled Jianshu draft automation body.</p>" }),
          };
        }
        if (text.includes("/author/notebooks/57148354/notes")) {
          return {
            status: () => 200,
            url: () => url,
            text: async () => JSON.stringify([{
              id: 141684195,
              slug: "8d78c57a6cc6",
              notebook_id: 57148354,
              title: "Jianshu draft only illustrated article",
              shared: false,
            }]),
          };
        }
        return { status: () => 404, url: () => url, text: async () => "" };
      },
    },
    on() {},
    off() {},
    setDefaultTimeout() {},
    setDefaultNavigationTimeout() {},
    keyboard: {
      async press(key) { actions.push(["press", key]); },
    },
    async goto(url) {
      actions.push(["goto", url]);
      page._url = url;
    },
    async bringToFront() {},
    async waitForLoadState() {},
    async waitForTimeout() {},
    async waitForFunction() {},
    url() { return page._url; },
    async evaluate() {
      return "writer notebook draft saved content management publish article editor";
    },
    locator(selector) {
      const locator = {
        first() { return locator; },
        async isVisible() {
          return /title|placeholder|CodeMirror|contenteditable|kalamu|发布/i.test(selector);
        },
        async isDisabled() { return false; },
        async click() { actions.push(["click", selector]); },
        async fill(value) { actions.push(["fill", selector, value]); },
        async dispatchEvent() {},
        async scrollIntoViewIfNeeded() {},
        async setInputFiles() {},
        locator() { return locator; },
        async press(key) { actions.push(["locator.press", selector, key]); },
        async evaluate() {
          if (!String(selector).includes("kalamu")) return {};
          bodyEvaluationCount += 1;
          if (bodyEvaluationCount === 1) {
            return { imageCount: 0, selectedImageCount: 0, selectedTextLength: 1, textLength: 1 };
          }
          if (bodyEvaluationCount === 2) return { imageCount: 0, text: "" };
          return { text: "This is a controlled Jianshu draft automation body.", headings: [] };
        },
      };
      return locator;
    },
  };
  const context = {
    pages() { return [page]; },
    async newPage() { return page; },
    async cookies() {
      return [{ name: "remember_user_token", value: "jianshu-token", domain: ".jianshu.com" }];
    },
    async close() { actions.push(["close"]); },
  };
  const adapter = new JianshuAdapter({
    browser: {
      async launchPersistentContext() { return context; },
    },
  });

  const result = await adapter.publishArticle({
    articleTitle: "Jianshu draft only illustrated article",
    contentMarkdown: "This is a controlled Jianshu draft automation body.",
    confirmPublish: false,
  });

  assert.equal(result.platformStatus, "draft_saved");
  assert.equal(result.publishedUrl, "");
  assert.ok(String(result.draftUrl).includes("jianshu.com/writer"));
});

test("publishes Jianshu through the browser API context using the create slug after publicize", async () => {
  const calls = [];
  let publicized = false;
  const page = {
    _url: "about:blank",
    request: {
      async fetch(url, options = {}) {
        calls.push({ url, options });
        const text = String(url);
        if (text.endsWith("/author/current_user")) {
          return {
            status: () => 200,
            url: () => url,
            text: async () => JSON.stringify({ id: 31306077, nickname: "Jianshu tester" }),
          };
        }
        if (text.endsWith("/author/notebooks")) {
          return {
            status: () => 200,
            url: () => url,
            text: async () => JSON.stringify([{ id: 57148354, name: "Daily" }]),
          };
        }
        if (text.endsWith("/author/notes") && options.method === "POST") {
          return {
            status: () => 200,
            url: () => url,
            text: async () => JSON.stringify({
              id: 163240218,
              notebook_id: 57148354,
              slug: "3d628c37f59b",
              autosave_control: 0,
              shared: false,
            }),
          };
        }
        if (text.includes("/publicize")) {
          publicized = true;
          return {
            status: () => 200,
            url: () => url,
            text: async () => JSON.stringify({ last_compiled_at: 1785081617 }),
          };
        }
        if (text.endsWith("/author/notes/163240218") && options.method === "PUT") {
          return {
            status: () => 200,
            url: () => url,
            text: async () => JSON.stringify({ id: 163240218, content_updated_at: 1785081616, last_compiled_at: 0 }),
          };
        }
        if (text.endsWith("/author/notes/163240218/content")) {
          return {
            status: () => 200,
            url: () => url,
            text: async () => JSON.stringify({
              content: "<p>This verifies Jianshu API note creation, update, and publicize.</p>",
            }),
          };
        }
        if (text.includes("/author/notebooks/57148354/notes")) {
          return {
            status: () => 200,
            url: () => url,
            text: async () => JSON.stringify([{
              id: 163240218,
              notebook_id: 57148354,
              slug: "3d628c37f59b",
              title: "Jianshu API-first publish test",
              shared: publicized,
              last_compiled_at: publicized ? 1785081617 : 0,
            }]),
          };
        }
        if (text.endsWith("/shakespeare/v2/notes/3d628c37f59b")) {
          return {
            status: () => 200,
            url: () => url,
            text: async () => JSON.stringify({
              id: 163240218,
              slug: "3d628c37f59b",
              public_title: "Jianshu API-first publish test",
              free_content: "<p>This verifies Jianshu API note creation, update, and publicize.</p>",
            }),
          };
        }
        return { status: () => 404, url: () => url, text: async () => "" };
      },
    },
    async goto(url) { page._url = url; },
    async waitForLoadState() {},
    async waitForTimeout() {},
    url: () => page._url,
    async title() { return "Jianshu"; },
    async evaluate() { return ""; },
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "remember_user_token", value: "jianshu-secret-token", domain: ".jianshu.com" }],
    close: async () => calls.push({ close: true }),
  };
  const adapter = new JianshuAdapter({
    browser: { launchPersistentContext: async () => context },
  });

  const result = await adapter.publishArticle({
    articleTitle: "Jianshu API-first publish test",
    contentMarkdown: "This verifies Jianshu API note creation, update, and publicize.",
    contentHtml: "<p>This verifies Jianshu API note creation, update, and publicize.</p>",
    confirmPublish: true,
    apiFirst: true,
    platformConfig: {
      csrfToken: "jianshu-secret-csrf",
    },
  });

  assert.equal(result.platformStatus, "published");
  assert.equal(result.publishedUrl, "https://www.jianshu.com/p/3d628c37f59b");
  assert.equal(result.publiclyVisible, true);
  assert.equal(result.externalIds.noteId, "163240218");
  assert.equal(result.transport, "api");
  assert.equal(result.publicVerified, true);
  assert.equal(result.publicationEvidence.source, "api");
  assert.equal(result.publicationEvidence.accepted, true);
  assert.equal(result.publicationEvidence.public.shared, true);
  assert.equal(calls.some((call) => String(call.url).endsWith("/shakespeare/v2/notes/3d628c37f59b")), true);
  assert.doesNotMatch(JSON.stringify(result.publicationEvidence), /jianshu-secret-token|jianshu-secret-csrf/);
});



test("hot-updatable Jianshu uploader accepts the final image snapshot", async () => {
  const { uploadJianshuPlatformImages } = await import("../src/adapters/jianshu.mjs");
  let reads = 0;
  const image = { src: "https://upload-images.jianshu.io/upload_images/final.png", loaded: true };
  const result = await uploadJianshuPlatformImages({
    tasks: [{ assetId: "final" }], timeoutMs: 5, pollMs: 10, onProgress: async () => {},
    selectFile: async () => {}, readImages: async () => ++reads >= 4 ? [image] : [],
  });
  assert.equal(result[0].platformImageUrl, image.src);
});
