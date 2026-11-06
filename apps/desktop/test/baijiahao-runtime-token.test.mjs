import assert from "node:assert/strict";
import { test } from "node:test";
import { BaijiahaoAdapter, readBaijiahaoRequestToken } from "../src/adapters/baijiahao.mjs";

test("token read preserves navigation failure instead of claiming missing credentials", async () => {
  const failure = new Error("Execution context was destroyed, most likely because of a navigation");
  await assert.rejects(readBaijiahaoRequestToken({ evaluate: async () => { throw failure; } }), error => error === failure);
});

test("validation does not refresh credentials or report success when editor token is missing", async () => {
  let refreshed = false;
  let closed = false;
  const page = { goto: async () => {}, evaluate: async () => "", waitForLoadState: async () => {} };
  const adapter = new BaijiahaoAdapter();
  adapter.launchAuthEnvironment = async () => ({ pages: () => [page], close: async () => { closed = true; } });
  adapter.reportCredentialRefresh = async () => { refreshed = true; return {}; };
  await assert.rejects(adapter.validateSession({ headless: true }), /BAIJIAHAO_RUNTIME_TOKEN_REQUIRED/);
  assert.equal(refreshed, false);
  assert.equal(closed, true);
});


test("reads browser storage when document navigation destroys evaluate", async () => {
  const page = {
    context: () => ({ storageState: async () => ({ origins: [
      { origin: "https://unrelated.example", localStorage: [{ name: "edit-token", value: "wrong" }] },
      { origin: "https://baijiahao.baidu.com", localStorage: [{ name: "edit-token", value: "current-token" }] }
    ] }) }),
    evaluate: async () => { throw new Error("Execution context was destroyed"); }
  };
  assert.equal(await readBaijiahaoRequestToken(page), "current-token");
});

test("missing browser token requires reauthorization without stale page fallback", async () => {
  const page = {
    context: () => ({ storageState: async () => ({ origins: [] }) }),
    evaluate: async () => "stale-token"
  };
  await assert.rejects(readBaijiahaoRequestToken(page), /BAIJIAHAO_NEEDS_REAUTH/);
});
