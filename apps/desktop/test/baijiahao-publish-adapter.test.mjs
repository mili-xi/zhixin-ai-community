import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import {
  BaijiahaoAdapter,
  baijiahaoPageApiFetch,
  baijiahaoCaptureLosesEditorToken,
  baijiahaoDraftUrlFromArticleId,
  baijiahaoListItemPubliclyVisible,
  buildBaijiahaoAuthArtifact,
  cleanupBaijiahaoArticle,
  decodeBaijiahaoRequestToken,
  findBaijiahaoDraftArticleId,
  inspectBaijiahaoPublicArticle,
  mergeBaijiahaoEditorTokenExpiry,
  normalizeBaijiahaoImageUrl,
  readBaijiahaoArticleList,
  readBaijiahaoRequestToken,
  uploadBaijiahaoImage,
  uploadBaijiahaoInlineImages,
  waitForBaijiahaoDraftUrl,
  waitForBaijiahaoEditorImages,
} from "../src/adapters/baijiahao.mjs";

test("browser API bypasses a throwing page fetch without retrying a publish", async () => {
  const calls = [];
  class XMLHttpRequest {
    open(...args) { calls.push({ open: args, headers: {} }); }
    setRequestHeader(name, value) { calls[0].headers[name] = value; }
    send(body) {
      calls[0].body = body;
      calls[0].withCredentials = this.withCredentials;
      this.status = 200;
      this.responseText = '{"errno":0}';
      this.onload();
    }
  }
  const page = {
    evaluate(callback, input) {
      return runInNewContext(`(${callback.toString()})(input)`, {
        input, XMLHttpRequest,
        fetch() { throw new TypeError("Failed to fetch"); },
      });
    },
  };
  const result = await baijiahaoPageApiFetch(page, "https://baijiahao.baidu.com/pcui/article/publish", {
    method: "POST", form: { title: "a & b" }, headers: { token: "test-token", Referer: "ignored" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.payload.errno, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].withCredentials, true);
  assert.equal(calls[0].headers.token, "test-token");
  assert.equal(calls[0].headers.Referer, undefined);
  assert.equal(calls[0].body, "title=a+%26+b");
});

for (const [event, code] of [["onerror", "NETWORK_ERROR"], ["ontimeout", "NETWORK_TIMEOUT"], ["onabort", "NETWORK_ABORTED"]]) {
  test(`browser API reports ${event} without retrying a potentially submitted publish`, async () => {
    let sends = 0;
    class XMLHttpRequest {
      open() {}
      setRequestHeader() {}
      send() { sends += 1; this[event](); }
    }
    const page = { evaluate(callback, input) {
      return runInNewContext(`(${callback.toString()})(input)`, { input, XMLHttpRequest });
    } };
    await assert.rejects(baijiahaoPageApiFetch(page, "https://baijiahao.baidu.com/pcui/article/publish", { method: "POST" }), new RegExp(`BAIJIAHAO_API_${code}`));
    assert.equal(sends, 1);
  });
}

function makeEditToken({ ttlSeconds = 43200, issuedAgoSeconds = 60 } = {}) {
  const iat = Math.floor(Date.now() / 1000) - issuedAgoSeconds;
  const payload = Buffer.from(JSON.stringify({ exp: iat + ttlSeconds, iat, sub: "probe" })).toString("base64url");
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`;
 }

// A /lists row only counts as publicly visible once review actually passed:
// the native /s?id= URL plus every audit field the platform uses to flag a
// rejected, withdrawn or still-pending article. A bare {article_id,title,url}
// row reads as "not published yet" and keeps the flow submitted_for_review.
function baijiahaoPublishedListItem(articleId, title) {
  return {
    article_id: articleId,
    id: articleId,
    title,
    url: `https://baijiahao.baidu.com/s?id=${articleId}`,
    status: "publish",
    secure_status: "publish",
    quality_status: "publish",
    audit_status_info: { quality_status: 1, qm_info: { status: 1, audit_reason: "" } },
    cover_images: '[{"src":"https://pic.rmb.bdstatic.com/bjh/cover.png","isLegal":0,"machine_chooseimg":0}]',
  };
}

// The Baijiahao public article page carries no <article> element and no
// .article-content / .content class: its body sits in a div keyed only by
// data-testid, and every other locator on the page is platform chrome. This
// mock answers each locator the way the measured live page does.
function makeBaijiahaoPublicPage({ articleTitle, bodyText, publicImageUrl = "" }) {
  const requestedSelectors = [];
  const imageHandle = {
    async getAttribute(name) {
      if (name === "content") return "";
      if (name === "src") return publicImageUrl;
      return "";
    },
    // A real locator handle rejects a body read instead of throwing
    // synchronously, so the adapter's .catch() sees a promise either way.
    async innerText() { throw new Error("locator.innerText: Timeout 30000ms exceeded."); },
  };
  const page = {
    _url: "about:blank",
    async goto(url) { page._url = url; },
    async waitForLoadState() {},
    async waitForFunction() {},
    async title() { return articleTitle; },
    locator(selector) {
      requestedSelectors.push(selector);
      if (selector === "[data-testid='article'], article, .article-content, .content") {
        return { first() { return { async innerText() { return bodyText; } }; } };
      }
      return { first() { return imageHandle; } };
    },
  };
  return { page, requestedSelectors };
}

