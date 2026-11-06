import assert from "node:assert/strict";
import { test } from "node:test";

import { commitSohuUploadedImagesToEditor, configureSohuPublication, fillSohuBody, inspectSohuPublicArticle, normalizeSohuPublishInput, readSohuEditorSnapshot, readSohuManagementArticleEvidence, resolveSohuAcceptedManagementFallback, SohuAdapter, uploadSohuInlineImages, writeSohuEditorContentInPage } from "../src/adapters/sohu.mjs";

test("configures Sohu cover, content property, and AI declaration", async () => {
  const actions = [];
  let coverUploaded = false;
  const item = (selector) => ({
    click: async () => actions.push(["click", selector]),
    isVisible: async () => selector.includes("positive-button") ? coverUploaded : true,
    isDisabled: async () => false,
    setInputFiles: async (filePath) => {
      coverUploaded = true;
      actions.push(["upload", selector, filePath]);
    },
  });
  const page = {
    locator: (selector) => ({
      first: () => item(selector),
      last: () => item(selector),
    }),
    evaluate: async () => ({ selectedCategory: "经验教程", creationStatementValue: "2", creationStatementText: "AI辅助创作", coverSelected: coverUploaded }),
    getByText: (text) => ({
      last: () => item(`text:${text}`),
    }),
  };

  await configureSohuPublication(page, {
    coverImagePath: "C:\\tmp\\sohu-cover.png",
    category: "\u7ecf\u9a8c\u6559\u7a0b",
    creationStatement: "AI\u8f85\u52a9\u521b\u4f5c",
  }, { timeoutMs: 20 });

  assert.ok(actions.some((entry) => entry[0] === "click" && entry[1] === ".cover-button"));
  assert.ok(actions.some((entry) => entry[0] === "upload" && entry[2] === "C:\\tmp\\sohu-cover.png"));
  assert.ok(actions.some((entry) => entry[0] === "click" && entry[1].includes("select-main:visible")));
  assert.ok(actions.some((entry) => entry[0] === "click" && entry[1] === "text:\u7ecf\u9a8c\u6559\u7a0b"));
  assert.ok(actions.some((entry) => entry[0] === "click" && entry[1].includes("input[value='2']")));
});

test("confirms Sohu cover upload when the confirm control is a non-button DOM element", async () => {
  const actions = [];
  let fileUploaded = false;
  let confirmClicked = false;
  const item = (selector) => ({
    click: async () => actions.push(["click", selector]),
    isVisible: async () => selector === ".cover-button",
    isDisabled: async () => false,
    setInputFiles: async (filePath) => {
      fileUploaded = true;
      actions.push(["upload", selector, filePath]);
    },
  });
  const page = {
    locator: (selector) => ({
      first: () => item(selector),
      last: () => item(selector),
    }),
    evaluate: async (fn) => {
      const source = String(fn || "");
      if (source.includes("target.click()") && fileUploaded) {
        confirmClicked = true;
        actions.push(["domConfirmClick"]);
        return { clicked: true, className: "upload-dialog-confirm" };
      }
      return { selectedCategory: "", creationStatementValue: "", creationStatementText: "", coverSelected: confirmClicked };
    },
    waitForTimeout: async () => {},
  };

  await configureSohuPublication(page, {
    coverImagePath: "C:\\tmp\\sohu-cover.png",
  }, { timeoutMs: 50 });

  assert.equal(fileUploaded, true);
  assert.equal(confirmClicked, true);
  assert.ok(actions.some((entry) => entry[0] === "domConfirmClick"));
});

test("fails Sohu cover configuration with evidence when upload dialog closes without selected cover", async () => {
  const progress = [];
  let fileUploaded = false;
  const item = (selector) => ({
    click: async () => {},
    isVisible: async () => selector === ".cover-button",
    isDisabled: async () => false,
    getAttribute: async () => "",
    setInputFiles: async () => {
      fileUploaded = true;
    },
    scrollIntoViewIfNeeded: async () => {},
  });
  const page = {
    locator: (selector) => ({
      first: () => item(selector),
      last: () => item(selector),
    }),
    evaluate: async (fn) => {
      const source = String(fn || "");
      if (source.includes("target.click()") && fileUploaded) {
        return { clicked: true, text: "确定", className: "button positive-button" };
      }
      return { selectedCategory: "", creationStatementValue: "", creationStatementText: "", coverSelected: false };
    },
    waitForTimeout: async () => {},
    screenshot: async () => {},
  };

  await assert.rejects(
    () => configureSohuPublication(page, { coverImagePath: "C:\\tmp\\sohu-cover.png" }, {
      timeoutMs: 30,
      onProgress: async (event) => progress.push(event),
    }),
    /SOHU_COVER_NOT_CONFIRMED/,
  );
  assert.ok(progress.some((event) => event.step === "cover_not_confirmed"));
});

test("accepts Chinese body commit without ASCII markers", async () => {
  const chinese = "高中学习方法要科学，费曼学习法能帮助理解知识漏洞，间隔复习提高记忆效率。".repeat(3);
  const page = {
    locator: () => ({
      first: () => ({
        waitFor: async () => {},
        scrollIntoViewIfNeeded: async () => {},
        click: async () => {},
        fill: async () => {},
        dispatchEvent: async () => {},
      }),
    }),
    evaluate: async () => ({
      ok: true,
      method: "quill_html",
      text: chinese,
      htmlLength: chinese.length + 20,
      imageCount: 0,
      editorCount: 1,
      visibleEditorCount: 1,
      loadedImageCount: 0,
    }),
    waitForFunction: async () => true,
    waitForTimeout: async () => {},
  };
  await fillSohuBody(page, chinese, `<p>${chinese}</p>`);
});

