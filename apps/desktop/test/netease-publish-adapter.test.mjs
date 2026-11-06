import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { NeteasePublishAdapter, chooseNeteaseSingleCover, uploadNeteaseInlineImages } from "../src/adapters/netease.mjs";
import { getAdapter } from "../src/adapters/index.mjs";

function createLocator(actions, selector, { visible = true, disabled = false, onClick = null, attr = "" } = {}) {
  const locator = {
    first: () => locator,
    last: () => locator,
    fill: async (value) => actions.push(["fill", selector, value]),
    click: async () => {
      actions.push(["click", selector]);
      await onClick?.();
    },
    press: async (key) => actions.push(["press", selector, key]),
    isVisible: async () => typeof visible === "function" ? visible() : visible,
    isDisabled: async () => typeof disabled === "function" ? disabled() : disabled,
    getAttribute: async () => attr,
    scrollIntoViewIfNeeded: async () => actions.push(["scroll", selector]),
    dispatchEvent: async (eventName) => actions.push(["dispatch", selector, eventName])
  };
  return locator;
}

function createNeteaseHarness({ pageText = "创作中心 内容管理 发布 写文章 今日已发布0/10", managementPageText = "", navinfo = null, publishPayload = null, publishResponseUrl = "https://mp.163.com/wemedia/article/publish.do", emitPublishResponse = true, publishAfterClick = 1, deferPreflightUntilFinalPolling = false, recheckPreflightWaits = 0, blockMissingPublishedLinkLookup = false, managementRecords = [], publishedLinkHref = "", publishedHeadlineForUrl = null } = {}) {
  const actions = [];
  const wordingSuggestion = arguments[0]?.wordingSuggestion === true;
  let responseHandler = null;
  let publishClickCount = 0;
  let coverDialogOpen = false;
  let coverCandidateSelected = false;
  let coverCommitted = false;
  let pendingPreflight = false;
  let pendingPreflightThreshold = 3;
  let postPublishWaitCount = 0;
  let suggestionOutstanding = wordingSuggestion;
  let currentPageText = pageText;
  const emitPreflight = async () => {
    for (const url of [
      "https://mp.163.com/wemedia/assistant/check/content.do",
      "https://mp.163.com/wemedia/admin/similar/wrongWordDetect.do",
      "https://mp.163.com/wemedia/assistant/check/coverPic.do",
    ]) await responseHandler?.({
      url: () => url,
      request: () => ({ method: () => "POST" }),
      status: () => 200,
      text: async () => JSON.stringify({ code: 1, data: { passed: true } })
    });
  };
  const page = {
    _url: "about:blank",
    on: (event, handler) => {
      if (event === "response") responseHandler = handler;
    },
    off: () => {},
    goto: async (url) => {
      actions.push(["goto", url]);
      page._url = url;
      if (url.includes("#/content-manage")) {
        currentPageText = managementPageText || pageText;
        await responseHandler?.({
          url: () => "https://mp.163.com/wemedia/content/manage/list.do",
          status: () => 200,
          text: async () => JSON.stringify({ code: 1, data: { list: managementRecords } })
        });
      }
      await responseHandler?.({
        url: () => "https://mp.163.com/wemedia/navinfo.do",
        text: async () => JSON.stringify(navinfo ?? { code: 1, data: { todayPubCount: 0, maxDailyPublishCount: 10, onlineState: 1, auditState: 2, verifyState: 2 } })
      });
      await responseHandler?.({
        url: () => "https://mp.163.com/wemedia/article/postpage.do?mediaId=mock",
        text: async () => JSON.stringify(navinfo ?? { code: 1, data: { todayPubCount: 0, maxDailyPublishCount: 10, onlineState: 1, auditState: 2, verifyState: 2 } })
      });
    },
    bringToFront: async () => actions.push(["bringToFront"]),
    waitForLoadState: async (state) => actions.push(["waitForLoadState", state]),
    waitForTimeout: async (ms) => {
      actions.push(["waitForTimeout", ms]);
      if (pendingPreflight) {
        postPublishWaitCount += 1;
        if (postPublishWaitCount >= pendingPreflightThreshold) {
          pendingPreflight = false;
          await emitPreflight();
        }
      }
    },
    waitForFunction: async () => actions.push(["waitForFunction"]),
    url: () => page._url,
    title: async () => "网易号创作中心",
    evaluate: async (...args) => {
      if (args.length > 1) actions.push(["evaluateWithArg", args[1]]);
      if (args.length > 1) return true;
      return page._url.includes("/article/")
        ? `${page._publishedTitle || ""} ${currentPageText}`
        : currentPageText;
    },
    locator: (selector) => {
      if (/h1|article-title|post_title/.test(selector)) {
        const headline = createLocator(actions, selector);
        headline.innerText = async () => (typeof publishedHeadlineForUrl === "function" ? publishedHeadlineForUrl(page._url) : page._publishedTitle) || "";
        return headline;
      }
      if (selector === "a[href*='163.com'][href*='.html'], a[href*='/dy/article/']") {
        const publishedLink = createLocator(actions, selector);
        publishedLink.count = async () => publishedLinkHref ? 1 : 0;
        publishedLink.getAttribute = async () => {
          actions.push(["publishedLinkGetAttribute", selector]);
          if (blockMissingPublishedLinkLookup) return new Promise(() => {});
          return publishedLinkHref;
        };
        return publishedLink;
      }
      if (selector.includes("input[type='radio'][value='custom']")) {
        return createLocator(actions, selector);
      }
      if (selector === ".cover-pic__single__content__choose") {
        return createLocator(actions, selector, {
          onClick: async () => { coverDialogOpen = true; },
        });
      }
      if (selector === ".ne-modal.cover-picture") {
        return createLocator(actions, selector, { visible: coverDialogOpen });
      }
      if (selector === ".ne-modal.cover-picture .cover-picture__item") {
        const candidate = createLocator(actions, selector, {
          onClick: async () => { coverCandidateSelected = true; },
        });
        candidate.count = async () => coverDialogOpen ? 1 : 0;
        return candidate;
      }
      if (selector.includes("\u786e\u8ba4") && selector.includes("cover-picture")) {
        return createLocator(actions, selector, {
          visible: coverDialogOpen,
          disabled: !coverCandidateSelected,
          onClick: async () => {
            coverCommitted = true;
            coverDialogOpen = false;
          },
        });
      }
      if (selector === ".cover-pic__single img, .cover-pic__single__content img") {
        return createLocator(actions, selector, { visible: coverCommitted });
      }
      if (selector.includes("\u4e00\u952e\u91c7\u7eb3") || selector.includes("\u91c7\u7eb3")) {
        return createLocator(actions, selector, {
          visible: () => suggestionOutstanding,
          onClick: async () => { suggestionOutstanding = false; },
        });
      }
      if (selector.includes("\u91cd\u65b0\u68c0\u6d4b")) {
        return createLocator(actions, selector, {
          visible: () => wordingSuggestion && !suggestionOutstanding,
          onClick: async () => {
            if (recheckPreflightWaits > 0) {
              postPublishWaitCount = 0;
              pendingPreflightThreshold = recheckPreflightWaits;
              pendingPreflight = true;
              return;
            }
            await emitPreflight();
          },
        });
      }
      if (selector.includes(".ne-modal") || selector.includes(".ant-modal") || selector.includes("[role='dialog']")) {
        return createLocator(actions, selector, { visible: false });
      }
      if (selector.includes("发布") || selector.includes("button")) {
        return createLocator(actions, selector, {
          onClick: async () => {
            if (!selector.includes("发布")) return;
            publishClickCount += 1;
            if (publishClickCount < publishAfterClick) {
              if (deferPreflightUntilFinalPolling) pendingPreflight = true;
              else await emitPreflight();
              return;
            }
            if (publishPayload?.url) page._url = publishPayload.url;
            if (emitPublishResponse) {
              await responseHandler?.({
                url: () => publishResponseUrl,
                request: () => ({ method: () => "POST" }),
                status: () => 200,
                text: async () => JSON.stringify(publishPayload || {})
              });
            }
          }
        });
      }
      return createLocator(actions, selector);
    },
    getByRole: (role, options = {}) => {
      const name = options.name?.toString?.() || String(options.name || "");
      return createLocator(actions, `role=${role}:${name}`, {
        onClick: async () => {
          if (/发布/.test(name)) {
            publishClickCount += 1;
            if (publishClickCount < publishAfterClick) {
              for (const url of [
                "https://mp.163.com/wemedia/assistant/check/content.do",
                "https://mp.163.com/wemedia/admin/similar/wrongWordDetect.do",
                "https://mp.163.com/wemedia/assistant/check/coverPic.do",
              ]) await responseHandler?.({
                url: () => url,
                request: () => ({ method: () => "POST" }),
                status: () => 200,
                text: async () => JSON.stringify({ code: 1, data: { passed: true } })
              });
              return;
            }
            if (publishPayload?.url) page._url = publishPayload.url;
            if (emitPublishResponse) {
              await responseHandler?.({
                url: () => publishResponseUrl,
                request: () => ({ method: () => "POST" }),
                status: () => 200,
                text: async () => JSON.stringify(publishPayload || {})
              });
            }
          }
        }
      });
    }
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [
      { name: "NTES_SESS", value: "creator-session", domain: ".163.com" },
      { name: "NTES_PASSPORT", value: "passport", domain: ".163.com" }
    ],
    close: async () => actions.push(["close"])
  };
  const adapter = new NeteasePublishAdapter({
    browser: {
      launchPersistentContext: async () => context
    }
  });
  return { actions, adapter, page };
}