test("discovers a reviewed Baijiahao article and verifies its public platform image", async () => {
  const publicImage = {
    async getAttribute(name) {
      if (name === "src") return "https://pic.rmb.bdstatic.com/bjh/public-inline.png";
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
    async innerText() { return "The authenticated public body is available."; },
  };
  const page = {
    _url: "about:blank",
    async goto(url) { page._url = url; },
    async waitForLoadState() {},
    async waitForFunction(_fn, payload) {
      assert.equal(payload.selector, "[data-testid='article'] img, article img, .article-content img, .content img");
      assert.equal(payload.expectedCount, 1);
    },
    async title() { return "Baijiahao reviewed illustrated article"; },
    locator(selector) {
      if (selector === "[data-testid='article'] img, article img, .article-content img, .content img") return imageLocator;
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
    platformImageUrl: "https://baijiahao.baidu.com/bjh/picproxy?param=draft",
    loaded: true,
  };

  const result = await inspectBaijiahaoPublicArticle(page, {
    publicUrl: "https://baijiahao.baidu.com/s?id=1870656649915477340",
    articleTitle: "Baijiahao reviewed illustrated article",
    contentMarkdown: "The authenticated public body is available.",
    imagePublicationEvidence: {
      expectedCount: 1,
      expected,
      upload: { images: [priorImage] },
      draft: { images: [priorImage] },
    },
  });

  assert.equal(result.found, true);
  assert.equal(result.publicUrl, "https://baijiahao.baidu.com/s?id=1870656649915477340");
  assert.equal(result.imagePublicationEvidence.status, "verified");
  assert.equal(result.imagePublicationEvidence.public.verifiedCount, 1);
  assert.equal(
    result.imagePublicationEvidence.public.images[0].platformImageUrl,
    "https://pic.rmb.bdstatic.com/bjh/public-inline.png"
  );
});

test("verifies Baijiahao public images served from the pics0 and pics5 hosts", async () => {
  // Measured on the live public page 2026-10-22: the platform serves an
  // article's inline images from pics0.baidu.com / pics5.baidu.com as often as
  // from pic.rmb.bdstatic.com. The old host-specific selector counted zero
  // images on a healthy page and reported a defect that was not there.
  const publicImageUrls = [
    "https://pics0.baidu.com/feed/09f1c9b1a24a11f0.png",
    "https://pics5.baidu.com/feed/2b7d4e0c35aa21f0.png",
  ];
  const imageHandles = publicImageUrls.map((url) => ({
    async getAttribute(name) {
      if (name === "src") return url;
      if (name === "alt") return "workflow image";
      return "";
    },
    async evaluate() { return true; },
  }));
  const imageLocator = {
    async count() { return imageHandles.length; },
    nth(index) { return imageHandles[index]; },
  };
  const bodyLocator = {
    first() { return bodyLocator; },
    async innerText() { return "The authenticated public body is available."; },
  };
  const page = {
    _url: "about:blank",
    async goto(url) { page._url = url; },
    async waitForLoadState() {},
    async waitForFunction(_fn, payload) {
      assert.equal(payload.selector, "[data-testid='article'] img, article img, .article-content img, .content img");
      assert.equal(payload.expectedCount, 2);
    },
    async title() { return "Baijiahao reviewed illustrated article"; },
    locator(selector) {
      if (selector === "[data-testid='article'] img, article img, .article-content img, .content img") return imageLocator;
      return bodyLocator;
    },
  };
  const expected = [
    { assetId: "asset-inline", sectionId: "workflow", position: 2, idempotencyKey: "asset-inline:workflow:hash" },
    { assetId: "asset-second", sectionId: "workflow", position: 4, idempotencyKey: "asset-second:workflow:hash" },
  ];
  const priorImages = expected.map((task) => ({
    ...task,
    platformImageUrl: "https://baijiahao.baidu.com/bjh/picproxy?param=draft",
    loaded: true,
  }));

  const result = await inspectBaijiahaoPublicArticle(page, {
    publicUrl: "https://baijiahao.baidu.com/s?id=1870656649915477340",
    articleTitle: "Baijiahao reviewed illustrated article",
    contentMarkdown: "The authenticated public body is available.",
    imagePublicationEvidence: {
      expectedCount: 2,
      expected,
      upload: { images: priorImages },
      draft: { images: priorImages },
    },
  });

  assert.equal(result.imagePublicationEvidence.status, "verified");
  assert.equal(result.imagePublicationEvidence.public.verifiedCount, 2);
  assert.deepEqual(
    result.imagePublicationEvidence.public.images.map((image) => image.platformImageUrl),
    publicImageUrls
  );
});

test("verifies a published Baijiahao public page rendered inside the data-testid article container", async () => {
  // Measured on the live platform 2026-10-18: the public page has no <article>
  // element and no .article-content / .content class. Its body sits in
  // <div class="_18p7x" data-testid="article">, every markdown block rendered
  // as its own <section><h3>/<p> pair with image containers between blocks.
  const articleTitle = "800万 4K POE 枪机：3 项技术适配商用监控场景";
  const contentMarkdown = [
    "### 写在前面",
    "面向室外商用场景的800万像素POE有线枪机，通过感光硬件、编码算法、智能侦测三项核心技术的迭代，解决了传统商用监控画质模糊、夜视失效、存储冗余的普遍痛点。",
    "",
    "### 800万像素与H.265编码：如何做到省存储不省画质",
    "该设备的感光元件采用1/1.8英寸大底设计，相比传统商用枪机常用的1/3英寸感光面积大2.25倍，进光量提升明显，配合800万像素的4K分辨率，在10米监控距离下可清晰捕捉人脸纹理、车牌字符。",
    "",
    "### 智能全彩夜视：如何解决室外暗光场景成像模糊问题",
    "传统红外夜视仅能输出黑白画面，且在光线不足或存在遮挡的场景下容易出现噪点、模糊，无法识别目标特征。",
    "",
    "### 智能侦测与POE架构：如何降低部署复杂度与误报率",
    "传统移动侦测对光照变化、风吹树叶、小动物经过都会触发报警，无效报警率超过80%，大幅增加巡检负担。",
  ].join("\n");
  const bodyText = [
    "写在前面",
    "面向室外商用场景的800万像素POE有线枪机，通过感光硬件、编码算法、智能侦测三项核心技术的迭代，解决了传统商用监控画质模糊、夜视失效、存储冗余的普遍痛点。",
    "",
    "800万像素与H.265编码：如何做到省存储不省画质",
    "该设备的感光元件采用1/1.8英寸大底设计，相比传统商用枪机常用的1/3英寸感光面积大2.25倍，进光量提升明显，配合800万像素的4K分辨率，在10米监控距离下可清晰捕捉人脸纹理、车牌字符。",
    "",
    "智能全彩夜视：如何解决室外暗光场景成像模糊问题",
    "传统红外夜视仅能输出黑白画面，且在光线不足或存在遮挡的场景下容易出现噪点、模糊，无法识别目标特征。",
    "",
    "智能侦测与POE架构：如何降低部署复杂度与误报率",
    "传统移动侦测对光照变化、风吹树叶、小动物经过都会触发报警，无效报警率超过80%，大幅增加巡检负担。",
  ].join("\n");
  const { page, requestedSelectors } = makeBaijiahaoPublicPage({
    articleTitle,
    bodyText,
    publicImageUrl: "https://pic.rmb.bdstatic.com/bjh/3ea152b676cb/261014/e0d2f0d9bf8cb8ae5a29ab031c69a1c7.jpeg",
  });

  const result = await inspectBaijiahaoPublicArticle(page, {
    publicUrl: "https://baijiahao.baidu.com/s?id=1879026802935414656",
    articleTitle,
    contentMarkdown,
  });

  assert.equal(result.found, true);
  assert.equal(result.titleMatched, true);
  assert.equal(result.bodyMatched, true);
  assert.equal(result.publicImageFound, true);
  assert.equal(
    result.publicImageUrl,
    "https://pic.rmb.bdstatic.com/bjh/3ea152b676cb/261014/e0d2f0d9bf8cb8ae5a29ab031c69a1c7.jpeg"
  );
  assert.ok(requestedSelectors.some((selector) => selector.includes("[data-testid='article']")));
  assert.ok(result.pageText.includes("写在前面"));
});

test("matches the Baijiahao public body when a platform caption splits a heading from its paragraph", async () => {
  // The public page wraps inline images in extra container paragraphs whose
  // caption text can render between a section heading and its paragraph, so a
  // markdown fragment merging the two never appears verbatim even though every
  // piece of the article is on the page.
  const articleTitle = "800万 4K POE 枪机：3 项技术适配商用监控场景";
  const contentMarkdown = [
    "### 写在前面",
    "面向室外商用场景的800万像素POE有线枪机，通过感光硬件、编码算法、智能侦测三项核心技术的迭代。",
    "",
    "### 800万像素与H.265编码：如何做到省存储不省画质",
    "该设备的感光元件采用1/1.8英寸大底设计，相比传统商用枪机常用的1/3英寸感光面积大2.25倍。",
  ].join("\n");
  const bodyText = [
    "写在前面",
    "图：室外枪机安装实拍",
    "面向室外商用场景的800万像素POE有线枪机，通过感光硬件、编码算法、智能侦测三项核心技术的迭代。",
    "",
    "800万像素与H.265编码：如何做到省存储不省画质",
    "图：大底感光元件细节",
    "该设备的感光元件采用1/1.8英寸大底设计，相比传统商用枪机常用的1/3英寸感光面积大2.25倍。",
  ].join("\n");
  const { page } = makeBaijiahaoPublicPage({ articleTitle, bodyText });

  const result = await inspectBaijiahaoPublicArticle(page, {
    publicUrl: "https://baijiahao.baidu.com/s?id=1879026802935414656",
    articleTitle,
    contentMarkdown,
  });

  assert.equal(result.found, true);
  assert.equal(result.bodyMatched, true);
});

test("matches the Baijiahao public body when the platform drops the section headings", async () => {
  // Measured on the live stuck order 2026-10-22: an article published through
  // the API renders its ### headings nowhere in the page text while every
  // paragraph below them is present. Splitting the evidence on blank lines
  // fused each heading with its paragraph, and the heading was a piece no
  // published page carries, so a fully public article read as "body not found".
  const articleTitle = "室内与室外摄像头防护等级差异在哪";
  const contentMarkdown = [
    "### 防护等级的基本含义",
    "室内与室外摄像头的防护等级差异，核心在防水防尘与耐腐蚀设计。",
    "",
    "### 室外摄像头的防护要求",
    "室外摄像头需要至少IP66以上的防护等级，才能抵御雨水与粉尘。",
  ].join("\n");
  const bodyText = [
    "室内与室外摄像头的防护等级差异，核心在防水防尘与耐腐蚀设计。",
    "",
    "室外摄像头需要至少IP66以上的防护等级，才能抵御雨水与粉尘。",
  ].join("\n");
  const { page } = makeBaijiahaoPublicPage({ articleTitle, bodyText });

  const result = await inspectBaijiahaoPublicArticle(page, {
    publicUrl: "https://baijiahao.baidu.com/s?id=1879623218377447665",
    articleTitle,
    contentMarkdown,
  });

  assert.equal(result.found, true);
  assert.equal(result.titleMatched, true);
  assert.equal(result.bodyMatched, true);
});

test("still rejects a Baijiahao public page whose body is not this article", async () => {
  const articleTitle = "800万 4K POE 枪机：3 项技术适配商用监控场景";
  const contentMarkdown = [
    "### 写在前面",
    "面向室外商用场景的800万像素POE有线枪机，通过感光硬件、编码算法、智能侦测三项核心技术的迭代。",
    "",
    "### 800万像素与H.265编码：如何做到省存储不省画质",
    "该设备的感光元件采用1/1.8英寸大底设计，相比传统商用枪机常用的1/3英寸感光面积大2.25倍。",
  ].join("\n");
  const bodyText = [
    "写在前面",
    "这是一篇已经下线很久的旧稿件，正文与本次待复验的文章没有任何关系。",
    "",
    "某个无关的小标题",
    "无关的段落内容，虽然也提到了枪机和夜视，但行文与目标稿件完全不同。",
  ].join("\n");
  const { page } = makeBaijiahaoPublicPage({ articleTitle, bodyText });

  const result = await inspectBaijiahaoPublicArticle(page, {
    publicUrl: "https://baijiahao.baidu.com/s?id=1879026802935414656",
    articleTitle,
    contentMarkdown,
  });

  assert.equal(result.found, false);
  assert.equal(result.titleMatched, true);
  assert.equal(result.bodyMatched, false);
});

test("keeps a Baijiahao public page without a readable article body unverified", async () => {
  // This is the failure the live orders showed: the legacy selector matched
  // nothing, so the body read came back empty while the page title still
  // carried the article title.
  const articleTitle = "800万 4K POE 枪机：3 项技术适配商用监控场景";
  const { page } = makeBaijiahaoPublicPage({ articleTitle, bodyText: "" });

  const result = await inspectBaijiahaoPublicArticle(page, {
    publicUrl: "https://baijiahao.baidu.com/s?id=1879026802935414656",
    articleTitle,
    contentMarkdown: "### 写在前面\n面向室外商用场景的800万像素POE有线枪机。",
  });

  assert.equal(result.found, false);
  assert.equal(result.titleMatched, true);
  assert.equal(result.bodyMatched, false);
});

test("only counts a Baijiahao list item as publicly visible once the platform published it", () => {
  // The recheck backlink has to come from the platform's own publication
  // statement: the status word, and whether the address it served for the
  // article is the public /s?id= one or an editor one. A draft URL, a
  // machine-review status and a withdrawal each mean the article is not
  // published, whatever the row's url field claims.
  const articleId = "1879729464038944710";
  const title = "监控录像机本地与云端存储可靠性差异在哪";
  const refused = [
    ["a draft still holding the editor preview URL", {
      ...baijiahaoPublishedListItem(articleId, title),
      url: `https://baijiahao.baidu.com/builder/preview/s?id=${articleId}`,
    }],
    ["an article still in machine review", {
      ...baijiahaoPublishedListItem(articleId, title),
      status: "analyze",
    }],
    ["a withdrawn article", {
      ...baijiahaoPublishedListItem(articleId, title),
      status: "withdraw",
    }],
  ];
  for (const [label, item] of refused) {
    const verdict = baijiahaoListItemPubliclyVisible(item);
    assert.equal(verdict.visible, false, label);
    assert.equal(verdict.publicUrl, "", label);
    assert.ok(verdict.reason, label);
  }
  const published = baijiahaoListItemPubliclyVisible(baijiahaoPublishedListItem(articleId, title));
  assert.equal(published.visible, true);
  assert.equal(published.reason, "");
  assert.equal(published.publicUrl, `https://baijiahao.baidu.com/s?id=${articleId}`);
  assert.equal(published.reviewRefusals, undefined);
});

test("reports a Baijiahao quality refusal as a diagnostic instead of refusing the article", () => {
  // Article 1879623218377447665 carried exactly these refusals and was still
  // readable end to end by an anonymous visitor, so three orders were stranded
  // on BAIJIAHAO_LIST_QUALITY_STATUS_REJECTED for an article the platform had
  // already published. The field family is carried as evidence now.
  const articleId = "1879623218377447665";
  const title = "室内与室外摄像头防护等级差异在哪";
  const verdict = baijiahaoListItemPubliclyVisible({
    ...baijiahaoPublishedListItem(articleId, title),
    quality_status: "rejected",
    secure_status: "0",
    quality_not_pass_reason: "内容质量不达标",
    audit_status_info: { quality_status: 1, qm_info: { status: 0, audit_reason: "内容质量不达标" } },
  });
  assert.equal(verdict.visible, true);
  assert.equal(verdict.reason, "");
  assert.equal(verdict.publicUrl, `https://baijiahao.baidu.com/s?id=${articleId}`);
  // "1" is the platform's passed marker, so only the stages that actually carry
  // a refusal word are listed.
  assert.deepEqual(verdict.reviewRefusals, [
    "quality_status",
    "secure_status",
    "audit_status_info.qm_info.status",
    "quality_not_pass_reason",
  ]);
});

test("rediscovers the public backlink through the content list API when the review URL is not public", async () => {
  // The API publish path hands back the editor review URL, which is not a
  // public address: inspecting it threw BAIJIAHAO_PUBLIC_URL_INVALID and the
  // whole recheck died with that one code. The content-management list reports
  // the platform's own review verdict together with the article's public URL,
  // so the gate walks that path and comes back with the real backlink.
  const articleId = "1879729464038944710";
  const articleTitle = "监控录像机本地与云端存储可靠性差异在哪";
  const contentMarkdown = "本地存储与云端存储的可靠性差异，取决于网络带宽与冗余策略。";
  const page = {
    _url: `https://baijiahao.baidu.com/builder/rc/edit?type=news&article_id=${articleId}`,
    request: {
      async fetch(url) {
        const payload = String(url).includes("/lists")
          ? { errno: 0, data: { list: [baijiahaoPublishedListItem(articleId, articleTitle)] } }
          : { errno: 0, data: { result: true } };
        return { status: () => 200, url: () => url, text: async () => JSON.stringify(payload) };
      },
    },
    async evaluate(callback) {
      // No editor token in storage: the list API still answers on cookies alone.
      if (String(callback).includes("edit-token")) return "";
      return "";
    },
    async goto(url) { page._url = url; },
    async waitForLoadState() {},
    url() { return page._url; },
    async title() { return articleTitle; },
    locator(selector) {
      if (selector === "[data-testid='article'], article, .article-content, .content") {
        return { first: () => ({ async innerText() { return `${articleTitle}\n${contentMarkdown}`; } }) };
      }
      return { first: () => ({ async getAttribute() { return ""; } }) };
    },
  };
  const context = { pages: () => [page], newPage: async () => page, close: async () => {} };
  const adapter = new BaijiahaoAdapter({ browser: { launchPersistentContext: async () => context } });

  const result = await adapter.discoverPublication({
    reviewUrl: `https://baijiahao.baidu.com/builder/rc/edit?type=news&article_id=${articleId}`,
    articleTitle,
    contentMarkdown,
  });

  assert.equal(result.found, true);
  assert.equal(result.titleMatched, true);
  assert.equal(result.bodyMatched, true);
  assert.equal(result.publicUrl, `https://baijiahao.baidu.com/s?id=${articleId}`);
  assert.equal(result.publishedUrl, `https://baijiahao.baidu.com/s?id=${articleId}`);
});

test("keeps a Baijiahao recheck honest when the list still reports the article under review", async () => {
  // Fail-closed: an article the platform has not passed has to come back as
  // "not found" with a readable reason, never as a thrown discovery error. A
  // throw becomes publication_discovery_failed, which leaves the order holding
  // one adapter code with no retry path; found:false lets the next recheck run
  // and tells the operator why.
  const articleId = "1879623218377447665";
  const articleTitle = "室内与室外摄像头防护等级差异在哪";
  const contentMarkdown = "室内与室外摄像头的防护等级差异，核心在防水防尘与耐腐蚀设计。";
  const page = {
    _url: `https://baijiahao.baidu.com/builder/rc/edit?type=news&article_id=${articleId}`,
    request: {
      async fetch(url) {
        const listItem = { ...baijiahaoPublishedListItem(articleId, articleTitle), status: "analyze" };
        const payload = String(url).includes("/lists")
          ? { errno: 0, data: { list: [listItem] } }
          : { errno: 0, data: { result: true } };
        return { status: () => 200, url: () => url, text: async () => JSON.stringify(payload) };
      },
    },
    async evaluate(callback) {
      if (String(callback).includes("edit-token")) return "";
      return "";
    },
    async goto(url) { page._url = url; },
    async waitForLoadState() {},
    url() { return page._url; },
    async title() { return articleTitle; },
    locator() {
      return { first: () => ({ async innerText() { return ""; }, async getAttribute() { return ""; } }) };
    },
  };
  const context = { pages: () => [page], newPage: async () => page, close: async () => {} };
  const adapter = new BaijiahaoAdapter({ browser: { launchPersistentContext: async () => context } });

  const result = await adapter.discoverPublication({
    reviewUrl: `https://baijiahao.baidu.com/builder/rc/edit?type=news&article_id=${articleId}`,
    articleTitle,
    contentMarkdown,
  });

  assert.equal(result.found, false);
  assert.equal(result.publicUrl, "");
  assert.match(result.message, /百家号内容管理未确认该文章已审核通过并公开/);
  assert.match(result.message, /BAIJIAHAO_LIST_STATUS_ANALYZE/);
});

// A discovery walks two browser pages: the authenticated one that carries the
// account cookies, and the incognito one that carries none. What separates them
// here is only what each page renders, so the same factory serves both.
function makeBaijiahaoDiscoveryPage({ articleId, articleTitle, contentMarkdown, rendersArticle, bodyText, listItem }) {
  const page = {
    _url: `https://baijiahao.baidu.com/builder/rc/edit?type=news&article_id=${articleId}`,
    request: {
      async fetch(url) {
        const payload = String(url).includes("/lists")
          ? { errno: 0, data: { list: [listItem] } }
          : { errno: 0, data: { result: true } };
        return { status: () => 200, url: () => url, text: async () => JSON.stringify(payload) };
      },
    },
    async evaluate(callback) {
      if (String(callback).includes("edit-token")) return "";
      return bodyText;
    },
    async goto(url) { page._url = url; },
    async waitForLoadState() {},
    url() { return page._url; },
    async title() { return rendersArticle ? articleTitle : "百家号"; },
    locator(selector) {
      if (selector === "[data-testid='article'], article, .article-content, .content") {
        return {
          first: () => ({
            async innerText() { return rendersArticle ? `${articleTitle}\n${contentMarkdown}` : ""; },
          }),
        };
      }
      return { first: () => ({ async getAttribute() { return ""; } }) };
    },
  };
  return page;
}

function makeBaijiahaoDiscoveryContext(authedPage, anonymousPage) {
  const anonymousContext = { newPage: async () => anonymousPage, close: async () => {} };
  return {
    pages: () => [authedPage],
    newPage: async () => authedPage,
    close: async () => {},
    browser: () => ({ newContext: async () => anonymousContext }),
  };
}

function baijiahaoDiscoveryInput(articleId, articleTitle, contentMarkdown) {
  return {
    reviewUrl: `https://baijiahao.baidu.com/builder/rc/edit?type=news&article_id=${articleId}`,
    articleTitle,
    contentMarkdown,
  };
}

test("confirms a Baijiahao backlink by reading the public page without cookies", async () => {
  // The order's backlink is proof for the rest of the pipeline, and the claim it
  // has to carry is that a visitor can open it. The discovery page holds the
  // account's cookies, so the platform serves an author their own article there
  // whether or not it went public; the verdict has to come from the incognito
  // read, which is what publicPageReadMode records.
  const articleId = "1879623218377447665";
  const articleTitle = "室内与室外摄像头防护等级差异在哪";
  const contentMarkdown = "室内与室外摄像头的防护等级差异，核心在防水防尘与耐腐蚀设计。";
  const listItem = {
    ...baijiahaoPublishedListItem(articleId, articleTitle),
    quality_status: "rejected",
    quality_not_pass_reason: "内容质量不达标",
  };
  const authed = makeBaijiahaoDiscoveryPage({
    articleId, articleTitle, contentMarkdown, rendersArticle: true,
    bodyText: `${articleTitle}\n${contentMarkdown}`, listItem,
  });
  const anonymous = makeBaijiahaoDiscoveryPage({
    articleId, articleTitle, contentMarkdown, rendersArticle: true,
    bodyText: `${articleTitle}\n${contentMarkdown}\n举报/反馈`, listItem,
  });
  const adapter = new BaijiahaoAdapter({
    browser: { launchPersistentContext: async () => makeBaijiahaoDiscoveryContext(authed, anonymous) },
  });

  const result = await adapter.discoverPublication(baijiahaoDiscoveryInput(articleId, articleTitle, contentMarkdown));

  assert.equal(result.found, true);
  assert.equal(result.publicPageReadMode, "anonymous");
  assert.equal(result.publicUrl, `https://baijiahao.baidu.com/s?id=${articleId}`);
  assert.equal(anonymous._url, `https://baijiahao.baidu.com/s?id=${articleId}`);
});

test("falls back to the authenticated read when Baidu walls the anonymous one off", async () => {
  // Baidu answers an anonymous read with its security verification page often
  // enough that a walled-off read has to be treated as no verdict at all.
  // Reporting "still under review" for an article the platform already
  // published is the bug this gate exists to remove, so the authenticated read
  // decides and the wall is recorded beside it.
  const articleId = "1879729464038944710";
  const articleTitle = "监控录像机本地与云端存储可靠性差异在哪";
  const contentMarkdown = "本地存储与云端存储的可靠性差异，取决于网络带宽与冗余策略。";
  const listItem = baijiahaoPublishedListItem(articleId, articleTitle);
  const authed = makeBaijiahaoDiscoveryPage({
    articleId, articleTitle, contentMarkdown, rendersArticle: true,
    bodyText: `${articleTitle}\n${contentMarkdown}`, listItem,
  });
  const anonymous = makeBaijiahaoDiscoveryPage({
    articleId, articleTitle, contentMarkdown, rendersArticle: false,
    bodyText: "百度安全验证 请完成下方验证后继续操作 拖动左侧滑块使图片为正", listItem,
  });
  const adapter = new BaijiahaoAdapter({
    browser: { launchPersistentContext: async () => makeBaijiahaoDiscoveryContext(authed, anonymous) },
  });

  const result = await adapter.discoverPublication(baijiahaoDiscoveryInput(articleId, articleTitle, contentMarkdown));

  assert.equal(result.found, true);
  assert.equal(result.publicPageReadMode, "authenticated");
  assert.equal(result.anonymousBlocker, "BAIJIAHAO_SECURITY_VERIFICATION_REQUIRED");
  assert.equal(result.publicUrl, `https://baijiahao.baidu.com/s?id=${articleId}`);
});

test("refuses a Baijiahao backlink only the author can open", async () => {
  // Reverse experiment. The platform reports the article published and serves
  // its public address, and the author's own page still renders it, but no
  // anonymous visitor can read it. That is the case the quality_status veto used
  // to be asked to catch, and it is caught here by the read that actually
  // measures it: the order stays on its retry path with no URL handed back.
  const articleId = "1879623218377447665";
  const articleTitle = "室内与室外摄像头防护等级差异在哪";
  const contentMarkdown = "室内与室外摄像头的防护等级差异，核心在防水防尘与耐腐蚀设计。";
  const listItem = baijiahaoPublishedListItem(articleId, articleTitle);
  const authed = makeBaijiahaoDiscoveryPage({
    articleId, articleTitle, contentMarkdown, rendersArticle: true,
    bodyText: `${articleTitle}\n${contentMarkdown}`, listItem,
  });
  const anonymous = makeBaijiahaoDiscoveryPage({
    articleId, articleTitle, contentMarkdown, rendersArticle: false,
    bodyText: "您访问的内容不存在或已被删除", listItem,
  });
  const adapter = new BaijiahaoAdapter({
    browser: { launchPersistentContext: async () => makeBaijiahaoDiscoveryContext(authed, anonymous) },
  });

  const result = await adapter.discoverPublication(baijiahaoDiscoveryInput(articleId, articleTitle, contentMarkdown));

  assert.equal(result.found, false);
  assert.equal(result.publicUrl, "");
  assert.equal(result.publishedUrl, "");
  assert.equal(result.publicPageReadMode, "anonymous");
  assert.equal(result.titleMatched, false);
  assert.equal(result.bodyMatched, false);
  assert.match(result.message, /百家号已发布并给出公开地址，但公开页未读到文章正文/);
  assert.match(result.message, /BAIJIAHAO_PUBLIC_PAGE_NOT_MATCHED/);
});

test("builds Baijiahao draft URLs from the numeric save response article_id", () => {
  assert.equal(
    findBaijiahaoDraftArticleId({ data: [{ id: "ai_tts" }, { article_id: "1870656049761655735" }] }),
    "1870656049761655735"
  );
  assert.equal(
    baijiahaoDraftUrlFromArticleId("1870656049761655735"),
    "https://baijiahao.baidu.com/builder/rc/edit?type=news&article_id=1870656049761655735"
  );
});

test("normalizes trusted Baijiahao image proxies to HTTPS", () => {
  assert.equal(
    normalizeBaijiahaoImageUrl("http://baijiahao.baidu.com/bjh/picproxy?param=abc"),
    "https://baijiahao.baidu.com/bjh/picproxy?param=abc"
  );
  assert.equal(normalizeBaijiahaoImageUrl("http://example.com/image.png"), "");
});

test("falls back to a public image src when its metadata content is empty", async () => {
  const publicImageUrl = "https://pic.rmb.bdstatic.com/bjh/cover-from-src.png";
  const publicImage = {
    async getAttribute(name) {
      return name === "src" ? publicImageUrl : "";
    },
  };
  const page = {
    async goto() {},
    async title() { return "Baijiahao src fallback article"; },
    locator() {
      return {
        first() {
          return {
            ...publicImage,
            async innerText() { return "Public page body"; },
          };
        },
      };
    },
  };

  const result = await inspectBaijiahaoPublicArticle(page, {
    publicUrl: "https://baijiahao.baidu.com/s?id=1870656649915477340",
    articleTitle: "Baijiahao src fallback article",
    contentMarkdown: "Public page body",
  });

  assert.equal(result.publicImageFound, true);
  assert.equal(result.publicImageUrl, publicImageUrl);
});

test("waits for the Baijiahao save response and asynchronous draft images", async () => {
  const state = { draftUrl: "" };
  let waits = 0;
  const image = {
    async getAttribute(name) {
      return name === "src" ? "http://baijiahao.baidu.com/bjh/picproxy?param=draft" : "draft image";
    },
    async evaluate() { return true; },
  };
  const page = {
    url: () => "https://baijiahao.baidu.com/builder/rc/edit?type=news",
    async waitForTimeout() {
      waits += 1;
      if (waits === 2) {
        state.draftUrl = "https://baijiahao.baidu.com/builder/rc/edit?type=news&article_id=1870656049761655735";
      }
    },
    frameLocator() {
      return {
        locator() {
          return {
            async count() { return waits >= 3 ? 1 : 0; },
            nth() { return image; },
          };
        },
      };
    },
  };

  const draftUrl = await waitForBaijiahaoDraftUrl(state, page, 100, 1);
  const images = await waitForBaijiahaoEditorImages(page, 1, 100, 1);

  assert.equal(draftUrl, state.draftUrl);
  assert.equal(images[0].platformImageUrl, "https://baijiahao.baidu.com/bjh/picproxy?param=draft");
});

test("uploads Baijiahao body images through the UEditor native image dialog", async () => {
  const actions = [];
  const images = [];
  let imageDialogClicks = 0;
  const imageLocator = {
    async count() { return images.length; },
    nth(index) {
      return {
        async getAttribute(name) { return name === "src" ? images[index].src : images[index].alt; },
        async evaluate() { return true; },
      };
    },
  };
  const body = {
    async click() { actions.push(["clickEditorBody"]); },
    async evaluate() { return true; },
  };
  const page = {
    async evaluate(_fn, payload) {
      actions.push(["focusImageToolbar", payload]);
      return true;
    },
    frameLocator() {
      return {
        locator(selector) {
          if (selector === "body") return { first: () => body };
          return imageLocator;
        },
      };
    },
    locator(selector) {
      return {
        first() {
          return {
            async click() {
              actions.push(["click", selector]);
              if (selector.includes("edui-for-insertimage")) imageDialogClicks += 1;
            },
            async isVisible() { return selector.includes("确认"); },
            async waitFor() {
              if (selector.includes("input[type='file']") && imageDialogClicks < 2) {
                throw new Error("IMAGE_DIALOG_NOT_OPEN");
              }
            },
            async setInputFiles(filePath) {
              if (imageDialogClicks < 2) throw new Error("IMAGE_DIALOG_NOT_OPEN");
              actions.push(["file", selector, filePath]);
              images.push({ src: "https://pic.rmb.bdstatic.com/inline.png", alt: "正文图" });
            },
          };
        },
      };
    },
  };

  const uploaded = await uploadBaijiahaoInlineImages(page, [{
    assetId: "asset-inline",
    sectionId: "workflow",
    position: 2,
    path: "C:/inline.png",
  }]);

  assert.equal(uploaded[0].platformImageUrl, "https://pic.rmb.bdstatic.com/inline.png");
  const bodyClickIndex = actions.findIndex((item) => item[0] === "clickEditorBody");
  const focusIndex = actions.findIndex((item) => item[0] === "focusImageToolbar");
  const clickIndex = actions.findIndex((item) => item[0] === "click" && item[1].includes("edui-for-insertimage > [id$='_state']"));
  assert.ok(bodyClickIndex >= 0 && focusIndex > bodyClickIndex && clickIndex > focusIndex);
  assert.equal(actions[focusIndex][1].sectionId, "workflow");
  assert.equal(imageDialogClicks, 2);
  assert.ok(actions.some((item) => item[0] === "file" && item[2] === "C:/inline.png"));
});

test("publishes a Baijiahao article through the real editor flow", async () => {
  const actions = [];
  let publishDisabledChecks = 0;
  const bodyLocator = {
    first: () => bodyLocator,
    fill: async (value) => actions.push(["fillBody", value]),
    click: async () => actions.push(["clickBody"]),
    press: async (key) => actions.push(["pressBody", key])
  };
  const page = {
    _url: "about:blank",
    _coverSelected: true,
    goto: async (url) => {
      actions.push(["goto", url]);
      page._url = url;
    },
    bringToFront: async () => {},
    waitForLoadState: async (state) => actions.push(["waitForLoadState", state]),
    waitForTimeout: async (ms) => actions.push(["waitForTimeout", ms]),
    waitForFunction: async () => actions.push(["waitForFunction"]),
    url: () => page._url,
    title: async () => "Baijiahao",
    evaluate: async (fn) => {
      if (typeof fn === "function") return page._coverSelected;
      return "Baijiahao creator center publish content management saved publish";
    },
    locator: (selector) => ({
      first: () => ({
        fill: async (value) => actions.push(["fill", selector, value]),
        click: async () => actions.push(["click", selector]),
        isDisabled: async () => false,
        isVisible: async () => selector.includes("button"),
        getAttribute: async () => ""
      })
    }),
    frameLocator: (selector) => ({
      locator: (innerSelector) => {
        actions.push(["frameLocator", selector, innerSelector]);
        return bodyLocator;
      }
    }),
    getByRole: (role, options = {}) => ({
      first: () => ({
        isVisible: async () => true,
        isDisabled: async () => {
          if (String(options.name).includes("publish")) {
            publishDisabledChecks += 1;
            return publishDisabledChecks === 1;
          }
          return false;
        },
        click: async () => {
          actions.push(["roleClick", role, options.name?.toString?.() || options.name || ""]);
          if (String(options.name).includes("publish")) page._url = "https://baijiahao.baidu.com/s?id=123456789";
        }
      })
    })
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "BDUSS", value: "auth-token", domain: ".baidu.com" }],
    close: async () => actions.push(["close"])
  };
  const adapter = new BaijiahaoAdapter({
    browser: {
      launchPersistentContext: async () => context
    }
  });

  const result = await adapter.publishArticle({
    articleTitle: "Zhixin AI Baijiahao publish test",
    contentMarkdown: "This is a Baijiahao publish flow test article.",
    confirmPublish: true,
    // 这条用例专门覆盖浏览器编辑器流程，适配器默认已经改成走 API 通道。
    apiFirst: false,
    keepBrowserOpen: false
  });

  assert.equal(result.publishedUrl, "https://baijiahao.baidu.com/s?id=123456789");
  assert.equal(result.platformStatus, "published");
  assert.deepEqual(actions.filter((item) => item[0] === "goto")[0], ["goto", "https://baijiahao.baidu.com/builder/rc/edit?type=news"]);
  assert.ok(actions.some((item) => item[0] === "fill" && item[1].includes("#newsTextArea") && item[2] === "Zhixin AI Baijiahao publish test"));
  assert.ok(actions.some((item) => item[0] === "fillBody" && item[1].includes("Baijiahao publish flow test")));
  assert.ok(actions.some((item) => item[0] === "roleClick" && item[2].includes("publish")));
});