test("writes Sohu rich body through the Vue-owned Quill instance", () => {
  const writes = [];
  const editor = {
    className: "ql-editor ql-blank",
    innerHTML: "<p><br></p>",
    innerText: "",
    textContent: "",
    parentElement: null,
    classList: { remove: () => {} },
    closest: (selector) => selector === ".ql-container" ? editor.parentElement : null,
    dispatchEvent: () => true,
    focus: () => {},
    getBoundingClientRect: () => ({ width: 780, height: 500 }),
    querySelectorAll: () => [],
    scrollIntoView: () => {},
  };
  const container = { parentElement: null };
  const host = { parentElement: null };
  editor.parentElement = container;
  container.parentElement = host;
  const quill = {
    clipboard: {
      dangerouslyPasteHTML: (...args) => {
        const html = args.find((value) => typeof value === "string" && value.includes("<p>"));
        writes.push(html);
        editor.innerHTML = html;
        editor.innerText = "\u771f\u5b9e\u6b63\u6587\u5185\u5bb9";
        editor.textContent = editor.innerText;
      },
    },
    getLength: () => editor.innerText.length + 1,
    setSelection: () => {},
    setText: () => {
      editor.innerHTML = "<p><br></p>";
      editor.innerText = "";
      editor.textContent = "";
    },
    update: () => {},
  };
  host.__vue__ = { quill };

  const previous = {
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    window: globalThis.window,
  };
  globalThis.document = { querySelectorAll: () => [editor] };
  globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible" });
  globalThis.window = {};
  try {
    const result = writeSohuEditorContentInPage({ text: "\u771f\u5b9e\u6b63\u6587\u5185\u5bb9", html: "<p>\u771f\u5b9e\u6b63\u6587\u5185\u5bb9</p>" });
    assert.equal(result.ok, true);
    assert.equal(result.method, "vue_quill_html");
    assert.deepEqual(writes, ["<p>\u771f\u5b9e\u6b63\u6587\u5185\u5bb9</p>"]);
  } finally {
    Object.assign(globalThis, previous);
  }
});
test("does not downgrade Quill image HTML through a plain-text paste event", () => {
  const editor = {
    innerHTML: "<p><br></p>",
    innerText: "",
    textContent: "",
    parentElement: null,
    classList: { remove: () => {} },
    closest: (selector) => selector === ".ql-container" ? editor.parentElement : null,
    dispatchEvent: (event) => {
      if (event?.type === "input" && event?.inputType === "insertFromPaste" && event?.data) {
        editor.innerHTML = `<p>${event.data}</p>`;
      }
      return true;
    },
    focus: () => {},
    getBoundingClientRect: () => ({ width: 780, height: 500 }),
    querySelectorAll: (selector) => selector === "img"
      ? Array.from({ length: (editor.innerHTML.match(/<img\b/gi) || []).length }, () => ({}))
      : [],
    scrollIntoView: () => {},
  };
  const container = { parentElement: null };
  const host = { parentElement: null };
  editor.parentElement = container;
  container.parentElement = host;
  const quill = {
    clipboard: {
      dangerouslyPasteHTML: (...args) => {
        const html = args.find((value) => typeof value === "string" && value.includes("<img"));
        editor.innerHTML = html;
        editor.innerText = "\u6b63\u6587\u5185\u5bb9";
        editor.textContent = editor.innerText;
      },
    },
    getLength: () => editor.innerText.length + 1,
    getText: () => editor.innerText,
    setSelection: () => {},
    setText: () => {
      editor.innerHTML = "<p><br></p>";
      editor.innerText = "";
      editor.textContent = "";
    },
    update: () => {},
  };
  host.__vue__ = { quill };

  class FakeEvent {
    constructor(type, options = {}) {
      this.type = type;
      Object.assign(this, options);
    }
  }
  const previous = {
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    window: globalThis.window,
    InputEvent: globalThis.InputEvent,
    KeyboardEvent: globalThis.KeyboardEvent,
    Event: globalThis.Event,
  };
  globalThis.document = { querySelectorAll: () => [editor] };
  globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible" });
  globalThis.window = {};
  globalThis.InputEvent = FakeEvent;
  globalThis.KeyboardEvent = FakeEvent;
  globalThis.Event = FakeEvent;
  try {
    const result = writeSohuEditorContentInPage({
      text: "\u6b63\u6587\u5185\u5bb9",
      html: '<p>\u6b63\u6587\u5185\u5bb9</p><img src="https://res.mp.sohu.com/inline.png">',
    });
    assert.equal(result.ok, true);
    assert.equal(result.imageCount, 1);
    assert.match(editor.innerHTML, /res\.mp\.sohu\.com\/inline\.png/);
  } finally {
    Object.assign(globalThis, previous);
  }
});
test("commits uploaded Sohu CDN images into the main Vue Quill article before saving", async () => {
  const writes = [];
  const page = {
    evaluate: async (_callback, payload) => {
      if (payload?.html) {
        writes.push(payload.html);
        return {
          ok: true,
          method: "vue_quill_html",
          text: "正文内容",
          htmlLength: payload.html.length,
          imageCount: 1,
        };
      }
      return {
        text: "正文内容",
        htmlLength: writes.at(-1)?.length || 0,
        imageCount: 1,
        loadedImageCount: 1,
      };
    },
    waitForTimeout: async () => {},
  };
  const publishInput = {
    content: "正文内容",
    richHtml: "<section data-zhixin-section=\"section-1\"><h2>第一节</h2><p>正文内容</p></section>",
    contentBlocks: [
      { type: "section", sectionId: "section-1", title: "第一节", paragraphs: ["正文内容"] },
      { type: "image", sectionId: "section-1", assetId: "asset-1", altText: "正文配图" },
    ],
    platformImageTasks: [{ assetId: "asset-1", sectionId: "section-1", altText: "正文配图" }],
  };

  const result = await commitSohuUploadedImagesToEditor(page, publishInput, [{
    assetId: "asset-1",
    sectionId: "section-1",
    platformImageUrl: "https://res.mp.sohu.com/sohu-inline-1.png",
    loaded: true,
  }], { requiredStableReads: 1 });

  assert.equal(result.committed, true);
  assert.equal(result.imageCount, 1);
  assert.match(writes[0], /https:\/\/res\.mp\.sohu\.com\/sohu-inline-1\.png/);
  assert.doesNotMatch(writes[0], /\/uploads\/assets\//);
});

test("counts protocol-relative Sohu CDN images as committed editor images", async () => {
  class FakeImageElement {}
  const image = Object.assign(new FakeImageElement(), {
    complete: true,
    naturalWidth: 896,
    currentSrc: "https://res.mp.sohu.com/committed-image",
    getAttribute: (name) => name === "src" ? "//res.mp.sohu.com/committed-image" : "",
  });
  const editor = {
    innerText: "?????????????",
    textContent: "?????????????",
    innerHTML: '<p>?????????????</p><img src="//res.mp.sohu.com/committed-image">',
    getBoundingClientRect: () => ({ width: 800, height: 600 }),
    closest: (selector) => selector.includes("main") ? {} : null,
    querySelectorAll: (selector) => selector === "img" ? [image] : [],
  };
  const previous = {
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    HTMLImageElement: globalThis.HTMLImageElement,
  };
  globalThis.document = { querySelectorAll: () => [editor] };
  globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible" });
  globalThis.HTMLImageElement = FakeImageElement;
  try {
    const page = { evaluate: async (callback) => callback() };
    const snapshot = await readSohuEditorSnapshot(page);

    assert.equal(snapshot.imageCount, 1);
    assert.equal(snapshot.loadedImageCount, 1);
  } finally {
    Object.assign(globalThis, previous);
  }
});
test("rewrites uploaded Sohu images when a late platform update clears the Quill body", async () => {
  const writes = [];
  let imageCount = 0;
  let snapshotReads = 0;
  let destructiveCommitCalls = 0;
  const page = {
    evaluate: async (_callback, payload) => {
      if (payload?.html) {
        writes.push(payload.html);
        imageCount = 1;
        return {
          ok: true,
          method: "vue_quill_html",
          text: "\u7b2c\u4e00\u8282\u6b63\u6587\u5185\u5bb9\u8fd9\u662f\u4e00\u6bb5\u7528\u4e8e\u9a8c\u8bc1\u7f16\u8f91\u5668\u5f02\u6b65\u8986\u76d6\u6062\u590d\u903b\u8f91\u7684\u5b8c\u6574\u6d4b\u8bd5\u5185\u5bb9",
          htmlLength: payload.html.length,
          imageCount,
        };
      }
      if (String(_callback).includes("insertFromPaste")) {
        destructiveCommitCalls += 1;
        imageCount = 0;
        return true;
      }
      snapshotReads += 1;
      if (snapshotReads === 1) imageCount = 0;
      return {
        text: "\u7b2c\u4e00\u8282\u6b63\u6587\u5185\u5bb9\u8fd9\u662f\u4e00\u6bb5\u7528\u4e8e\u9a8c\u8bc1\u7f16\u8f91\u5668\u5f02\u6b65\u8986\u76d6\u6062\u590d\u903b\u8f91\u7684\u5b8c\u6574\u6d4b\u8bd5\u5185\u5bb9",
        htmlLength: writes.at(-1)?.length || 0,
        imageCount,
        loadedImageCount: imageCount,
      };
    },
    waitForTimeout: async () => {},
  };
  const publishInput = {
    content: "\u6b63\u6587\u5185\u5bb9\u8fd9\u662f\u4e00\u6bb5\u7528\u4e8e\u9a8c\u8bc1\u7f16\u8f91\u5668\u5f02\u6b65\u8986\u76d6\u6062\u590d\u903b\u8f91\u7684\u5b8c\u6574\u6d4b\u8bd5\u5185\u5bb9",
    richHtml: "<section data-zhixin-section=\"section-1\"><h2>\u7b2c\u4e00\u8282</h2><p>\u6b63\u6587\u5185\u5bb9\u8fd9\u662f\u4e00\u6bb5\u7528\u4e8e\u9a8c\u8bc1\u7f16\u8f91\u5668\u5f02\u6b65\u8986\u76d6\u6062\u590d\u903b\u8f91\u7684\u5b8c\u6574\u6d4b\u8bd5\u5185\u5bb9</p></section>",
    contentBlocks: [
      { type: "section", sectionId: "section-1", title: "\u7b2c\u4e00\u8282", paragraphs: ["\u6b63\u6587\u5185\u5bb9\u8fd9\u662f\u4e00\u6bb5\u7528\u4e8e\u9a8c\u8bc1\u7f16\u8f91\u5668\u5f02\u6b65\u8986\u76d6\u6062\u590d\u903b\u8f91\u7684\u5b8c\u6574\u6d4b\u8bd5\u5185\u5bb9"] },
      { type: "image", sectionId: "section-1", assetId: "asset-1", altText: "\u6b63\u6587\u914d\u56fe" },
    ],
    platformImageTasks: [{ assetId: "asset-1", sectionId: "section-1", altText: "\u6b63\u6587\u914d\u56fe" }],
  };

  const result = await commitSohuUploadedImagesToEditor(page, publishInput, [{
    assetId: "asset-1",
    sectionId: "section-1",
    platformImageUrl: "https://res.mp.sohu.com/sohu-inline-1.png",
    loaded: true,
  }], { timeoutMs: 20, pollMs: 1, requiredStableReads: 2 });

  assert.equal(result.committed, true);
  assert.equal(result.imageCount, 1);
  assert.equal(writes.length, 2);
  assert.equal(destructiveCommitCalls, 0);
});
test("fills Sohu body through Quill once without plain-text prefill", async () => {
  const actions = [];
  const page = {
    locator: (selector) => ({
      first: () => ({
        click: async () => actions.push(["click", selector]),
        fill: async (value) => actions.push(["fill", selector, value]),
      }),
    }),
    evaluate: async (fn, payload) => {
      actions.push(["evaluate", payload]);
      return { ok: true, method: "quill_html", text: "正文第一段 正文第二段", htmlLength: 80, imageCount: 0 };
    },
  };

  await fillSohuBody(page, "正文第一段\n\n正文第二段", "<h2>正文第一段</h2><p>正文第二段</p>");

  assert.deepEqual(actions.filter((item) => item[0] === "fill"), []);
  assert.equal(actions.filter((item) => item[0] === "evaluate").length >= 1, true);
  assert.match(actions.find((item) => item[0] === "evaluate")?.[1]?.html || "", /<h2>正文第一段<\/h2>/);
});

test("keeps rich Sohu body from downgrading to markdown when paste fallback fails", async () => {
  const actions = [];
  const page = {
    locator: (selector) => ({
      first: () => ({
        click: async () => actions.push(["click", selector]),
        fill: async (value) => actions.push(["fill", selector, value]),
        dispatchEvent: async (eventName) => actions.push(["dispatch", selector, eventName]),
        evaluate: async () => false,
      }),
    }),
    evaluate: async () => ({ ok: false, method: "missing_editor" }),
    keyboard: {
      press: async (key) => actions.push(["press", key]),
    },
  };

  await assert.rejects(
    () => fillSohuBody(page, "# Title\n\nParagraph one\n\nParagraph two", "<h2>Title</h2><p>Paragraph one</p><p>Paragraph two</p>"),
    /SOHU_RICH_BODY_WRITE_FAILED|SOHU_RICH_BODY_NOT_COMMITTED|SOHU_BODY_NOT_COMMITTED|SOHU_BODY_FIELD_NOT_FOUND/,
  );
  // Plain-text fill may be attempted as recovery, but rich HTML must still fail if editor never commits.
  assert.ok(actions.some((item) => item[0] === "evaluate" || item[0] === "fill" || item[0] === "press"));
});

test("normalizes Sohu publish input away from markdown-like contentHtml", () => {
  const publishInput = normalizeSohuPublishInput({
    title: "Markdown should become rich HTML",
    contentMarkdown: "# Markdown should become rich HTML\n\n## Opening\n\nBody paragraph.",
    contentHtml: "# Markdown should become rich HTML\n\n## Opening\n\nBody paragraph.",
    contentBlocks: [
      { type: "title", text: "Markdown should become rich HTML" },
      { type: "section", sectionId: "opening", title: "Opening", content: "Body paragraph." },
    ],
  });

  assert.match(publishInput.richHtml, /<h2[^>]*>Opening<\/h2>/);
  assert.doesNotMatch(publishInput.richHtml, /## Opening/);
  assert.doesNotMatch(publishInput.richHtml, /# Markdown should become rich HTML/);
});

test("confirms the Sohu upload dialog before waiting for the editor image", async () => {
  const actions = [];
  let fileUploaded = false;
  let imageInserted = false;
  const image = {
    getAttribute: async (name) => name === "src" ? "https://res.mp.sohu.com/uploaded-inline.png" : "",
    evaluate: async () => true,
  };
  const page = {
    locator: (selector) => {
      if (selector === ".ql-editor:visible img") {
        return {
          count: async () => imageInserted ? 1 : 0,
          nth: () => image,
        };
      }
      if (selector.includes(".ql-editor")) {
        return {
          first: () => ({
            click: async () => actions.push(["editorClick", selector]),
            fill: async (value) => actions.push(["editorFill", selector, value]),
            evaluate: async () => true,
            dispatchEvent: async (eventName) => actions.push(["editorDispatch", eventName]),
          }),
        };
      }
      if (selector.includes("input[type='file']")) {
        return {
          last: () => ({
            setInputFiles: async (filePath) => {
              actions.push(["upload", filePath]);
              fileUploaded = true;
            },
          }),
        };
      }
      return {
        first: () => ({
          click: async () => {
            actions.push(["click", selector]);
            if (selector.includes("positive-button") && fileUploaded) imageInserted = true;
          },
          isVisible: async () => !selector.includes(".el-dialog") && selector.includes("positive-button"),
          isDisabled: async () => false,
        }),
      };
    },
  };

  const result = await uploadSohuInlineImages(page, [{
    assetId: "asset-sohu-1",
    sectionId: "section-1",
    path: "C:\\tmp\\sohu-inline.png",
  }], { timeoutMs: 20 });

  assert.equal(result.length, 1);
  assert.equal(result[0].platformImageUrl, "https://res.mp.sohu.com/uploaded-inline.png");
  assert.ok(actions.some((item) => item[0] === "click" && item[1].includes("positive-button")));
});

test("skips disabled Sohu upload confirm controls before clicking the enabled positive button", async () => {
  const actions = [];
  let fileUploaded = false;
  let imageInserted = false;
  const image = {
    getAttribute: async (name) => name === "src" ? "https://res.mp.sohu.com/enabled-confirm-inline.png" : "",
    evaluate: async () => true,
  };
  const page = {
    locator: (selector) => {
      if (selector === ".ql-editor:visible img") {
        return {
          count: async () => imageInserted ? 1 : 0,
          nth: () => image,
        };
      }
      if (selector.includes(".ql-editor")) {
        return {
          first: () => ({
            click: async () => actions.push(["editorClick", selector]),
            fill: async () => {},
            evaluate: async () => true,
            dispatchEvent: async () => {},
          }),
        };
      }
      if (selector.includes("input[type='file']")) {
        return {
          last: () => ({
            count: async () => 1,
            setInputFiles: async () => { fileUploaded = true; },
          }),
        };
      }
      return {
        first: () => ({
          click: async () => {
            actions.push(["click", selector]);
            if (selector.includes("p.positive-button") && fileUploaded) imageInserted = true;
          },
          isVisible: async () => selector.includes("positive-button"),
          isDisabled: async () => false,
          getAttribute: async (name) => {
            if (name === "class" && selector.includes("positive-button")) {
              return selector.includes("p.positive-button") ? "button positive-button" : "button disable-button positive-button";
            }
            return "";
          },
        }),
      };
    },
    waitForTimeout: async () => {},
  };

  const result = await uploadSohuInlineImages(page, [{
    assetId: "asset-enabled-confirm",
    sectionId: "section-enabled-confirm",
    path: "C:\\tmp\\sohu-enabled-confirm.png",
  }], { timeoutMs: 50 });

  assert.equal(result[0].platformImageUrl, "https://res.mp.sohu.com/enabled-confirm-inline.png");
  assert.ok(actions.some((item) => item[0] === "click" && item[1].includes("p.positive-button")));
  assert.equal(actions.some((item) => item[0] === "click" && item[1].includes(".local-upload .button.positive-button")), false);
});

test("reads only visible Sohu editor images during upload verification", async () => {
  const selectors = [];
  let fileUploaded = false;
  const page = {
    locator: (selector) => {
      selectors.push(selector);
      if (selector === ".ql-editor:visible img") {
        return {
          count: async () => fileUploaded ? 1 : 0,
          nth: () => ({
            getAttribute: async (name) => name === "src" ? "https://res.mp.sohu.com/visible-inline.png" : "",
            evaluate: async () => true,
          }),
        };
      }
      if (selector === ".ql-editor img") {
        return {
          count: async () => 1,
          nth: () => ({
            getAttribute: async (name) => name === "src" ? "https://res.mp.sohu.com/hidden-old-inline.png" : "",
            evaluate: async () => true,
          }),
        };
      }
      if (selector.includes(".ql-editor")) {
        return {
          first: () => ({
            click: async () => actions.push(["editorClick", selector]),
            fill: async (value) => actions.push(["editorFill", selector, value]),
            evaluate: async () => true,
            dispatchEvent: async (eventName) => actions.push(["editorDispatch", eventName]),
          }),
        };
      }
      if (selector.includes("input[type='file']")) {
        return { last: () => ({ setInputFiles: async () => { fileUploaded = true; } }) };
      }
      return {
        first: () => ({
          click: async () => {},
          isVisible: async () => selector.includes("positive-button"),
          isDisabled: async () => false,
        }),
      };
    },
  };

  const result = await uploadSohuInlineImages(page, [{
    assetId: "asset-visible",
    sectionId: "visible-section",
    path: "C:\\tmp\\sohu-visible.png",
  }], { timeoutMs: 20 });

  assert.equal(result[0].platformImageUrl, "https://res.mp.sohu.com/visible-inline.png");
  assert.ok(selectors.includes(".ql-editor:visible img"));
});

function createLocator(actions, selector, page) {
  return {
    first: () => ({
      fill: async (value) => actions.push(["fill", selector, value]),
      click: async () => actions.push(["click", selector]),
      isDisabled: async () => false,
      isVisible: async () => selector.includes("button") || selector.includes("modal"),
      getAttribute: async () => "",
      scrollIntoViewIfNeeded: async () => actions.push(["scroll", selector]),
      dispatchEvent: async (eventName) => actions.push(["dispatch", selector, eventName])
    }),
    last: () => ({
      fill: async (value) => actions.push(["fillLast", selector, value]),
      click: async () => actions.push(["clickLast", selector]),
      isDisabled: async () => false,
      isVisible: async () => false,
      getAttribute: async () => "",
      scrollIntoViewIfNeeded: async () => actions.push(["scrollLast", selector])
    }),
    getByText: () => createLocator(actions, `${selector} text`, page)
  };
}

function createTextLocator(actions, text, { visible = true, onClick = null } = {}) {
  return {
    first: () => ({
      fill: async (value) => actions.push(["textFill", text, value]),
      click: async () => {
        actions.push(["textClick", text]);
        await onClick?.();
      },
      isDisabled: async () => false,
      isVisible: async () => visible,
      getAttribute: async () => "",
      dispatchEvent: async (eventName) => actions.push(["textDispatch", text, eventName])
    })
  };
}

function createSohuPublishHarness({ text = "Sohu creator content management publish draft saved", publishedUrl = "", publishApiPayload = null, draftApiPayload = null, fallbackPublishedHref = "", hangPostPublishDialog = false, failCoverConfigToManagement = false, managementArticleTitle = "", clientAuthUrl = "", clientAuthClears = false, blockerVisibleText = "", coverUploadGate = false } = {}) {
  // A non-empty clientAuthUrl bounces the editor onto the Sohu SMS gate.
  const actions = [];
  let responseHandler = null;
  let gateCleared = false;
  const SOHU_EDITOR_TEST_URL = "https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=1";
  const isGateUrl = (url) => Boolean(clientAuthUrl) && String(url || "").startsWith(clientAuthUrl);
  // clientAuthClears models a person finishing the SMS code: the gate lifts on
  // the adapter's verification poll, and later navigations land on the editor.
  const clearSohuGate = () => {
    if (gateCleared || !clientAuthClears || !isGateUrl(page._url)) return;
    gateCleared = true;
    page._url = SOHU_EDITOR_TEST_URL;
  };
  const page = {
    _url: "about:blank",
    on: (event, handler) => {
      if (event === "response") responseHandler = handler;
    },
    off: () => {},
    goto: async (url) => {
      actions.push(["goto", url]);
      page._url = gateCleared && isGateUrl(url) ? SOHU_EDITOR_TEST_URL : url;
    },
    bringToFront: async () => actions.push(["bringToFront"]),
    waitForLoadState: async (state) => actions.push(["waitForLoadState", state]),
    waitForTimeout: async (ms) => {
      actions.push(["waitForTimeout", ms]);
      // Only the adapter's verification poll can lift the gate, so an ordinary
      // editor settle never sneaks past the SMS gate.
      if (ms === 3000) clearSohuGate();
    },
    waitForFunction: async () => actions.push(["waitForFunction"]),
    url: () => page._url,
    title: async () => "Sohu creator center",
    evaluate: async (...args) => {
      // The blocker reader is the only evaluate that inspects toast text, so it
      // is the only one that gets the object shape a real page returns.
      if (blockerVisibleText && typeof args[0] === "function" && String(args[0]).includes("visibleMessageText")) {
        return { bodyText: text, visibleMessageText: blockerVisibleText };
      }
      if (failCoverConfigToManagement && args.length > 1 && args[1] === managementArticleTitle) {
        return {
          found: true,
          articleTitle: managementArticleTitle,
          statusText: "审核中",
          rowText: `${managementArticleTitle} 2026-07-18 10:58 Validate Sohu accepted-review writeback. 审核中 栏目0 更多`,
          publicUrl: "",
          currentUrl: "https://mp.sohu.com/mpfe/v4/contentManagement/first/page",
        };
      }
      if (args.length > 1) actions.push(["evaluateWithArg", args[1]]);
      return args.length > 1 ? true : text;
    },
    locator: (selector) => {
      if (failCoverConfigToManagement && selector === ".cover-button") {
        return {
          first: () => ({
            click: async () => {
              actions.push(["click", selector]);
              page._url = "https://mp.sohu.com/mpfe/v4/contentManagement/first/page";
            },
            isVisible: async () => true,
            isDisabled: async () => false,
            getAttribute: async () => "",
            scrollIntoViewIfNeeded: async () => {},
            dispatchEvent: async () => {},
          }),
          last: () => ({
            isVisible: async () => false,
            click: async () => {},
          }),
        };
      }
      if (failCoverConfigToManagement && selector.includes("input[type='file']")) {
        return {
          first: () => ({ isVisible: async () => false, click: async () => {} }),
          last: () => ({ count: async () => 0, isVisible: async () => false, click: async () => {} }),
        };
      }
      if (selector.includes("存草稿")) {
        return createTextLocator(actions, "存草稿", {
          onClick: async () => {
            if (responseHandler) {
              await responseHandler({
                url: () => "https://mp.sohu.com/mpbp/bp/news/v4/news/draft/v2",
                text: async () => JSON.stringify(draftApiPayload || { status: 0, data: { newsId: "sohu-draft-001" } })
              });
            }
            if (clientAuthUrl && !gateCleared) page._url = clientAuthUrl;
          }
        });
      }
      if (selector.includes("发布") && selector.includes("publish-report-btn")) {
        return createTextLocator(actions, "发布", {
          onClick: async () => {
            if (publishedUrl) page._url = publishedUrl;
            if (publishApiPayload && responseHandler) {
              await responseHandler({
                url: () => "https://mp.sohu.com/mpbp/bp/news/v4/news/publish/v2",
                text: async () => JSON.stringify(publishApiPayload)
              });
            }
          }
        });
      }
      if (coverUploadGate && selector === ".cover-button") {
        return {
          first: () => ({
            click: async () => {
              actions.push(["click", selector]);
              // The upload answer carries the security challenge, and the editor
              // is bounced onto the SMS gate with it.
              if (responseHandler) {
                await responseHandler({
                  url: () => "https://turing.captcha.qcloud.com/captcha",
                  status: () => 403
                });
              }
              if (clientAuthUrl && !gateCleared) page._url = clientAuthUrl;
            },
            isVisible: async () => true,
            isDisabled: async () => false,
            getAttribute: async () => "",
            scrollIntoViewIfNeeded: async () => {},
            dispatchEvent: async () => {}
          }),
          last: () => ({ isVisible: async () => false, click: async () => {} })
        };
      }
      if (hangPostPublishDialog && selector.includes("ant-modal")) {
        return {
          first: () => ({
            fill: async () => {},
            click: () => new Promise(() => {}),
            isDisabled: async () => false,
            isVisible: async () => true,
            getAttribute: async () => "",
            scrollIntoViewIfNeeded: async () => {},
            dispatchEvent: async () => {}
          })
        };
      }
      return createLocator(actions, selector, page);
    },
    getByRole: (role, options = {}) => ({
      first: () => ({
        isVisible: async () => true,
        isDisabled: async () => false,
        click: async () => {
          const name = options.name?.toString?.() || String(options.name || "");
          actions.push(["roleClick", role, name]);
          if (name.includes("publish") && publishedUrl) page._url = publishedUrl;
          if (name.includes("publish") && publishApiPayload && responseHandler) {
            await responseHandler({
              url: () => "https://mp.sohu.com/mpbp/bp/news/v4/news/publish/v2",
              text: async () => JSON.stringify(publishApiPayload)
            });
          }
          if (name.includes("draft") && responseHandler) {
            await responseHandler({
              url: () => "https://mp.sohu.com/mpbp/bp/news/v4/news/draft/v2",
              text: async () => JSON.stringify(draftApiPayload || { status: 0, data: { newsId: "sohu-draft-001" } })
            });
          }
        }
      })
    })
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "ppinf", value: "passport-token", domain: ".sohu.com" }],
    close: async () => actions.push(["close"])
  };
  const adapter = new SohuAdapter({
    browser: {
      launchPersistentContext: async () => context
    }
  });
  return { actions, adapter, page };
}

test("seeds Sohu credentials into the stable persistent auth profile", async () => {
  const { actions, page } = createSohuPublishHarness();
  let persistentLaunches = 0;
  let temporaryLaunches = 0;
  let injectedCookies = [];
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "ppinf", value: "passport-token", domain: ".sohu.com" }],
    addCookies: async (cookies) => {
      injectedCookies = cookies;
    },
    close: async () => actions.push(["close"])
  };
  const adapter = new SohuAdapter({
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
    articleTitle: "Zhixin AI Sohu injected cookie test",
    contentMarkdown: "This test verifies cookie injected publishing.",
    cookies: [{ name: "ppinf", value: "passport-token", domain: ".sohu.com", path: "/" }]
  });

  assert.equal(result.platformStatus, "draft_saved");
  assert.equal(persistentLaunches, 1);
  assert.equal(temporaryLaunches, 0);
  assert.equal(injectedCookies.length, 1);
});

