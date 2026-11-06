import { DouyinAdapter } from "./douyin.mjs";
import { MediaPlatformAdapter } from "./base.mjs";
import { BaijiahaoAdapter } from "./baijiahao.mjs";
import { CsdnAdapter } from "./csdn.mjs";
import { JianshuAdapter } from "./jianshu.mjs";
import { NeteasePublishAdapter } from "./netease.mjs";
import { PenguinAdapter } from "./penguin.mjs";
import { SohuAdapter } from "./sohu.mjs";
import { ToutiaoAdapter } from "./toutiao.mjs";
import { ZhihuAdapter } from "./zhihu.mjs";
import { loadVerifiedHotAdapter, rollbackAdapterBundle } from "../adapter-update-manager.mjs";

const adapterExports = {
  douyin: "DouyinAdapter",
  zhihu: "ZhihuAdapter",
  baijiahao: "BaijiahaoAdapter",
  sohu: "SohuAdapter",
  csdn: "CsdnAdapter",
  netease: "NeteasePublishAdapter",
  penguin: "PenguinAdapter",
  toutiao: "ToutiaoAdapter",
  jianshu: "JianshuAdapter",
};

export const adapters = {
  douyin: new DouyinAdapter(),
  zhihu: new ZhihuAdapter(),
  baijiahao: new BaijiahaoAdapter(),
  sohu: new SohuAdapter(),
  csdn: new CsdnAdapter(),
  netease: new NeteasePublishAdapter(),
  penguin: new PenguinAdapter(),
  toutiao: new ToutiaoAdapter(),
  jianshu: new JianshuAdapter(),
  wechat: new MediaPlatformAdapter(
    "wechat",
    "https://mp.weixin.qq.com/",
    ["title", "cover", "content", "summary"],
    "WeChat Official Account"
  )
};

export function getBundledAdapter(platform) {
  const platformKey = String(platform || "").trim().toLowerCase();
  const adapter = adapters[platformKey];
  if (adapter) return adapter;

  const error = new Error(`Platform adapter '${platformKey || "unknown"}' is not implemented.`);
  error.code = "PLATFORM_ADAPTER_NOT_IMPLEMENTED";
  error.platform = platformKey;
  throw error;
}

function hasHotAdapterOptions(options = {}) {
  return Boolean(options?.statePath || options?.stateDir);
}

function instantiateHotAdapter(platformKey, module) {
  const Exported = module?.[adapterExports[platformKey]]
    || module?.default
    || Object.values(module || {}).find((value) => typeof value === "function" && /Adapter$/.test(value.name || ""));
  if (typeof Exported !== "function") throw new Error(`HOT_ADAPTER_EXPORT_MISSING: ${platformKey}`);
  return new Exported();
}

async function resolveHotAdapter(platformKey, options = {}) {
  const bundled = getBundledAdapter(platformKey);
  let loaded = null;
  try {
    loaded = await loadVerifiedHotAdapter({
      platform: platformKey,
      stateDir: options.stateDir,
      statePath: options.statePath,
      publicKeyPem: options.publicKeyPem,
    });
    if (!loaded) return bundled;
    const adapter = instantiateHotAdapter(platformKey, loaded.module);
    adapter.adapterBundleVersion = loaded.bundleVersion;
    return adapter;
  } catch (error) {
    await rollbackAdapterBundle({
      stateDir: options.stateDir,
      statePath: options.statePath,
      expectedBundleVersion: loaded?.bundleVersion,
      reason: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    if (typeof options.onHotAdapterError === "function") await options.onHotAdapterError(error).catch(() => undefined);
    return bundled;
  }
}

export async function resolveAdapter(platform, options = {}) {
  const platformKey = String(platform || "").trim().toLowerCase();
  getBundledAdapter(platformKey);
  return resolveHotAdapter(platformKey, options);
}

export function getAdapter(platform, options = {}) {
  if (hasHotAdapterOptions(options)) return resolveAdapter(platform, options);
  return getBundledAdapter(platform);
}
