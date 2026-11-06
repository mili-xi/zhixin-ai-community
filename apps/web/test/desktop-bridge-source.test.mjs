import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const bridgePath = path.resolve(testDir, "../src/lib/desktop-bridge.ts");
const freeMediaPath = path.resolve(testDir, "../app/free-media/page.tsx");
const ownerBindingPath = path.resolve(testDir, "../src/lib/desktop-owner-binding.ts");
const appShellPath = path.resolve(testDir, "../src/components/app-shell.tsx");

test("desktop bridge client uses postMessage request/reply events", async () => {
  const source = await readFile(bridgePath, "utf8");

  assert.match(source, /zhixin:agent-command/);
  assert.match(source, /zhixin:agent-command-result/);
  assert.match(source, /zhixin:agent-command-error/);
  assert.match(source, /runDesktopAgentCommand/);
  assert.match(source, /isDesktopBridgeAvailable/);
  assert.match(source, /sessionStorage\.setItem\(desktopBridgeSessionKey,\s*"1"\)/);
  assert.match(source, /sessionStorage\.getItem\(desktopBridgeSessionKey\)\s*===\s*"1"/);
  assert.match(source, /hasDesktopQuery\s*\|\|\s*rememberedDesktopMode/);
  assert.match(source, /window\.parent\.postMessage/);
});

// Execute the page's actual handler without mounting the unrelated account table.
async function mediaAuthorizationHandler(dependencies) {
  const source = await readFile(freeMediaPath, "utf8");
  const ast = ts.createSourceFile(freeMediaPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "authorizePlatform") handler = node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(handler, "the media page must expose its authorization handler");
  const { outputText } = ts.transpileModule(handler.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  });
  return new Function(...Object.keys(dependencies), `${outputText}\nreturn authorizePlatform;`)(...Object.values(dependencies));
}

test("free media authorization stops before invoking the bridge in a browser", async () => {
  const effects = [];
  const authorize = await mediaAuthorizationHandler({
    requireDesktop: (action) => { effects.push(action); return false; },
    setBusy: () => assert.fail("browser authorization must not start"),
    setMessage: () => assert.fail("browser authorization must not report success"),
    runDesktopAgentCommand: () => assert.fail("browser authorization must not invoke the bridge"),
    refreshAll: () => assert.fail("blocked authorization must not refresh accounts")
  });
  await authorize("penguin");
  assert.deepEqual(effects, ["媒体账号授权"]);
});

test("free media authorization awaits the local bridge before refreshing accounts", async () => {
  const effects = [];
  let finishAuthorization;
  const pending = new Promise((resolve) => { finishAuthorization = resolve; });
  const authorize = await mediaAuthorizationHandler({
    requireDesktop: () => true,
    platformName: () => "企鹅号",
    setBusy: (busy) => effects.push(busy),
    setMessage: () => {},
    runDesktopAgentCommand: (command) => { effects.push(command); return pending; },
    refreshAll: async () => { effects.push("refresh"); }
  });
  const operation = authorize("penguin");
  assert.deepEqual(effects, [true, {
    command: "authorize",
    args: ["--platform", "penguin", "--wait-login-ms", "300000"],
    timeoutMs: 360000
  }]);
  finishAuthorization();
  await operation;
  assert.deepEqual(effects.slice(2), ["refresh", false]);
});

test("free media authorization reports bridge failure and releases the busy state", async () => {
  const busyStates = [];
  const messages = [];
  const authorize = await mediaAuthorizationHandler({
    requireDesktop: () => true,
    platformName: () => "企鹅号",
    setBusy: (busy) => busyStates.push(busy),
    setMessage: (message) => messages.push(message),
    runDesktopAgentCommand: async () => { throw new Error("AUTHORIZATION_FAILED"); },
    refreshAll: () => assert.fail("failed authorization must not refresh accounts")
  });
  await authorize("penguin");
  assert.equal(messages.at(-1), "AUTHORIZATION_FAILED");
  assert.deepEqual(busyStates, [true, false]);
});


test("desktop shell automatically binds the local device to the signed-in member", async () => {
  const bindingSource = await readFile(ownerBindingPath, "utf8");
  const shellSource = await readFile(appShellPath, "utf8");
  const accountSource = await readFile(path.resolve(testDir, "../src/components/account-menu.tsx"), "utf8");

  assert.match(bindingSource, /\/api\/auth\/me/);
  assert.match(bindingSource, /\/api\/desktop-owner-bindings/);
  assert.match(bindingSource, /command:\s*"register"/);
  assert.match(bindingSource, /command:\s*"bind-owner"/);
  assert.match(bindingSource, /"--binding-id"/);
  assert.match(bindingSource, /"--pairing-code"/);
  assert.match(bindingSource, /boundOwnerId/);
  assert.match(bindingSource, /bindingPromise/);
  assert.match(shellSource, /AccountMenu/);
  assert.match(accountSource, /ensureDesktopOwnerBinding/);
});