test("opens the Sohu editor from the creator home page before filling fields", async () => {
  const actions = [];
  let editorOpened = false;
  const page = {
    _url: "about:blank",
    on: () => {},
    off: () => {},
    goto: async (url) => {
      actions.push(["goto", url]);
      page._url = "https://mp.sohu.com/mpfe/v4/contentManagement/first/page";
    },
    bringToFront: async () => actions.push(["bringToFront"]),
    waitForLoadState: async (state) => actions.push(["waitForLoadState", state]),
    waitForTimeout: async (ms) => actions.push(["waitForTimeout", ms]),
    waitForFunction: async () => actions.push(["waitForFunction"]),
    url: () => page._url,
    title: async () => "Sohu creator center",
    evaluate: async () => editorOpened
      ? "Sohu creator content management publish draft saved"
      : "Sohu creator content management first page",
    locator: (selector) => ({
      first: () => ({
        fill: async (value) => {
          if (!editorOpened && selector.includes("title")) throw new Error("not in editor");
          actions.push(["fill", selector, value]);
        },
        click: async () => {
          actions.push(["click", selector]);
          if (selector.includes("ant-modal")) page._url = "https://www.sohu.com/a/900000003_122929277";
          if (selector === "button.publish-btn") {
            editorOpened = true;
            page._url = "https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=1";
          }
        },
        isDisabled: async () => false,
        isVisible: async () => selector === "button.publish-btn" || editorOpened,
      getAttribute: async () => (selector.includes("sohu.com/a/") || selector.includes("/a/") ? fallbackPublishedHref : ""),
        dispatchEvent: async (eventName) => actions.push(["dispatch", selector, eventName])
      })
    }),
    getByRole: (role, options = {}) => ({
      first: () => ({
        isVisible: async () => editorOpened,
        isDisabled: async () => false,
        click: async () => {
          const name = options.name?.toString?.() || String(options.name || "");
          actions.push(["roleClick", role, name]);
        }
      })
    })
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "ppinf", value: "passport-token", domain: ".sohu.com" }],
    close: async () => actions.push(["close"])
  };
  const adapter = new SohuAdapter({
    browser: {
      launchPersistentContext: async () => context
    }
  });

  const result = await adapter.publishArticle({
    articleTitle: "Zhixin AI Sohu routed editor test",
    contentMarkdown: "This verifies routed editor opening.",
    keepBrowserOpen: false
  });

  assert.equal(result.platformStatus, "draft_saved");
  assert.ok(actions.some((item) => item[0] === "click" && item[1] === "button.publish-btn"));
  assert.ok(actions.some((item) => item[0] === "fill" && item[1].includes("title")));
});