test("confirms Baijiahao post-publish dialog and normalizes preview links", async () => {
  const actions = [];
  let afterConfirm = false;
  const bodyLocator = {
    first: () => bodyLocator,
    fill: async (value) => actions.push(["fillBody", value]),
    click: async () => {},
    press: async () => {}
  };
  const page = {
    _url: "https://baijiahao.baidu.com/builder/rc/edit?type=news",
    _coverSelected: true,
    goto: async (url) => {
      actions.push(["goto", url]);
      page._url = url;
    },
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    waitForFunction: async () => {},
    url: () => page._url,
    title: async () => "Baijiahao",
    evaluate: async (fn) => {
      if (typeof fn === "function") return page._coverSelected;
      return "Baijiahao creator center publish content management saved publish";
    },
    frameLocator: () => ({ locator: () => bodyLocator }),
    locator: (selector) => ({
      first: () => ({
        fill: async (value) => actions.push(["fill", selector, value]),
        click: async () => {
          actions.push(["click", selector]);
          if (selector.includes("ueditor-responese-modal")) afterConfirm = true;
        },
        isDisabled: async () => false,
        isVisible: async () => selector.includes("ueditor-responese-modal"),
        getAttribute: async () => (
          afterConfirm && selector.includes("builder/preview/s?id=")
            ? "http://baijiahao.baidu.com/builder/preview/s?id=1869855536696580221"
            : ""
        )
      })
    }),
    getByRole: (role, options = {}) => ({
      first: () => ({
        isVisible: async () => true,
        isDisabled: async () => false,
        click: async () => actions.push(["roleClick", role, options.name?.toString?.() || options.name || ""])
      })
    })
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "BDUSS", value: "auth-token", domain: ".baidu.com" }],
    close: async () => {}
  };
  const adapter = new BaijiahaoAdapter({
    browser: {
      launchPersistentContext: async () => context
    }
  });

  const result = await adapter.publishArticle({
    articleTitle: "Zhixin AI Baijiahao confirm test",
    contentMarkdown: "This test requires a post publish confirm dialog.",
    // 这条用例专门覆盖浏览器编辑器流程，适配器默认已经改成走 API 通道。
    apiFirst: false,
    confirmPublish: true
  });

  assert.equal(result.publishedUrl, "https://baijiahao.baidu.com/s?id=1869855536696580221");
  assert.ok(actions.some((item) => item[0] === "click" && item[1].includes("ueditor-responese-modal")));
});

