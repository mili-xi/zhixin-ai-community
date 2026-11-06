import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function invokeEncodedPowerShell(script) {
  const input = `${script.replace(/\r?\n/g, "\r\n")}\r\nexit 0\r\n`;
  return spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "-"], {
    encoding: "utf8",
    input,
  });
}

function invokeRealGateValidator(publishScript, { result, jsonText, expectedVersion, platform }) {
  const source = Buffer.from(publishScript, "utf8").toString("base64");
  const request = Buffer.from(
    JSON.stringify({ jsonText: jsonText ?? JSON.stringify(result), expectedVersion, platform }),
    "utf8",
  ).toString("base64");
  const validatorScript = `
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${source}'))
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${request}')) | ConvertFrom-Json
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)
$functionAst = $ast.Find({
  param($node)
  $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-RealGateResult'
}, $true)
if (-not $functionAst) { throw 'Assert-RealGateResult was not found.' }
. ([scriptblock]::Create($functionAst.Extent.Text))
try {
  Assert-RealGateResult -JsonText $request.jsonText -ExpectedVersion $request.expectedVersion -Platform $request.platform
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

  return invokeEncodedPowerShell(validatorScript);
}

function invokeAgentFailureGuard(publishScript, sensitiveMarker) {
  const source = Buffer.from(publishScript, "utf8").toString("base64");
  const marker = Buffer.from(sensitiveMarker, "utf8").toString("base64");
  const validatorScript = `
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${source}'))
$marker = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${marker}'))
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)
$functionAst = $ast.Find({
  param($node)
  $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-RealPlatformGate'
}, $true)
if (-not $functionAst) { throw 'Invoke-RealPlatformGate was not found.' }
. ([scriptblock]::Create($functionAst.Extent.Text))
$ErrorActionPreference = 'Stop'
function node {
  Write-Error $marker
  $global:LASTEXITCODE = 23
}
try {
  Invoke-RealPlatformGate -Arguments @('agent.mjs', 'run-once') -StagedManifestUrl 'https://zhixin.example.com/staging/test.json'
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

  return invokeEncodedPowerShell(validatorScript);
}

function invokeCheckedFailureGuard(publishScript, sensitiveMarker) {
  const source = Buffer.from(publishScript, "utf8").toString("base64");
  const marker = Buffer.from(sensitiveMarker, "utf8").toString("base64");
  const validatorScript = `
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${source}'))
$marker = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${marker}'))
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)
$functionAst = $ast.Find({
  param($node)
  $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-Checked'
}, $true)
if (-not $functionAst) { throw 'Invoke-Checked was not found.' }
. ([scriptblock]::Create($functionAst.Extent.Text))
$ErrorActionPreference = 'Stop'
try {
  Invoke-Checked 'powershell' @(
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "[Console]::Error.WriteLine('$marker'); exit 23"
  )
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

  return invokeEncodedPowerShell(validatorScript);
}

function invokePublishInputValidator(publishScript, values) {
  const source = Buffer.from(publishScript, "utf8").toString("base64");
  const request = Buffer.from(JSON.stringify(values), "utf8").toString("base64");
  const validatorScript = `
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${source}'))
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${request}')) | ConvertFrom-Json
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)
$functionAst = $ast.Find({
  param($node)
  $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-PublishInputs'
}, $true)
if (-not $functionAst) { throw 'Assert-PublishInputs was not found.' }
. ([scriptblock]::Create($functionAst.Extent.Text))
try {
  Assert-PublishInputs -Version $request.version -Platforms $request.platforms -RemoteRoot $request.remoteRoot -Server $request.server
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

  return invokeEncodedPowerShell(validatorScript);
}