test("waits for the mounted Sohu editor instead of trusting the hash route alone", async () => {
  const actions = [];
  let editorMounted = false;
  const page = {
    _url: "https://mp.sohu.com/mpfe/v4/main#/contentManagement/news/addarticle?contentStatus=1",
    on: () => {},
    off: () => {},
    goto: async (url) => {
      actions.push(["goto", url]);
      page._url = url;
    },
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    waitForFunction: async () => {
      actions.push(["waitForFunction"]);
    },
    url: () => page._url,
    title: async () => "Sohu creator center",
    evaluate: async () => "Sohu creator content management publish draft saved",
    locator: (selector) => ({
      first: () => ({
        fill: async (value) => {
          if (!editorMounted) throw new Error("editor is not mounted");
          actions.push(["fill", selector, value]);
        },
        click: async () => {
          actions.push(["click", selector]);
          if (selector === "button.publish-btn") editorMounted = true;
        },
        isDisabled: async () => false,
        isVisible: async () => selector === "button.publish-btn" || editorMounted,
        getAttribute: async () => "",
        dispatchEvent: async () => {},
        scrollIntoViewIfNeeded: async () => {},
      }),
    }),
    getByRole: () => ({
      first: () => ({
        isVisible: async () => editorMounted,
        isDisabled: async () => false,
        click: async () => {},
      }),
    }),
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "ppinf", value: "passport-token", domain: ".sohu.com" }],
    close: async () => {},
  };
  const adapter = new SohuAdapter({
    browser: { launchPersistentContext: async () => context },
  });

  const result = await adapter.publishArticle({
    articleTitle: "Zhixin AI Sohu delayed editor test",
    contentMarkdown: "This verifies the editor DOM is mounted before fields are filled.",
  });

  assert.equal(result.platformStatus, "draft_saved");
  assert.ok(actions.some((item) => item[0] === "click" && item[1] === "button.publish-btn"));
});

test("waits for Sohu re-login during publish before filling the editor", async () => {
  const actions = [];
  let loggedIn = false;
  let responseHandler = null;
  const editorUrl = "https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=1";
  const page = {
    _url: "about:blank",
    on: (event, handler) => {
      if (event === "response") responseHandler = handler;
    },
    off: () => {},
    goto: async (url) => {
      actions.push(["goto", url]);
      page._url = loggedIn ? editorUrl : "https://mp.sohu.com/mpfe/v4/login";
    },
    bringToFront: async () => actions.push(["bringToFront"]),
    waitForLoadState: async (state) => actions.push(["waitForLoadState", state]),
    waitForTimeout: async (ms) => actions.push(["waitForTimeout", ms]),
    waitForFunction: async () => actions.push(["waitForFunction"]),
    url: () => page._url,
    title: async () => page._url.includes("/login") ? "搜狐号" : "Sohu creator center",
    evaluate: async (...args) => {
      if (args.length > 1) {
        actions.push(["evaluateWithArg", args[1]]);
        return true;
      }
      return page._url.includes("/login")
        ? "账号登录 手机登录 用户协议 隐私政策 登录"
        : "Sohu creator content management publish draft saved";
    },
    locator: (selector) => {
      if (selector.includes("存草稿")) {
        return createTextLocator(actions, "存草稿", {
          onClick: async () => {
            if (responseHandler) {
              await responseHandler({
                url: () => "https://mp.sohu.com/mpbp/bp/news/v4/news/draft/v2",
                text: async () => JSON.stringify({ status: 0, data: { newsId: "sohu-draft-after-login" } })
              });
            }
          }
        });
      }
      return createLocator(actions, selector, page);
    },
    getByRole: () => ({
      first: () => ({
        isVisible: async () => true,
        isDisabled: async () => false,
        click: async () => {}
      })
    })
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => {
      actions.push(["cookies", loggedIn]);
      if (!loggedIn) {
        loggedIn = true;
        page._url = editorUrl;
        return [];
      }
      return [{ name: "ppinf", value: "fresh-passport-token", domain: ".sohu.com" }];
    },
    close: async () => actions.push(["close"])
  };
  const adapter = new SohuAdapter({
    browser: { launchPersistentContext: async () => context }
  });
  const progress = [];

  const result = await adapter.publishArticle({
    articleTitle: "Zhixin AI Sohu re-login test",
    contentMarkdown: "This verifies Sohu publish resumes after manual login.",
    waitLoginMs: 80,
    loginPollMs: 1,
    keepBrowserOpen: false,
    onProgress: async (event) => progress.push(event)
  });

  assert.equal(result.platformStatus, "draft_saved");
  assert.match(result.draftUrl, /sohu-draft-after-login/);
  assert.ok(progress.some((event) => event.step === "wait_login"));
  assert.ok(progress.some((event) => event.step === "login_restored"));
  assert.ok(actions.filter((item) => item[0] === "goto" && item[1].includes("addarticle")).length >= 2);
});
test("saves a Sohu article draft through the editor flow", async () => {
  const { actions, adapter } = createSohuPublishHarness();

  const result = await adapter.publishArticle({
    articleTitle: "Zhixin AI Sohu draft test",
    contentMarkdown: "This is a Sohu draft flow test article.",
    keepBrowserOpen: false
  });

  assert.equal(result.platformStatus, "draft_saved");
  assert.equal(result.publishedUrl, "");
  assert.match(result.draftUrl, /sohu-draft-001|contentManagement\/news/);
  assert.ok(actions.some((item) => item[0] === "goto" && item[1].includes("/mpfe/v4/contentManagement/news/addarticle")));
  assert.ok(actions.every((item) => item[0] !== "goto" || !item[1].includes("main#/contentManagement/news/addarticle")));
  assert.ok(actions.some((item) => item[0] === "fill" && item[1].includes("title") && item[2] === "Zhixin AI Sohu draft test"));
  assert.ok(actions.some((item) => item[0] === "evaluateWithArg" && item[1]?.text === "This is a Sohu draft flow test article."));
  assert.ok(actions.some((item) => item[0] === "waitForFunction"));
  assert.ok(actions.some((item) => item[0] === "textClick" && item[1] === "存草稿"));
});