test("reports Baijiahao security verification as an actionable blocker", async () => {
  const bodyLocator = {
    first: () => bodyLocator,
    fill: async () => {},
    click: async () => {},
    press: async () => {}
  };
  const page = {
    _url: "https://baijiahao.baidu.com/builder/rc/edit?type=news",
    _coverSelected: true,
    goto: async (url) => { page._url = url; },
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    waitForFunction: async () => {},
    url: () => page._url,
    title: async () => "Baijiahao",
    evaluate: async (fn) => {
      if (typeof fn === "function" && String(fn).includes("bjhNewsCover")) return true;
      return "Baijiahao creator center publish saved 百度安全验证 请完成下方验证后继续操作";
    },
    frameLocator: () => ({ locator: () => bodyLocator }),
    locator: (selector) => ({
      first: () => ({
        fill: async () => {},
        click: async () => {},
        isDisabled: async () => false,
        isVisible: async () => false,
        getAttribute: async () => ""
      }),
      last: () => ({
        click: async () => {},
        setInputFiles: async () => {},
        isDisabled: async () => false,
        isVisible: async () => false,
        getAttribute: async () => ""
      })
    }),
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
    cookies: async () => [{ name: "BDUSS", value: "auth-token", domain: ".baidu.com" }],
    close: async () => {}
  };
  const adapter = new BaijiahaoAdapter({
    browser: {
      launchPersistentContext: async () => context
    }
  });

  await assert.rejects(() => adapter.publishArticle({
    articleTitle: "Zhixin AI Baijiahao security test",
    contentMarkdown: "This test verifies security verification blockers.",
    // 这条用例专门覆盖浏览器编辑器流程，适配器默认已经改成走 API 通道。
    apiFirst: false,
    confirmPublish: true,
    manualVerificationTimeoutMs: 1
  }), /BAIJIAHAO_SECURITY_VERIFICATION_REQUIRED/);
});

test("retains a disposable draft for foreground Baijiahao security verification", async () => {
  const calls = [];
  const progress = [];
  const payloadFor = (url) => {
    const path = new URL(url).pathname;
    calls.push(path);
    return path.endsWith("/save")
      ? { errno: 0, ret: { article_id: "1869859444444444444" } }
      : path.endsWith("/edit")
        ? { errno: 0, ret: {} }
        : path.endsWith("/publish")
          ? { errno: 10000015, errmsg: "security verification required" }
          : path.endsWith("/lists")
            ? { errno: 0, data: { list: [{ article_id: "1869859444444444444", title: "Baijiahao API security verification" }] } }
            : path.endsWith("/withdraw")
              ? { errno: 20040028 }
              : { errno: 0, ret: {} };
  };
  const page = {
    _url: "https://baijiahao.baidu.com/builder/rc/edit?type=news",
    async goto(url) { page._url = url; },
    async waitForLoadState() {},
    url: () => page._url,
    request: {
      async fetch(url) {
        return {
          status: () => 200,
          url: () => url,
          text: async () => JSON.stringify(payloadFor(url)),
        };
      },
    },
    async evaluate(callback, request) {
      if (String(callback).includes('credentials: "include"') && request?.requestUrl) {
        return { status: 200, url: request.requestUrl, text: JSON.stringify(payloadFor(request.requestUrl)) };
      }
      if (String(callback).includes("edit-token")) return JSON.stringify("runtime-request-token");
      return { nonce: "runtime-only", bjhmt: "" };
    },
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "BDUSS", value: "auth-token", domain: ".baidu.com" }],
    close: async () => {},
  };
  const adapter = new BaijiahaoAdapter({ browser: { launchPersistentContext: async () => context } });

  const result = await adapter.publishArticle({
    articleTitle: "Baijiahao API security verification",
    contentMarkdown: "This is a disposable security verification test.",
    confirmPublish: true,
    apiFirst: true,
    disposableTest: true,
    preserveDraftOnManualVerification: true,
    coverImageUrl: "https://baijiahao.baidu.com/bjh/picproxy?param=cover",
    onProgress: async (event) => progress.push(event),
  });

  assert.equal(result.platformStatus, "manual_verification_required");
  assert.equal(result.reviewStatus, "security_verification_required");
  assert.equal(result.publishedUrl, "");
  assert.equal(result.publicationEvidence.accepted, false);
  assert.equal(result.testCleanup, undefined);
  assert.match(result.currentUrl, /article_id=1869859444444444444/);
  assert.match(page._url, /article_id=1869859444444444444/);
  assert.ok(progress.some((event) => event.type === "manual_verification_required"));
  // publish retries once after the fake clearance (the draft page exposes no blocker), so the
  // second blocked attempt ends the loop instead of waiting out the manual-verification budget.
  assert.deepEqual(calls.filter((path) => /\/(publish|withdraw|remove)$/.test(path)), [
    "/pcui/article/publish",
    "/pcui/article/publish",
  ]);
});

test("reports security verification required when cleanup is blocked after API publication", async () => {
  const calls = [];
  const progress = [];
  const payloadFor = (url) => {
    const path = new URL(url).pathname;
    calls.push(path);
    return path.endsWith("/save")
      ? { errno: 0, ret: { article_id: "1869859555555555555" } }
      : path.endsWith("/edit")
        ? { errno: 0, ret: {} }
        : path.endsWith("/publish")
          ? { errno: 0, ret: { _action: "publish", article_id: "1869859555555555555" } }
          : path.endsWith("/lists")
            ? { errno: 0, data: { list: [{ article_id: "1869859555555555555", title: "Baijiahao cleanup verification" }] } }
            : path.endsWith("/withdraw")
              ? { errno: 10000015, errmsg: "security verification required" }
              : { errno: 0, ret: {} };
  };
  const page = {
    _url: "https://baijiahao.baidu.com/builder/rc/edit?type=news",
    async goto(url) { page._url = url; },
    async waitForLoadState() {},
    url: () => page._url,
    request: {
      async fetch(url) {
        return { status: () => 200, url: () => url, text: async () => JSON.stringify(payloadFor(url)) };
      },
    },
    async evaluate(callback, request) {
      if (String(callback).includes('credentials: "include"') && request?.requestUrl) {
        return { status: 200, url: request.requestUrl, text: JSON.stringify(payloadFor(request.requestUrl)) };
      }
      if (String(callback).includes("edit-token")) return JSON.stringify("runtime-request-token");
      return { nonce: "runtime-only", bjhmt: "" };
    },
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "BDUSS", value: "auth-token", domain: ".baidu.com" }],
    close: async () => {},
  };
  const adapter = new BaijiahaoAdapter({ browser: { launchPersistentContext: async () => context } });

  const result = await adapter.publishArticle({
    articleTitle: "Baijiahao cleanup verification",
    contentMarkdown: "This test verifies cleanup security verification handling.",
    confirmPublish: true,
    apiFirst: true,
    disposableTest: true,
    coverImageUrl: "https://baijiahao.baidu.com/bjh/picproxy?param=cover",
    onProgress: async (event) => progress.push(event),
  });

  assert.equal(result.platformStatus, "manual_verification_required");
  assert.equal(result.manualVerificationStage, "cleanup");
  assert.equal(result.publicationEvidence.accepted, true);
  assert.equal(result.testCleanup, undefined);
  assert.match(page._url, /article_id=1869859555555555555/);
  assert.ok(progress.some((event) => event.type === "manual_verification_required"));
  assert.deepEqual(calls.filter((path) => /\/(publish|withdraw|remove)$/.test(path)), [
    "/pcui/article/publish",
    "/pcui/article/withdraw",
    "/pcui/article/withdraw",
  ]);
});

test("uses Baijiahao publish API response when the page does not expose a public link", async () => {
  const bodyLocator = {
    first: () => bodyLocator,
    fill: async () => {},
    click: async () => {},
    press: async () => {}
  };
  let responseHandler = null;
  const page = {
    _url: "https://baijiahao.baidu.com/builder/rc/edit?type=news",
    _coverSelected: true,
    on: (event, handler) => {
      if (event === "response") responseHandler = handler;
    },
    off: () => {},
    goto: async (url) => { page._url = url; },
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    waitForFunction: async () => {},
    url: () => page._url,
    title: async () => "Baijiahao",
    evaluate: async (fn) => {
      if (typeof fn === "function" && String(fn).includes("bjhNewsCover")) return true;
      return "Baijiahao creator center publish content management saved publish";
    },
    frameLocator: () => ({ locator: () => bodyLocator }),
    locator: () => ({
      first: () => ({
        fill: async () => {},
        click: async () => {},
        isDisabled: async () => false,
        isVisible: async () => false,
        getAttribute: async () => ""
      }),
      last: () => ({
        click: async () => {},
        setInputFiles: async () => {},
        isDisabled: async () => false,
        isVisible: async () => false,
        getAttribute: async () => ""
      })
    }),
    getByRole: () => ({
      first: () => ({
        isVisible: async () => true,
        isDisabled: async () => false,
        click: async () => {
          await responseHandler?.({
            url: () => "https://baijiahao.baidu.com/pcui/article/publish?type=news&callback=bjhpublish",
            text: async () => "bjhpublish({\"errno\":0,\"data\":{\"article_id\":\"1869859000000000000\"}})"
          });
        }
      })
    })
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "BDUSS", value: "auth-token", domain: ".baidu.com" }],
    close: async () => {}
  };
  const adapter = new BaijiahaoAdapter({
    browser: {
      launchPersistentContext: async () => context
    }
  });

  const result = await adapter.publishArticle({
    articleTitle: "Zhixin AI Baijiahao API response test",
    contentMarkdown: "This test verifies API response URL extraction.",
    // 这条用例专门覆盖浏览器编辑器流程，适配器默认已经改成走 API 通道。
    apiFirst: false,
    confirmPublish: true
  });

  assert.equal(result.publishedUrl, "https://baijiahao.baidu.com/s?id=1869859000000000000");
});

test("waits for manual Baidu verification and continues when publish result appears", async () => {
  const bodyLocator = {
    first: () => bodyLocator,
    fill: async () => {},
    click: async () => {},
    press: async () => {}
  };
  let textState = "百度安全验证 请完成下方验证后继续操作";
  let timeoutCalls = 0;
  const page = {
    _url: "https://baijiahao.baidu.com/builder/rc/edit?type=news",
    _coverSelected: true,
    on: () => {},
    off: () => {},
    goto: async (url) => { page._url = url; },
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {
      timeoutCalls += 1;
      if (timeoutCalls > 2) {
        textState = "Baijiahao creator center publish success";
        page._url = "https://baijiahao.baidu.com/builder/preview/s?id=1869859111111111111";
      }
    },
    waitForFunction: async () => {},
    url: () => page._url,
    title: async () => "Baijiahao",
    evaluate: async (fn) => {
      if (typeof fn === "function" && String(fn).includes("bjhNewsCover")) return true;
      return textState;
    },
    frameLocator: () => ({ locator: () => bodyLocator }),
    locator: () => ({
      first: () => ({
        fill: async () => {},
        click: async () => {},
        isDisabled: async () => false,
        isVisible: async () => false,
        getAttribute: async () => ""
      }),
      last: () => ({
        click: async () => {},
        setInputFiles: async () => {},
        isDisabled: async () => false,
        isVisible: async () => false,
        getAttribute: async () => ""
      })
    }),
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
    cookies: async () => [{ name: "BDUSS", value: "auth-token", domain: ".baidu.com" }],
    close: async () => {}
  };
  const adapter = new BaijiahaoAdapter({
    browser: {
      launchPersistentContext: async () => context
    }
  });

  const result = await adapter.publishArticle({
    articleTitle: "Zhixin AI Baijiahao manual verification test",
    contentMarkdown: "This test verifies manual verification continuation.",
    // 这条用例专门覆盖浏览器编辑器流程，适配器默认已经改成走 API 通道。
    apiFirst: false,
    confirmPublish: true,
    manualVerificationTimeoutMs: 10000
  });

  assert.equal(result.publishedUrl, "https://baijiahao.baidu.com/s?id=1869859111111111111");
  assert.equal(result.platformStatus, "published");
});

test("publishes Baijiahao through the browser API context without inventing a public backlink", async () => {
  const calls = [];
  const page = {
    _url: "about:blank",
    request: {
      async fetch(url, options = {}) {
        calls.push({ url, options });
        return {
          status: () => 200,
          url: () => url,
          text: async () => JSON.stringify({
            errno: 0,
            errmsg: "success",
            ret: { _action: "publish", article_id: "1869859222222222222" },
          }),
        };
      },
    },
    async goto(url) { page._url = url; },
    async waitForLoadState() {},
    async waitForTimeout() {},
    url: () => page._url,
    async title() { return "Baijiahao"; },
    async evaluate(callback, request) {
      if (String(callback).includes('credentials: "include"') && request?.requestUrl) {
        calls.push({
          url: request.requestUrl,
          options: {
            method: request.requestMethod,
            headers: request.requestHeaders,
            data: request.requestData,
          },
        });
        return {
          status: 200,
          url: request.requestUrl,
          text: JSON.stringify({
            errno: 0,
            errmsg: "success",
            ret: { _action: "publish", article_id: "1869859222222222222" },
          }),
        };
      }
      if (String(callback).includes("edit-token")) return JSON.stringify("runtime-request-token");
      return { nonce: "runtime-only", bjhmt: "runtime-only" };
    },
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "BDUSS", value: "baidu-secret-token", domain: ".baidu.com" }],
    close: async () => calls.push({ close: true }),
  };
  const adapter = new BaijiahaoAdapter({
    browser: { launchPersistentContext: async () => context },
  });

  const result = await adapter.publishArticle({
    articleTitle: "Baijiahao API-first publish test",
    contentMarkdown: "This verifies Baijiahao API publishing waits for public review before backlink writeback.",
    contentHtml: "<p>This verifies Baijiahao API publishing waits for public review before backlink writeback.</p>",
    confirmPublish: true,
    apiFirst: true,
    platformConfig: {
      publishApiUrl: "https://baijiahao.baidu.com/pcui/article/publish?type=news",
    },
  });

  assert.equal(result.platformStatus, "submitted_for_review");
  assert.equal(result.publishedUrl, "");
  assert.equal(result.publiclyVisible, false);
  assert.equal(result.externalIds.articleId, "1869859222222222222");
  assert.match(result.reviewUrl, /article_id=1869859222222222222/);
  assert.equal(result.publicationEvidence.source, "api");
  assert.equal(result.publicationEvidence.accepted, true);
  assert.equal(calls.filter((call) => String(call.url).includes("/pcui/article/publish")).length, 1);
  assert.doesNotMatch(JSON.stringify(result.publicationEvidence), /baidu-secret-token/);
});