function createNeteaseDiscoveryHarness({
  records = [],
  publicTitle = "",
  publicHeadline = publicTitle,
  publicBody = `${publicTitle} 正文内容`,
  publicImages = [],
  responseUrl = "https://mp.163.com/wemedia/article/list.do",
  responsePayload = null,
  closedPageRejectsReads = false,
} = {}) {
  const actions = [];
  let responseHandler = null;
  const managementPage = {
    _url: "about:blank",
    on: (event, handler) => {
      if (event === "response") responseHandler = handler;
    },
    off: () => {},
    goto: async (url) => {
      actions.push(["goto", url]);
      managementPage._url = url;
      await responseHandler?.({
        url: () => responseUrl,
        text: async () => JSON.stringify(responsePayload ?? { code: 1, data: { list: records } })
      });
      return { status: () => 200 };
    },
    bringToFront: async () => actions.push(["bringToFront"]),
    waitForLoadState: async (state) => actions.push(["waitForLoadState", state]),
    waitForTimeout: async (ms) => actions.push(["waitForTimeout", ms]),
    url: () => managementPage._url,
    title: async () => "网易号内容管理",
    evaluate: async (...args) => args.length > 1 ? "" : "创作中心 内容管理 发布 写文章",
    locator: (selector) => createLocator(actions, selector)
  };
  // A real context hands out a fresh page per newPage(), so a page one
  // verification step closed must not break the page the next step opens.
  const createPublicPage = () => {
    let closed = false;
    return {
      goto: async (url) => {
        actions.push(["verify", url]);
        return { status: () => 200 };
      },
      waitForLoadState: async () => undefined,
      waitForTimeout: async () => undefined,
      title: async () => publicTitle,
      locator: (selector) => {
        if (publicImages.length && selector.includes("img")) {
          const imageLocator = {
            // A closed page rejects locator calls, and Playwright validates the
            // target when a call is dispatched rather than when it is invoked, so
            // the rejection lands a microtask after count() starts. That is the
            // window a page closed ahead of its own evidence read loses.
            count: async () => {
              await Promise.resolve();
              if (closedPageRejectsReads && closed) {
                throw new Error("Target page, context or browser has been closed");
              }
              return publicImages.length;
            },
            nth: (index) => ({
              getAttribute: async (name) => (publicImages[index]?.[name] || ""),
              evaluate: async () => ({ currentSrc: publicImages[index]?.src || "", loaded: true }),
            }),
          };
          imageLocator.first = () => imageLocator;
          return imageLocator;
        }
        const locator = {
          innerText: async () => /h1|article-title|post_title/.test(selector) ? publicHeadline : publicBody,
          count: async () => /h1|article-title|post_title/.test(selector) && publicHeadline ? 1 : 0,
        };
        locator.first = () => locator;
        return locator;
      },
      evaluate: async () => publicBody,
      close: async () => {
        closed = true;
        actions.push(["closePublicPage"]);
      },
    };
  };
  const context = {
    pages: () => [managementPage],
    newPage: async () => createPublicPage(),
    cookies: async () => [
      { name: "NTES_SESS", value: "creator-session", domain: ".163.com" },
      { name: "NTES_PASSPORT", value: "passport", domain: ".163.com" }
    ],
    close: async () => actions.push(["closeContext"])
  };
  const adapter = new NeteasePublishAdapter({
    browser: { launchPersistentContext: async () => context }
  });
  return { actions, adapter };
}

test("registers NetEase as a dedicated publishing adapter", () => {
  assert.equal(getAdapter("netease").platform, "netease");
  assert.equal(getAdapter("netease").constructor.name, "NeteasePublishAdapter");
});

test("publishes a NetEase article through the real editor flow", async () => {
  const { actions, adapter, page } = createNeteaseHarness({
    publishPayload: {
      code: 1,
      data: {
        docid: "netease-doc-001",
        url: "https://www.163.com/dy/article/NETEASE001.html"
      }
    }
  });
  page._publishedTitle = "Zhixin AI Netease Publish Test";

  const result = await adapter.publishArticle({
    articleTitle: "Zhixin AI Netease Publish Test",
    contentMarkdown: "This is a controlled NetEase publishing automation test body with enough useful content for the editor.",
    category: "科技",
    coverMode: "auto",
    confirmPublish: true
  });

  assert.equal(result.platformStatus, "published");
  assert.equal(result.publishedUrl, "https://www.163.com/dy/article/NETEASE001.html");
  assert.ok(actions.some((item) => item[0] === "goto" && item[1] === "https://mp.163.com/#/article-publish"));
  assert.ok(actions.some((item) => item[0] === "fill" && item[1].includes("textarea") && item[2] === "Zhixin AI Netease Publish Test"));
  assert.ok(actions.some((item) => item[0] === "fill" && item[1].includes("contenteditable") && item[2].includes("NetEase publishing automation")));
  assert.ok(actions.some((item) => item[0] === "click" && item[1].includes("发布")));
});