test("builds the Sohu draft reload URL from a primitive API data id", async () => {
  const { adapter } = createSohuPublishHarness({
    draftApiPayload: { data: 1050202771, code: 2000000, success: true },
  });

  const result = await adapter.publishArticle({
    articleTitle: "Zhixin AI Sohu primitive draft id test",
    contentMarkdown: "This verifies the current Sohu draft response shape.",
  });

  assert.match(result.draftUrl, /newsId=1050202771/);
});

test("publishes a Sohu article when confirmPublish is explicit", async () => {
  const { actions, adapter } = createSohuPublishHarness({
    publishedUrl: "https://www.sohu.com/a/900000001_122929277"
  });

  const result = await adapter.publishArticle({
    articleTitle: "Zhixin AI Sohu publish test",
    contentMarkdown: "This is a Sohu publish flow test article.",
    confirmPublish: true
  });

  assert.equal(result.platformStatus, "published");
  assert.equal(result.publishedUrl, "https://www.sohu.com/a/900000001_122929277");
  assert.ok(actions.some((item) => item[0] === "textClick" && item[1] === "发布"));
});

test("fills the Sohu abstract and synchronizes Quill content before publishing", async () => {
  const { actions, adapter } = createSohuPublishHarness({
    publishedUrl: "https://www.sohu.com/a/900000005_122929277"
  });

  const result = await adapter.publishArticle({
    articleTitle: "Zhixin AI Sohu metadata test",
    contentMarkdown: "First paragraph.\n\nSecond paragraph.",
    summary: "Short Sohu abstract for publishing.",
    confirmPublish: true
  });

  assert.equal(result.platformStatus, "published");
  assert.ok(actions.some((item) => item[0] === "fill" && item[1].includes("abstract-main-textarea") && item[2] === "Short Sohu abstract for publishing."));
  assert.ok(actions.some((item) => item[0] === "waitForFunction"));
});

test("does not mark Sohu publish successful when platform keeps only a draft", async () => {
  const { adapter } = createSohuPublishHarness({
    publishApiPayload: {
      status: 0,
      data: {
        newsId: "sohu-draft-only-001",
        status: 1,
        auditStatus: 1
      }
    }
  });

  const result = await adapter.publishArticle({
    articleTitle: "Zhixin AI Sohu draft only test",
    contentMarkdown: "This verifies draft-only publish is not treated as success.",
    confirmPublish: true
  });

  assert.equal(result.platformStatus, "draft_saved");
  assert.equal(result.publiclyVisible, false);
  assert.equal(result.publishedUrl, "");
  assert.match(result.reviewUrl, /sohu-draft-only-001/);
});

test("returns Sohu submitted review status when publish is accepted without a public url", async () => {
  const { adapter } = createSohuPublishHarness({
    publishApiPayload: { data: 1050202888, code: 2000000, success: true },
  });

  const result = await adapter.publishArticle({
    articleTitle: "Zhixin AI Sohu pending public url test",
    contentMarkdown: "This verifies Sohu publish acceptance without public URL stays recheckable.",
    confirmPublish: true
  });

  assert.equal(result.platformStatus, "submitted_for_review");
  assert.equal(result.publiclyVisible, false);
  assert.match(result.reviewUrl, /newsId=1050202888/);
  assert.equal(result.publishedUrl, "");
});

test("enters Sohu draft edit mode with a real mouse click before image verification and publish", async () => {
  const actions = [];
  const progress = [];
  let responseHandler = null;
  let mode = "editor";
  let uploaded = false;
  const publicUrl = "https://www.sohu.com/a/900000010_122929277";
  const image = {
    getAttribute: async (name) => name === "src" ? "https://res.mp.sohu.com/inline-real-click.png" : "",
    evaluate: async () => true,
  };
  const page = {
    _url: "about:blank",
    mouse: {
      click: async (x, y) => {
        actions.push(["mouseClick", x, y]);
        if (mode === "readonlyDraft") mode = "draftEdit";
      },
    },
    on: (event, handler) => {
      if (event === "response") responseHandler = handler;
    },
    off: () => {},
    goto: async (url) => {
      actions.push(["goto", url]);
      page._url = url;
      if (url.includes("newsId=sohu-draft-mouse")) mode = "readonlyDraft";
    },
    bringToFront: async () => actions.push(["bringToFront"]),
    waitForLoadState: async (state) => actions.push(["waitForLoadState", state]),
    waitForTimeout: async (ms) => actions.push(["waitForTimeout", ms]),
    waitForFunction: async () => actions.push(["waitForFunction"]),
    url: () => page._url,
    title: async () => "Sohu creator center",
    evaluate: async (...args) => {
      if (args.length > 1) actions.push(["evaluateWithArg", args[1]]);
      if (args[1]?.html) {
        return { ok: true, method: "vue_quill_html", text: "This verifies reopened Sohu drafts enter edit mode before publish.", htmlLength: args[1].html.length, imageCount: uploaded ? 1 : 0 };
      }
      if (String(args[0]).includes("loadedImageCount")) {
        return { text: "This verifies reopened Sohu drafts enter edit mode before publish.", htmlLength: 200, imageCount: uploaded && mode !== "readonlyDraft" ? 1 : 0, loadedImageCount: uploaded && mode !== "readonlyDraft" ? 1 : 0 };
      }
      return mode === "readonlyDraft"
        ? "Sohu creator content management draft continue edit 发布 存草稿"
        : "Sohu creator content management publish draft saved";
    },
    locator: (selector) => {
      if (selector === ".ql-editor:visible img") {
        return {
          count: async () => uploaded && mode !== "readonlyDraft" ? 1 : 0,
          nth: () => image,
        };
      }
      if (selector.includes(".ql-editor")) {
        return {
          first: () => ({
            click: async () => actions.push(["editorClick", selector]),
            fill: async (value) => actions.push(["editorFill", selector, value]),
            evaluate: async () => true,
            dispatchEvent: async (eventName) => actions.push(["editorDispatch", eventName]),
          }),
        };
      }
      if (selector.includes("input[type='file']")) {
        return {
          last: () => ({
            setInputFiles: async (filePath) => {
              uploaded = true;
              actions.push(["upload", filePath]);
            },
          }),
        };
      }
      if (selector.includes("\u7ee7\u7eed\u7f16\u8f91")) {
        return {
          first: () => ({
            click: async () => actions.push(["continueLocatorClick", selector]),
            isVisible: async () => mode === "readonlyDraft",
            isDisabled: async () => false,
            scrollIntoViewIfNeeded: async () => actions.push(["scroll", selector]),
            boundingBox: async () => ({ x: 10, y: 20, width: 120, height: 32 }),
          }),
        };
      }
      if (selector.includes("\u5b58\u8349\u7a3f")) {
        return {
          first: () => ({
            click: async () => {
              actions.push(["saveDraft", selector]);
              if (responseHandler) {
                await responseHandler({
                  url: () => "https://mp.sohu.com/mpbp/bp/news/v4/news/draft/v2",
                  text: async () => JSON.stringify({ code: 2000000, success: true, data: { newsId: "sohu-draft-mouse" } }),
                });
              }
            },
            isVisible: async () => true,
            isDisabled: async () => false,
            scrollIntoViewIfNeeded: async () => {},
          }),
        };
      }
      if (selector.includes("\u53d1\u5e03") && selector.includes("publish-report-btn")) {
        return {
          first: () => ({
            click: async () => {
              actions.push(["publishClick", selector, mode]);
              if (mode !== "readonlyDraft") {
                page._url = publicUrl;
                if (responseHandler) {
                  await responseHandler({
                    url: () => "https://mp.sohu.com/mpbp/bp/news/v4/news/publish/v2",
                    text: async () => JSON.stringify({ code: 2000000, success: true, data: { newsUrl: publicUrl } }),
                  });
                }
              }
            },
            isVisible: async () => true,
            isDisabled: async () => false,
            scrollIntoViewIfNeeded: async () => {},
          }),
        };
      }
      return createLocator(actions, selector, page);
    },
    getByRole: (role, options = {}) => ({
      first: () => ({
        isVisible: async () => true,
        isDisabled: async () => false,
        click: async () => actions.push(["roleClick", role, String(options.name || "")]),
      }),
    }),
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "ppinf", value: "passport-token", domain: ".sohu.com" }],
    close: async () => actions.push(["close"]),
  };
  const adapter = new SohuAdapter({
    browser: { launchPersistentContext: async () => context },
  });

  const result = await adapter.publishArticle({
    articleTitle: "Zhixin AI Sohu mouse edit mode test",
    contentMarkdown: "This verifies reopened Sohu drafts enter edit mode before publish.",
    confirmPublish: true,
    platformImageTasks: [{
      assetId: "asset-sohu-mouse",
      sectionId: "section-sohu-mouse",
      path: "C:\\tmp\\sohu-inline-mouse.png",
    }],
    onProgress: (event) => progress.push(event),
  });

  assert.equal(result.platformStatus, "published");
  assert.equal(result.publishedUrl, publicUrl);
  assert.ok(actions.some((item) => item[0] === "continueLocatorClick"));
  assert.ok(actions.some((item) => item[0] === "mouseClick"));
  assert.ok(progress.some((event) => event.step === "draft_edit_mode_before"));
  assert.ok(progress.some((event) => event.step === "draft_edit_mode_after"));
});