test("reports only the HTTP and business code when Baijiahao rejects the first API save", async () => {
  const page = {
    async evaluate(callback, request) {
      if (String(callback).includes('credentials: "include"') && request?.requestUrl) {
        return {
          status: 200,
          url: request.requestUrl,
          text: JSON.stringify({ errno: 12345, errmsg: "platform rejection detail" }),
        };
      }
      if (String(callback).includes("edit-token")) return JSON.stringify("runtime-request-token");
      return { nonce: "runtime-only", bjhmt: "runtime-only" };
    },
    async goto() {},
  };
  const context = { pages: () => [page], newPage: async () => page, close: async () => {} };
  const adapter = new BaijiahaoAdapter({ browser: { launchPersistentContext: async () => context } });

  await assert.rejects(
    () => adapter.publishArticle({
      articleTitle: "Baijiahao rejected save diagnostic",
      contentMarkdown: "No draft should be accepted for this test.",
      confirmPublish: true,
      apiFirst: true,
    }),
    /BAIJIAHAO_API_DRAFT_CREATE_NOT_ACCEPTED_HTTP_200_CODE_12345/
  );
});

test("publishes Baijiahao through two API saves that reuse the returned article ID", async () => {
  const calls = [];
  const browserCalls = [];
  const page = {
    request: {
      async fetch(url, options = {}) {
        calls.push({ url, options });
        const path = new URL(url).pathname;
        const payload = path.endsWith("/save")
          ? { errno: 0, ret: { article_id: "1869859333333333333" } }
          : { errno: 0, ret: { _action: "publish", article_id: "1869859333333333333" } };
        return {
          status: () => 200,
          url: () => url,
          text: async () => JSON.stringify(payload),
        };
      },
    },
    async goto() {},
    async evaluate(callback, request) {
      if (String(callback).includes('credentials: "include"') && request?.requestUrl) {
        browserCalls.push(request);
        const path = new URL(request.requestUrl).pathname;
        const payload = path.endsWith("/save")
          ? { errno: 0, ret: { article_id: "1869859333333333333" } }
          : { errno: 0, ret: { _action: "publish", article_id: "1869859333333333333" } };
        return { status: 200, url: request.requestUrl, text: JSON.stringify(payload) };
      }
      if (String(callback).includes("edit-token")) return JSON.stringify("runtime-request-token");
      if (String(callback).includes("BJH_FE_NOUNCE")) return { nonce: "editor-provided-nonce", bjhmt: "" };
      return {};
    },
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "BDUSS", value: "baidu-secret-token", domain: ".baidu.com" }],
    close: async () => undefined,
  };
  const adapter = new BaijiahaoAdapter({
    browser: { launchPersistentContext: async () => context },
  });

  const result = await adapter.publishArticle({
    articleTitle: "Baijiahao saved API chain test",
    contentMarkdown: "Saved through the captured API chain.",
    contentHtml: "<p>Saved through the captured API chain.</p>",
    confirmPublish: true,
    apiFirst: true,
  });

  const saves = browserCalls.filter((call) => new URL(call.requestUrl).pathname.endsWith("/save"));
  const publish = browserCalls.find((call) => new URL(call.requestUrl).pathname.endsWith("/publish"));
  assert.equal(saves.length, 2);
  assert.equal(new URL(saves[0].requestUrl).searchParams.get("callback"), "bjhdraft");
  assert.equal(new URL(saves[1].requestUrl).searchParams.get("callback"), "bjhpreview");
  assert.equal(saves[0].requestHeaders.token, "runtime-request-token");
  assert.equal(saves[1].requestHeaders.token, "runtime-request-token");
  assert.equal(new URLSearchParams(saves[0].requestData).has("article_id"), false);
  assert.equal(new URLSearchParams(saves[1].requestData).get("article_id"), "1869859333333333333");
  assert.match(new URLSearchParams(saves[0].requestData).get("len"), /^\d+$/);
  assert.equal(new URLSearchParams(saves[0].requestData).get("source_reprinted_allow"), "0");
  assert.equal(new URLSearchParams(saves[0].requestData).get("abstract_from"), "1");
  assert.equal(new URLSearchParams(saves[0].requestData).get("isBeautify"), "false");
  assert.equal(new URLSearchParams(saves[0].requestData).get("usingImgFilter"), "false");
  assert.equal(new URLSearchParams(saves[0].requestData).get("first_exclusive_publish_v2"), "3");
  assert.equal(new URLSearchParams(saves[0].requestData).get("activity_list[0][id]"), "ai_tts");
  assert.equal(new URLSearchParams(saves[0].requestData).get("activity_list[0][is_checked]"), "1");
  assert.equal(new URLSearchParams(saves[0].requestData).get("activity_list[1][id]"), "aigc_bjh_status");
  assert.equal(new URLSearchParams(saves[0].requestData).get("activity_list[1][is_checked]"), "0");
  assert.equal(new URLSearchParams(saves[0].requestData).get("subtitle"), "");
  assert.equal(new URLSearchParams(saves[0].requestData).get("bjhtopic_id"), "");
  assert.equal(new URLSearchParams(saves[0].requestData).get("bjhtopic_info"), "");
  assert.equal(new URLSearchParams(publish.requestData).get("article_id"), "1869859333333333333");
  assert.equal(new URLSearchParams(publish.requestData).get("BJH_FE_NOUNCE"), "editor-provided-nonce");
  assert.equal(new URLSearchParams(publish.requestData).get("bjhmt"), null);
  assert.equal(result.externalIds.articleId, "1869859333333333333");
  assert.doesNotMatch(JSON.stringify(result.publicationEvidence), /runtime-only|baidu-secret-token/);
});

test("converts structured content blocks to editor-compatible paragraphs for the Baijiahao save API", async () => {
  const browserCalls = [];
  const page = {
    async goto() {},
    async waitForLoadState() {},
    async evaluate(callback, request) {
      if (String(callback).includes('credentials: "include"') && request?.requestUrl) {
        browserCalls.push(request);
        const pathname = new URL(request.requestUrl).pathname;
        const payload = pathname.endsWith("/save")
          ? { errno: 0, ret: { article_id: "1869859444444444444" } }
          : { errno: 0, ret: { _action: "publish", article_id: "1869859444444444444" } };
        return { status: 200, url: request.requestUrl, text: JSON.stringify(payload) };
      }
      if (String(callback).includes("edit-token")) return "runtime-request-token";
      return { nonce: "runtime-only", bjhmt: "runtime-only" };
    },
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "BDUSS", value: "baidu-secret-token", domain: ".baidu.com" }],
    close: async () => undefined,
  };
  const adapter = new BaijiahaoAdapter({
    browser: { launchPersistentContext: async () => context },
  });

  await adapter.publishArticle({
    articleTitle: "Baijiahao structured content compatibility test",
    contentMarkdown: "Plain body marker.",
    contentBlocks: [
      { type: "title", text: "Baijiahao structured content compatibility test" },
      { type: "section", sectionId: "section-1", title: "Section title", content: "Plain body marker." },
    ],
    confirmPublish: true,
    apiFirst: true,
  });

  const firstSave = browserCalls.find((call) => new URL(call.requestUrl).pathname.endsWith("/save"));
  const content = new URLSearchParams(firstSave.requestData).get("content") || "";
  assert.doesNotMatch(content, /<section|<h2/i);
  assert.match(content, /^<p[ >]/i);
});

test("refreshes the Baijiahao request token after cover upload before saving", async () => {
  const calls = [];
  let tokenReads = 0;
  const articleId = "1869859555555555555";
  const page = {
    request: {
      async fetch(url, options = {}) {
        calls.push({ url, options });
        const pathname = new URL(url).pathname;
        let payload = { errno: 0 };
        if (pathname.endsWith("/appinfo")) payload = { errno: 0, data: { app_id: "123456789" } };
        if (pathname.includes("uploadProxy")) payload = { errno: 0, ret: { https_url: "https://pic.rmb.bdstatic.com/bjh/token-refresh-cover.png" } };
        if (pathname.endsWith("/save")) payload = { errno: 0, ret: { article_id: articleId } };
        if (pathname.endsWith("/publish")) payload = { errno: 0, ret: { _action: "publish", article_id: articleId } };
        if (pathname.endsWith("/lists")) payload = { errno: 0, data: { list: [{ article_id: articleId, title: "Token refresh test" }] } };
        if (pathname.endsWith("/withdraw") || pathname.endsWith("/remove")) payload = { errno: 0 };
        return {
          status: () => 200,
          url: () => url,
          text: async () => JSON.stringify(payload),
        };
      },
    },
    async goto() {},
    async evaluate(callback, request) {
      if (String(callback).includes('credentials: "include"') && request?.requestUrl) {
        calls.push({ url: request.requestUrl, options: { headers: request.requestHeaders, data: request.requestData } });
        const pathname = new URL(request.requestUrl).pathname;
        const payload = pathname.endsWith("/save")
          ? { errno: 0, ret: { article_id: articleId } }
          : { errno: 0, ret: { _action: "publish", article_id: articleId } };
        return { status: 200, url: request.requestUrl, text: JSON.stringify(payload) };
      }
      if (String(callback).includes("edit-token")) {
        tokenReads += 1;
        return tokenReads === 1 ? "token-before-upload" : "token-after-upload";
      }
      return { nonce: "runtime-only", bjhmt: "runtime-only" };
    },
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "BDUSS", value: "baidu-secret-token", domain: ".baidu.com" }],
    close: async () => undefined,
  };
  const adapter = new BaijiahaoAdapter({
    browser: { launchPersistentContext: async () => context },
  });

  await adapter.publishArticle({
    articleTitle: "Token refresh test",
    contentMarkdown: "Cover upload rotates the editor token.",
    coverImagePath: fileURLToPath(new URL("../resources/adapter_ed25519_public.pem", import.meta.url)),
    confirmPublish: true,
    apiFirst: true,
    verifyPublication: false,
    disposableTest: true,
  });

  const upload = calls.find((call) => new URL(call.url).pathname.includes("uploadProxy"));
  const saves = calls.filter((call) => new URL(call.url).pathname.endsWith("/save"));
  assert.equal(upload.options.headers.token, "token-before-upload");
  assert.equal(saves.length, 2);
  assert.equal(saves[0].options.headers.token, "token-after-upload");
  assert.equal(saves[1].options.headers.token, "token-after-upload");
});

test("includes the platform cover in the first Baijiahao API save", async () => {
  const browserCalls = [];
  const articleId = "1869859666666666666";
  const page = {
    async goto() {},
    async evaluate(callback, request) {
      if (String(callback).includes('credentials: "include"') && request?.requestUrl) {
        browserCalls.push(request);
        const pathname = new URL(request.requestUrl).pathname;
        const payload = pathname.endsWith("/save")
          ? { errno: 0, ret: { article_id: articleId } }
          : { errno: 0, ret: { _action: "publish", article_id: articleId } };
        return { status: 200, url: request.requestUrl, text: JSON.stringify(payload) };
      }
      if (String(callback).includes("edit-token")) return "runtime-request-token";
      return { nonce: "runtime-only", bjhmt: "runtime-only" };
    },
  };
  const context = { pages: () => [page], newPage: async () => page, close: async () => undefined };
  const adapter = new BaijiahaoAdapter({ browser: { launchPersistentContext: async () => context } });

  await adapter.publishArticle({
    articleTitle: "Baijiahao first save cover test",
    contentMarkdown: "The first save must carry the uploaded platform cover.",
    coverImageUrl: "https://baijiahao.baidu.com/bjh/picproxy?param=platform-cover",
    confirmPublish: true,
    apiFirst: true,
  });

  const saves = browserCalls.filter((call) => new URL(call.requestUrl).pathname.endsWith("/save"));
  assert.equal(saves.length, 2);
  const firstSave = new URLSearchParams(saves[0].requestData);
  assert.deepEqual(JSON.parse(firstSave.get("cover_images")), [{
    src: "https://baijiahao.baidu.com/bjh/picproxy?param=platform-cover",
    cover_source_tag: "text",
    cropData: {},
    isLegal: 0,
    machine_chooseimg: 0,
  }]);
  assert.deepEqual(JSON.parse(firstSave.get("_cover_images_map")), [{
    origin_src: "https://baijiahao.baidu.com/bjh/picproxy?param=platform-cover",
    src: "https://baijiahao.baidu.com/bjh/picproxy?param=platform-cover",
  }]);
  assert.equal(firstSave.get("cover_image_source[wide_cover_image_source]"), "text");
  assert.equal(firstSave.get("source"), "upload");
});

test("reloads the Baijiahao editor record between the two API saves", async () => {
  const browserCalls = [];
  const articleId = "1869859777777777777";
  const page = {
    async goto() {},
    async evaluate(callback, request) {
      if (String(callback).includes('credentials: "include"') && request?.requestUrl) {
        browserCalls.push(request);
        const pathname = new URL(request.requestUrl).pathname;
        const payload = pathname.endsWith("/save")
          ? { errno: 0, ret: { article_id: articleId } }
          : pathname.endsWith("/edit")
            ? { errno: 0, data: { article_id: articleId } }
            : { errno: 0, ret: { _action: "publish", article_id: articleId } };
        return { status: 200, url: request.requestUrl, text: JSON.stringify(payload) };
      }
      if (String(callback).includes("edit-token")) return "runtime-request-token";
      return { nonce: "runtime-only", bjhmt: "runtime-only" };
    },
  };
  const context = { pages: () => [page], newPage: async () => page, close: async () => undefined };
  const adapter = new BaijiahaoAdapter({ browser: { launchPersistentContext: async () => context } });

  await adapter.publishArticle({
    articleTitle: "Baijiahao editor reload test",
    contentMarkdown: "The editor record must be reloaded between saves.",
    coverImageUrl: "https://baijiahao.baidu.com/bjh/picproxy?param=platform-cover",
    confirmPublish: true,
    apiFirst: true,
  });

  const apiPaths = browserCalls.map((call) => new URL(call.requestUrl).pathname);
  assert.deepEqual(apiPaths.slice(0, 3), ["/pcui/article/save", "/pcui/article/edit", "/pcui/article/save"]);
});

