import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { uploadJianshuInlineImages } from "../src/adapters/jianshu.mjs";
import { uploadNeteaseInlineImages } from "../src/adapters/netease.mjs";
import { uploadPenguinInlineImages } from "../src/adapters/penguin.mjs";
import { uploadSohuInlineImages } from "../src/adapters/sohu.mjs";
import { uploadToutiaoInlineImages } from "../src/adapters/toutiao.mjs";

function createImagePage(platformImageUrl, options = {}) {
  const actions = [];
  const images = [];
  let selectedEditorBlockIndex = -1;
  const editor = {
    async evaluate(_callback, payload) {
      actions.push(["editorEvaluate", payload]);
      if (payload?.base64) images.push({ src: platformImageUrl, alt: "正文图" });
      if (payload?.sectionTitle) {
        return { targetIndex: 1, headingIndex: 0, nextHeadingIndex: 2 };
      }
      if (Number.isInteger(payload?.targetIndex)) {
        return selectedEditorBlockIndex >= payload.headingIndex
          && selectedEditorBlockIndex < payload.nextHeadingIndex;
      }
      return true;
    },
    locator(selector) {
      assert.equal(selector, ":scope > *");
      return {
        nth(index) {
          return {
            async scrollIntoViewIfNeeded() { actions.push(["scrollEditorBlock", index]); },
            async boundingBox() { return { x: 0, y: index * 40, width: 640, height: 32 }; },
            async click(clickOptions) {
              selectedEditorBlockIndex = index;
              actions.push(["clickEditorBlock", index, clickOptions]);
            },
          };
        },
      };
    },
  };
  const imageLocator = {
    async count() { return images.length; },
    nth(index) {
      return {
        async getAttribute(name) { return name === "src" ? images[index].src : images[index].alt; },
        async evaluate() { return true; },
      };
    },
  };
  const page = {
    keyboard: {
      async press(key) { actions.push(["keyboardPress", key]); },
    },
    locator(selector) {
      if (selector.includes(" img") || selector.endsWith("img")) return imageLocator;
      return {
        first() {
          if (/ProseMirror|ql-editor|kalamu-area|DraftEditor|contenteditable/.test(selector)) return editor;
          return {
            async click() { actions.push(["click", selector]); },
            async isVisible() { return true; },
            async setInputFiles(filePath) {
              actions.push(["file", selector, filePath]);
              images.push({ src: platformImageUrl, alt: "正文图" });
            },
          };
        },
        last() {
          return this.first();
        },
      };
    },
    frameLocator() {
      return {
        locator(selector) {
          if (selector.includes("img")) return imageLocator;
          return { first: () => editor };
        },
      };
    },
    getByRole(role, roleOptions = {}) {
      return {
        first() {
          return {
            async click() { actions.push(["roleClick", role, String(roleOptions.name || "")]); },
          };
        },
      };
    },
    getByText(pattern) {
      return {
        first() {
          return {
            async waitFor() { actions.push(["waitForText", String(pattern)]); },
          };
        },
      };
    },
    async waitForFunction() { actions.push(["waitForFunction"]); },
    async waitForResponse(predicate) {
      const creating = actions.filter((item) => item[0] === "imageApiCreated").length === 0;
      const response = creating ? {
        url: () => "https://api.zhihu.com/images",
        status: () => 200,
        request: () => ({ method: () => "POST" }),
        json: async () => ({ upload_file: { image_id: "123456" } }),
      } : {
        url: () => "https://api.zhihu.com/images/123456",
        status: () => 200,
        request: () => ({ method: () => "GET" }),
      };
      assert.equal(predicate(response), true);
      actions.push([creating ? "imageApiCreated" : "imageApiCompleted"]);
      return response;
    },
  };
  return { actions, page, images, editor, options };
}

const localFile = fileURLToPath(import.meta.url);
const task = {
  assetId: "asset-inline",
  sectionId: "workflow",
  sectionTitle: "实施流程",
  position: 2,
  path: localFile,
};

const cases = [
  ["Sohu", uploadSohuInlineImages, "https://p0.itc.cn/inline.png", "ql-image"],
  ["NetEase", uploadNeteaseInlineImages, "https://dingyue.ws.126.net/inline.png", "image"],
  ["Toutiao", uploadToutiaoInlineImages, "https://p3-sign.toutiaoimg.com/inline.png", "syl-toolbar-tool.image"],
  ["Jianshu", uploadJianshuInlineImages, "https://upload-images.jianshu.io/inline.png", "openImageModal"],
];

for (const [name, upload, url, expectedSelector] of cases) {
  test(`uploads ${name} body images through its native editor control`, async () => {
    const { actions, page } = createImagePage(url);

    const result = await upload(page, [task]);

    assert.equal(result[0].platformImageUrl, url);
    assert.ok(actions.some((item) => item[0] === "click" && item[1].includes(expectedSelector)));
    // Some platforms fall back to ProseMirror paste/drop when the toolbar file input is unavailable.
    assert.ok(
      actions.some((item) => item[0] === "file" && item[2] === localFile)
      || actions.some((item) => item[0] === "editorEvaluate" && item[1]?.base64)
    );
  });
}

test("uploads Penguin body images through the ProseMirror native paste handler", async () => {
  const url = "https://inews.gtimg.com/inline.png";
  const { actions, page } = createImagePage(url);

  const result = await uploadPenguinInlineImages(page, [task]);

  assert.equal(result[0].platformImageUrl, url);
  assert.ok(actions.some((item) => item[0] === "editorEvaluate" && item[1]?.base64));
  assert.equal(actions.some((item) => item[0] === "file"), false);
});
