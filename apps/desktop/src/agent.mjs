#!/usr/bin/env node

import {
  DEFAULT_API_BASE_URL,
  DEFAULT_STATE_PATH,
  authorizePlatform,
  bindOwner,
  cleanupProfiles,
  cleanupLocalAssets,
  fetchAssetCleanupKeepKeys,
  heartbeat,
  logLine,
  readLog,
  readStatus,
  registerDevice,
  runAuth,
  runOnce,
  watch
} from "./agent-core.mjs";

function parseArgs(argv) {
  const args = { _: [] };
  // Flags that name one item at a time are collected instead of overwritten, so
  // "--keep-profile-key a --keep-profile-key b" does not silently drop the first.
  const repeatable = new Set(["keep-profile-key"]);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item.startsWith("--")) {
      const [key, inlineValue] = item.slice(2).split("=");
      const next = argv[index + 1];
      let value;
      if (inlineValue !== undefined) value = inlineValue;
      else if (next && !next.startsWith("--")) {
        value = next;
        index += 1;
      } else value = true;
      if (!repeatable.has(key)) {
        args[key] = value;
        continue;
      }
      const collected = Array.isArray(args[key]) ? args[key] : args[key] === undefined ? [] : [args[key]];
      collected.push(value);
      args[key] = collected;
    } else {
      args._.push(item);
    }
  }
  return args;
}

function repeatableValues(value) {
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return list
    .flatMap((item) => String(item).split(","))
    .map((item) => item.trim())
    .filter(Boolean);
}

// A flag given without a value parses as true, which would become 1 through
// Number(). Leave it undefined so the caller falls back to its own default.
function optionalNumber(value) {
  return value === undefined || value === true ? undefined : Number(value);
}

function help() {
  return `
Zhixin AI Desktop Agent MVP

Commands:
  register                         Register this device with FastAPI
  bind-owner --binding-id ID --pairing-code CODE
                                   Bind this device to the signed-in member
  auth --session-id ID --pairing-code CODE
                                   Claim a media auth session, submit artifacts, and bind account
  authorize                        Create and complete a media auth session from desktop
  run-once                         Execute one queued desktop command
  watch                            Keep polling desktop commands
  heartbeat                        Send one heartbeat event
  cleanup-profiles                 Remove local browser profiles
  cleanup-assets                   Remove stale publication assets and unused browser profiles
  status                           Print local device state
  logs                             Print recent local agent logs

Options:
  --api URL                        FastAPI base URL, defaults to ${DEFAULT_API_BASE_URL}
  --state PATH                     State file path, defaults to ${DEFAULT_STATE_PATH}
  --platform zhihu                 Platform adapter for auth/publish
  --account-name NAME              Account name returned to API
  --wait-login-ms 300000           Max time to wait for manual login in the browser auth environment
  --keep-browser-open              Keep the auth browser window open after capture
  --allow-foreground               Allow a queued desktop command to focus its browser window
  --adapter-bundle-manifest URL    Install a staged adapter bundle before executing the command
  --headless                       Force headless browser execution for this CLI run
  --interval-ms 5000               Watch interval
  --open-browser                   Open login URL in system browser during auth
  --once                           Watch one polling cycle and exit

Cleanup options:
  --dry-run                        Report what would be removed without removing it
  --assets-keep N                  Newest publication asset directories to keep, defaults to 50
  --assets-max-age-days N          Age in days before an asset directory may be removed, defaults to 7
  --profiles-max-age-days N        Age in days before an unused profile may be removed, defaults to 14
  --keep-profile-key KEY           Protect this profile key, repeatable or comma separated
  --all-profiles                   Ignore the keep list and age for profiles, locks still win
`.trim();
}

function print(payload) {
  console.log(typeof payload === "string" ? payload : JSON.stringify(payload, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "help";
  const options = {
    apiBaseUrl: args.api || DEFAULT_API_BASE_URL,
    statePath: args.state || DEFAULT_STATE_PATH,
    deviceName: args["device-name"],
    bindingId: args["binding-id"],
    sessionId: args["session-id"],
    pairingCode: args["pairing-code"],
    accountName: args["account-name"],
    mediaAccountId: args["media-account-id"],
    platform: args.platform,
    openBrowser: Boolean(args["open-browser"]),
    waitLoginMs: Number(args["wait-login-ms"] || 300000),
    keepBrowserOpen: Boolean(args["keep-browser-open"]),
    headless: args.headless === undefined ? undefined : Boolean(args.headless),
    allowForeground: Boolean(args["allow-foreground"]),
    adapterBundleManifestUrl: args["adapter-bundle-manifest"] || process.env.ZHIXIN_ADAPTER_BUNDLE_MANIFEST_URL,
    intervalMs: Number(args["interval-ms"] || 5000),
    once: Boolean(args.once),
    all: Boolean(args.all),
    allProfiles: Boolean(args["all-profiles"]),
    dryRun: Boolean(args["dry-run"]),
    silent: false
  };

  if (command === "help" || args.help) return print(help());
  if (command === "register") return print(await registerDevice(options));
  if (command === "bind-owner") return print(await bindOwner(options));
  if (command === "auth") return print(await runAuth(options));
  if (command === "authorize") return print(await authorizePlatform(options));
  if (command === "run-once") return print(await runOnce(options));
  if (command === "watch") {
    if (options.once) return print(await runOnce(options));
    console.log(`Watching desktop commands every ${options.intervalMs}ms. Press Ctrl+C to stop.`);
    return watch(options);
  }
  if (command === "heartbeat") return print(await heartbeat(options));
  if (command === "cleanup-profiles") return print(await cleanupProfiles(options));
  if (command === "cleanup-assets") {
    const requestedKeys = repeatableValues(args["keep-profile-key"]);
    let keepProfileKeys = requestedKeys;
    if (!requestedKeys.length && !options.allProfiles) {
      // An explicit --all-profiles ignores the keep set, so asking the server
      // for one would make a run that never needed it fail against a down API.
      keepProfileKeys = await fetchAssetCleanupKeepKeys(options).catch(async (error) => {
        // Without a keep list the profile half stands down, so record why
        // instead of leaving an empty list to explain itself.
        await logLine({ statePath: options.statePath }, "assets.cleanup_keep_keys_unavailable", {
          error: error instanceof Error ? error.message : String(error)
        }).catch(() => undefined);
        return [];
      });
    }
    return print(await cleanupLocalAssets({
      ...options,
      keepProfileKeys,
      assetsKeep: optionalNumber(args["assets-keep"]),
      assetsMaxAgeDays: optionalNumber(args["assets-max-age-days"]),
      profilesMaxAgeDays: optionalNumber(args["profiles-max-age-days"])
    }));
  }
  if (command === "status") return print(await readStatus(options));
  if (command === "logs") return print(await readLog(options));
  throw new Error(`UNKNOWN_COMMAND: ${command}`);
}

main().catch(async (error) => {
  const args = parseArgs(process.argv.slice(2));
  await logLine(
    { statePath: args.state || DEFAULT_STATE_PATH },
    "agent.error",
    { command: args._[0] || "help", error: error instanceof Error ? error.message : String(error) }
  ).catch(() => undefined);
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