test("reads Baijiahao article evidence and removes a disposable article through captured APIs", async () => {
  const articleId = "1870000000000000001";
  const calls = [];
  const page = {
    request: {
      async fetch(url, options = {}) {
        calls.push({ url, options });
        return {
          status: () => 200,
          url: () => url,
          text: async () => JSON.stringify({
            errno: 0,
            data: {
              list: [{
                article_id: articleId,
                title: "Disposable Baijiahao gate article",
                cover_images: ["https://pic.rmb.bdstatic.com/bjh/cover.png"],
                status: 1,
                is_published: 1,
              }],
            },
          }),
        };
      },
    },
    async evaluate(callback, request) {
      if (!String(callback).includes('credentials: "include"')) return null;
      calls.push({
        url: request.requestUrl,
        options: {
          method: request.requestMethod,
          headers: request.requestHeaders,
          data: request.requestData,
        },
      });
      if (String(request.requestUrl).includes("/pcui/article/lists")) {
        return {
          status: 200,
          url: request.requestUrl,
          text: JSON.stringify({
            errno: 0,
            data: {
              list: [{
                article_id: articleId,
                title: "Disposable Baijiahao gate article",
                cover_images: ["https://pic.rmb.bdstatic.com/bjh/cover.png"],
                status: 1,
                is_published: 1,
              }],
            },
          }),
        };
      }
      return {
        status: 200,
        url: request.requestUrl,
        text: JSON.stringify({ errno: 0, errmsg: "success", data: { result: true } }),
      };
    },
  };

  const listed = await readBaijiahaoArticleList(page, { articleId });
  assert.equal(listed.found, true);
  assert.equal(listed.articleId, articleId);
  assert.equal(listed.title, "Disposable Baijiahao gate article");
  assert.equal(listed.coverImageCount, 1);

  const cleanup = await cleanupBaijiahaoArticle(page, { articleId });
  assert.equal(cleanup.withdrawn, true);
  assert.equal(cleanup.removed, true);
  assert.equal(cleanup.articleId, articleId);
  assert.equal(calls.filter((call) => String(call.url).includes("/withdraw")).length, 1);
  assert.equal(calls.filter((call) => String(call.url).includes("/remove")).length, 1);
  assert.match(String(calls.find((call) => String(call.url).includes("/withdraw")).options.data), /article_id=/);
});

test("removes an unpublished Baijiahao disposable draft without a withdraw step", async () => {
  const articleId = "1870000000000000003";
  const calls = [];
  const page = {
    async evaluate(callback, request) {
      if (!String(callback).includes('credentials: "include"')) return null;
      calls.push(request);
      const pathname = new URL(request.requestUrl).pathname;
      const payload = pathname.endsWith("/withdraw")
        ? { errno: 20040028, errmsg: "draft does not require withdrawal" }
        : { errno: 0, errmsg: "success", data: { result: true } };
      return { status: 200, url: request.requestUrl, text: JSON.stringify(payload) };
    },
  };

  const cleanup = await cleanupBaijiahaoArticle(page, { articleId });

  assert.equal(cleanup.withdrawn, false);
  assert.equal(cleanup.withdrawalNotRequired, true);
  assert.equal(cleanup.removed, true);
  assert.equal(calls.filter((call) => new URL(call.requestUrl).pathname.endsWith("/withdraw")).length, 1);
  assert.equal(calls.filter((call) => new URL(call.requestUrl).pathname.endsWith("/remove")).length, 1);
});

test("keeps cleaning a published Baijiahao draft when withdraw hits the rate limit", async () => {
  // 2026-10-04 07:29 实测：撤回已发布测试稿撞上 10000008（操作太频繁）后清理整体抛错，
  // 已经发出去的文章留在账号里。撤回只是状态回落，remove 仍可删稿，所以只记录不中止。
  const articleId = "1870000000000000004";
  const calls = [];
  const page = {
    async evaluate(callback, request) {
      if (!String(callback).includes('credentials: "include"')) return null;
      calls.push(request);
      const pathname = new URL(request.requestUrl).pathname;
      const payload = pathname.endsWith("/withdraw")
        ? { errno: 10000008, errmsg: "you are operating too frequently" }
        : { errno: 0, errmsg: "success", data: { result: true } };
      return { status: 200, url: request.requestUrl, text: JSON.stringify(payload) };
    },
  };

  const cleanup = await cleanupBaijiahaoArticle(page, { articleId });

  assert.equal(cleanup.withdrawn, false);
  assert.equal(cleanup.withdrawalRateLimited, true);
  assert.equal(cleanup.removed, true);
  assert.equal(calls.filter((call) => new URL(call.requestUrl).pathname.endsWith("/withdraw")).length, 1);
  assert.equal(calls.filter((call) => new URL(call.requestUrl).pathname.endsWith("/remove")).length, 1);
  assert.deepEqual(cleanup.evidence.stages[0], { stage: "withdraw_rate_limited" });
});

test("API-first disposable mode verifies the public page before cleanup", async () => {
  const articleId = "1870000000000000002";
  const calls = [];
  const page = {
    _url: "https://baijiahao.baidu.com/builder/rc/edit?type=news",
    request: {
      async fetch(url, options = {}) {
        calls.push({ url, options });
        const path = new URL(url).pathname;
        const payload = String(url).includes("/builder/app/appinfo")
          ? { errno: 0, data: { user: { app_id: "1869000000000000000" } } }
          : String(url).includes("/materialui/picture/uploadProxy")
            ? { errno: 0, ret: { https_url: "https://baijiahao.baidu.com/bjh/picproxy?param=platform-cover" } }
          : path.endsWith("/save")
          ? { errno: 0, ret: { article_id: articleId } }
          : path.endsWith("/publish")
            ? { errno: 0, ret: { article_id: articleId } }
            : path.endsWith("/lists")
              ? { errno: 0, data: { list: [baijiahaoPublishedListItem(articleId, "Disposable API gate article")] } }
              : { errno: 0, data: { result: true } };
        return { status: () => 200, url: () => url, text: async () => JSON.stringify(payload) };
      },
    },
    async evaluate(callback, request) {
      if (String(callback).includes('credentials: "include"')) {
        calls.push({
          url: request.requestUrl,
          options: {
            method: request.requestMethod,
            headers: request.requestHeaders,
            data: request.requestData,
          },
        });
        const path = new URL(request.requestUrl).pathname;
        if (/\/(withdraw|remove)$/.test(path) && !page._url.startsWith("https://baijiahao.baidu.com/builder/rc/edit")) {
          throw new Error("BAIJIAHAO_CLEANUP_REQUIRES_EDITOR_ORIGIN");
        }
        const payload = path.endsWith("/save")
          ? { errno: 0, ret: { article_id: articleId } }
          : path.endsWith("/publish")
            ? { errno: 0, ret: { article_id: articleId } }
            : path.endsWith("/lists")
              ? { errno: 0, data: { list: [baijiahaoPublishedListItem(articleId, "Disposable API gate article")] } }
              : { errno: 0, data: { result: true } };
        return { status: 200, url: request.requestUrl, text: JSON.stringify(payload) };
      }
      if (String(callback).includes("edit-token")) return "runtime-request-token";
      return { nonce: "runtime-only", bjhmt: "runtime-only" };
    },
    async goto(url) { page._url = url; },
    async waitForLoadState() {},
    url() { return page._url; },
    async title() { return "Disposable API gate article"; },
    locator() {
      return { first: () => ({ async innerText() { return "Disposable API gate article Disposable API gate article body"; } }) };
    },
  };
  const context = { pages: () => [page], newPage: async () => page, close: async () => {} };
  const adapter = new BaijiahaoAdapter({ browser: { launchPersistentContext: async () => context } });

  const result = await adapter.publishArticle({
    articleTitle: "Disposable API gate article",
    contentMarkdown: "Disposable API gate article body",
    contentHtml: "<p>Disposable API gate article body</p>",
    confirmPublish: true,
    apiFirst: true,
    verifyPublication: true,
    disposableTest: true,
    coverImageUrl: "/uploads/assets/source-cover.png",
    coverImagePath: fileURLToPath(new URL("../resources/adapter_ed25519_public.pem", import.meta.url)),
  });

  assert.equal(result.platformStatus, "published");
  assert.equal(result.publiclyVisible, true);
  assert.equal(result.testCleanup.removed, true);
  assert.equal(result.publicEvidence.titleMatched, true);
  assert.equal(result.coverImageEvidence.status, "verified");
  assert.equal(result.coverImageEvidence.platformImageUrl, "https://baijiahao.baidu.com/bjh/picproxy?param=platform-cover");
  const saves = calls.filter((call) => new URL(call.url).pathname.endsWith("/save"));
  assert.equal(saves.length, 2);
  assert.deepEqual(
    JSON.parse(new URLSearchParams(saves[0].options.data).get("cover_images")),
    [{
      src: "https://baijiahao.baidu.com/bjh/picproxy?param=platform-cover",
      cover_source_tag: "text",
      cropData: {},
      isLegal: 0,
      machine_chooseimg: 0,
    }]
  );
  assert.deepEqual(
    JSON.parse(new URLSearchParams(saves[1].options.data).get("cover_images")),
    [{
      src: "https://baijiahao.baidu.com/bjh/picproxy?param=platform-cover",
      cover_source_tag: "text",
      cropData: {},
      isLegal: 0,
      machine_chooseimg: 0,
    }]
  );
  assert.equal(calls.filter((call) => String(call.url).includes("/lists")).length, 1);
  assert.equal(calls.filter((call) => String(call.url).includes("/withdraw")).length, 1);
  assert.equal(calls.filter((call) => String(call.url).includes("/remove")).length, 1);
});

test("treats a successful Baijiahao withdraw that embeds risk metadata as success, not verification", async () => {
  // Regression: the real withdraw/publish payload always embeds article metadata whose field
  // names contain `bjh_risk_profile`, `risk_group` and `norisk`. The old detector stringified the
  // whole payload, so every successful withdraw/remove was reported as a security-verification
  // block and the command got stuck in the manual-verification state.
  const articleId = "1878103385243229627";
  const calls = [];
  const progress = [];
  const acceptedPayload = {
    errno: 0,
    errmsg: "success",
    data: {
      _action: "publish",
      article_id: articleId,
      id: articleId,
      status: "publish",
      is_published: 1,
      secure_status: "publish",
      quality_status: "publish",
      bjh_risk_profile: { risk_group: 0 },
      black_ip_data: '{"is_hit": false, "standard": ""}',
      leader_content_model_v2: [{ desc: "leader", score: 0.00005, raw_score: { norisk: 0.9997, leader: 0.00005 } }],
      audit_status_info: { qm_info: { status: 1, audit_reason: "" } },
      cover_images: '[{"src":"https://pic.rmb.bdstatic.com/bjh/cover.png","isLegal":0,"machine_chooseimg":0}]',
      url: `https://baijiahao.baidu.com/s?id=${articleId}`,
      title: "Disposable API gate article",
    },
  };
  const page = {
    _url: "https://baijiahao.baidu.com/builder/rc/edit?type=news",
    request: {
      async fetch(url) {
        calls.push(url);
        const path = new URL(url).pathname;
        if (/\/lists$/.test(path)) {
          return {
            status: () => 200,
            url: () => url,
            text: async () => JSON.stringify({
              errno: 0,
              data: { list: [baijiahaoPublishedListItem(articleId, "Disposable API gate article")] },
            }),
          };
        }
        return { status: () => 200, url: () => url, text: async () => JSON.stringify(acceptedPayload) };
      },
    },
    async evaluate(callback, request) {
      if (String(callback).includes('credentials: "include"')) {
        calls.push(request.requestUrl);
        const path = new URL(request.requestUrl).pathname;
        if (/\/(withdraw|remove)$/.test(path) && !page._url.startsWith("https://baijiahao.baidu.com/builder/rc/edit")) {
          throw new Error("BAIJIAHAO_CLEANUP_REQUIRES_EDITOR_ORIGIN");
        }
        if (/\/lists$/.test(path)) {
          return {
            status: 200,
            url: request.requestUrl,
            text: JSON.stringify({
              errno: 0,
              data: { list: [baijiahaoPublishedListItem(articleId, "Disposable API gate article")] },
            }),
          };
        }
        return { status: 200, url: request.requestUrl, text: JSON.stringify(acceptedPayload) };
      }
      if (String(callback).includes("edit-token")) return "runtime-request-token";
      return { nonce: "runtime-only", bjhmt: "runtime-only" };
    },
    async goto(url) { page._url = url; },
    async waitForLoadState() {},
    url() { return page._url; },
    async title() { return "Disposable API gate article"; },
    locator() {
      return { first: () => ({ async innerText() { return "Disposable API gate article Disposable API gate article body"; } }) };
    },
  };
  const context = { pages: () => [page], newPage: async () => page, close: async () => {} };
  const adapter = new BaijiahaoAdapter({ browser: { launchPersistentContext: async () => context } });

  const result = await adapter.publishArticle({
    articleTitle: "Disposable API gate article",
    contentMarkdown: "Disposable API gate article body",
    contentHtml: "<p>Disposable API gate article body</p>",
    confirmPublish: true,
    apiFirst: true,
    verifyPublication: true,
    disposableTest: true,
    coverImageUrl: "https://baijiahao.baidu.com/bjh/picproxy?param=platform-cover",
    onProgress: async (event) => progress.push(event),
  });

  assert.equal(result.platformStatus, "published");
  assert.equal(result.publiclyVisible, true);
  assert.equal(result.testCleanup.removed, true);
  assert.equal(result.testCleanup.withdrawn, true);
  assert.equal(result.testCleanup.withdrawalNotRequired, undefined);
  const withdraws = calls.filter((url) => String(url).endsWith("/pcui/article/withdraw"));
  const removes = calls.filter((url) => String(url).endsWith("/pcui/article/remove"));
  assert.equal(withdraws.length, 1);
  assert.equal(removes.length, 1);
  assert.equal(progress.filter((event) => event.type === "manual_verification_required").length, 0);
});

test("uploads a Baijiahao cover through the current-session image API", async () => {
  const calls = [];
  const page = {
    request: {
      async fetch(url, options = {}) {
        calls.push({ url, options });
        const payload = String(url).includes("/builder/app/appinfo")
          ? { errno: 0, data: { user: { app_id: "1869000000000000000" } } }
          : { errno: 0, ret: { https_url: "https://baijiahao.baidu.com/bjh/picproxy?param=platform-image" } };
        return { status: () => 200, url: () => url, text: async () => JSON.stringify(payload) };
      },
    },
  };

  const result = await uploadBaijiahaoImage(page, {
    imagePath: fileURLToPath(new URL("../resources/adapter_ed25519_public.pem", import.meta.url)),
  });

  assert.equal(result.platformImageUrl, "https://baijiahao.baidu.com/bjh/picproxy?param=platform-image");
  const upload = calls.find((call) => String(call.url).includes("/materialui/picture/uploadProxy"));
  assert.ok(upload);
  assert.equal(upload.options.multipart.article_type, "news");
  assert.equal(upload.options.multipart.type, "image");
  assert.ok(upload.options.multipart.media.buffer.length > 0);
});