function createSohuManagementEvidencePage(records) {
  const rows = records.map((record) => {
    const row = {
      innerText: record.rowText,
      textContent: record.rowText,
      querySelectorAll: (selector) => selector === "a[href]" ? [anchor] : [],
    };
    const anchor = {
      textContent: record.title,
      getAttribute: (name) => name === "href" ? record.href || "" : name === "title" ? record.title : "",
      closest: (selector) => selector === "li.content-item" ? row : null,
    };
    row.titleAnchor = anchor;
    return row;
  });
  const titleAnchors = rows.map((row) => row.titleAnchor);
  return {
    url: () => "https://mp.sohu.com/mpfe/v4/contentManagement/first/page",
    waitForTimeout: async () => {},
    locator: () => ({
      first: () => ({
        isVisible: async () => false,
        fill: async () => {},
        press: async () => {},
        click: async () => {},
      }),
    }),
    evaluate: async (callback, arg) => {
      const previous = { document: globalThis.document, location: globalThis.location };
      globalThis.location = { origin: "https://mp.sohu.com" };
      globalThis.document = {
        querySelectorAll: (selector) => {
          if (selector.includes("h3.title") || selector.includes("article-content-info")) return titleAnchors;
          if (selector === "a[href]") return titleAnchors;
          return rows;
        },
      };
      try {
        return callback(arg);
      } finally {
        globalThis.document = previous.document;
        globalThis.location = previous.location;
      }
    },
  };
}

test("extracts the real Sohu public URL from an exact management article row", async () => {
  const title = "给中小企业的实操指南";
  const publicUrl = "https://www.sohu.com/a/1053078043_122929277";
  const page = createSohuManagementEvidencePage([{
    title,
    href: publicUrl,
    rowText: `${title} 2026-07-21 21:56 阅读 1 评论 0 编辑 更多`,
  }]);

  const evidence = await readSohuManagementArticleEvidence(page, { articleTitle: title }, { navigate: false });

  assert.equal(evidence.publicUrl, publicUrl);
  assert.match(evidence.rowText, /21:56/);
});

test("prefers the newest exact Sohu management row over an older draft with the same title", async () => {
  const title = "给中小企业的实操指南";
  const publicUrl = "https://www.sohu.com/a/1053078043_122929277";
  const page = createSohuManagementEvidencePage([
    { title, href: "", rowText: `${title} 2026-07-21 21:48 草稿 编辑 更多` },
    { title, href: publicUrl, rowText: `${title} 2026-07-21 21:56 阅读 1 评论 0 编辑 更多` },
  ]);

  const evidence = await readSohuManagementArticleEvidence(page, { articleTitle: title }, { navigate: false });

  assert.equal(evidence.publicUrl, publicUrl);
  assert.match(evidence.rowText, /21:56/);
  assert.doesNotMatch(evidence.rowText, /21:48/);
});
test("discovers a Sohu public article from content management", async () => {
  const actions = [];
  let currentUrl = "";
  const articleTitle = "Zhixin AI Sohu public discovery test";
  const publicUrl = "https://www.sohu.com/a/900000099_122929277";
  const page = {
    goto: async (url) => {
      actions.push(["goto", url]);
      currentUrl = url;
    },
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    waitForFunction: async () => {},
    title: async () => currentUrl === publicUrl ? `${articleTitle} - Sohu` : "Sohu content management",
    url: () => currentUrl,
    evaluate: async (callback, arg) => {
      if (currentUrl === publicUrl) return `${articleTitle}\nDiscovery body paragraph`;
      return callback(arg);
    },
    locator: (selector) => ({
      first: () => ({
        innerText: async () => currentUrl === publicUrl ? `${articleTitle}\nDiscovery body paragraph` : "",
        getAttribute: async () => "",
        isVisible: async () => false,
        fill: async () => {},
        press: async () => {},
        click: async () => {},
      }),
      count: async () => 0,
      nth: () => ({ getAttribute: async () => "", evaluate: async () => false }),
    }),
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "ppinf", value: "passport-token", domain: ".sohu.com" }],
    close: async () => actions.push(["close"]),
  };
  page.evaluate = async (callback, arg) => {
    if (currentUrl === publicUrl) return `${articleTitle}\nDiscovery body paragraph`;
    return publicUrl;
  };
  const adapter = new SohuAdapter({
    browser: { launchPersistentContext: async () => context },
  });

  const result = await adapter.discoverPublication({
    articleTitle,
    contentMarkdown: "Discovery body paragraph",
  });

  assert.equal(result.found, true);
  assert.equal(result.publicUrl, publicUrl);
  assert.ok(actions.some((item) => item[0] === "goto" && item[1].includes("articlelist")));
  assert.ok(actions.some((item) => item[0] === "goto" && item[1] === publicUrl));
});

test("keeps Sohu publication discovery pending when no public URL is visible yet", async () => {
  const actions = [];
  const page = {
    goto: async (url) => actions.push(["goto", url]),
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    evaluate: async () => "",
    locator: () => ({
      first: () => ({
        innerText: async () => "",
        getAttribute: async () => "",
        isVisible: async () => false,
        fill: async () => {},
        press: async () => {},
        click: async () => {},
      }),
      count: async () => 0,
      nth: () => ({ getAttribute: async () => "", evaluate: async () => false }),
    }),
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "ppinf", value: "passport-token", domain: ".sohu.com" }],
    close: async () => actions.push(["close"]),
  };
  const adapter = new SohuAdapter({
    browser: { launchPersistentContext: async () => context },
  });

  const result = await adapter.discoverPublication({
    articleTitle: "Sohu article still under review",
    publicUrl: "https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=1&newsId=1051344766",
  });

  assert.equal(result.found, false);
  assert.equal(result.platformStatus, "pending_public_visibility");
  assert.equal(result.publiclyVisible, false);
  assert.ok(actions.some((item) => item[0] === "goto" && item[1].includes("articlelist")));
});

test("reports Sohu rejected management evidence instead of pending public discovery", async () => {
  const articleTitle = "Sohu rejected article must not keep a backlink";
  const page = {
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    url: () => "https://mp.sohu.com/mpfe/v4/contentManagement/news/articlelist",
    evaluate: async () => ({
      found: true,
      articleTitle,
      rowText: `${articleTitle} 2026-07-26 09:10 未通过 栏目0 更多`,
      statusText: "未通过",
      publicUrl: "",
    }),
    locator: () => ({
      first: () => ({
        innerText: async () => "",
        getAttribute: async () => "",
        isVisible: async () => false,
        fill: async () => {},
        press: async () => {},
        click: async () => {},
      }),
      count: async () => 0,
      nth: () => ({ getAttribute: async () => "", evaluate: async () => false }),
    }),
  };

  const result = await inspectSohuPublicArticle(page, { articleTitle });

  assert.equal(result.found, false);
  assert.equal(result.publicUrl, "");
  assert.equal(result.publishedUrl, "");
  assert.equal(result.platformStatus, "rejected");
  assert.equal(result.reviewStatus, "rejected");
  assert.equal(result.publiclyVisible, false);
  assert.match(result.message, /审核未通过/);
  assert.equal(result.managementEvidence.statusText, "未通过");
});

test("verifies Sohu public images only from the article body", async () => {
  const articleTitle = "Sohu public image body scope";
  const articleImages = [
    "https://q4.itc.cn/images01/20260728/body-one.png",
    "https://q5.itc.cn/images01/20260728/body-two.png",
  ];
  const uiImages = [
    "https://c1494161c414f.cdn.sohucs.com/user-profilephoto/merged-photo/14.jpg",
    "https://statics.itc.cn/mptc-mpfe/img/article/icon_comment.png",
    "https://statics.itc.cn/web/static/images/pic/preload.png",
  ];
  const imageEvidence = {
    expected: [
      { assetId: "asset-one", sectionId: "s1", position: 2 },
      { assetId: "asset-two", sectionId: "s2", position: 4 },
    ],
    upload: {
      images: [
        { assetId: "asset-one", sectionId: "s1", position: 2, platformImageUrl: "https://res.mp.sohu.com/upload-one.png", loaded: true },
        { assetId: "asset-two", sectionId: "s2", position: 4, platformImageUrl: "https://res.mp.sohu.com/upload-two.png", loaded: true },
      ],
    },
    draft: {
      images: [
        { assetId: "asset-one", sectionId: "s1", position: 2, platformImageUrl: "https://res.mp.sohu.com/draft-one.png", loaded: true },
        { assetId: "asset-two", sectionId: "s2", position: 4, platformImageUrl: "https://res.mp.sohu.com/draft-two.png", loaded: true },
      ],
    },
  };
  const page = {
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForFunction: async () => {},
    title: async () => `${articleTitle} - Sohu`,
    locator: (selector) => {
      if (selector.includes("article, .article-content")) {
        return {
          first: () => ({ innerText: async () => `${articleTitle}\nBody paragraph` }),
        };
      }
      const images = selector.includes("body img") ? [...uiImages, ...articleImages] : articleImages;
      return {
        count: async () => images.length,
        nth: (index) => ({
          getAttribute: async (name) => (name === "src" ? images[index] : ""),
          evaluate: async () => ({ currentSrc: images[index], loaded: true }),
        }),
      };
    },
  };

  const result = await inspectSohuPublicArticle(page, {
    articleTitle,
    contentMarkdown: "Body paragraph",
    publicUrl: "https://www.sohu.com/a/1055612980_122929277",
    imagePublicationEvidence: imageEvidence,
  });

  assert.equal(result.found, true);
  assert.equal(result.imagePublicationEvidence.status, "verified");
  assert.deepEqual(
    result.imagePublicationEvidence.public.images.map((image) => image.platformImageUrl),
    articleImages,
  );
});

