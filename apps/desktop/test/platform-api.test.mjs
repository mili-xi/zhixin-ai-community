import assert from "node:assert/strict";
import { test } from "node:test";

import { platformApiFetch, sanitizeApiEvidence } from "../src/adapters/platform-api.mjs";

test("sanitizes platform API evidence without leaking cookies or tokens", () => {
  const evidence = sanitizeApiEvidence({
    request: {
      method: "POST",
      url: "https://mp.example.com/publish?token=secret-token&accountId=122",
      headers: {
        Cookie: "session=secret-cookie",
        Authorization: "Bearer secret-auth",
        "X-Csrf-Token": "secret-csrf",
        Referer: "https://mp.example.com/editor",
      },
    },
    response: {
      status: 200,
      payload: {
        code: 0,
        data: {
          articleId: "article-1",
          cookie: "secret-cookie",
          accessToken: "secret-access-token",
        },
      },
    },
  });

  const serialized = JSON.stringify(evidence);
  assert.match(serialized, /REDACTED/);
  assert.doesNotMatch(serialized, /secret-cookie|secret-auth|secret-csrf|secret-token|secret-access-token/);
  assert.equal(evidence.request.method, "POST");
  assert.equal(evidence.response.status, 200);
  assert.equal(evidence.response.payload.data.articleId, "article-1");
});

test("calls platform APIs through the authenticated browser request context", async () => {
  const calls = [];
  const page = {
    request: {
      async fetch(url, options = {}) {
        calls.push({ url, options });
        return {
          status: () => 200,
          url: () => url,
          text: async () => JSON.stringify({ success: true, data: { newsId: "sohu-news-1" } }),
        };
      },
    },
  };

  const result = await platformApiFetch(page, "https://mp.sohu.com/mpbp/bp/news/v4/news/publish/v2?accountId=122", {
    method: "POST",
    json: { title: "API publish", content: "<p>body</p>" },
    headers: { Cookie: "ppinf=secret", Referer: "https://mp.sohu.com/" },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(result.payload, { success: true, data: { newsId: "sohu-news-1" } });
  assert.equal(result.evidence.response.payload.data.newsId, "sohu-news-1");
  assert.equal(result.evidence.request.data, "REDACTED");
  assert.doesNotMatch(JSON.stringify(result.evidence), /ppinf=secret/);
});

test("falls back to a plain fetch with browser cookies when request.fetch is unavailable", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return {
      status: 200,
      url: () => url,
      text: async () => JSON.stringify({ response: { code: 0, msg: "success" }, data: { articleId: "20260728A095U7" } }),
    };
  };

  try {
    const page = {
      context() {
        return {
          async cookies(urls) {
            assert.deepEqual(urls, ["https://om.qq.com"]);
            return [
              { name: "omaccesstoken", value: "token-value", domain: ".om.qq.com", path: "/" },
              { name: "csrfToken", value: "csrf-value", domain: ".om.qq.com", path: "/" },
            ];
          },
        };
      },
    };

    const result = await platformApiFetch(page, "https://om.qq.com/marticlepublish/omPublish", {
      method: "POST",
      form: { title: "Fallback publish", category_id: "17" },
      headers: { Referer: "https://om.qq.com/main/creation/article" },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://om.qq.com/marticlepublish/omPublish");
    assert.equal(calls[0].options.method, "POST");
    assert.match(String(calls[0].options.headers.Cookie || calls[0].options.headers.cookie || ""), /omaccesstoken=token-value/);
    assert.match(String(calls[0].options.headers.Cookie || calls[0].options.headers.cookie || ""), /csrfToken=csrf-value/);
    assert.deepEqual(result.payload, { response: { code: 0, msg: "success" }, data: { articleId: "20260728A095U7" } });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