test("decodes the Baijiahao editor edit-token JWT and reports its real 12 hour lifetime", () => {
  const decoded = decodeBaijiahaoRequestToken(makeEditToken({ ttlSeconds: 43200, issuedAgoSeconds: 60 }));

  assert.equal(decoded.hasExpiry, true);
  assert.equal(decoded.ttlSeconds, 43200);
  assert.equal(decoded.expiresAt, new Date(decoded.exp * 1000).toISOString());
  assert.ok(decoded.remainingMs > 43100 * 1000);
  assert.match(decoded.token, /^eyJhbGciOiJIUzI1NiJ9\./);
});

test("decodes an edit-token wrapped by the editor's JSON envelope", () => {
  const raw = makeEditToken({ ttlSeconds: 43200, issuedAgoSeconds: 120 });

  assert.equal(decodeBaijiahaoRequestToken(JSON.stringify(raw)).token, raw);
  assert.equal(decodeBaijiahaoRequestToken(JSON.stringify(raw)).ttlSeconds, 43200);
});

test("keeps a non-JWT request token usable instead of forcing an expiry it does not carry", () => {
  for (const value of ["", "   ", "runtime-request-token", '{"token":1}', "only.two"]) {
    const decoded = decodeBaijiahaoRequestToken(value);
    assert.equal(decoded.hasExpiry, false);
  }
  assert.equal(decodeBaijiahaoRequestToken("runtime-request-token").token, "runtime-request-token");
});

test("credential expiry takes the earlier of persistent cookies and the editor token", () => {
  const token = makeEditToken({ ttlSeconds: 43200, issuedAgoSeconds: 60 });
  const tokenExpiry = decodeBaijiahaoRequestToken(token).expiresAt;
  const artifact = buildBaijiahaoAuthArtifact({
    cookies: [
      { name: "BDUSS", value: "baidu-secret-token", domain: ".baidu.com", expires: 4102444800 },
      { name: "PHPSESSID", value: "session", domain: ".baijiahao.baidu.com", expires: 0 },
    ],
    localStorage: { "edit-token": token },
    sessionStorage: {},
  }, { capturedAt: new Date().toISOString() });

  // 持久 cookie 到 2100 年，但发文能力 12 小时后就没有了。
  assert.equal(artifact.credentialMetadata.editorTokenExpiresAt, tokenExpiry);
  assert.equal(artifact.credentialMetadata.editorTokenTtlSeconds, 43200);
  assert.equal(artifact.credentialMetadata.credentialExpiresAt, tokenExpiry);
});

test("cookie expiry still wins when it is genuinely the shorter one", () => {
  const token = makeEditToken({ ttlSeconds: 43200, issuedAgoSeconds: 60 });
  const merged = mergeBaijiahaoEditorTokenExpiry(
    { credentialExpiresAt: "2026-10-04T00:00:00.000Z" },
    { "edit-token": token }
  );

  assert.equal(merged.credentialExpiresAt, "2026-10-04T00:00:00.000Z");
  assert.equal(merged.editorTokenTtlSeconds, 43200);
});

test("credential expiry is untouched when the snapshot carries no editor token", () => {
  const baseline = { credentialExpiresAt: "2027-11-08T00:00:00.000Z", strongCookieCount: 3 };

  assert.deepEqual(mergeBaijiahaoEditorTokenExpiry(baseline, {}), baseline);
  assert.deepEqual(mergeBaijiahaoEditorTokenExpiry(baseline, { "edit-token": "not-a-jwt" }), baseline);
});

test("refuses to publish on an expired or nearly expired edit-token", async () => {
  const pageFor = (token) => ({
    async evaluate() { return token; },
  });

  await assert.rejects(
    () => readBaijiahaoRequestToken(pageFor(makeEditToken({ ttlSeconds: 43200, issuedAgoSeconds: 43300 }))),
    /BAIJIAHAO_RUNTIME_TOKEN_EXPIRED/
  );
  await assert.rejects(
    () => readBaijiahaoRequestToken(pageFor(makeEditToken({ ttlSeconds: 43200, issuedAgoSeconds: 43140 }))),
    /BAIJIAHAO_RUNTIME_TOKEN_EXPIRED: edit-token expires in \d+s/
  );
  await assert.rejects(
    () => readBaijiahaoRequestToken(pageFor("")),
    /BAIJIAHAO_RUNTIME_TOKEN_REQUIRED/
  );
});

test("the edit-token guard keeps an API-recognised reauth marker after sanitisation", async () => {
  const pageFor = (token) => ({ async evaluate() { return token; } });
  const markerSets = [
    ["LOGIN_REQUIRED", "NEEDS_REAUTH", "AUTH_EXPIRED", "TOKEN_EXPIRED", "SESSION_EXPIRED"],
    ["LOGIN_REQUIRED", "NEEDS_REAUTH", "AUTH_EXPIRED", "TOKEN_EXPIRED"],
  ];

  for (const issuedAgoSeconds of [43300, 43140]) {
    let message = "";
    try {
      await readBaijiahaoRequestToken(pageFor(makeEditToken({ ttlSeconds: 43200, issuedAgoSeconds })));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // agent-core reduces the thrown message to the leading error code before it
    // reaches the API, so the code itself has to carry the marker.
    const reported = message.match(/\b[A-Z][A-Z0-9_]*_[A-Z0-9_]+\b/)?.[0] || "";
    assert.equal(reported, "BAIJIAHAO_RUNTIME_TOKEN_EXPIRED");
    for (const markers of markerSets) {
      assert.ok(markers.some((marker) => reported.includes(marker)), `${reported} matches no reauth marker`);
    }
  }
});

test("a fresh edit-token still reaches the publish API call", async () => {
  const token = makeEditToken({ ttlSeconds: 43200, issuedAgoSeconds: 60 });
  const page = { async evaluate() { return JSON.stringify(token); } };

  assert.equal(await readBaijiahaoRequestToken(page), token);
});

test("publish omits BJH_FE_NOUNCE instead of fabricating one when the editor does not expose it", async () => {
  const browserCalls = [];
  const page = {
    request: {
      async fetch(url) {
        return { status: () => 200, url: () => url, text: async () => JSON.stringify({ errno: 0 }) };
      },
    },
    async goto() {},
    async waitForLoadState() {},
    async evaluate(callback, request) {
      if (String(callback).includes('credentials: "include"') && request?.requestUrl) {
        browserCalls.push(request);
        const path = new URL(request.requestUrl).pathname;
        const payload = path.endsWith("/save")
          ? { errno: 0, ret: { article_id: "1869859333333333333" } }
          : { errno: 0, ret: { _action: "publish", article_id: "1869859333333333333" } };
        return { status: 200, url: request.requestUrl, text: JSON.stringify(payload) };
      }
      if (String(callback).includes("edit-token")) return JSON.stringify("runtime-request-token");
      return {};
    },
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "BDUSS", value: "baidu-secret-token", domain: ".baidu.com" }],
    close: async () => undefined,
  };
  const adapter = new BaijiahaoAdapter({
    browser: { launchPersistentContext: async () => context },
  });

  const result = await adapter.publishArticle({
    articleTitle: "Baijiahao no fabricated nonce test",
    contentMarkdown: "No fabricated runtime fields.",
    contentHtml: "<p>No fabricated runtime fields.</p>",
    confirmPublish: true,
    apiFirst: true,
  });

  const publish = browserCalls.find((call) => new URL(call.requestUrl).pathname.endsWith("/publish"));
  assert.ok(publish);
  assert.equal(result.externalIds.articleId, "1869859333333333333");
  assert.equal(new URLSearchParams(publish.requestData).has("BJH_FE_NOUNCE"), false);
  assert.equal(new URLSearchParams(publish.requestData).has("bjhmt"), false);
});

test("the editor-token downgrade guard only fires when stored evidence exists", () => {
  assert.equal(baijiahaoCaptureLosesEditorToken({ credentialMetadata: {} }, { "edit-token": "stored" }), true);
  assert.equal(
    baijiahaoCaptureLosesEditorToken({ credentialMetadata: { editorTokenExpiresAt: "2026-10-05T00:00:00.000Z" } }, { "edit-token": "stored" }),
    false
  );
  assert.equal(baijiahaoCaptureLosesEditorToken({ credentialMetadata: {} }, {}), false);
});

function baijiahaoTokenPageMock({ localStorage: storage }) {
  return {
    url: () => "https://baijiahao.baidu.com/builder/rc/edit?type=news",
    title: async () => "Baijiahao creator center",
    evaluate: async (callback) => {
      if (String(callback).includes("innerText")) return "content management article publish";
      return { localStorage: storage, sessionStorage: {} };
    },
  };
}

function baijiahaoAliveCookieContext(page) {
  return {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "BDUSS", value: "still-alive", domain: ".baidu.com", expires: 4102444800 }],
    close: async () => undefined,
  };
}

test("a token-less credential refresh no longer overwrites the stored artifact", async () => {
  // The stored artifact still carries an edit-token, but the editor removed the expired
  // one from the live page. Uploading this token-less capture would reset the account to
  // cookie-only expiry on the API side and wipe the honest 12 hour publishing window.
  const storedToken = makeEditToken({ ttlSeconds: 43200, issuedAgoSeconds: 43300 });
  const page = baijiahaoTokenPageMock({ localStorage: { setItem: "", getItem: "", removeItem: "" } });
  const context = baijiahaoAliveCookieContext(page);
  const pushed = [];
  const adapter = new BaijiahaoAdapter({ browser: { launchPersistentContext: async () => context } });

  const artifact = await adapter.reportCredentialRefresh(
    { localStorage: { "edit-token": storedToken }, onCredentialRefresh: (next) => pushed.push(next) },
    context,
    page
  );

  assert.equal(pushed.length, 0);
  // The raw capture is exactly the downgraded shape the API must never receive again.
  assert.equal(artifact.credentialMetadata.editorTokenExpiresAt, undefined);
  assert.ok(Date.parse(artifact.credentialMetadata.credentialExpiresAt) > Date.now() + 300 * 24 * 3600 * 1000);
});

test("session validation keeps the real publishing deadline after the editor token disappears", async () => {
  const storedToken = makeEditToken({ ttlSeconds: 43200, issuedAgoSeconds: 43300 });
  const expected = decodeBaijiahaoRequestToken(storedToken);
  const page = baijiahaoTokenPageMock({ localStorage: {} });
  page._url = "about:blank";
  page.goto = async (url) => { page._url = url; };
  page.bringToFront = async () => {};
  page.waitForLoadState = async () => {};
  const context = baijiahaoAliveCookieContext(page);
  const pushed = [];
  const adapter = new BaijiahaoAdapter({ browser: { launchPersistentContext: async () => context } });

  const result = await adapter.validateSession({
    localStorage: { "edit-token": storedToken },
    onCredentialRefresh: (next) => pushed.push(next),
  });

  assert.equal(result.valid, true);
  assert.equal(pushed.length, 0);
  assert.equal(result.credentialMetadata.editorTokenExpiresAt, expected.expiresAt);
  assert.equal(result.credentialMetadata.editorTokenTtlSeconds, 43200);
  assert.equal(result.credentialMetadata.credentialExpiresAt, expected.expiresAt);
});

test("a freshly reissued editor token keeps the credential refresh pushing", async () => {
  const freshToken = makeEditToken({ ttlSeconds: 43200, issuedAgoSeconds: 60 });
  const staleStoredToken = makeEditToken({ ttlSeconds: 43200, issuedAgoSeconds: 43140 });
  const page = baijiahaoTokenPageMock({ localStorage: { "edit-token": freshToken } });
  const context = baijiahaoAliveCookieContext(page);
  const pushed = [];
  const adapter = new BaijiahaoAdapter({ browser: { launchPersistentContext: async () => context } });

  const artifact = await adapter.reportCredentialRefresh(
    { localStorage: { "edit-token": staleStoredToken }, onCredentialRefresh: (next) => pushed.push(next) },
    context,
    page
  );

  assert.equal(pushed.length, 1);
  assert.ok(artifact.credentialMetadata.editorTokenExpiresAt);
});

test("a credential refresh without stored editor-token evidence still pushes", async () => {
  const page = baijiahaoTokenPageMock({ localStorage: { setItem: "", getItem: "", removeItem: "" } });
  const context = baijiahaoAliveCookieContext(page);
  const pushed = [];
  const adapter = new BaijiahaoAdapter({ browser: { launchPersistentContext: async () => context } });

  await adapter.reportCredentialRefresh(
    { localStorage: {}, onCredentialRefresh: (next) => pushed.push(next) },
    context,
    page
  );

  assert.equal(pushed.length, 1);
});
test("publishes through the Baijiahao API by default without apiFirst or platformConfig", async () => {
  const browserCalls = [];
  const uploadCalls = [];
  const articleId = "1869859777777777777";
  const coverPath = fileURLToPath(new URL("../resources/adapter_ed25519_public.pem", import.meta.url));
  const page = {
    async goto() {},
    async waitForLoadState() {},
    request: {
      async fetch(url) {
        uploadCalls.push(String(url));
        const path = new URL(url).pathname;
        const payload = path.endsWith("/appinfo")
          ? { errno: 0, data: { user: { app_id: "123456789" } } }
          : path.includes("uploadProxy")
            ? { errno: 0, ret: { https_url: "https://pic.rmb.bdstatic.com/bjh/default-cover.png" } }
            : { errno: 0, ret: {} };
        return { status: () => 200, url: () => url, text: async () => JSON.stringify(payload) };
      },
    },
    async evaluate(callback, request) {
      if (String(callback).includes('credentials: "include"') && request?.requestUrl) {
        browserCalls.push(request);
        const path = new URL(request.requestUrl).pathname;
        const payload = path.endsWith("/save")
          ? { errno: 0, ret: { article_id: articleId } }
          : { errno: 0, ret: { _action: "publish", article_id: articleId } };
        return { status: 200, url: request.requestUrl, text: JSON.stringify(payload) };
      }
      if (String(callback).includes("edit-token")) return "runtime-request-token";
      return { nonce: "runtime-only", bjhmt: "" };
    },
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "BDUSS", value: "baidu-secret-token", domain: ".baidu.com" }],
    close: async () => undefined,
  };
  const adapter = new BaijiahaoAdapter({ browser: { launchPersistentContext: async () => context } });
  const evidence = [];
  const result = await adapter.publishArticle({
    articleTitle: "Baijiahao API default routing",
    contentMarkdown: "The API channel must be the default path.",
    confirmPublish: true,
    coverImagePath: coverPath,
    // 智心托管的封面地址不是百家号域名，normalizeBaijiahaoImageUrl 会拒掉它，
    // 所以必须落到本地上传，而不是把这个 URL 原样提交给平台。
    coverImageUrl: "https://zhixin.example.com/uploads/assets/source-cover.png",
    evidenceSink: (event) => evidence.push(event),
  });

  assert.equal(result.platformStatus, "submitted_for_review");
  assert.equal(result.reviewStatus, "pending_public_visibility");
  assert.equal(result.externalIds.articleId, articleId);
  assert.ok(evidence.some((event) => event.platformStatus === "draft_saved" && event.externalIds.articleId === articleId));
  // 封面上传不再需要 verifyPublication/disposableTest，正式发布也会带上平台封面。
  assert.equal(uploadCalls.filter((url) => url.includes("/materialui/picture/uploadProxy")).length, 1);
  const saves = browserCalls.filter((call) => new URL(call.requestUrl).pathname.endsWith("/save"));
  assert.equal(saves.length, 2);
  const firstSave = new URLSearchParams(saves[0].requestData);
  assert.equal(JSON.parse(firstSave.get("cover_images"))[0].src, "https://pic.rmb.bdstatic.com/bjh/default-cover.png");
  assert.doesNotMatch(firstSave.get("cover_images"), /example\.com\.cn/);
  assert.deepEqual(
    browserCalls.map((call) => new URL(call.requestUrl).pathname).filter((path) => /\/(save|publish)$/.test(path)),
    ["/pcui/article/save", "/pcui/article/save", "/pcui/article/publish"]
  );
});