test("desktop package exposes a reproducible Windows installer command", async () => {
  const packageJson = JSON.parse(await readFile(path.join(desktopRoot, "package.json"), "utf8"));
  const tauriConfig = JSON.parse(await readFile(path.join(desktopRoot, "src-tauri", "tauri.conf.json"), "utf8"));
  const installerScript = await readFile(path.join(desktopRoot, "installer", "windows", "zhixin-ai.iss"), "utf8");

  assert.equal(typeof packageJson.scripts["build:installer"], "string");
  assert.match(packageJson.scripts["build:installer"], /ISCC|build-windows-installer/);
  assert.equal(packageJson.version, tauriConfig.package.version);
  assert.match(installerScript, new RegExp(`#define AppVersion "${packageJson.version}"`));
  assert.match(installerScript, /#define AppName "智心AI"/);
});

test("desktop resources include both headed and headless Chromium runtimes", async () => {
  const prepareScript = await readFile(
    path.join(desktopRoot, "scripts", "prepare-tauri-resources.mjs"),
    "utf8",
  );

  assert.match(prepareScript, /chromium-/);
  assert.match(prepareScript, /chromium_headless_shell-/);
});

test("desktop release tooling supports signed adapter hot-update bundles", async () => {
  const packageJson = JSON.parse(await readFile(path.join(desktopRoot, "package.json"), "utf8"));
  const tauriConfig = JSON.parse(await readFile(path.join(desktopRoot, "src-tauri", "tauri.conf.json"), "utf8"));
  const prepareScript = await readFile(path.join(desktopRoot, "scripts", "prepare-tauri-resources.mjs"), "utf8");
  const createScript = await readFile(path.join(desktopRoot, "scripts", "create-adapter-bundle.mjs"), "utf8");
  const publishScript = await readFile(path.join(desktopRoot, "scripts", "publish-adapter-bundle.ps1"), "utf8");

  assert.match(packageJson.scripts["build:adapter-bundle"], /create-adapter-bundle\.mjs/);
  assert.match(packageJson.scripts["publish:adapter-bundle"], /publish-adapter-bundle\.ps1/);
  assert.match(prepareScript, /adapter_ed25519_public\.pem/);
  assert.ok(tauriConfig.tauri.bundle.resources.includes("resources/adapter_ed25519_public.pem"));
  assert.match(createScript, /\.zhixin-ai-community-signing.+adapter_ed25519_private\.pem/s);
  assert.match(createScript, /adapter-version\.json/);
  assert.match(createScript, /includedAdapterFiles/);
  assert.match(createScript, /ADAPTER_BUNDLE_INCLUDE_FILE_NOT_ALLOWED/);
  assert.doesNotMatch(publishScript, /\bRealTestCommand\b|Invoke-Expression/);
  assert.match(publishScript, /Invoke-RealPlatformGate/);
  assert.match(publishScript, /PublicDownloadBaseUrl/);
  assert.match(publishScript, /staging/);
});

test("adapter promotion gate cannot skip real platform tests", async () => {
  const publishScript = await readFile(
    path.join(desktopRoot, "scripts", "publish-adapter-bundle.ps1"),
    "utf8",
  );

  assert.doesNotMatch(publishScript, /\bSkipRealTest\b/);
});

test("desktop check includes the Jianshu hot-update adapter", async () => {
  const packageJson = JSON.parse(await readFile(path.join(desktopRoot, "package.json"), "utf8"));

  assert.match(packageJson.scripts.check, /node --check src\/adapters\/jianshu\.mjs/);
});

test("adapter publishing defaults to the verified HTTPS origin", async () => {
  const publishScript = await readFile(
    path.join(desktopRoot, "scripts", "publish-adapter-bundle.ps1"),
    "utf8",
  );

  assert.match(publishScript, /\[string\]\$ApiBaseUrl\s*=\s*"https:\/\/zhixin\.example\.com"/);
  assert.match(publishScript, /\[string\]\$PublicDownloadBaseUrl\s*=\s*"https:\/\/zhixin\.example\.com"/);
  assert.doesNotMatch(publishScript, /http:\/\/192\.0\.2\.20/);
});

test("adapter publishing secures every remote call with the deployment identity", async () => {
  const publishScript = await readFile(
    path.join(desktopRoot, "scripts", "publish-adapter-bundle.ps1"),
    "utf8",
  );

  assert.match(
    publishScript,
    /\[string\]\$IdentityFile\s*=\s*"\$env:USERPROFILE\\\.ssh\\zhixin_deploy_ed25519"/,
  );
  assert.match(publishScript, /\$sshOptions\s*=\s*@\(.*"-i"\s*,\s*\$IdentityFile/s);
  assert.match(publishScript, /\$sshOptions\s*=\s*@\(.*"IdentitiesOnly=yes"/s);
  assert.match(publishScript, /\$sshOptions\s*=\s*@\(.*"BatchMode=yes"/s);

  const remoteCalls = publishScript.match(/Invoke-Checked "(?:ssh|scp)"/g) ?? [];
  const securedRemoteCalls = publishScript.match(
    /Invoke-Checked "(?:ssh|scp)" @\(\$sshOptions \+ /g,
  ) ?? [];
  assert.ok(remoteCalls.length > 0);
  assert.equal(securedRemoteCalls.length, remoteCalls.length);
});

test("adapter publishing validates remote inputs before build or SSH", async () => {
  const publishScript = await readFile(
    path.join(desktopRoot, "scripts", "publish-adapter-bundle.ps1"),
    "utf8",
  );
  const validInputs = {
    version: "2026.07.31_release-1",
    platforms: "penguin",
    remoteRoot: "/opt/zhixin-ai/adapter_bundles-1",
    server: "deploy-user@publish.example.com",
  };
  const accepted = invokePublishInputValidator(publishScript, validInputs);
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);

  const marker = "SENSITIVE_SSH_INJECTION_MARKER";
  const rejectedInputs = [
    ["Platforms", { ...validInputs, platforms: "other,penguin" }],
    ["Platforms", { ...validInputs, platforms: "--init-key" }],
    ["Version", { ...validInputs, version: `release';Write-Output ${marker};#` }],
    ["Version", { ...validInputs, version: "--init-key" }],
    ["RemoteRoot", { ...validInputs, remoteRoot: `/opt/releases/../${marker}` }],
    ["RemoteRoot", { ...validInputs, remoteRoot: `/opt/releases '${marker}` }],
    ["Server", { ...validInputs, server: `-oProxyCommand=${marker}` }],
    ["Server", { ...validInputs, server: `deploy@host';${marker}` }],
  ];
  for (const [field, values] of rejectedInputs) {
    const rejected = invokePublishInputValidator(publishScript, values);
    const output = `${rejected.stdout}${rejected.stderr}`;
    assert.notEqual(rejected.status, 0, `${field} injection was accepted`);
    assert.match(output, new RegExp(`Invalid ${field} value`));
    assert.doesNotMatch(output, new RegExp(marker));
  }

  assert.match(publishScript, /\$Platforms\s*=\s*\$Platforms\.Trim\(\)/);
  const validationIndex = publishScript.indexOf("Assert-PublishInputs -Version");
  const buildIndex = publishScript.indexOf("if (-not $SkipBuild)");
  const sshIndex = publishScript.indexOf('Invoke-Checked "ssh"');
  assert.ok(validationIndex >= 0 && validationIndex < buildIndex && validationIndex < sshIndex);
});

test("adapter gate failures do not log command secrets or article content", async () => {
  const publishScript = await readFile(
    path.join(desktopRoot, "scripts", "publish-adapter-bundle.ps1"),
    "utf8",
  );
  const sensitiveMarker = "SENSITIVE_TOKEN_COOKIE_ARTICLE_BODY";
  const rejected = invokeRealGateValidator(publishScript, {
    result: {
      status: "completed",
      command: {
        status: "failed",
        errorMessage: sensitiveMarker,
      },
    },
    expectedVersion: "202607300001",
    platform: "penguin",
  });

  assert.notEqual(rejected.status, 0);
  assert.doesNotMatch(`${rejected.stdout}${rejected.stderr}`, new RegExp(sensitiveMarker));

  const untrustedFields = [
    { status: sensitiveMarker, result: {} },
    {
      status: "succeeded",
      result: { adapterBundleVersion: sensitiveMarker },
    },
    {
      status: "succeeded",
      result: {
        adapterBundleVersion: "202607300001",
        platformStatus: sensitiveMarker,
      },
    },
  ];
  for (const command of untrustedFields) {
    const fieldRejected = invokeRealGateValidator(publishScript, {
      result: { status: "completed", command },
      expectedVersion: "202607300001",
      platform: "penguin",
    });
    assert.notEqual(fieldRejected.status, 0);
    assert.doesNotMatch(
      `${fieldRejected.stdout}${fieldRejected.stderr}`,
      new RegExp(sensitiveMarker),
    );
  }
});

test("malformed gate JSON is rejected without logging its contents", async () => {
  const publishScript = await readFile(
    path.join(desktopRoot, "scripts", "publish-adapter-bundle.ps1"),
    "utf8",
  );
  const sensitiveMarker = "SENSITIVE_MALFORMED_JSON_TOKEN";
  const rejected = invokeRealGateValidator(publishScript, {
    jsonText: `{"token":"${sensitiveMarker}",`,
    expectedVersion: "202607300001",
    platform: "penguin",
  });
  const output = `${rejected.stdout}${rejected.stderr}`;

  assert.notEqual(rejected.status, 0);
  assert.match(output, /Real platform gate returned invalid JSON/);
  assert.doesNotMatch(output, new RegExp(sensitiveMarker));
});

test("agent stderr is captured and replaced with a fixed gate error", async () => {
  const publishScript = await readFile(
    path.join(desktopRoot, "scripts", "publish-adapter-bundle.ps1"),
    "utf8",
  );
  const sensitiveMarker = "SENSITIVE_AGENT_STDERR_TOKEN_COOKIE_BODY";
  const rejected = invokeAgentFailureGuard(publishScript, sensitiveMarker);
  const output = `${rejected.stdout}${rejected.stderr}`;

  assert.notEqual(rejected.status, 0);
  assert.match(output, /Real platform gate failed\. Staged bundle was not promoted/);
  assert.doesNotMatch(output, new RegExp(sensitiveMarker));
});

test("native command stderr is captured and replaced with a fixed error", async () => {
  const publishScript = await readFile(
    path.join(desktopRoot, "scripts", "publish-adapter-bundle.ps1"),
    "utf8",
  );
  const sensitiveMarker = "SENSITIVE_NATIVE_STDERR_TOKEN_COOKIE_BODY";
  const rejected = invokeCheckedFailureGuard(publishScript, sensitiveMarker);
  const output = `${rejected.stdout}${rejected.stderr}`;

  assert.notEqual(rejected.status, 0);
  assert.match(output, /Command failed: powershell/);
  assert.doesNotMatch(output, new RegExp(sensitiveMarker));
});

test("generic promotion gate rejects fallback states and unsafe public URLs", async () => {
  const publishScript = await readFile(
    path.join(desktopRoot, "scripts", "publish-adapter-bundle.ps1"),
    "utf8",
  );
  const expectedVersion = "202607300001";
  const resultWith = (result) => ({
    status: "completed",
    command: {
      status: "succeeded",
      result: { adapterBundleVersion: expectedVersion, ...result },
    },
  });

  const acceptedResults = [
    resultWith({ platformStatus: "reviewing" }),
    resultWith({ platformStatus: "submitted_for_review" }),
    resultWith({ platformStatus: "pending_public_visibility" }),
    resultWith({ reviewStatus: "review_pending" }),
    resultWith({ platformStatus: "published", publishedUrl: "https://news.example.com/articles/123" }),
    resultWith({ platformStatus: "published", publishedUrl: "https://news.example.com./articles/123" }),
  ];
  for (const result of acceptedResults) {
    const accepted = invokeRealGateValidator(publishScript, {
      result,
      expectedVersion,
      platform: "other-platform",
    });
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
  }

  const rejectedResults = [
    ["fallback status with invalid-domain URL", resultWith({
      platformStatus: "api_publish_fallback",
      publishedUrl: "https://example.invalid/fallback",
    })],
    ["obvious fallback status with valid URL", resultWith({
      reviewStatus: "dom_fallback",
      publicUrl: "https://news.example.com/articles/123",
    })],
    ["non-URL string", resultWith({ publishedUrl: "published" })],
    ["reserved invalid domain", resultWith({ publicUrl: "https://example.invalid/article" })],
    ["localhost URL", resultWith({ backlinkUrl: "http://localhost/article" })],
    ["localhost URL with trailing dot", resultWith({ backlinkUrl: "http://localhost./article" })],
    ["IP URL", resultWith({ backlinkUrl: "http://127.0.0.1/article" })],
    ["URL with userinfo", resultWith({ publishedUrl: "https://user:pass@news.example.com/article" })],
    ["published without URL", resultWith({ platformStatus: "published" })],
    ["valid URL without closed status", resultWith({ publishedUrl: "https://news.example.com/article" })],
    ["reviewing with malformed URL", resultWith({
      platformStatus: "reviewing",
      publishedUrl: "not-a-url",
    })],
    ["one valid and one invalid URL", resultWith({
      platformStatus: "published",
      publishedUrl: "https://news.example.com/article",
      publicUrl: "https://example.invalid/article",
    })],
  ];
  for (const [scenario, result] of rejectedResults) {
    const rejected = invokeRealGateValidator(publishScript, {
      result,
      expectedVersion,
      platform: "other-platform",
    });
    assert.notEqual(rejected.status, 0, `${scenario} was accepted`);
  }
});

test("adapter promotion gate requires a fully verified and deleted Jianshu API test article", async () => {
  const publishScript = await readFile(
    path.join(desktopRoot, "scripts", "publish-adapter-bundle.ps1"),
    "utf8",
  );
  const expectedVersion = "20260803-jianshu-api-gate-1";
  const noteId = "141684195";
  const slug = "3d628c37f59b";
  const validResult = {
    status: "completed",
    command: {
      status: "succeeded",
      result: {
        adapterBundleVersion: expectedVersion,
        platformStatus: "published",
        publishedUrl: `https://www.jianshu.com/p/${slug}`,
        transport: "api",
        publicVerified: true,
        externalIds: { noteId, slug },
        publicationEvidence: {
          source: "api",
          accepted: true,
          public: {
            endpoint: `https://www.jianshu.com/shakespeare/v2/notes/${slug}`,
            noteId: Number(noteId),
            slug,
            titleMatched: true,
            bodyMatched: true,
            shared: true,
            imageCount: 1,
          },
        },
        imagePublicationEvidence: {
          status: "verified",
          expectedCount: 1,
          public: { status: "verified", verifiedCount: 1 },
        },
        testCleanup: { deleted: true, noteId },
      },
    },
  };

  const accepted = invokeRealGateValidator(publishScript, {
    result: validResult,
    expectedVersion,
    platform: "jianshu",
  });
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);

  const invalidMutations = [
    ["DOM transport", (payload) => { payload.transport = "dom"; }],
    ["unverified public article", (payload) => { payload.publicVerified = false; }],
    ["unverified title", (payload) => { payload.publicationEvidence.public.titleMatched = false; }],
    ["unverified body", (payload) => { payload.publicationEvidence.public.bodyMatched = false; }],
    ["unshared note", (payload) => { payload.publicationEvidence.public.shared = false; }],
    ["missing public image", (payload) => { payload.imagePublicationEvidence.public.verifiedCount = 0; }],
    ["missing image expectation", (payload) => { payload.imagePublicationEvidence.expectedCount = 0; }],
    ["cleanup failure", (payload) => { payload.testCleanup.deleted = false; }],
    ["inconsistent cleanup note", (payload) => { payload.testCleanup.noteId = "141684196"; }],
    ["inconsistent public slug", (payload) => { payload.publicationEvidence.public.slug = "wrong-slug"; }],
    ["review-only status", (payload) => { payload.platformStatus = "reviewing"; }],
  ];
  for (const [scenario, mutate] of invalidMutations) {
    const rejectedResult = structuredClone(validResult);
    mutate(rejectedResult.command.result);
    const rejected = invokeRealGateValidator(publishScript, {
      result: rejectedResult,
      expectedVersion,
      platform: "jianshu",
    });
    assert.notEqual(rejected.status, 0, `${scenario} was accepted`);
  }
});

test("adapter promotion gate requires a fully verified and deleted CSDN signed-gateway test article", async () => {
  const publishScript = await readFile(
    path.join(desktopRoot, "scripts", "publish-adapter-bundle.ps1"),
    "utf8",
  );
  const expectedVersion = "20260803-csdn-api-gate-4";
  const articleId = "163500001";
  const username = "zhixin_ai";
  const publishedUrl = `https://blog.csdn.net/${username}/article/details/${articleId}`;
  const validResult = {
    status: "completed",
    command: {
      status: "succeeded",
      result: {
        adapterBundleVersion: expectedVersion,
        platformStatus: "published",
        publishedUrl,
        publiclyVisible: true,
        externalIds: { articleId, username },
        publicationEvidence: {
          source: "api",
          transport: "csdn_signed_gateway",
          accepted: true,
          steps: [
            { stage: "account", endpoint: "https://bizapi.csdn.net/blog-console-api/v1/user/info", username },
            { stage: "draft", endpoint: "https://bizapi.csdn.net/blog-console-api/v3/mdeditor/saveArticle", articleId, status: 2 },
            { stage: "publish", endpoint: "https://bizapi.csdn.net/blog-console-api/v3/mdeditor/saveArticle", articleId },
            { stage: "article_readback", endpoint: "https://bizapi.csdn.net/blog-console-api/v3/editor/getArticle", articleId, status: 1 },
            { stage: "article_list", endpoint: "https://bizapi.csdn.net/blog/phoenix/console/v1/article/list", articleId, status: 1 },
            { stage: "public_page", endpoint: publishedUrl, articleId, title: "CSDN gate article" },
          ],
        },
        imagePublicationEvidence: {
          status: "verified",
          expectedCount: 1,
          upload: { status: "verified", verifiedCount: 1 },
          draft: { status: "verified", verifiedCount: 1 },
          public: { status: "verified", verifiedCount: 1 },
        },
        coverImageEvidence: {
          status: "verified",
          platformImageUrl: "https://i-blog.csdnimg.cn/direct/csdn-gate-cover.png",
          draftImages: ["https://i-blog.csdnimg.cn/direct/csdn-gate-cover.png"],
          listImages: ["https://i-blog.csdnimg.cn/direct/csdn-gate-cover.png"],
        },
        testCleanup: {
          deleted: true,
          articleId,
          softDeleted: true,
          permanentlyDeleted: true,
          listVerified: true,
        },
      },
    },
  };

  const accepted = invokeRealGateValidator(publishScript, {
    result: validResult,
    expectedVersion,
    platform: "csdn",
  });
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);

  const invalidMutations = [
    ["review-only status", (payload) => { payload.platformStatus = "reviewing"; }],
    ["unsigned transport", (payload) => { payload.publicationEvidence.transport = "page_request"; }],
    ["inconsistent username", (payload) => { payload.externalIds.username = "other_user"; }],
    ["inconsistent article ID", (payload) => { payload.testCleanup.articleId = "163500002"; }],
    ["missing public image", (payload) => { payload.imagePublicationEvidence.public.verifiedCount = 0; }],
    ["missing image expectation", (payload) => { payload.imagePublicationEvidence.expectedCount = 0; }],
    ["unverified cover", (payload) => { payload.coverImageEvidence.status = "draft_verified"; }],
    ["cleanup failure", (payload) => { payload.testCleanup.deleted = false; }],
    ["unsafe public host", (payload) => { payload.publishedUrl = `https://example.com/${articleId}`; }],
  ];
  for (const [scenario, mutate] of invalidMutations) {
    const rejectedResult = structuredClone(validResult);
    mutate(rejectedResult.command.result);
    const rejected = invokeRealGateValidator(publishScript, {
      result: rejectedResult,
      expectedVersion,
      platform: "csdn",
    });
    assert.notEqual(rejected.status, 0, `${scenario} was accepted`);
  }
});

test("adapter promotion gate requires Baijiahao public writeback before promotion", async () => {
  const publishScript = await readFile(
    path.join(desktopRoot, "scripts", "publish-adapter-bundle.ps1"),
    "utf8",
  );
  const expectedVersion = "20260806-baijiahao-api-gate-1";
  const articleId = "1869855536696580221";
  const mediaOrderId = "media-order-baijiahao-api-gate";
  const publishedUrl = `https://baijiahao.baidu.com/s?id=${articleId}`;
  const validResult = {
    status: "completed",
    command: {
      status: "succeeded",
      result: {
        adapterBundleVersion: expectedVersion,
        mediaOrderId,
        title: "Baijiahao API gate article",
        platformStatus: "published",
        reviewStatus: "public",
        publiclyVisible: true,
        publishedUrl,
        externalIds: { articleId },
        publicationEvidence: {
          source: "api",
          accepted: true,
          stages: [
            { stage: "draft_create", httpStatus: 200 },
            { stage: "draft_update", httpStatus: 200 },
            { stage: "publish", httpStatus: 200 },
          ],
        },
        draftEvidence: {
          found: true,
          articleId,
          title: "Baijiahao API gate article",
          coverImageCount: 1,
        },
        coverImageEvidence: {
          status: "verified",
          platformImageUrl: "https://baijiahao.baidu.com/bjh/picproxy?param=gate-cover",
        },
        publicEvidence: {
          found: true,
          titleMatched: true,
          bodyMatched: true,
          publicImageFound: true,
          publicUrl: publishedUrl,
        },
        testCleanup: { withdrawn: true, removed: true, articleId },
      },
    },
    mediaOrder: {
      id: mediaOrderId,
      status: "succeeded",
      platformStatus: "published",
      reviewStatus: "public",
      backlinkStatus: "published",
      backlinkUrl: publishedUrl,
    },
  };

  const accepted = invokeRealGateValidator(publishScript, {
    result: validResult,
    expectedVersion,
    platform: "baijiahao",
  });
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);

  const rejectedResult = structuredClone(validResult);
  rejectedResult.mediaOrder = {
    ...rejectedResult.mediaOrder,
    status: "review_required",
    backlinkStatus: "reviewing",
    backlinkUrl: "",
  };
  const rejected = invokeRealGateValidator(publishScript, {
    result: rejectedResult,
    expectedVersion,
    platform: "baijiahao",
  });
  assert.notEqual(rejected.status, 0, "missing Baijiahao writeback was accepted");
});

test("adapter promotion gate requires direct Penguin API acceptance evidence", async () => {
  const publishScript = await readFile(
    path.join(desktopRoot, "scripts", "publish-adapter-bundle.ps1"),
    "utf8",
  );
  const expectedVersion = "20260805-penguin-strict-api-gate-1";
  const articleId = "20260805A0CBE3";
  const mediaOrderId = "media-order-20260805A0CBE3";
  const publicUrl = "https://page.om.qq.com/page/20260805A0CBE3";
  const title = "企鹅号严格门禁测试文章";
  const body = "这是一篇用于验证草稿、图片、公开页、回写和删除闭环的测试文章。";
  const validPenguinResult = {
    status: "completed",
    command: {
      status: "succeeded",
      result: {
        adapterBundleVersion: expectedVersion,
        platformStatus: "published",
        reviewStatus: "public",
        publiclyVisible: true,
        publicVerified: true,
        publishedUrl: publicUrl,
        backlinkUrl: publicUrl,
        mediaOrderId,
        title,
        contentMarkdown: body,
        publicationEvidence: {
          source: "api",
          accepted: true,
          endpoint: "https://om.qq.com/marticlepublish/omPublish",
          public: {
            endpoint: publicUrl,
            titleMatched: true,
            bodyMatched: true,
            imageCount: 1,
            writebackUrl: publicUrl,
          },
          response: {
            response: { code: 0, data: { articleId } },
          },
        },
        imagePublicationEvidence: {
          status: "verified",
          expectedCount: 1,
          upload: { status: "verified", verifiedCount: 1 },
          draft: { status: "verified", verifiedCount: 1 },
          public: { status: "verified", verifiedCount: 1 },
        },
        testCleanup: {
          deleted: true,
          articleId,
          publicationEvidence: {
            request: { method: "POST", url: "https://om.qq.com/marticlepublish/deleteV2" },
            response: {
              status: 200,
              url: "https://om.qq.com/marticlepublish/deleteV2",
              payload: { response: { code: 0, msg: "success" }, data: { result: true } },
            },
          },
        },
        externalIds: { articleId },
      },
    },
    mediaOrder: {
      id: mediaOrderId,
      articleId: "article-penguin-strict-gate",
      status: "succeeded",
      platformStatus: "published",
      reviewStatus: "public",
      backlinkStatus: "published",
      backlinkUrl: publicUrl,
      imagePublicationEvidence: {
        status: "verified",
        expectedCount: 1,
        upload: { status: "verified", verifiedCount: 1 },
        draft: { status: "verified", verifiedCount: 1 },
        public: { status: "verified", verifiedCount: 1 },
      },
    },
  };
  const siblingDataPenguinResult = {
    ...validPenguinResult,
    command: {
      ...validPenguinResult.command,
      result: {
        ...validPenguinResult.command.result,
        publicationEvidence: {
          ...validPenguinResult.command.result.publicationEvidence,
          response: {
            response: { code: 0, msg: "success" },
            data: { articleId },
          },
        },
      },
    },
  };

  const acceptedResults = [
    validPenguinResult,
    siblingDataPenguinResult,
    {
      ...validPenguinResult,
      command: {
        ...validPenguinResult.command,
        result: {
          ...validPenguinResult.command.result,
          publicationEvidence: {
            ...validPenguinResult.command.result.publicationEvidence,
            response: { code: 0, data: { articleId } },
          },
        },
      },
    },
  ];

  for (const result of acceptedResults) {
    const accepted = invokeRealGateValidator(publishScript, {
      result,
      expectedVersion,
      platform: "penguin",
    });
    assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
  }

  const rejectedResults = [
    ["review-only status", {
      ...validPenguinResult,
      command: {
        ...validPenguinResult.command,
        result: { ...validPenguinResult.command.result, platformStatus: "submitted_for_review", publiclyVisible: false, publicVerified: false },
      },
    }],
    ["missing anonymous public verification", {
      ...validPenguinResult,
      command: {
        ...validPenguinResult.command,
        result: { ...validPenguinResult.command.result, publicVerified: false },
      },
    }],
    ["title mismatch", {
      ...validPenguinResult,
      command: {
        ...validPenguinResult.command,
        result: {
          ...validPenguinResult.command.result,
          publicationEvidence: { ...validPenguinResult.command.result.publicationEvidence, public: { ...validPenguinResult.command.result.publicationEvidence.public, titleMatched: false } },
        },
      },
    }],
    ["missing public image", {
      ...validPenguinResult,
      command: {
        ...validPenguinResult.command,
        result: {
          ...validPenguinResult.command.result,
          imagePublicationEvidence: { ...validPenguinResult.command.result.imagePublicationEvidence, public: { status: "missing", verifiedCount: 0 } },
        },
      },
    }],
    ["writeback order not succeeded", {
      ...validPenguinResult,
      mediaOrder: { ...validPenguinResult.mediaOrder, status: "review_required", backlinkStatus: "reviewing", backlinkUrl: "" },
    }],
    ["writeback backlink mismatch", {
      ...validPenguinResult,
      mediaOrder: { ...validPenguinResult.mediaOrder, backlinkUrl: "https://page.om.qq.com/page/other" },
    }],
    ["cleanup failure", {
      ...validPenguinResult,
      command: {
        ...validPenguinResult.command,
        result: {
          ...validPenguinResult.command.result,
          testCleanup: {
            deleted: false,
            articleId,
            publicationEvidence: {
              request: { method: "POST", url: "https://om.qq.com/marticlepublish/deleteV2" },
              response: { status: 200, url: "https://om.qq.com/marticlepublish/deleteV2", payload: { response: { code: 1 }, data: { result: false } } },
            },
          },
        },
      },
    }],
    ["cleanup article mismatch", {
      ...validPenguinResult,
      command: {
        ...validPenguinResult.command,
        result: { ...validPenguinResult.command.result, testCleanup: { ...validPenguinResult.command.result.testCleanup, articleId: "20260805OTHER" } },
      },
    }],
    ["forged closed status without API evidence", {
      ...validPenguinResult,
      command: {
        ...validPenguinResult.command,
        result: {
          adapterBundleVersion: expectedVersion,
          platformStatus: "published",
          publishedUrl: "https://example.invalid/forged",
        },
      },
    }],
    ["nonzero omPublish code", {
      ...validPenguinResult,
      command: {
        ...validPenguinResult.command,
        result: {
          ...validPenguinResult.command.result,
          publicationEvidence: {
            ...validPenguinResult.command.result.publicationEvidence,
            response: { response: { code: 1, data: { articleId } } },
          },
        },
      },
    }],
    ["string omPublish code", {
      ...validPenguinResult,
      command: {
        ...validPenguinResult.command,
        result: {
          ...validPenguinResult.command.result,
          publicationEvidence: {
            ...validPenguinResult.command.result.publicationEvidence,
            response: { response: { code: "0", data: { articleId } } },
          },
        },
      },
    }],
    ["non-omPublish endpoint", {
      ...validPenguinResult,
      command: {
        ...validPenguinResult.command,
        result: {
          ...validPenguinResult.command.result,
          publicationEvidence: {
            ...validPenguinResult.command.result.publicationEvidence,
            endpoint: "https://example.invalid/marticlepublish/omPublish",
          },
        },
      },
    }],
    ["omPublish endpoint with userinfo", {
      ...validPenguinResult,
      command: {
        ...validPenguinResult.command,
        result: {
          ...validPenguinResult.command.result,
          publicationEvidence: {
            ...validPenguinResult.command.result.publicationEvidence,
            endpoint: "https://user:secret@om.qq.com/marticlepublish/omPublish",
          },
        },
      },
    }],
    ["omPublish endpoint with query", {
      ...validPenguinResult,
      command: {
        ...validPenguinResult.command,
        result: {
          ...validPenguinResult.command.result,
          publicationEvidence: {
            ...validPenguinResult.command.result.publicationEvidence,
            endpoint: "https://om.qq.com/marticlepublish/omPublish?shadow=1",
          },
        },
      },
    }],
    ["omPublish endpoint with fragment", {
      ...validPenguinResult,
      command: {
        ...validPenguinResult.command,
        result: {
          ...validPenguinResult.command.result,
          publicationEvidence: {
            ...validPenguinResult.command.result.publicationEvidence,
            endpoint: "https://om.qq.com/marticlepublish/omPublish#shadow",
          },
        },
      },
    }],
    ["conflicting outer and nested omPublish codes", {
      ...validPenguinResult,
      command: {
        ...validPenguinResult.command,
        result: {
          ...validPenguinResult.command.result,
          publicationEvidence: {
            ...validPenguinResult.command.result.publicationEvidence,
            response: {
              code: 7,
              response: { code: 0, data: { articleId } },
            },
          },
        },
      },
    }],
    ["DOM fallback evidence", {
      ...validPenguinResult,
      command: {
        ...validPenguinResult.command,
        result: {
          ...validPenguinResult.command.result,
          publicationEvidence: {
            ...validPenguinResult.command.result.publicationEvidence,
            source: "api_publish_fallback",
          },
        },
      },
    }],
    ["unaccepted API evidence", {
      ...validPenguinResult,
      command: {
        ...validPenguinResult.command,
        result: {
          ...validPenguinResult.command.result,
          publicationEvidence: {
            ...validPenguinResult.command.result.publicationEvidence,
            accepted: false,
          },
        },
      },
    }],
    ["missing external articleId", {
      ...validPenguinResult,
      command: {
        ...validPenguinResult.command,
        result: {
          ...validPenguinResult.command.result,
          externalIds: {},
        },
      },
    }],
    ["mismatched response articleId", {
      ...validPenguinResult,
      command: {
        ...validPenguinResult.command,
        result: {
          ...validPenguinResult.command.result,
          externalIds: { articleId: "20260730DIFFERENT" },
        },
      },
    }],
    ["mismatched sibling response articleId", {
      ...siblingDataPenguinResult,
      command: {
        ...siblingDataPenguinResult.command,
        result: {
          ...siblingDataPenguinResult.command.result,
          externalIds: { articleId: "20260730DIFFERENT" },
        },
      },
    }],
    ["missing response articleId", {
      ...validPenguinResult,
      command: {
        ...validPenguinResult.command,
        result: {
          ...validPenguinResult.command.result,
          publicationEvidence: {
            ...validPenguinResult.command.result.publicationEvidence,
            response: { response: { code: 0 } },
          },
        },
      },
    }],
    ["conflicting sibling and nested response articleIds", {
      ...validPenguinResult,
      command: {
        ...validPenguinResult.command,
        result: {
          ...validPenguinResult.command.result,
          publicationEvidence: {
            ...validPenguinResult.command.result.publicationEvidence,
            response: {
              response: { code: 0, data: { articleId: "20260730CONFLICT" } },
              data: { articleId },
            },
          },
        },
      },
    }],
    ["unsafe external articleId", {
      ...validPenguinResult,
      command: {
        ...validPenguinResult.command,
        result: {
          ...validPenguinResult.command.result,
          publicationEvidence: {
            ...validPenguinResult.command.result.publicationEvidence,
            response: { response: { code: 0 } },
          },
          externalIds: { articleId: "not a safe id" },
        },
      },
    }],
  ];

  for (const [scenario, result] of rejectedResults) {
    const rejected = invokeRealGateValidator(publishScript, {
      result,
      expectedVersion,
      platform: "penguin",
    });
    assert.notEqual(
      rejected.status,
      0,
      `${scenario} was accepted\nstdout: ${rejected.stdout}\nstderr: ${rejected.stderr}`,
    );
  }

  const compatiblePlatform = invokeRealGateValidator(publishScript, {
    result: {
      status: "completed",
      command: {
        status: "succeeded",
        result: {
          adapterBundleVersion: expectedVersion,
          platformStatus: "published",
          publishedUrl: "https://news.example.com/article",
        },
      },
    },
    expectedVersion,
    platform: "other-platform",
  });
  assert.equal(compatiblePlatform.status, 0, compatiblePlatform.stderr || compatiblePlatform.stdout);
});
