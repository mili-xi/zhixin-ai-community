import assert from "node:assert/strict";
import { test } from "node:test";

import {
  JianshuAdapter,
  createJianshuNoteViaApi,
  inspectJianshuPublicArticleViaApi,
  publicizeJianshuNoteViaApi,
  softDestroyJianshuNoteViaApi,
  updateJianshuNoteViaApi,
  verifyJianshuDraftViaApi,
} from "../src/adapters/jianshu.mjs";

function apiResponse(status, payload, url = "") {
  return {
    status: () => status,
    url: () => url,
    text: async () => payload == null ? "" : JSON.stringify(payload),
  };
}

function apiPage(handler) {
  return {
    request: {
      fetch: handler,
    },
  };
}

test("creates a Jianshu note in a real notebook using the captured API contract", async () => {
  const calls = [];
  const page = apiPage(async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).endsWith("/author/notebooks")) {
      return apiResponse(200, [
        { id: 57148354, name: "Daily" },
        { id: 57148355, name: "Notes" },
      ], url);
    }
    return apiResponse(200, {
      id: 141684195,
      slug: "8d78c57a6cc6",
      notebook_id: 57148354,
      autosave_control: 0,
      shared: false,
    }, url);
  });

  const draft = await createJianshuNoteViaApi(page, "Jianshu API closure test");

  assert.deepEqual(draft, {
    noteId: "141684195",
    notebookId: "57148354",
    slug: "8d78c57a6cc6",
    autosaveControl: 0,
  });
  assert.equal(calls[0].url, "https://www.jianshu.com/author/notebooks");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[1].url, "https://www.jianshu.com/author/notes");
  assert.equal(calls[1].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[1].options.data), {
    notebook_id: "57148354",
    title: "Jianshu API closure test",
    at_bottom: false,
  });
});

test("updates and reads back the exact Jianshu draft before publishing", async () => {
  const calls = [];
  const html = "<h2>Workflow</h2><p>Draft body verified through the API.</p>";
  const imageUrl = "https://upload-images.jianshu.io/upload_images/31306077-image.jpg";
  const page = apiPage(async (url, options = {}) => {
    calls.push({ url, options });
    const text = String(url);
    if (options.method === "PUT") {
      return apiResponse(200, {
        id: 141684195,
        content_updated_at: 1785686938,
        content_size_status: "fine",
        last_compiled_at: 0,
      }, url);
    }
    if (text.endsWith("/content")) {
      return apiResponse(200, {
        content: `${html}<div class="image-package"><img src="${imageUrl}?imageView2/2/w/1240"></div>`,
      }, url);
    }
    return apiResponse(200, [{
      id: 141684195,
      slug: "8d78c57a6cc6",
      shared: false,
      notebook_id: 57148354,
      autosave_control: 1,
      title: "Jianshu API closure test",
      last_compiled_at: 0,
    }], url);
  });

  const update = await updateJianshuNoteViaApi(page, {
    noteId: "141684195",
    autosaveControl: 0,
  }, "Jianshu API closure test", html);
  const verified = await verifyJianshuDraftViaApi(page, {
    noteId: "141684195",
    notebookId: "57148354",
    slug: "8d78c57a6cc6",
    title: "Jianshu API closure test",
    html,
    expectedImageUrls: [imageUrl],
  });

  assert.equal(update.autosaveControl, 1);
  assert.deepEqual(JSON.parse(calls[0].options.data), {
    id: "141684195",
    autosave_control: 1,
    title: "Jianshu API closure test",
    content: html,
  });
  assert.equal(calls[1].url, "https://www.jianshu.com/author/notes/141684195/content");
  assert.match(calls[2].url, /author\/notebooks\/57148354\/notes\?page=1&count=10&nid=141684195$/);
  assert.equal(verified.verified, true);
  assert.equal(verified.metadata.shared, false);
  assert.deepEqual(verified.imageUrls, [imageUrl]);
});

test("derives the public URL from the create slug when publicize returns only last_compiled_at", async () => {
  const calls = [];
  const page = apiPage(async (url, options = {}) => {
    calls.push({ url, options });
    return apiResponse(200, { last_compiled_at: 1785686939 }, url);
  });

  const result = await publicizeJianshuNoteViaApi(page, {
    noteId: "141684195",
    slug: "8d78c57a6cc6",
  });

  assert.equal(calls[0].url, "https://www.jianshu.com/author/notes/141684195/publicize");
  assert.deepEqual(JSON.parse(calls[0].options.data), {});
  assert.equal(result.publishedUrl, "https://www.jianshu.com/p/8d78c57a6cc6");
  assert.equal(result.lastCompiledAt, 1785686939);
});

test("verifies the exact title, body, and images through Jianshu public article data", async () => {
  const imageUrl = "https://upload-images.jianshu.io/upload_images/31306077-image.jpg";
  const page = apiPage(async (url) => apiResponse(200, {
    id: 141684195,
    slug: "8d78c57a6cc6",
    public_title: "Jianshu API closure test",
    free_content: `<h2>Workflow</h2><p>Public body verified through the API.</p><img data-original-src="//upload-images.jianshu.io/upload_images/31306077-image.jpg">`,
  }, url));

  const result = await inspectJianshuPublicArticleViaApi(page, {
    noteId: "141684195",
    slug: "8d78c57a6cc6",
    title: "Jianshu API closure test",
    html: "<h2>Workflow</h2><p>Public body verified through the API.</p>",
    expectedImageUrls: [imageUrl],
  });

  assert.equal(result.found, true);
  assert.equal(result.publishedUrl, "https://www.jianshu.com/p/8d78c57a6cc6");
  assert.equal(result.titleMatched, true);
  assert.equal(result.bodyMatched, true);
  assert.deepEqual(result.imageUrls, [imageUrl]);
});

test("rejects a public Jianshu response for a different title", async () => {
  const page = apiPage(async (url) => apiResponse(200, {
    id: 141684195,
    slug: "8d78c57a6cc6",
    public_title: "A different article",
    free_content: "<p>Expected body.</p>",
  }, url));

  await assert.rejects(
    inspectJianshuPublicArticleViaApi(page, {
      noteId: "141684195",
      slug: "8d78c57a6cc6",
      title: "Jianshu API closure test",
      html: "<p>Expected body.</p>",
    }),
    /JIANSHU_PUBLIC_TITLE_MISMATCH/,
  );
});

test("soft-deletes a verified Jianshu test note through the captured endpoint", async () => {
  const calls = [];
  const page = apiPage(async (url, options = {}) => {
    calls.push({ url, options });
    return apiResponse(200, {
      id: 141684195,
      title: "Jianshu API closure test",
      deleted_at: 1785686986,
    }, url);
  });

  const result = await softDestroyJianshuNoteViaApi(page, "141684195");

  assert.equal(calls[0].url, "https://www.jianshu.com/author/notes/141684195/soft_destroy");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.data, undefined);
  assert.equal(result.deleted, true);
  assert.equal(result.noteId, "141684195");
});

test("Jianshu adapter uses the API transport without a DOM publish fallback", async () => {
  const calls = [];
  const page = {};
  const context = {
    pages: () => [page],
    newPage: async () => page,
    close: async () => calls.push("close"),
  };
  const adapter = new JianshuAdapter();
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
    articleTitle: "Jianshu API closure test",
    contentMarkdown: "A real article body for API publishing.",
    confirmPublish: true,
    publishTransport: "dom",
    allowDomFallback: true,
  });

  assert.equal(result.transport, "api");
  assert.deepEqual(calls, ["api", "close"]);
});