test("uses Sohu imgsList when article DOM keeps encoded image data", async () => {
  const articleTitle = "Sohu public cfgs image list";
  const articleImages = [
    "https://q4.itc.cn/images01/20260728/cfgs-one.png",
    "https://q3.itc.cn/images01/20260728/cfgs-two.png",
  ];
  const imageEvidence = {
    expected: [
      { assetId: "asset-one", sectionId: "s1", position: 2 },
      { assetId: "asset-two", sectionId: "s2", position: 4 },
    ],
    upload: {
      images: [
        { assetId: "asset-one", sectionId: "s1", position: 2, platformImageUrl: "https://res.mp.sohu.com/upload-one.png", loaded: true },
        { assetId: "asset-two", sectionId: "s2", position: 4, platformImageUrl: "https://res.mp.sohu.com/upload-two.png", loaded: true },
      ],
    },
    draft: {
      images: [
        { assetId: "asset-one", sectionId: "s1", position: 2, platformImageUrl: "https://res.mp.sohu.com/draft-one.png", loaded: true },
        { assetId: "asset-two", sectionId: "s2", position: 4, platformImageUrl: "https://res.mp.sohu.com/draft-two.png", loaded: true },
      ],
    },
  };
  const page = {
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForFunction: async () => {},
    title: async () => `${articleTitle} - Sohu`,
    evaluate: async () => articleImages.map((url) => `//${new URL(url).host}${new URL(url).pathname}`),
    locator: (selector) => {
      if (selector.includes("article, .article-content")) {
        return {
          first: () => ({ innerText: async () => `${articleTitle}\nBody paragraph` }),
        };
      }
      return {
        count: async () => 2,
        nth: (index) => ({
          getAttribute: async (name) => (name === "data-src" ? `encoded-${index}` : ""),
          evaluate: async () => ({ currentSrc: "", loaded: true }),
        }),
      };
    },
  };

  const result = await inspectSohuPublicArticle(page, {
    articleTitle,
    contentMarkdown: "Body paragraph",
    publicUrl: "https://www.sohu.com/a/1055612980_122929277",
    imagePublicationEvidence: imageEvidence,
  });

  assert.equal(result.found, true);
  assert.equal(result.imagePublicationEvidence.status, "verified");
  assert.deepEqual(
    result.imagePublicationEvidence.public.images.map((image) => image.platformImageUrl),
    articleImages,
  );
});

test("matches Sohu public body against rendered markdown text", async () => {
  const articleTitle = "作为OPC，这些准备工作必须到位";
  const pageBody = `${articleTitle}
一、理解OPC的角色：从定义到核心职责

在正式着手准备工作之前，必须对OPC有一个清晰的认知。OPC是“Operator Control”或“Operations Control”的简称，在不同行业中具体指代略有差异。

A person studying a detailed organizational chart and job description on a tablet.

二、技术与工具准备：搭建得心应手的工作台

工欲善其事，必先利其器。OPC的工作高度依赖可视化界面、控制系统和通信工具。`;
  const contentMarkdown = `# ${articleTitle}

## 一、理解OPC的角色：从定义到核心职责

在正式着手准备工作之前，必须对OPC有一个清晰的认知。OPC是“Operator Control”或“Operations Control”的简称，在不同行业中具体指代略有差异。

![A person studying a detailed organizational chart and job description on a tablet.](/uploads/assets/asset-one-inline.png)

## 二、技术与工具准备：搭建得心应手的工作台

工欲善其事，必先利其器。OPC的工作高度依赖可视化界面、控制系统和通信工具。`;
  const page = {
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForFunction: async () => {},
    title: async () => `${articleTitle}_操作_and_Control`,
    evaluate: async () => [],
    locator: (selector) => {
      if (selector.includes("article, .article-content")) {
        return {
          first: () => ({ innerText: async () => pageBody }),
        };
      }
      return {
        count: async () => 0,
        nth: () => ({ getAttribute: async () => "", evaluate: async () => ({}) }),
      };
    },
  };

  const result = await inspectSohuPublicArticle(page, {
    articleTitle,
    contentMarkdown,
    publicUrl: "https://www.sohu.com/a/1055612980_122929277",
  });

  assert.equal(result.titleMatched, true);
  assert.equal(result.bodyMatched, true);
  assert.equal(result.found, true);
});

test("does not treat unrelated Sohu article links on the editor page as publish success", async () => {
  const { adapter } = createSohuPublishHarness({
    fallbackPublishedHref: "https://www.sohu.com/a/1045389888_119436"
  });

  const result = await adapter.publishArticle({
    articleTitle: "Zhixin AI Sohu unrelated link test",
    contentMarkdown: "This verifies unrelated links are ignored.",
    confirmPublish: true
  });

  assert.equal(result.platformStatus, "draft_saved");
  assert.equal(result.publiclyVisible, false);
  assert.equal(result.publishedUrl, "");
  assert.match(result.reviewUrl, /sohu-draft-001/);
});

test("uses Sohu publish API response when the page does not expose a public link", async () => {
  const { adapter } = createSohuPublishHarness({
    publishApiPayload: {
      status: 0,
      data: {
        newsId: "sohu-news-002",
        newsUrl: "https://www.sohu.com/a/900000002_122929277"
      }
    }
  });

  const result = await adapter.publishArticle({
    articleTitle: "Zhixin AI Sohu API response test",
    contentMarkdown: "This test verifies Sohu publish API response extraction.",
    confirmPublish: true
  });

  assert.equal(result.platformStatus, "published");
  assert.equal(result.publishedUrl, "https://www.sohu.com/a/900000002_122929277");
});

test("treats exact Sohu management row under review as accepted after publish navigation", async () => {
  const articleTitle = "Zhixin Sohu Cover Evidence Test 20260718-104643";
  const page = {
    url: () => "https://mp.sohu.com/mpfe/v4/contentManagement/first/page",
    goto: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    locator: () => ({
      first: () => ({
        isVisible: async () => false,
        fill: async () => {},
        press: async () => {},
        click: async () => {},
      }),
    }),
    evaluate: async () => ({
      found: true,
      articleTitle,
      statusText: "审核中",
      rowText: `${articleTitle} 2026-07-18 10:46 Verify Sohu cover upload evidence and publication loop. 审核中 栏目0 更多`,
      publicUrl: "",
      currentUrl: "https://mp.sohu.com/mpfe/v4/contentManagement/first/page",
    }),
  };

  const result = await resolveSohuAcceptedManagementFallback(page, {
    title: articleTitle,
    articleTitle,
  }, {
    draftUrl: "https://mp.sohu.com/mpfe/v4/contentManagement/news/addarticle?contentStatus=1&newsId=1051344766",
  });

  assert.equal(result.platformStatus, "submitted_for_review");
  assert.equal(result.reviewStatus, "pending_public_visibility");
  assert.equal(result.publiclyVisible, false);
  assert.equal(result.managementEvidence.statusText, "审核中");
  assert.match(result.reviewUrl, /newsId=1051344766/);
});

test("returns accepted Sohu management result when initial cover configuration lands on review list", async () => {
  const articleTitle = "Zhixin Sohu Closed Loop Test 20260718-105831";
  const { adapter } = createSohuPublishHarness({
    failCoverConfigToManagement: true,
    managementArticleTitle: articleTitle,
  });

  const result = await adapter.publishArticle({
    articleTitle,
    contentMarkdown: "This test verifies early Sohu management fallback.",
    coverImagePath: "C:\\tmp\\sohu-cover.png",
    confirmPublish: true,
    draftTimeoutMs: 20,
  });

  assert.equal(result.platformStatus, "submitted_for_review");
  assert.equal(result.reviewStatus, "pending_public_visibility");
  assert.equal(result.publiclyVisible, false);
  assert.equal(result.managementEvidence.articleTitle, articleTitle);
  assert.match(result.reviewUrl, /contentManagement\/first\/page/);
});

test("confirms a Sohu post-publish dialog before reading the public link", async () => {
  const actions = [];
  let responseHandler = null;
  let afterConfirm = false;
  const page = {
    _url: "https://mp.sohu.com/mpfe/v4/main#/contentManagement/news/addarticle?contentStatus=1",
    on: (event, handler) => {
      if (event === "response") responseHandler = handler;
    },
    off: () => {},
    goto: async (url) => {
      actions.push(["goto", url]);
      page._url = url;
    },
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    waitForFunction: async () => {},
    url: () => page._url,
    title: async () => "Sohu creator center",
    evaluate: async () => "Sohu creator content management publish draft saved Zhixin AI Sohu dialog test",
    locator: (selector) => ({
      first: () => ({
        fill: async (value) => actions.push(["fill", selector, value]),
        click: async () => {
          actions.push(["click", selector]);
          if (selector.includes("ant-modal")) page._url = "https://www.sohu.com/a/900000003_122929277";
          if (selector.includes("ant-modal") || selector.includes("确定") || selector.includes("确认")) afterConfirm = true;
        },
        isDisabled: async () => false,
        isVisible: async () => selector.includes("ant-modal"),
        getAttribute: async () => (
          afterConfirm && selector.includes("sohu.com/a/")
            ? "https://www.sohu.com/a/900000003_122929277"
            : ""
        ),
        dispatchEvent: async () => {}
      })
    }),
    getByRole: (role, options = {}) => ({
      first: () => ({
        isVisible: async () => true,
        isDisabled: async () => false,
        click: async () => {
          const name = options.name?.toString?.() || String(options.name || "");
          actions.push(["roleClick", role, name]);
          if (name.includes("draft") && responseHandler) {
            await responseHandler({
              url: () => "https://mp.sohu.com/mpbp/bp/news/v4/news/draft/v2",
              text: async () => JSON.stringify({ status: 0, data: { newsId: "sohu-draft-003" } })
            });
          }
        }
      })
    })
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "ppinf", value: "passport-token", domain: ".sohu.com" }],
    close: async () => {}
  };
  const adapter = new SohuAdapter({
    browser: {
      launchPersistentContext: async () => context
    }
  });

  const result = await adapter.publishArticle({
    articleTitle: "Zhixin AI Sohu dialog test",
    contentMarkdown: "This test verifies Sohu post publish dialog confirmation.",
    confirmPublish: true
  });

  assert.equal(result.publishedUrl, "https://www.sohu.com/a/900000003_122929277");
  assert.ok(actions.some((item) => item[0] === "click" && item[1].includes("ant-modal")));
});

test("does not hang when Sohu post-publish dialog click never settles", async () => {
  const { adapter } = createSohuPublishHarness({
    hangPostPublishDialog: true
  });

  const result = await adapter.publishArticle({
    articleTitle: "Zhixin AI Sohu hanging dialog test",
    contentMarkdown: "This verifies a stuck Sohu confirmation dialog cannot keep a command running forever.",
    confirmPublish: true,
    publishTimeoutMs: 20
  });

  assert.equal(result.platformStatus, "draft_saved");
  assert.equal(result.publiclyVisible, false);
  assert.equal(result.publishedUrl, "");
});

test("reports Sohu verification or platform blockers as manual action", async () => {
  const progress = [];
  const { actions, adapter } = createSohuPublishHarness({
    // A content blocker has nothing a person can click, so it must fail fast.
    blockerVisibleText: "\u654f\u611f\u8bcd\u8bcd\u8bcd"
  });

  await assert.rejects(() => adapter.publishArticle({
    articleTitle: "Zhixin AI Sohu blocker test",
    contentMarkdown: "This test verifies Sohu manual blockers.",
    confirmPublish: true,
    manualVerificationTimeoutMs: 3000,
    onProgress: (event) => progress.push(event)
  }), /SOHU_MANUAL_ACTION_REQUIRED/);

  const manualEvent = progress.find((event) => event.type === "manual_verification_required");
  assert.equal(manualEvent?.type, "manual_verification_required");
  assert.equal(manualEvent?.platform, "sohu");
  // A toast-only blocker is not a gate, so the adapter never waits for a person.
  assert.equal(actions.some(([name, ms]) => name === "waitForTimeout" && ms === 3000), false);
});

