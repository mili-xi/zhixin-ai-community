import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const globalsPath = path.resolve(testDir, "../app/globals.css");
const loginPath = path.resolve(testDir, "../app/login/page.tsx");
const middlewarePath = path.resolve(testDir, "../middleware.ts");

test("login page supports verified registration and later password sign-in", async () => {
  const source = await readFile(loginPath, "utf8");
  assert.match(source, /\/api\/auth\/register\/request-code/);
  assert.match(source, /\/api\/auth\/register/);
  assert.match(source, /\/api\/auth\/login/);
  assert.match(source, /credentials:\s*"include"/);
  assert.match(source, /router\.replace\(/);
  assert.match(source, /邮箱密码登录/);
  assert.match(source, /验证码注册/);
  assert.match(source, /REGISTRATION_CODE_INVALID_OR_EXPIRED/);

  assert.doesNotMatch(source, /管理员登录|管理后台|admin/i);
});

test("auth fields render one visual shell and accessible password toggles", async () => {
  const [source, styles] = await Promise.all([
    readFile(loginPath, "utf8"),
    readFile(globalsPath, "utf8"),
  ]);

  assert.match(source, /className="auth-field-input"/);
  assert.match(source, /htmlFor=\{id\}/);
  assert.match(source, /\u663e\u793a\u5bc6\u7801/);
  assert.match(source, /\u9690\u85cf\u5bc6\u7801/);
  assert.match(styles, /\.auth-field-input[\s\S]*border:\s*0\s*!important/);
  assert.match(styles, /\.auth-field-input:focus[\s\S]*box-shadow:\s*none\s*!important/);
});

test("middleware protects business pages while leaving auth, API and static assets reachable", async () => {
  const source = await readFile(middlewarePath, "utf8");
  assert.match(source, /zhixin_session/);
  assert.match(source, /pathname\s*===\s*"\/login"/);
  assert.match(source, /url\.pathname\s*=\s*"\/login"/);
  assert.match(source, /pathname\.startsWith\("\/api\/"\)/);
  assert.match(source, /pathname\.startsWith\("\/uploads\/"\)/);
  assert.match(source, /pathname\.startsWith\("\/downloads\/"\)/);
  assert.match(source, /pathname\.startsWith\("\/_next\/"\)/);
});