test("uses structured article HTML instead of exposing markdown markers in NetEase Draft.js", async () => {
  const { actions, adapter } = createNeteaseHarness();

  await adapter.publishArticle({
    articleTitle: "智心AI网易号结构化正文测试",
    contentMarkdown: "## 第一部分\n\n这是一段用于验证网易号结构化排版的完整正文，文字长度足以通过平台校验。\n\n![正文配图](https://example.com/a.png)",
    contentBlocks: [
      { type: "section", sectionId: "s1", title: "第一部分", content: "这是一段用于验证网易号结构化排版的完整正文，文字长度足以通过平台校验。" },
      { type: "image", sectionId: "s1", assetId: "asset-1", altText: "正文配图" },
    ],
    contentHtmlWithoutImages: '<section data-zhixin-section="s1"><h2>第一部分</h2><p>这是一段用于验证网易号结构化排版的完整正文，文字长度足以通过平台校验。</p></section>',
  });

  const bodyWrites = actions.filter((item) => item[0] === "fill" && item[1].includes("contenteditable"));
  const richWrites = actions.filter((item) => item[0] === "evaluateWithArg").map((item) => JSON.stringify(item[1]));
  const serialized = JSON.stringify([...bodyWrites, ...richWrites]);
  assert.match(serialized, /第一部分/);
  assert.doesNotMatch(serialized, /##|!\[正文配图\]/);
});

test("uploads a NetEase inline image through the icon dialog and confirms insertion", async () => {
  const actions = [];
  let uploaded = false;
  const editor = {
    first: () => editor,
    evaluate: async (_callback, payload) => {
      actions.push(["position", payload.sectionId]);
      return true;
    },
  };
  const page = {
    locator: (selector) => {
      if (selector.includes("public-DraftEditor-content") && !selector.includes(" img")) return editor;
      if (selector.includes("public-DraftEditor-content img")) {
        return {
          count: async () => uploaded ? 1 : 0,
          nth: () => ({
            getAttribute: async (name) => name === "src" ? "https://dingyue.ws.126.net/uploaded.jpg" : "正文配图",
            evaluate: async () => ({ currentSrc: "https://dingyue.ws.126.net/uploaded.jpg", loaded: true }),
          }),
        };
      }
      if (selector === "button.rich-editor-panel-item:has(img[src*='icon_image'])") {
        const locator = { first: () => locator, click: async () => actions.push(["click-image-button", selector]) };
        return locator;
      }
      if (selector === ".ne-modal.picture-adder:visible input[type='file'][name='pic']") {
        const locator = { last: () => locator, setInputFiles: async (path) => actions.push(["set-files", path]) };
        return locator;
      }
      if (selector === ".ne-modal.picture-adder:visible button:has-text('确定'):visible") {
        const locator = {
          first: () => locator,
          isVisible: async () => true,
          isDisabled: async () => false,
          click: async () => {
            actions.push(["confirm-image"]);
            uploaded = true;
          },
        };
        return locator;
      }
      const unsupported = {
        first: () => unsupported,
        last: () => unsupported,
        click: async () => { throw new Error(`UNEXPECTED_SELECTOR:${selector}`); },
        setInputFiles: async () => { throw new Error(`UNEXPECTED_SELECTOR:${selector}`); },
      };
      return unsupported;
    },
  };

  const result = await uploadNeteaseInlineImages(page, [{
    assetId: "asset-1",
    sectionId: "s1",
    sectionTitle: "第一部分",
    path: "C:\\tmp\\netease-inline.png",
  }], { timeoutMs: 100 });

  assert.equal(result.length, 1);
  assert.deepEqual(actions.slice(0, 4), [
    ["position", "s1"],
    ["click-image-button", "button.rich-editor-panel-item:has(img[src*='icon_image'])"],
    ["set-files", "C:\\tmp\\netease-inline.png"],
    ["confirm-image"],
  ]);
});

test("selects a NetEase single cover from images already uploaded into the article", async () => {
  const actions = [];
  let coverDialogOpen = false;
  let coverCandidateSelected = false;
  let coverCommitted = false;
  const locatorFor = (selector) => {
    const locator = {
      first: () => locator,
      count: async () => selector === ".ne-modal.cover-picture .cover-picture__item" && coverDialogOpen ? 5 : 0,
      isVisible: async () => {
        if (selector === ".ne-modal.cover-picture") return coverDialogOpen;
        if (selector.includes(".cover-pic__single img")) return coverCommitted;
        return true;
      },
      isDisabled: async () => selector.includes("\u786e\u8ba4") && !coverCandidateSelected,
      click: async () => {
        actions.push(["click", selector]);
        if (selector.includes("input[value='custom']")) return;
        if (selector === ".cover-pic__single__content__choose") coverDialogOpen = true;
        if (selector === ".ne-modal.cover-picture .cover-picture__item") coverCandidateSelected = true;
        if (selector.includes("\u786e\u8ba4") && coverCandidateSelected) {
          coverCommitted = true;
          coverDialogOpen = false;
        }
      },
    };
    return locator;
  };
  const page = {
    locator: locatorFor,
    waitForTimeout: async () => undefined,
  };

  const result = await chooseNeteaseSingleCover(page, { timeoutMs: 100 });

  assert.equal(result.selected, true);
  assert.equal(result.candidateCount, 5);
  assert.ok(actions.some(([type, selector]) => type === "click" && selector.includes("value='custom'")));
  assert.ok(actions.some(([type, selector]) => type === "click" && selector === ".cover-pic__single__content__choose"));
  assert.ok(actions.some(([type, selector]) => type === "click" && selector === ".ne-modal.cover-picture .cover-picture__item"));
  assert.ok(actions.some(([type, selector]) => type === "click" && selector.includes("\u786e\u8ba4")));
});

test("refuses to publish a NetEase article when no uploaded image can be selected as cover", async () => {
  const page = {
    locator: (selector) => {
      const locator = {
        first: () => locator,
        count: async () => 0,
        isVisible: async () => selector !== ".cover-pic__single img, .cover-pic__single__content img",
        isDisabled: async () => true,
        click: async () => undefined,
      };
      return locator;
    },
    waitForTimeout: async () => undefined,
  };

  await assert.rejects(
    () => chooseNeteaseSingleCover(page, { timeoutMs: 25 }),
    /NETEASE_COVER_CANDIDATE_NOT_FOUND/
  );
});

test("does not treat a NetEase draft autosave response as a submitted publication", async () => {
  const { adapter } = createNeteaseHarness({
    publishPayload: { code: 1, data: { status: "saved", message: "草稿保存成功" } },
    publishResponseUrl: "https://mp.163.com/wemedia/article/save.do"
  });

  await assert.rejects(
    () => adapter.publishArticle({
      articleTitle: "智心AI网易号草稿不能冒充发布",
      contentMarkdown: "这段正文用于验证网易号自动保存草稿的响应不能被错误识别为已经提交审核。",
      confirmPublish: true
    }),
    /NETEASE_PUBLISHED_URL_NOT_FOUND/
  );
});
test("returns submitted for review when NetEase accepts publishing without a public URL", async () => {
  const { adapter } = createNeteaseHarness({
    publishPayload: { code: 1, data: { articleId: "NETEASE_AUDIT_001", status: "auditing", message: "提交成功，审核中" } },
  });

  const result = await adapter.publishArticle({
    articleTitle: "智心AI网易号审核受理测试",
    contentMarkdown: "这是一篇用于验证网易号已经受理发布、但尚未生成公开链接时状态回写的测试正文。",
    confirmPublish: true,
  });

  assert.equal(result.platformStatus, "submitted_for_review");
  assert.equal(result.publiclyVisible, false);
  assert.equal(result.reviewStatus, "pending_public_visibility");
  assert.equal(result.publishedUrl, "");
});

test("recognizes a semantic NetEase submission response when the endpoint name changes", async () => {
  const progress = [];
  const { adapter } = createNeteaseHarness({
    publishPayload: { code: 200, data: { articleId: "NETEASE_PENDING_001", status: "pending_review", message: "??????????" } },
    publishResponseUrl: "https://mp.163.com/wemedia/content/submitArticle?v=2",
  });

  const result = await adapter.publishArticle({
    articleTitle: "??AI???????????",
    contentMarkdown: "???????????????????????????????????????",
    confirmPublish: true,
    onProgress: async (event) => progress.push(event),
  });

  assert.equal(result.platformStatus, "submitted_for_review");
  assert.ok(progress.some((event) => event.type === "publish_response_observed" && event.accepted === true));
  assert.ok(progress.some((event) => event.type === "publish_button_found"));
  assert.ok(progress.some((event) => event.type === "publish_button_clicked"));
});

test("clicks NetEase publish again after preflight checks leave the editor unchanged", async () => {
  const progress = [];
  const { actions, adapter } = createNeteaseHarness({
    publishAfterClick: 2,
    publishPayload: { code: 1, data: { articleId: "NETEASE_AUDIT_001", status: "auditing", message: "提交成功，审核中" } },
  });

  const result = await adapter.publishArticle({
    articleTitle: "智心AI网易号二次发布测试",
    contentMarkdown: "这是一篇用于验证网易号第一次预检完成后，第二次点击才真正提交审核的测试正文。",
    confirmPublish: true,
    onProgress: async (event) => progress.push(event),
  });

  assert.equal(result.platformStatus, "submitted_for_review");
  assert.equal(actions.filter((item) => item[0] === "click" && item[1].includes("primary_button")).length, 2, JSON.stringify(progress));
  assert.ok(progress.some((event) => event.type === "publish_preflight_completed"));
});

test("adopts NetEase wording suggestions and reruns preflight before final publish", async () => {
  const progress = [];
  const { actions, adapter } = createNeteaseHarness({
    publishAfterClick: 2,
    wordingSuggestion: true,
    publishPayload: { code: 1, data: { articleId: "NETEASE_SUBMISSION_001", status: "auditing", message: "submitted" } },
  });

  const result = await adapter.publishArticle({
    articleTitle: "NetEase wording preflight recovery",
    contentMarkdown: "This body verifies that platform wording suggestions are resolved before final submission.",
    confirmPublish: true,
    onProgress: async (event) => progress.push(event),
  });

  assert.equal(result.platformStatus, "submitted_for_review");
  assert.ok(actions.some((item) => item[0] === "click" && item[1].includes("\u4e00\u952e\u91c7\u7eb3")));
  assert.ok(actions.some((item) => item[0] === "click" && item[1].includes("\u91cd\u65b0\u68c0\u6d4b")));
  assert.equal(actions.filter((item) => item[0] === "click" && item[1].includes("primary_button")).length, 2);
  assert.ok(progress.some((event) => event.type === "publish_preflight_suggestions_resolved"));
});

test("waits for delayed NetEase recheck responses before the final publish click", async () => {
  const progress = [];
  const { actions, adapter } = createNeteaseHarness({
    publishAfterClick: 2,
    wordingSuggestion: true,
    recheckPreflightWaits: 20,
    publishPayload: {
      code: 1,
      data: { articleId: "NETEASE_DELAYED_RECHECK_001", status: "auditing", message: "submitted" },
    },
  });

  const result = await adapter.publishArticle({
    articleTitle: "NetEase delayed recheck publication",
    contentMarkdown: "This body verifies that the final publish action waits for asynchronous platform checks.",
    confirmPublish: true,
    onProgress: async (event) => progress.push(event),
  });

  assert.equal(result.platformStatus, "submitted_for_review");
  assert.equal(actions.filter((item) => item[0] === "click" && item[1].includes("primary_button")).length, 2);
  assert.ok(progress.some((event) => event.type === "publish_preflight_recheck_completed"));
});
test("retries the NetEase publish action when preflight responses arrive during final polling", async () => {
  const progress = [];
  const { actions, adapter } = createNeteaseHarness({
    publishAfterClick: 2,
    deferPreflightUntilFinalPolling: true,
    publishPayload: { code: 1, data: { articleId: "NETEASE_SUBMISSION_001", status: "auditing", message: "submitted" } },
  });

  const result = await adapter.publishArticle({
    articleTitle: "Delayed NetEase preflight test",
    contentMarkdown: "This body verifies that delayed preflight responses still trigger the final publish action.",
    confirmPublish: true,
    onProgress: async (event) => progress.push(event),
  });

  assert.equal(result.platformStatus, "submitted_for_review");
  assert.equal(actions.filter((item) => item[0] === "click" && item[1].includes("primary_button")).length, 2);
  assert.ok(progress.some((event) => event.type === "publish_preflight_completed"));
});

test("does not wait for a missing NetEase public link before retrying publish after preflight", async () => {
  const progress = [];
  const { actions, adapter } = createNeteaseHarness({
    publishAfterClick: 2,
    deferPreflightUntilFinalPolling: true,
    blockMissingPublishedLinkLookup: true,
    publishPayload: { code: 1, data: { articleId: "NETEASE_SUBMISSION_001", status: "auditing", message: "submitted" } },
  });

  const result = await Promise.race([
    adapter.publishArticle({
      articleTitle: "Non-blocking NetEase public URL lookup",
      contentMarkdown: "This body verifies that an absent public link cannot block the second publish action.",
      confirmPublish: true,
      onProgress: async (event) => progress.push(event),
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("NETEASE_PUBLIC_LINK_LOOKUP_BLOCKED")), 250)),
  ]);

  assert.equal(result.platformStatus, "submitted_for_review");
  assert.equal(actions.some((item) => item[0] === "publishedLinkGetAttribute"), false);
  assert.equal(actions.filter((item) => item[0] === "click" && item[1].includes("primary_button")).length, 2);
  assert.ok(progress.some((event) => event.type === "publish_preflight_completed"));
});

