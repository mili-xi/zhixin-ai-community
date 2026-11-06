import assert from "node:assert/strict";
import test from "node:test";
import { bindContentBlocksToImages, composeRichArticleHtml } from "../src/rich-content.mjs";

test("binds downloaded images to their ordered section blocks", () => {
  const blocks = [
    { type: "title", text: "图文文章" },
    { type: "section", sectionId: "first", title: "第一节", content: "第一节正文" },
    { type: "image", sectionId: "first", assetId: "asset-first", url: "/uploads/first.png", altText: "第一节插图" },
    { type: "section", sectionId: "second", title: "第二节", content: "第二节正文" },
    { type: "image", sectionId: "second", assetId: "asset-second", url: "/uploads/second.png", altText: "第二节插图" },
  ];
  const images = [
    { assetId: "asset-first", sectionId: "first", path: "C:/local/first.png", dataUrl: "data:image/png;base64,Zmlyc3Q=" },
    { assetId: "asset-second", sectionId: "second", path: "C:/local/second.png", dataUrl: "data:image/png;base64,c2Vjb25k" },
  ];

  const result = bindContentBlocksToImages(blocks, images);

  assert.equal(result[2].path, "C:/local/first.png");
  assert.equal(result[4].path, "C:/local/second.png");
});

test("composes section-aware rich html with inline images", () => {
  const html = composeRichArticleHtml([
    { type: "section", sectionId: "first", title: "第一节", content: "第一段\n\n第二段" },
    { type: "image", sectionId: "first", platformImageUrl: "https://img-blog.csdnimg.cn/direct/first.png", altText: "第一节插图" },
  ]);

  assert.match(html, /<h2[^>]*>第一节<\/h2>/);
  assert.match(html, /<p style="margin: 0 0 12px; line-height: 1.8;">.*<\/p><p style="margin: 0 0 12px; line-height: 1.8;">.*<\/p>/);
  assert.match(html, /<img[^>]+src="https:\/\/img-blog\.csdnimg\.cn\/direct\/first\.png"[^>]+alt="第一节插图"/);
  assert.ok(html.indexOf("第一节") < html.indexOf("第一节插图"));
});


test("composes rich html with clean spacing and figure framing", () => {
  const html = composeRichArticleHtml([
    { type: "section", sectionId: "workflow", title: "Workflow", content: "First paragraph.\n\nSecond paragraph." },
    { type: "image", sectionId: "workflow", platformImageUrl: "https://img-blog.csdnimg.cn/direct/workflow.png", altText: "Workflow image" },
  ]);

  assert.match(html, /style="margin: 0 0 24px;"/);
  assert.match(html, /style="margin: 0 0 12px; line-height: 1.8;"/);
  assert.match(html, /style="margin: 20px 0; text-align: center;"/);
  assert.match(html, /style="display: block; max-width: 100%; height: auto; margin: 0 auto 8px;"/);
  assert.match(html, /style="margin: 0; font-size: 12px; color: #666; text-align: center;"/);
});test("composes section-aware editor html without transient images", () => {
  const html = composeRichArticleHtml([
    { type: "section", sectionId: "first", title: "第一节", content: "正文" },
    { type: "image", sectionId: "first", dataUrl: "data:image/png;base64,Zmlyc3Q=", altText: "第一节插图" },
  ], { includeImages: false });

  assert.match(html, /data-zhixin-section="first"/);
  assert.doesNotMatch(html, /<img|data:image/);
});

test("prefers the uploaded platform image url over local materialized bytes", () => {
  const html = composeRichArticleHtml([
    { type: "section", sectionId: "first", title: "第一节", content: "正文" },
    {
      type: "image",
      sectionId: "first",
      platformImageUrl: "https://img-blog.csdnimg.cn/direct/uploaded.png",
      url: "https://img-blog.csdnimg.cn/direct/uploaded.png",
      dataUrl: "data:image/png;base64,Zmlyc3Q=",
      altText: "第一节插图",
    },
  ]);

  assert.match(html, /<img[^>]+src="https:\/\/img-blog\.csdnimg\.cn\/direct\/uploaded\.png"/);
  assert.doesNotMatch(html, /data:image/);
});

test("drops image blocks whose bytes never reached a public url", () => {
  const html = composeRichArticleHtml([
    { type: "section", sectionId: "first", title: "第一节", content: "正文" },
    { type: "image", sectionId: "first", url: "/uploads/assets/local.png", dataUrl: "data:image/png;base64,Zmlyc3Q=", altText: "本地图" },
  ]);

  assert.match(html, /<h2[^>]*>第一节<\/h2>/);
  assert.doesNotMatch(html, /<img|data:image|\/uploads\//);
});

test("keeps a public https url when no platform url was recorded", () => {
  const html = composeRichArticleHtml([
    { type: "image", sectionId: "first", url: "https://upload-images.jianshu.io/upload_images/first.png", altText: "公网图" },
  ]);

  assert.match(html, /<img[^>]+src="https:\/\/upload-images\.jianshu\.io\/upload_images\/first\.png"/);
});


test("content consistency detects missing ending without mutating either representation", async () => {
  const { inspectArticleContentConsistency } = await import("../src/rich-content.mjs");
  const input = { contentBlocks: [{ type: "section", title: "章节", content: "正文" }], contentMarkdown: "## 章节\n正文\n遗漏结尾" };
  const before = JSON.stringify(input);
  assert.equal(inspectArticleContentConsistency(input).code, "ARTICLE_CONTENT_REPRESENTATION_MISMATCH");
  assert.equal(JSON.stringify(input), before);
  assert.equal(inspectArticleContentConsistency({ ...input, contentMarkdown: "# 文章标题\n## 章节\n**正文**\n![图](https://example.com/a.png)" }), null);
  assert.equal(inspectArticleContentConsistency({ contentMarkdown: "正文" }), null);
  assert.equal(inspectArticleContentConsistency({ contentBlocks: input.contentBlocks }), null);
});