test("stops Sohu publish on the clientAuth SMS gate instead of failing obscurely", async () => {
  const progress = [];
  const clientAuthUrl = "https://mp.sohu.com/mpfe/v4/clientAuth?bizType=2&redirect=%2Fmpfe%2Fv4%2FcontentManagement%2Fnews%2Faddarticle";
  const { adapter } = createSohuPublishHarness();

  await assert.rejects(() => adapter.publishArticle({
    articleTitle: "Zhixin AI Sohu clientAuth test",
    contentMarkdown: "This verifies the Sohu SMS gate surfaces as manual verification.",
    confirmPublish: true,
    editorUrl: clientAuthUrl,
    manualVerificationTimeoutMs: 3000,
    onProgress: (event) => progress.push(event)
  }), /SOHU_MANUAL_ACTION_REQUIRED/);

  const manualEvent = progress.find((event) => event.type === "manual_verification_required");
  assert.equal(manualEvent?.type, "manual_verification_required");
  assert.equal(manualEvent?.platform, "sohu");
  assert.equal(manualEvent?.currentUrl, clientAuthUrl);
  assert.match(manualEvent?.message || "", /短信验证码/);
});

test("reports the Sohu clientAuth SMS gate even when it appears mid-flight", async () => {
  const progress = [];
  const clientAuthUrl = "https://mp.sohu.com/mpfe/v4/clientAuth?bizType=2";
  const { adapter } = createSohuPublishHarness({ clientAuthUrl });

  await assert.rejects(() => adapter.publishArticle({
    articleTitle: "Zhixin AI Sohu mid-flight clientAuth test",
    contentMarkdown: "This verifies a mid-flight Sohu SMS gate is still reported.",
    confirmPublish: true,
    manualVerificationTimeoutMs: 3000,
    onProgress: (event) => progress.push(event)
  }), /SOHU_MANUAL_ACTION_REQUIRED/);

  const manualEvent = progress.find((event) => event.type === "manual_verification_required");
  assert.equal(manualEvent?.currentUrl, clientAuthUrl);
});

test("resumes the Sohu publish once the clientAuth SMS gate is cleared", async () => {
  const progress = [];
  const clientAuthUrl = "https://mp.sohu.com/mpfe/v4/clientAuth?bizType=2";
  const { actions, adapter } = createSohuPublishHarness({
    clientAuthUrl,
    clientAuthClears: true,
    publishedUrl: "https://www.sohu.com/a/900000010_122929277"
  });

  const result = await adapter.publishArticle({
    articleTitle: "Zhixin AI Sohu gate resume test",
    contentMarkdown: "This verifies the Sohu publish continues after the SMS gate clears.",
    confirmPublish: true,
    manualVerificationTimeoutMs: 30000,
    onProgress: (event) => progress.push(event)
  });

  assert.equal(result.platformStatus, "published");
  assert.equal(result.publishedUrl, "https://www.sohu.com/a/900000010_122929277");

  const gateEvent = progress.find((event) => event.type === "manual_verification_required");
  assert.equal(gateEvent?.currentUrl, clientAuthUrl);
  assert.match(gateEvent?.message || "", /\u9a8c\u8bc1\u901a\u8fc7\u540e\u4f1a\u81ea\u52a8\u7ee7\u7eed\u53d1\u5e03/);
  assert.ok(actions.some(([name, ms]) => name === "waitForTimeout" && ms === 3000));
});

test("retries the Sohu cover upload after the SMS gate is cleared", async () => {
  const progress = [];
  const clientAuthUrl = "https://mp.sohu.com/mpfe/v4/clientAuth?bizType=2";
  const { actions, adapter } = createSohuPublishHarness({
    clientAuthUrl,
    clientAuthClears: true,
    coverUploadGate: true
  });

  await assert.rejects(() => adapter.publishArticle({
    articleTitle: "Zhixin AI Sohu cover gate test",
    contentMarkdown: "This verifies the Sohu cover security answer is waited out.",
    coverImagePath: "C:\\tmp\\sohu-cover.png",
    confirmPublish: true,
    draftTimeoutMs: 20,
    manualVerificationTimeoutMs: 30000,
    onProgress: (event) => progress.push(event)
  }), /SOHU_MANUAL_ACTION_REQUIRED/);

  // The cover entry opens twice: the gate cleared in between, so the adapter
  // retried the upload instead of giving up on the first security answer.
  const coverClicks = actions.filter(([name, selector]) => name === "click" && selector === ".cover-button");
  assert.equal(coverClicks.length, 2);
  const gateEvent = progress.find((event) => event.type === "manual_verification_required");
  assert.equal(gateEvent?.currentUrl, clientAuthUrl);
  assert.match(gateEvent?.message || "", /自动继续发布/);
});

test("does not wait for the Sohu SMS gate in a headless browser", async () => {
  const progress = [];
  const clientAuthUrl = "https://mp.sohu.com/mpfe/v4/clientAuth?bizType=2";
  const { actions, adapter } = createSohuPublishHarness({ clientAuthUrl });

  await assert.rejects(() => adapter.publishArticle({
    articleTitle: "Zhixin AI Sohu headless gate test",
    contentMarkdown: "This verifies nobody can clear the Sohu SMS gate without a window.",
    confirmPublish: true,
    headless: true,
    manualVerificationTimeoutMs: 30000,
    onProgress: (event) => progress.push(event)
  }), /SOHU_MANUAL_ACTION_REQUIRED/);

  assert.ok(progress.some((event) => event.type === "manual_verification_required"));
  assert.equal(actions.some(([name, ms]) => name === "waitForTimeout" && ms === 3000), false);
});

test("does not treat normal Sohu list counters as manual publish blockers", async () => {
  const { adapter } = createSohuPublishHarness({
    text: "Sohu creator center 已发布0 审核中0 未通过0 草稿0 定时发布0",
    publishedUrl: "https://www.sohu.com/a/900000004_122929277"
  });

  const result = await adapter.publishArticle({
    articleTitle: "Zhixin AI Sohu normal counters test",
    contentMarkdown: "This test verifies ordinary list counters are not blockers.",
    confirmPublish: true
  });

  assert.equal(result.platformStatus, "published");
  assert.equal(result.publishedUrl, "https://www.sohu.com/a/900000004_122929277");
});

test("does not treat ordinary Sohu declaration labels as manual blockers", async () => {
  const { adapter } = createSohuPublishHarness({
    text: "Sohu creator center publish draft saved 原创声明 包含AI创作内容 信息来源 无特别声明",
    publishedUrl: "https://www.sohu.com/a/900000006_122929277"
  });

  const result = await adapter.publishArticle({
    articleTitle: "Zhixin AI Sohu declaration label test",
    contentMarkdown: "This verifies ordinary declaration labels are not blockers.",
    confirmPublish: true
  });

  assert.equal(result.platformStatus, "published");
  assert.equal(result.publishedUrl, "https://www.sohu.com/a/900000006_122929277");
});

test("publishes Sohu through the browser API context when account configuration is available", async () => {
  const calls = [];
  const page = {
    request: {
      async fetch(url, options = {}) {
        calls.push({ url, options });
        return {
          status: () => 200,
          url: () => url,
          text: async () => JSON.stringify({ code: 2000000, success: true, data: 1055223497 }),
        };
      },
    },
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "ppinf", value: "passport-token", domain: ".sohu.com" }],
    close: async () => calls.push({ close: true }),
  };
  const adapter = new SohuAdapter({
    browser: { launchPersistentContext: async () => context },
  });

  const result = await adapter.publishArticle({
    articleTitle: "Sohu API-first publish test",
    contentMarkdown: "This verifies the Sohu API publish path keeps public URLs empty until verified.",
    contentHtml: "<p>This verifies the Sohu API publish path keeps public URLs empty until verified.</p>",
    confirmPublish: true,
    apiFirst: true,
    platformConfig: {
      accountId: "122929277",
      channelId: 47,
      categoryId: -1,
    },
  });

  assert.equal(result.platformStatus, "submitted_for_review");
  assert.equal(result.publishedUrl, "");
  assert.equal(result.externalIds.newsId, "1055223497");
  assert.match(result.reviewUrl, /newsId=1055223497/);
  assert.equal(result.publicationEvidence.source, "api");
  assert.equal(result.publicationEvidence.accepted, true);
  assert.ok(calls.some((call) => String(call.url || "").includes("/mpbp/bp/news/v4/news/draft/v2?accountId=122929277")));
  assert.doesNotMatch(JSON.stringify(result.publicationEvidence), /passport-token/);
});

test("publishes Sohu through the captured draft, limit, and direct-publish API sequence", async () => {
  const calls = [];
  const page = {
    request: {
      async fetch(url, options = {}) {
        calls.push({ url, options });
        const path = new URL(url).pathname;
        const payload = path.endsWith("/draft/v2")
          ? { code: 2000000, success: true, data: 1059241000 }
          : { code: 2000000, success: true, data: true };
        return { status: () => 200, url: () => url, text: async () => JSON.stringify(payload) };
      },
    },
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "ppinf", value: "passport-token", domain: ".sohu.com" }],
    close: async () => undefined,
  };
  const adapter = new SohuAdapter({ browser: { launchPersistentContext: async () => context } });

  const result = await adapter.publishArticle({
    articleTitle: "Sohu captured API chain test",
    contentMarkdown: "This test follows the captured Sohu submission sequence.",
    confirmPublish: true,
    apiFirst: true,
    platformConfig: { accountId: "122929277", channelId: 47, categoryId: -1 },
  });

  const paths = calls.map((call) => new URL(call.url).pathname);
  assert.deepEqual(paths, [
    "/mpbp/bp/news/v4/news/draft/v2",
    "/mpbp/bp/news/v4/news/publishLimit",
    "/mpbp/bp/news/v4/news/1059241000/publishDirect",
  ]);
  assert.equal(new URLSearchParams(calls[2].options.data).get("accountId"), "122929277");
  assert.equal(result.externalIds.newsId, "1059241000");
  assert.equal(result.platformStatus, "submitted_for_review");
  assert.doesNotMatch(JSON.stringify(result.publicationEvidence), /passport-token/);
});