test("does not treat a generic NetEase publishV2 success response as submission acceptance", async () => {
  const progress = [];
  const { adapter } = createNeteaseHarness({
    publishPayload: { code: 1, message: "\u64cd\u4f5c\u6210\u529f" },
    publishResponseUrl: "https://mp.163.com/wemedia/article/status/api/publishV2.do",
  });

  await assert.rejects(
    () => adapter.publishArticle({
      articleTitle: "NetEase publishV2 acceptance test",
      contentMarkdown: "This body verifies a generic operation-success response cannot stand in for a real submission record.",
      confirmPublish: true,
      onProgress: async (event) => progress.push(event),
    }),
    /NETEASE_PUBLISH_ACCEPTANCE_NOT_CONFIRMED/
  );
  assert.ok(progress.some((event) => event.type === "publish_response_observed" && event.accepted === false));
});

test("accepts a generic NetEase publish response only after the exact title appears in content management", async () => {
  const articleTitle = "NetEase management acceptance test";
  const { adapter, actions } = createNeteaseHarness({
    publishPayload: { code: 1, message: "\u64cd\u4f5c\u6210\u529f" },
    publishResponseUrl: "https://mp.163.com/wemedia/article/status/api/publishV2.do",
    managementRecords: [{
      contentType: 1,
      contentState: 2,
      title: articleTitle,
      articleId: "NETEASE_MANAGED_001",
    }],
  });

  const result = await adapter.publishArticle({
    articleTitle,
    contentMarkdown: "This body verifies that an exact content-management record is valid submission evidence.",
    confirmPublish: true,
  });

  assert.equal(result.platformStatus, "submitted_for_review");
  assert.equal(result.publishedUrl, "");
  assert.ok(actions.some((item) => item[0] === "goto" && item[1].includes("#/content-manage")));
});

test("accepts visible NetEase management text as pending-review submission evidence", async () => {
  const articleTitle = "2025\u5e74\u6700\u706b\u5927\u6a21\u578b\u901f\u89c8\uff1a\u4ece\u96f6\u4e0a\u624b\u5168\u80fdAI\u6307\u5357";
  const { adapter } = createNeteaseHarness({
    managementPageText: `\u5185\u5bb9\u7ba1\u7406 3\u6761\u5185\u5bb9 ${articleTitle} \u5ba1\u6838\u4e2d \u521b\u5efa\u4e8e\u521a\u521a 0\u6b21\u5c55\u73b0`,
    publishPayload: { code: 1, message: "\u64cd\u4f5c\u6210\u529f" },
    publishResponseUrl: "https://mp.163.com/wemedia/article/status/api/publishV2.do",
  });

  const result = await adapter.publishArticle({
    articleTitle,
    contentMarkdown: "\u8fd9\u662f\u7528\u4e8e\u9a8c\u8bc1\u7f51\u6613\u53f7\u5185\u5bb9\u7ba1\u7406\u53ef\u89c1\u6587\u672c\u80fd\u4f5c\u4e3a\u63d0\u4ea4\u5ba1\u6838\u8bc1\u636e\u7684\u6d4b\u8bd5\u6b63\u6587\u3002",
    confirmPublish: true,
  });

  assert.equal(result.platformStatus, "submitted_for_review");
  assert.equal(result.reviewStatus, "pending_public_visibility");
  assert.equal(result.publiclyVisible, false);
  assert.equal(result.publishedUrl, "");
});

test("falls back to NetEase management evidence when a stale candidate URL fails public verification", async () => {
  const articleTitle = "\u4f5c\u4e3aOPC\uff0c\u8fd9\u4e9b\u51c6\u5907\u5de5\u4f5c\u5fc5\u987b\u5230\u4f4d";
  const progress = [];
  const { adapter, page } = createNeteaseHarness({
    managementPageText: `\u4e92\u52a8\u6d88\u606f 3 \u7ad9\u5185\u4fe1 WERW \u5f00\u59cb\u521b\u4f5c \u6587\u7ae0 \u89c6\u9891 \u52a8\u6001 \u9996\u9875 \u7ba1\u7406 \u5185\u5bb9\u7ba1\u7406 \u8349\u7a3f\u7ba1\u7406 \u5408\u96c6\u7ba1\u7406 \u8ddf\u8d34\u7ba1\u7406 \u6570\u636e \u5185\u5bb9\u6570\u636e \u5168\u90e8\u72b6\u6001 \u5df2\u53d1\u5e03 \u672a\u901a\u8fc7 \u5ba1\u6838\u4e2d \u5f85\u53d1\u5e03 \u5904\u7406\u5931\u8d25 \u5f00\u59cb\u65f6\u95f4 ~ \u7ed3\u675f\u65f6\u95f4 3\u6761\u5185\u5bb9 ${articleTitle} \u5ba1\u6838\u4e2d \u521b\u5efa\u4e8e\u521a\u521a 0\u6b21\u5c55\u73b0 0\u6b21\u89c2\u770b 0\u4e2a\u9876`,
    publishPayload: { code: 1, message: "\u64cd\u4f5c\u6210\u529f" },
    publishResponseUrl: "https://mp.163.com/wemedia/article/status/api/publishV2.do",
    publishedLinkHref: "https://www.163.com/dy/article/OLDARTICLE.html",
  });
  page._publishedTitle = "An unrelated existing NetEase article";

  const result = await adapter.publishArticle({
    articleTitle,
    contentMarkdown: "This body reproduces a real NetEase run where an old public link was visible but the new article row was already under review.",
    confirmPublish: true,
    onProgress: async (event) => progress.push(event),
  });

  assert.equal(result.platformStatus, "submitted_for_review");
  assert.equal(result.reviewStatus, "pending_public_visibility");
  assert.equal(result.publiclyVisible, false);
  assert.equal(result.publishedUrl, "");
  assert.ok(progress.some((event) => event.type === "publish_management_verification" && event.found === true));
});