test("keeps the browser editor flow when apiFirst is explicitly disabled", async () => {
  const actions = [];
  const bodyLocator = {
    first: () => bodyLocator,
    fill: async (value) => actions.push(["fillBody", value]),
    click: async () => actions.push(["clickBody"]),
    press: async () => actions.push(["pressBody"]),
  };
  const page = {
    _url: "about:blank",
    _coverSelected: true,
    goto: async (url) => {
      actions.push(["goto", url]);
      page._url = url;
    },
    bringToFront: async () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    waitForFunction: async () => {},
    url: () => page._url,
    title: async () => "Baijiahao",
    evaluate: async (fn) => {
      if (String(fn).includes('credentials: "include"')) throw new Error("BAIJIAHAO_API_CHANNEL_MUST_NOT_RUN");
      if (typeof fn === "function") return page._coverSelected;
      return "Baijiahao creator center publish content management saved publish";
    },
    request: {
      fetch: async () => {
        throw new Error("BAIJIAHAO_API_CHANNEL_MUST_NOT_RUN");
      },
    },
    locator: (selector) => ({
      first: () => ({
        fill: async (value) => actions.push(["fill", selector, value]),
        click: async () => actions.push(["click", selector]),
        isDisabled: async () => false,
        isVisible: async () => selector.includes("button"),
        getAttribute: async () => "",
      }),
      last: () => ({
        click: async () => {},
        setInputFiles: async () => {},
        isDisabled: async () => false,
        isVisible: async () => false,
        getAttribute: async () => "",
      }),
    }),
    frameLocator: () => ({ locator: () => bodyLocator }),
    getByRole: (role, options = {}) => ({
      first: () => ({
        // 只有发布按钮可见，弹窗里的"我知道了/确认"保持不可见，
        // 否则 dismissKnownPopups 会先点掉它们并把页面地址改掉，登录态校验就过不了。
        isVisible: async () => /publish|\u53d1\u5e03/.test(String(options.name)),
        isDisabled: async () => false,
        click: async () => {
          if (/publish|\u53d1\u5e03/.test(String(options.name))) {
            page._url = "https://baijiahao.baidu.com/s?id=1869859888888888888";
          }
        },
      }),
    }),
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "BDUSS", value: "auth-token", domain: ".baidu.com" }],
    close: async () => actions.push(["close"]),
  };
  const adapter = new BaijiahaoAdapter({ browser: { launchPersistentContext: async () => context } });

  const result = await adapter.publishArticle({
    articleTitle: "Zhixin AI Baijiahao opt-out test",
    contentMarkdown: "This test verifies the explicit browser-flow opt-out.",
    confirmPublish: true,
    apiFirst: false,
  });

  assert.equal(result.publishedUrl, "https://baijiahao.baidu.com/s?id=1869859888888888888");
  assert.equal(result.platformStatus, "published");
  assert.ok(actions.some((item) => item[0] === "fill" && item[1].includes("#newsTextArea")));
});

test("retries the Baijiahao title fill once after a navigation detaches the field", async () => {
  const actions = [];
  let titleFillAttempts = 0;
  const bodyLocator = {
    first: () => bodyLocator,
    fill: async (value) => actions.push(["fillBody", value]),
    click: async () => actions.push(["clickBody"]),
    press: async () => actions.push(["pressBody"]),
  };
  const page = {
    _url: "about:blank",
    _coverSelected: true,
    goto: async (url) => {
      actions.push(["goto", url]);
      page._url = url;
    },
    bringToFront: async () => {},
    // 正常流程全用 networkidle；只有 fillFirstLocator 的“等导航平稳+重试一次”用 domcontentloaded，正好当探针。
    waitForLoadState: async (state) => actions.push(["waitForLoadState", state]),
    waitForTimeout: async () => {},
    waitForFunction: async () => {},
    url: () => page._url,
    title: async () => "Baijiahao",
    evaluate: async (fn) => {
      if (String(fn).includes('credentials: "include"')) throw new Error("BAIJIAHAO_API_CHANNEL_MUST_NOT_RUN");
      if (typeof fn === "function") return page._coverSelected;
      return "Baijiahao creator center publish content management saved publish";
    },
    request: {
      fetch: async () => {
        throw new Error("BAIJIAHAO_API_CHANNEL_MUST_NOT_RUN");
      },
    },
    locator: (selector) => ({
      first: () => ({
        fill: async (value) => {
          // 只有标题字段带 data-lexical-editor；正文选择器的 :not(#newsTextArea ...) 里也含 #newsTextArea，不能拿它当判据。
          if (selector.includes("data-lexical-editor")) {
            titleFillAttempts += 1;
            actions.push(["fillTitle", titleFillAttempts]);
            // 第一次模拟主框架重导航把标题字段 detachment，第二次成功。
            if (titleFillAttempts === 1) throw new Error("Element is not attached to the DOM");
            return;
          }
          actions.push(["fill", selector, value]);
        },
        click: async () => actions.push(["click", selector]),
        isDisabled: async () => false,
        isVisible: async () => selector.includes("button"),
        getAttribute: async () => "",
      }),
      last: () => ({
        click: async () => {},
        setInputFiles: async () => {},
        isDisabled: async () => false,
        isVisible: async () => false,
        getAttribute: async () => "",
      }),
    }),
    frameLocator: () => ({ locator: () => bodyLocator }),
    getByRole: (role, options = {}) => ({
      first: () => ({
        isVisible: async () => /publish|\u53d1\u5e03/.test(String(options.name)),
        isDisabled: async () => false,
        click: async () => {
          if (/publish|\u53d1\u5e03/.test(String(options.name))) {
            page._url = "https://baijiahao.baidu.com/s?id=1869859777777777777";
          }
        },
      }),
    }),
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "BDUSS", value: "auth-token", domain: ".baidu.com" }],
    close: async () => actions.push(["close"]),
  };
  const adapter = new BaijiahaoAdapter({ browser: { launchPersistentContext: async () => context } });

  const result = await adapter.publishArticle({
    articleTitle: "Zhixin AI Baijiahao title retry test",
    contentMarkdown: "This test verifies the title field retries after a navigation detaches it.",
    confirmPublish: true,
    apiFirst: false,
  });

  assert.equal(result.publishedUrl, "https://baijiahao.baidu.com/s?id=1869859777777777777");
  assert.equal(result.platformStatus, "published");
  const firstTitleFill = actions.findIndex((item) => item[0] === "fillTitle" && item[1] === 1);
  const secondTitleFill = actions.findIndex((item) => item[0] === "fillTitle" && item[1] === 2);
  assert.ok(firstTitleFill >= 0 && secondTitleFill > firstTitleFill, "title should be filled twice after a detach");
  const settle = actions.findIndex(
    (item, index) => item[0] === "waitForLoadState" && item[1] === "domcontentloaded" && index > firstTitleFill && index < secondTitleFill
  );
  assert.ok(settle > firstTitleFill && settle < secondTitleFill, "a domcontentloaded settle should happen between the two title fills");
});

test("binds Baijiahao API inline images into the saved content at their block position", async () => {
  const browserCalls = [];
  const uploadCalls = [];
  const articleId = "1869859999999999999";
  const inlinePath = fileURLToPath(new URL("../resources/adapter_ed25519_public.pem", import.meta.url));
  const page = {
    async goto() {},
    async waitForLoadState() {},
    request: {
      async fetch(url) {
        uploadCalls.push(String(url));
        const path = new URL(url).pathname;
        const payload = path.endsWith("/appinfo")
          ? { errno: 0, data: { user: { app_id: "123456789" } } }
          : path.includes("uploadProxy")
            ? { errno: 0, ret: { https_url: "https://pic.rmb.bdstatic.com/bjh/inline-1.png" } }
            : { errno: 0, ret: {} };
        return { status: () => 200, url: () => url, text: async () => JSON.stringify(payload) };
      },
    },
    async evaluate(callback, request) {
      if (String(callback).includes('credentials: "include"') && request?.requestUrl) {
        browserCalls.push(request);
        const path = new URL(request.requestUrl).pathname;
        const payload = path.endsWith("/save")
          ? { errno: 0, ret: { article_id: articleId } }
          : { errno: 0, ret: { _action: "publish", article_id: articleId } };
        return { status: 200, url: request.requestUrl, text: JSON.stringify(payload) };
      }
      if (String(callback).includes("edit-token")) return "runtime-request-token";
      return { nonce: "runtime-only", bjhmt: "" };
    },
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "BDUSS", value: "baidu-secret-token", domain: ".baidu.com" }],
    close: async () => undefined,
  };
  const adapter = new BaijiahaoAdapter({ browser: { launchPersistentContext: async () => context } });

  const result = await adapter.publishArticle({
    articleTitle: "Baijiahao API inline image binding",
    contentMarkdown: "Body before the image. Body after the image.",
    contentBlocks: [
      { type: "section", sectionId: "section-1", title: "Section one", content: "Body before the image." },
      { type: "image", assetId: "asset-inline-1", sectionId: "section-1", altText: "插图一", path: inlinePath },
      { type: "section", sectionId: "section-2", title: "Section two", content: "Body after the image." },
    ],
    platformImageTasks: [{
      assetId: "asset-inline-1",
      sectionId: "section-1",
      position: 1,
      path: inlinePath,
      altText: "插图一",
      contentHash: "inline-hash",
      idempotencyKey: "asset-inline-1:section-1:inline-hash",
    }],
    confirmPublish: true,
  });

  assert.equal(uploadCalls.filter((url) => url.includes("/materialui/picture/uploadProxy")).length, 1);
  const firstSave = browserCalls.find((call) => new URL(call.requestUrl).pathname.endsWith("/save"));
  const content = new URLSearchParams(firstSave.requestData).get("content") || "";
  // 图片必须落在它自己的块位置上，而不是被丢掉或者堆到正文末尾。
  assert.equal(
    content,
    '<p style="margin: 0 0 12px; line-height: 1.8;">Body before the image.</p>'
    + '<p style="margin: 0 0 12px; line-height: 1.8; text-align: center;">'
    + '<img src="https://pic.rmb.bdstatic.com/bjh/inline-1.png" alt="插图一"></p>'
    + '<p style="margin: 0 0 12px; line-height: 1.8;">Body after the image.</p>'
  );
  // 上传阶段只证明图传上去了，草稿回读没做过，所以 draft 阶段留空、整体标注待复核。
  assert.equal(result.imagePublicationEvidence.upload.status, "verified");
  assert.equal(result.imagePublicationEvidence.upload.verifiedCount, 1);
  assert.equal(result.imagePublicationEvidence.draft.expectedCount, 1);
  assert.equal(result.imagePublicationEvidence.draft.verifiedCount, 0);
  assert.equal(result.imagePublicationEvidence.status, "review_required");
});

test("saves a Baijiahao draft through the API without publishing it", async () => {
  const browserCalls = [];
  const uploadCalls = [];
  const articleId = "1869860000000000000";
  const page = {
    async goto() {},
    async waitForLoadState() {},
    request: {
      async fetch(url) {
        uploadCalls.push(String(url));
        return { status: () => 200, url: () => url, text: async () => JSON.stringify({ errno: 0, ret: {} }) };
      },
    },
    async evaluate(callback, request) {
      if (String(callback).includes('credentials: "include"') && request?.requestUrl) {
        browserCalls.push(request);
        const payload = new URL(request.requestUrl).pathname.endsWith("/save")
          ? { errno: 0, ret: { article_id: articleId } }
          : { errno: 0, ret: {} };
        return { status: 200, url: request.requestUrl, text: JSON.stringify(payload) };
      }
      if (String(callback).includes("edit-token")) return "runtime-request-token";
      return { nonce: "runtime-only", bjhmt: "" };
    },
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "BDUSS", value: "baidu-secret-token", domain: ".baidu.com" }],
    close: async () => undefined,
  };
  const adapter = new BaijiahaoAdapter({ browser: { launchPersistentContext: async () => context } });
  const evidence = [];
  const result = await adapter.publishArticle({
    articleTitle: "Baijiahao API draft only",
    contentMarkdown: "Draft only, never published.",
    confirmPublish: false,
    evidenceSink: (event) => evidence.push(event),
  });

  assert.equal(result.platformStatus, "draft_saved");
  assert.equal(result.publishedUrl, "");
  assert.equal(result.draftUrl, `https://baijiahao.baidu.com/builder/rc/edit?type=news&article_id=${articleId}`);
  assert.equal(result.externalIds.articleId, articleId);
  assert.equal(result.publicationEvidence.stages.length, 3);
  assert.ok(evidence.some((event) => event.platformStatus === "draft_saved"));
  const paths = browserCalls.map((call) => new URL(call.requestUrl).pathname);
  assert.ok(!paths.some((path) => path.endsWith("/publish")));
  assert.deepEqual(paths.filter((path) => path.endsWith("/save")), ["/pcui/article/save", "/pcui/article/save"]);
  assert.equal(uploadCalls.length, 0);
});

test("API request survives page navigation without executing page JavaScript", async () => {
  let calls = 0;
  const page = { evaluate() { throw new Error("Execution context was destroyed"); },
    context() { return { request: { async fetch(url, options) {
      calls++;
      assert.equal(options.maxRetries, 0);
      assert.equal(options.data, "title=test");
      return { status: () => 200, url: () => url, text: async () => '{"errno":0}', dispose: async () => {} };
    } } }; } };
  const result = await baijiahaoPageApiFetch(page, "https://baijiahao.baidu.com/pcui/article/publish", { method: "POST", form: { title: "test" } });
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
});