test("publishes a distribution-restricted NetEase record when its own address clears the public-page gate", async () => {
  const articleTitle = "\u5546\u94fa\u76d1\u63a7\u5f55\u50cf\u8981\u5b5830\u5929\uff0c\u786c\u76d8\u8be5\u914d\u591a\u5927";
  const articleId = "L9ROIMCU0556O5HU";
  const publicUrl = `https://www.163.com/dy/article/${articleId}.html`;
  const progress = [];
  const { adapter } = createNeteaseHarness({
    publishPayload: { code: 1, message: "\u64cd\u4f5c\u6210\u529f", url: "https://www.163.com/dy/article/STALE163.html" },
    publishResponseUrl: "https://mp.163.com/wemedia/article/status/api/publishV2.do",
    managementRecords: [{
      contentType: 1,
      contentState: 3,
      title: articleTitle,
      articleId,
      unrecomReason: "\u5185\u5bb9\u542b\u6709\u5e7f\u544a\u4fe1\u606f",
      appealStatus: 0,
    }],
    // The stale candidate address has to fail the anonymous public-page read
    // while the restricted record's own address passes it, and the harness
    // hands the same page to every verification, so the headline answer has to
    // follow the URL under verification.
    publishedHeadlineForUrl: (url) => (url === publicUrl ? articleTitle : ""),
  });

  const result = await adapter.publishArticle({
    articleTitle,
    contentMarkdown: "This body reproduces a real NetEase run where the publish response pointed at a stale address but the restricted management record carried the live public page.",
    confirmPublish: true,
    onProgress: async (event) => progress.push(event),
  });

  assert.equal(result.platformStatus, "published");
  assert.equal(result.publishedUrl, publicUrl);
  assert.equal(result.reviewStatus, "public");
  assert.equal(result.publiclyVisible, true);
  assert.ok(progress.some((event) => event.type === "publish_management_verification" && event.found === true));
});

test("does not combine a parent response title with an unrelated NetEase content row", async () => {
  const articleTitle = "\u6b63\u786e\u770b\u5f85\u552f\u7269\u4e3b\u4e49\u7684\u5b9e\u7528\u6307\u5357";
  const { adapter } = createNeteaseHarness({
    publishPayload: { code: 1, message: "\u64cd\u4f5c\u6210\u529f" },
    publishResponseUrl: "https://mp.163.com/wemedia/article/status/api/publishV2.do",
    managementRecords: {
      title: articleTitle,
      contentState: 2,
      list: [{
        title: "\u8fd1\u671f\u54ea\u4e00\u90e8\u7535\u89c6\u5267\u6bd4\u8f83\u5438\u5f15\u4eba",
        articleId: "L2EVAI9I0556O5HU",
        contentState: 3,
      }],
    },
  });

  await assert.rejects(
    () => adapter.publishArticle({
      articleTitle,
      contentMarkdown: "\u8fd9\u662f\u7528\u4e8e\u9a8c\u8bc1\u7f51\u6613\u53f7\u5185\u5bb9\u7ba1\u7406\u8bb0\u5f55\u5f52\u5c5e\u7684\u6d4b\u8bd5\u6b63\u6587\u3002",
      confirmPublish: true,
    }),
    /NETEASE_PUBLISH_ACCEPTANCE_NOT_CONFIRMED/
  );
});

test("recovers a published NetEase article from content management when no publish response is observed", async () => {
  const articleTitle = "\u6b63\u786e\u770b\u5f85\u552f\u7269\u4e3b\u4e49\u7684\u5b9e\u7528\u6307\u5357";
  const articleId = "L2ME165V0556O5HU";
  const publicUrl = `https://www.163.com/dy/article/${articleId}.html`;
  const { adapter, actions, page } = createNeteaseHarness({
    emitPublishResponse: false,
    managementRecords: [{
      contentType: 1,
      contentState: 3,
      title: articleTitle,
      articleId,
    }],
  });
  page._publishedTitle = articleTitle;

  const result = await adapter.publishArticle({
    articleTitle,
    contentMarkdown: "\u8fd9\u662f\u7528\u4e8e\u9a8c\u8bc1\u7f51\u6613\u53f7\u53d1\u5e03\u540e\u7ba1\u7406\u7aef\u7cbe\u786e\u590d\u9a8c\u7684\u6d4b\u8bd5\u6b63\u6587\u3002",
    confirmPublish: true,
  });

  assert.equal(result.platformStatus, "published");
  assert.equal(result.publiclyVisible, true);
  assert.equal(result.publishedUrl, publicUrl);
  assert.ok(actions.some((item) => item[0] === "goto" && item[1].includes("#/content-manage")));
});
test("does not accept a successful draft save response after the publish button is clicked", async () => {
  const { adapter } = createNeteaseHarness({
    publishPayload: { code: 200, data: { status: "saved", message: "??????" } },
    publishResponseUrl: "https://mp.163.com/wemedia/article/saveDraft",
  });

  await assert.rejects(
    () => adapter.publishArticle({
      articleTitle: "??AI???????????",
      contentMarkdown: "???????????????????????????????????",
      confirmPublish: true,
    }),
    /NETEASE_PUBLISHED_URL_NOT_FOUND/
  );
});

test("seeds NetEase credentials into the stable persistent auth profile", async () => {
  const { actions, page } = createNeteaseHarness({
    pageText: "创作中心 内容管理 发布 写文章 今日已发布0/10"
  });
  let persistentLaunches = 0;
  let temporaryLaunches = 0;
  let injectedCookies = [];
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "NTES_SESS", value: "creator-session", domain: ".163.com" }],
    addCookies: async (cookies) => {
      injectedCookies = cookies;
    },
    close: async () => actions.push(["close"])
  };
  const adapter = new NeteasePublishAdapter({
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
    articleTitle: "Zhixin AI NetEase injected cookie test",
    contentMarkdown: "This test verifies NetEase cookie injected publishing without opening the persistent auth profile.",
    cookies: [{ name: "NTES_SESS", value: "creator-session", domain: ".163.com", path: "/" }]
  });

  assert.equal(result.platformStatus, "draft_saved");
  assert.equal(persistentLaunches, 1);
  assert.equal(temporaryLaunches, 0);
  assert.equal(injectedCookies.length, 1);
});

test("returns a quota blocked status when NetEase account is under review", async () => {
  const { adapter } = createNeteaseHarness({
    pageText: "您的账号信息正在审核中 请耐心等待 今日已发布0/0",
    navinfo: {
      code: 1,
      data: {
        todayPubCount: 0,
        maxDailyPublishCount: 0,
        onlineState: 1,
        auditState: 1,
        verifyState: 1
      }
    }
  });

  const result = await adapter.publishArticle({
    articleTitle: "Zhixin AI Netease Review Blocked",
    contentMarkdown: "This body will not be published because the account has no available publishing quota.",
    confirmPublish: true
  });

  assert.ok(["quota_blocked", "account_under_review"].includes(result.platformStatus));
  assert.equal(result.publiclyVisible, false);
  assert.match(result.message, /审核|额度|quota|review/i);
});


test("rejects an unverified NetEase candidate URL when the publish API did not confirm acceptance", async () => {
  const progress = [];
  const { adapter, page } = createNeteaseHarness({
    publishPayload: {
      data: {
        url: "https://www.163.com/dy/article/UNCONFIRMED_CANDIDATE.html"
      }
    }
  });
  page._publishedTitle = "An unrelated NetEase article";

  await assert.rejects(
    () => adapter.publishArticle({
      articleTitle: "Zhixin AI Netease acceptance evidence test",
      contentMarkdown: "This body verifies that a candidate URL cannot stand in for real publication acceptance evidence.",
      confirmPublish: true,
      onProgress: async (event) => progress.push(event),
    }),
    /NETEASE_PUBLISH_ACCEPTANCE_NOT_CONFIRMED/
  );
  assert.ok(progress.some((event) => event.type === "publish_ui_diagnostic"));
});
test("does not return a stale NetEase URL when public verification points to another article", async () => {
  const { adapter, page } = createNeteaseHarness({
    publishPayload: {
      code: 1,
      data: {
        docid: "old-docid",
        status: "auditing",
        message: "submitted",
        url: "https://www.163.com/dy/article/OLDARTICLE.html"
      }
    }
  });
  page._publishedTitle = "An unrelated existing NetEase article";

  const result = await adapter.publishArticle({
    articleTitle: "Zhixin AI Netease New Article",
    contentMarkdown: "This body verifies that stale NetEase links are not stored as real public backlinks.",
    confirmPublish: true
  });

  assert.equal(result.platformStatus, "submitted_for_review");
  assert.equal(result.publiclyVisible, false);
  assert.equal(result.publishedUrl, "");
  assert.equal(result.reviewUrl ?? "", "");
  assert.equal(result.candidateUrl ?? "", "");
  assert.equal(result.reviewStatus, "pending_public_visibility");
});

test("discovers the matching reviewed NetEase article from content management", async () => {
  const articleTitle = "智心AI网易号审核后公开测试";
  const publicUrl = "https://www.163.com/dy/article/NETEASE_REVIEW_OK.html";
  const { actions, adapter } = createNeteaseDiscoveryHarness({
    records: [
      { title: "另一篇文章", docid: "OTHER_ARTICLE", url: "https://www.163.com/dy/article/OTHER_ARTICLE.html" },
      { title: articleTitle, docid: "NETEASE_REVIEW_OK", url: publicUrl, status: "published" }
    ],
    publicTitle: articleTitle
  });

  const result = await adapter.discoverPublication({ articleTitle });

  assert.equal(result.found, true);
  assert.equal(result.publicUrl, publicUrl);
  assert.equal(result.publishedUrl, publicUrl);
  assert.equal(result.publiclyVisible, true);
  assert.ok(actions.some((item) => item[0] === "goto" && item[1].includes("#/content-manage")));
  assert.ok(actions.some((item) => item[0] === "verify" && item[1] === publicUrl));
  assert.equal(result.imagePublicationEvidence, undefined);
});

test("re-reads the public page images when a discovery recheck carries order evidence", async () => {
  const articleTitle = "智心AI网易号复验补图测试";
  const publicUrl = "https://www.163.com/dy/article/NETEASE_RECHECK_IMG.html";
  const { adapter } = createNeteaseDiscoveryHarness({
    records: [{ title: articleTitle, docid: "NETEASE_RECHECK_IMG", url: publicUrl, status: "published" }],
    publicTitle: articleTitle,
    publicImages: [
      { src: "https://nimg.ws.126.net/?url=https://dingyue.ws.126.net/public-1.jpg" },
      { src: "https://nimg.ws.126.net/?url=https://dingyue.ws.126.net/public-2.jpg" },
    ],
  });

  const result = await adapter.discoverPublication({
    articleTitle,
    imagePublicationEvidence: {
      version: 1,
      status: "review_required",
      expectedCount: 2,
      expected: [
        { assetId: "asset-1", sectionId: "s1", position: 3, idempotencyKey: "asset-1:s1:hash1" },
        { assetId: "asset-2", sectionId: "s2", position: 7, idempotencyKey: "asset-2:s2:hash2" },
      ],
      upload: {
        stage: "upload",
        expectedCount: 2,
        observedCount: 2,
        verifiedCount: 2,
        status: "verified",
        images: [
          { assetId: "asset-1", sectionId: "s1", position: 3, platformImageUrl: "https://dingyue.ws.126.net/upload-1.jpg", loaded: true },
          { assetId: "asset-2", sectionId: "s2", position: 7, platformImageUrl: "https://dingyue.ws.126.net/upload-2.jpg", loaded: true },
        ],
      },
      draft: {
        stage: "draft",
        expectedCount: 2,
        observedCount: 2,
        verifiedCount: 2,
        status: "verified",
        images: [
          { assetId: "asset-1", sectionId: "s1", position: 3, platformImageUrl: "https://dingyue.ws.126.net/draft-1.jpg", loaded: true },
          { assetId: "asset-2", sectionId: "s2", position: 7, platformImageUrl: "https://dingyue.ws.126.net/draft-2.jpg", loaded: true },
        ],
      },
      public: {
        stage: "public",
        expectedCount: 2,
        observedCount: 0,
        verifiedCount: 0,
        status: "failed",
        images: [],
      },
      issues: ["PUBLIC_IMAGE_MISSING"],
      verifiedAt: "",
    },
  });

  assert.equal(result.found, true);
  const evidence = result.imagePublicationEvidence;
  assert.ok(evidence, "discovery should return fresh image evidence");
  assert.equal(evidence.status, "verified");
  assert.deepEqual(evidence.issues, []);
  assert.equal(evidence.public.status, "verified");
  assert.equal(evidence.public.verifiedCount, 2);
  assert.ok(evidence.public.images.every((image) => /^https:\/\//.test(image.platformImageUrl)));
  assert.equal(evidence.upload.status, "verified");
  assert.equal(evidence.upload.images[0].platformImageUrl, "https://dingyue.ws.126.net/upload-1.jpg");
  assert.equal(evidence.draft.status, "verified");
  assert.equal(evidence.draft.images[1].platformImageUrl, "https://dingyue.ws.126.net/draft-2.jpg");
});

test("finishes reading the public page images before closing that page", async () => {
  const articleTitle = "智心AI网易号复验关页竞态测试";
  const publicUrl = "https://www.163.com/dy/article/NETEASE_RECHECK_CLOSE.html";
  const { actions, adapter } = createNeteaseDiscoveryHarness({
    records: [{ title: articleTitle, docid: "NETEASE_RECHECK_CLOSE", url: publicUrl, status: "published" }],
    publicTitle: articleTitle,
    publicImages: [
      { src: "https://nimg.ws.126.net/?url=https://dingyue.ws.126.net/public-1.jpg" },
      { src: "https://nimg.ws.126.net/?url=https://dingyue.ws.126.net/public-2.jpg" },
    ],
    closedPageRejectsReads: true,
  });

  const result = await adapter.discoverPublication({
    articleTitle,
    imagePublicationEvidence: {
      version: 1,
      status: "review_required",
      expectedCount: 2,
      expected: [
        { assetId: "asset-1", sectionId: "s1", position: 3, idempotencyKey: "asset-1:s1:hash1" },
        { assetId: "asset-2", sectionId: "s2", position: 7, idempotencyKey: "asset-2:s2:hash2" },
      ],
      upload: {
        stage: "upload",
        expectedCount: 2,
        observedCount: 2,
        verifiedCount: 2,
        status: "verified",
        images: [
          { assetId: "asset-1", sectionId: "s1", position: 3, platformImageUrl: "https://dingyue.ws.126.net/upload-1.jpg", loaded: true },
          { assetId: "asset-2", sectionId: "s2", position: 7, platformImageUrl: "https://dingyue.ws.126.net/upload-2.jpg", loaded: true },
        ],
      },
      draft: {
        stage: "draft",
        expectedCount: 2,
        observedCount: 2,
        verifiedCount: 2,
        status: "verified",
        images: [
          { assetId: "asset-1", sectionId: "s1", position: 3, platformImageUrl: "https://dingyue.ws.126.net/draft-1.jpg", loaded: true },
          { assetId: "asset-2", sectionId: "s2", position: 7, platformImageUrl: "https://dingyue.ws.126.net/draft-2.jpg", loaded: true },
        ],
      },
      public: { stage: "public", expectedCount: 2, observedCount: 0, verifiedCount: 0, status: "failed", images: [] },
      issues: ["PUBLIC_IMAGE_MISSING"],
      verifiedAt: "",
    },
  });

  assert.equal(result.found, true);
  const evidence = result.imagePublicationEvidence;
  assert.equal(evidence.public.status, "verified");
  assert.equal(evidence.public.verifiedCount, 2);
  assert.deepEqual(evidence.issues, []);
  // The page still has to be closed, just after the read instead of during it.
  assert.ok(actions.some((item) => item[0] === "closePublicPage"));
});

test("keeps the public image stage failed when a rechecked NetEase page exposes no images", async () => {
  const articleTitle = "智心AI网易号复验缺图测试";
  const publicUrl = "https://www.163.com/dy/article/NETEASE_RECHECK_NOIMG.html";
  const { adapter } = createNeteaseDiscoveryHarness({
    records: [{ title: articleTitle, docid: "NETEASE_RECHECK_NOIMG", url: publicUrl, status: "published" }],
    publicTitle: articleTitle,
  });

  const result = await adapter.discoverPublication({
    articleTitle,
    imagePublicationEvidence: {
      expectedCount: 1,
      expected: [{ assetId: "asset-1", sectionId: "s1", position: 3, idempotencyKey: "asset-1:s1:hash1" }],
    },
  });

  assert.equal(result.found, true);
  assert.equal(result.imagePublicationEvidence.public.status, "failed");
  assert.ok(result.imagePublicationEvidence.issues.includes("PUBLIC_IMAGE_MISSING"));
  assert.equal(result.imagePublicationEvidence.status, "review_required");
});

test("discovers a reviewed NetEase article from the subscribe_v4 content API articleId", async () => {
  const articleTitle = "\u8fd1\u671f\u54ea\u4e00\u90e8\u7535\u89c6\u5267\u6bd4\u8f83\u5438\u5f15\u4eba";
  const publicUrl = "https://www.163.com/dy/article/L2EVAI9I0556O5HU.html";
  const { actions, adapter } = createNeteaseDiscoveryHarness({
    responseUrl: "https://mp.163.com/wemedia/content/manage/list.do",
    records: [{
      contentType: 1,
      contentState: 3,
      title: articleTitle,
      articleId: "L2EVAI9I0556O5HU",
      showTime: "2026-07-22 15:19:56",
    }],
    publicTitle: articleTitle,
  });

  const result = await adapter.discoverPublication({ articleTitle });

  assert.equal(result.found, true);
  assert.equal(result.publicUrl, publicUrl);
  assert.equal(result.publishedUrl, publicUrl);
  assert.ok(actions.some((item) => item[0] === "goto"
    && item[1] === "https://mp.163.com/subscribe_v4/index.html#/content-manage"));
  assert.ok(actions.some((item) => item[0] === "fill"
    && item[1].includes("input.ne-input[type='text']") && item[2] === articleTitle));
  assert.ok(actions.some((item) => item[0] === "click" && item[1] === ".search-btn"));
  assert.ok(actions.some((item) => item[0] === "verify" && item[1] === publicUrl));
});
test("reports the exact pending NetEase management record without claiming a public URL", async () => {
  const articleTitle = "\u6b63\u786e\u770b\u5f85\u552f\u7269\u4e3b\u4e49\u7684\u5b9e\u7528\u6307\u5357";
  const articleId = "NETEASE_PENDING_EXACT";
  const { adapter } = createNeteaseDiscoveryHarness({
    records: [{ title: articleTitle, articleId, contentState: 2 }],
  });

  const result = await adapter.discoverPublication({ articleTitle });

  assert.equal(result.found, false);
  assert.equal(result.managementRecordFound, true);
  assert.deepEqual(result.managementEvidence, {
    title: articleTitle,
    articleId,
    status: 2,
    contentState: 2,
    restrictionReason: "",
    appealStatus: null,
    publicUrl: "",
  });
  assert.equal(result.publicUrl, "");
});

test("reports a published NetEase record as distribution restricted when the public page is unavailable", async () => {
  const articleTitle = "\u6b63\u786e\u770b\u5f85\u552f\u7269\u4e3b\u4e49\u7684\u5b9e\u7528\u6307\u5357";
  const articleId = "L2ME165V0556O5HU";
  const { adapter } = createNeteaseDiscoveryHarness({
    records: [{
      title: articleTitle,
      articleId,
      contentState: 3,
      unrecomReason: "\u5185\u5bb9\u5206\u53d1\u53d7\u9650",
      appealStatus: 0,
    }],
    publicTitle: "404",
    publicHeadline: "404",
    publicBody: "404",
  });

  const result = await adapter.discoverPublication({ articleTitle });

  assert.equal(result.found, false);
  assert.equal(result.submissionAccepted, true);
  assert.equal(result.platformStatus, "published_restricted");
  assert.equal(result.reviewStatus, "distribution_restricted");
  assert.equal(result.publiclyVisible, false);
  assert.equal(result.managementVerificationReason, "PUBLICATION_DISTRIBUTION_RESTRICTED");
  assert.equal(
    result.message,
    "\u7f51\u6613\u53f7\u5df2\u63a5\u6536\u6587\u7ae0\uff0c\u4f46\u5185\u5bb9\u5206\u53d1\u53d7\u9650\uff0c\u5f53\u524d\u6ca1\u6709\u53ef\u9a8c\u8bc1\u516c\u5f00 URL\u3002\u8bf7\u524d\u5f80\u7f51\u6613\u53f7\u5185\u5bb9\u7ba1\u7406\u70b9\u51fb\u7533\u8bc9\u3002",
  );
  assert.deepEqual(result.managementEvidence, {
    title: articleTitle,
    articleId,
    status: 3,
    contentState: 3,
    restrictionReason: "\u5185\u5bb9\u5206\u53d1\u53d7\u9650",
    appealStatus: 0,
    publicUrl: `https://www.163.com/dy/article/${articleId}.html`,
  });
});

test("discovers a distribution-restricted NetEase record once its public page clears the gate", async () => {
  const articleTitle = "\u5546\u94fa\u76d1\u63a7\u5f55\u50cf\u8981\u5b5830\u5929\uff0c\u786c\u76d8\u8be5\u914d\u591a\u5927";
  const articleId = "L9ROIMCU0556O5HU";
  const publicUrl = `https://www.163.com/dy/article/${articleId}.html`;
  const { actions, adapter } = createNeteaseDiscoveryHarness({
    records: [{
      title: articleTitle,
      articleId,
      contentState: 3,
      unrecomReason: "\u5185\u5bb9\u542b\u6709\u5e7f\u544a\u4fe1\u606f",
      appealStatus: 0,
    }],
    publicTitle: articleTitle,
    publicHeadline: articleTitle,
    publicImages: [
      { src: "https://nimg.ws.126.net/?url=https://dingyue.ws.126.net/public-1.jpg" },
      { src: "https://nimg.ws.126.net/?url=https://dingyue.ws.126.net/public-2.jpg" },
    ],
  });

  const result = await adapter.discoverPublication({
    articleTitle,
    imagePublicationEvidence: {
      version: 1,
      status: "review_required",
      expectedCount: 2,
      expected: [
        { assetId: "asset-1", sectionId: "s1", position: 3, idempotencyKey: "asset-1:s1:hash1" },
        { assetId: "asset-2", sectionId: "s2", position: 7, idempotencyKey: "asset-2:s2:hash2" },
      ],
      upload: {
        stage: "upload",
        expectedCount: 2,
        observedCount: 2,
        verifiedCount: 2,
        status: "verified",
        images: [
          { assetId: "asset-1", sectionId: "s1", position: 3, platformImageUrl: "https://dingyue.ws.126.net/upload-1.jpg", loaded: true },
          { assetId: "asset-2", sectionId: "s2", position: 7, platformImageUrl: "https://dingyue.ws.126.net/upload-2.jpg", loaded: true },
        ],
      },
      draft: {
        stage: "draft",
        expectedCount: 2,
        observedCount: 2,
        verifiedCount: 2,
        status: "verified",
        images: [
          { assetId: "asset-1", sectionId: "s1", position: 3, platformImageUrl: "https://dingyue.ws.126.net/draft-1.jpg", loaded: true },
          { assetId: "asset-2", sectionId: "s2", position: 7, platformImageUrl: "https://dingyue.ws.126.net/draft-2.jpg", loaded: true },
        ],
      },
      public: { stage: "public", expectedCount: 2, observedCount: 0, verifiedCount: 0, status: "failed", images: [] },
      issues: ["PUBLIC_IMAGE_MISSING"],
      verifiedAt: "",
    },
  });

  assert.equal(result.found, true);
  assert.equal(result.publicUrl, publicUrl);
  assert.equal(result.publishedUrl, publicUrl);
  assert.equal(result.platformStatus, "published");
  assert.equal(result.reviewStatus, "public");
  assert.equal(result.publiclyVisible, true);
  assert.equal(result.managementVerificationReason, "PUBLIC_PAGE_VERIFIED_DISTRIBUTION_RESTRICTED");
  assert.equal(
    result.message,
    "\u7f51\u6613\u53f7\u6587\u7ae0\u5df2\u5ba1\u6838\u901a\u8fc7\u5e76\u516c\u5f00\uff0c\u4f46\u5e73\u53f0\u9650\u5236\u5206\u53d1\uff08\u5185\u5bb9\u542b\u6709\u5e7f\u544a\u4fe1\u606f\uff09\u3002",
  );
  const evidence = result.imagePublicationEvidence;
  assert.ok(evidence, "discovery should return fresh image evidence");
  assert.equal(evidence.status, "verified");
  assert.equal(evidence.public.status, "verified");
  assert.equal(evidence.public.verifiedCount, 2);
  assert.deepEqual(evidence.issues, []);
  assert.ok(actions.some((item) => item[0] === "verify" && item[1] === publicUrl));
});

test("does not discover a NetEase public URL from an unrelated content row", async () => {
  const { adapter } = createNeteaseDiscoveryHarness({
    records: [
      { title: "已经发布的旧文章", docid: "STALE_ARTICLE", url: "https://www.163.com/dy/article/STALE_ARTICLE.html" }
    ],
    publicTitle: "已经发布的旧文章"
  });

  const result = await adapter.discoverPublication({ articleTitle: "本次刚审核通过的新文章" });

  assert.equal(result.found, false);
  assert.equal(result.publicUrl, "");
  assert.equal(result.publishedUrl, "");
  assert.equal(result.reviewUrl ?? "", "");
  assert.equal(result.candidateUrl ?? "", "");
  assert.equal(result.managementRecordFound, false);
  assert.equal(result.managementEvidence, null);
  assert.equal(result.managementVerificationReason, "MANAGEMENT_RECORD_NOT_FOUND");
  assert.equal(result.reviewStatus, "management_record_not_found");
});

test("rejects a NetEase public page when the expected title appears only in sidebar content", async () => {
  const expectedTitle = "\u6b63\u786e\u770b\u5f85\u552f\u7269\u4e3b\u4e49\u7684\u5b9e\u7528\u6307\u5357";
  const staleTitle = "\u8fd1\u671f\u54ea\u4e00\u90e8\u7535\u89c6\u5267\u6bd4\u8f83\u5438\u5f15\u4eba";
  const staleUrl = "https://www.163.com/dy/article/L2EVAI9I0556O5HU.html";
  const { adapter } = createNeteaseDiscoveryHarness({
    records: [{ title: expectedTitle, articleId: "L2EVAI9I0556O5HU", contentState: 3 }],
    publicTitle: staleTitle,
    publicHeadline: staleTitle,
    publicBody: `${staleTitle} \u6b63\u6587 \u5f80\u671f\u56de\u987e ${expectedTitle}`,
  });

  const result = await adapter.discoverPublication({ articleTitle: expectedTitle });

  assert.equal(result.found, false);
  assert.equal(result.publicUrl, "");
  assert.notEqual(result.publicUrl, staleUrl);
});

test("accepts a NetEase public page only when its main headline exactly matches", async () => {
  const expectedTitle = "\u6b63\u786e\u770b\u5f85\u552f\u7269\u4e3b\u4e49\u7684\u5b9e\u7528\u6307\u5357";
  const publicUrl = "https://www.163.com/dy/article/NETEASE_TARGET.html";
  const { adapter } = createNeteaseDiscoveryHarness({
    records: [{ title: expectedTitle, articleId: "NETEASE_TARGET", contentState: 3 }],
    publicTitle: "\u7f51\u6613\u53f7",
    publicHeadline: expectedTitle,
    publicBody: "\u8fd9\u662f\u76ee\u6807\u6587\u7ae0\u7684\u6b63\u6587\u5185\u5bb9\u3002",
  });

  const result = await adapter.discoverPublication({ articleTitle: expectedTitle });

  assert.equal(result.found, true);
  assert.equal(result.publicUrl, publicUrl);
});

test("uses the article identifier from the exact matching NetEase record", async () => {
  const expectedTitle = "\u6b63\u786e\u770b\u5f85\u552f\u7269\u4e3b\u4e49\u7684\u5b9e\u7528\u6307\u5357";
  const targetId = "L2TARGET123456";
  const { adapter } = createNeteaseDiscoveryHarness({
    responsePayload: {
      code: 1,
      data: {
        title: expectedTitle,
        contentState: 3,
        list: [
          { title: "\u8fd1\u671f\u54ea\u4e00\u90e8\u7535\u89c6\u5267\u6bd4\u8f83\u5438\u5f15\u4eba", articleId: "L2EVAI9I0556O5HU", contentState: 3 },
          { title: expectedTitle, articleId: targetId, contentState: 3 },
        ],
      },
    },
    publicTitle: expectedTitle,
    publicHeadline: expectedTitle,
    publicBody: `${expectedTitle} \u6b63\u6587\u5185\u5bb9`,
  });

  const result = await adapter.discoverPublication({ articleTitle: expectedTitle });

  assert.equal(result.found, true);
  assert.equal(result.publicUrl, `https://www.163.com/dy/article/${targetId}.html`);
});

test("publishes NetEase through the browser API context when wemedia configuration is available", async () => {
  const calls = [];
  const page = {
    evaluate: async () => ({ ursToken: "runtime-urs-token", sign: "runtime-sign", timestamp: "runtime-timestamp" }),
    request: {
      async fetch(url, options = {}) {
        calls.push({ url, options });
        const text = String(url);
        if (text.includes("/api/v3/upload/picupload")) {
          return {
            status: () => 200,
            url: () => url,
            text: async () => JSON.stringify({ code: 200, data: { url: "http://dingyue.ws.126.net/api-cover.jpg", pid: "pic-api-1" } }),
          };
        }
        if (text.includes("/wemedia/material/picture/addPic.do")) {
          return {
            status: () => 200,
            url: () => url,
            text: async () => JSON.stringify({ code: 1, data: { picId: "PIC_API_1" } }),
          };
        }
        if (text.includes("/api/v2/upload/batchUploadImgUrl")) {
          return {
            status: () => 200,
            url: () => url,
            text: async () => JSON.stringify({ code: 1, data: { "http://dingyue.ws.126.net/api-cover.jpg": "http://dingyue.ws.126.net/api-cover-thumb.jpg" } }),
          };
        }
        return {
          status: () => 200,
          url: () => url,
          text: async () => JSON.stringify({ code: 1, data: calls.filter((call) => String(call.url).includes("publishV2.do")).length === 1
            ? "docId=L2API1630001&pkId=null"
            : "/wemedia/article/mylist/W5112429582733757739/1-20.html,L2API1630001" }),
        };
      },
    },
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    cookies: async () => [{ name: "NTES_SESS", value: "netease-session", domain: ".163.com" }],
    close: async () => calls.push({ close: true }),
  };
  const adapter = new NeteasePublishAdapter({
    browser: { launchPersistentContext: async () => context },
  });

  const result = await adapter.publishArticle({
    articleTitle: "NetEase API-first publish test",
    contentMarkdown: "This verifies NetEase API publishing waits for public visibility instead of inventing a URL.",
    contentHtml: "<p>This verifies NetEase API publishing waits for public visibility instead of inventing a URL.</p>",
    coverImagePath: fileURLToPath(import.meta.url),
    confirmPublish: true,
    apiFirst: true,
    platformConfig: {
      wemediaId: "W5112429582733757739",
      realUserId: "556O5HU",
    },
  });

  assert.equal(result.platformStatus, "submitted_for_review");
  assert.equal(result.publishedUrl, "");
  assert.equal(result.externalIds.docId, "L2API1630001");
  assert.equal(result.externalIds.picId, "PIC_API_1");
  assert.equal(result.publicationEvidence.source, "api");
  assert.equal(result.publicationEvidence.accepted, true);
  assert.equal(calls.filter((call) => String(call.url).includes("publishV2.do")).length, 4);
  assert.doesNotMatch(JSON.stringify(result.publicationEvidence), /netease-session/);
});

test("publishes NetEase with captured account discovery and ordered runtime-signed stages", async () => {
  const calls = [];
  const page = {
    evaluate: async () => ({ ursToken: "runtime-urs-token", sign: "runtime-sign", timestamp: "runtime-timestamp" }),
    request: {
      async fetch(url, options = {}) {
        calls.push({ url, options });
        const value = String(url);
        if (value.includes("/wemedia/bee/account/query.do")) {
          return { status: () => 200, url: () => url, text: async () => JSON.stringify({ code: 1, data: { wemediaId: "W-RUNTIME", beeUid: "U-RUNTIME" } }) };
        }
        if (value.includes("/api/v3/upload/picupload")) {
          return { status: () => 200, url: () => url, text: async () => JSON.stringify({ code: 1, data: { url: "https://dingyue.ws.126.net/runtime-cover.jpg" } }) };
        }
        if (value.includes("/wemedia/material/picture/addPic.do")) {
          return { status: () => 200, url: () => url, text: async () => JSON.stringify({ code: 1, data: { picId: "PIC-RUNTIME" } }) };
        }
        const publishCount = calls.filter((call) => String(call.url).includes("publishV2.do")).length;
        return { status: () => 200, url: () => url, text: async () => JSON.stringify({ code: 1, data: publishCount === 1 ? "docId=NETEASE_RUNTIME_1" : "submitted" }) };
      },
    },
  };
  const context = { pages: () => [page], newPage: async () => page, close: async () => undefined };
  const adapter = new NeteasePublishAdapter({ browser: { launchPersistentContext: async () => context } });

  const result = await adapter.publishArticle({
    articleTitle: "NetEase runtime API sequence",
    contentMarkdown: "This verifies the current-session account bootstrap and staged NetEase publish sequence.",
    coverImagePath: fileURLToPath(import.meta.url),
    confirmPublish: true,
    apiFirst: true,
  });

  const publishCalls = calls.filter((call) => String(call.url).includes("publishV2.do"));
  assert.equal(result.platformStatus, "submitted_for_review");
  assert.ok(calls.some((call) => String(call.url).includes("/wemedia/bee/account/query.do")));
  assert.equal(publishCalls.length, 4);
  assert.deepEqual(
    publishCalls.map((call) => new URLSearchParams(call.options.data).get("operation")),
    ["saveDraft", "saveDraft", "saveDraft", "publish"],
  );
  assert.equal(new URLSearchParams(publishCalls.at(-1).options.data).get("firstPub"), "true");
  assert.doesNotMatch(JSON.stringify(result.publicationEvidence), /runtime-sign|runtime-timestamp/);
});
