import type { VideoPreparationEvidence } from "@zengxing/core";

export const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
export const MAX_COVER_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_CAPTION_CODE_POINTS = 1000;
export const MAX_VIDEO_TITLE_CODE_POINTS = 30;
export const limitVideoTitle = (value: string) => Array.from(value).slice(0, MAX_VIDEO_TITLE_CODE_POINTS).join("");
export const captionCodePointCount = (value: string) => Array.from(value).length;
export const limitVideoCaption = (value: string) => Array.from(value).slice(0, MAX_VIDEO_CAPTION_CODE_POINTS).join("");

type PublicationState = { stage?: string; status?: string; platformStatus?: string; publicUrl?: string; submittedAt?: string; itemId?: string };

export function validateVideoFile(file: {name: string; size: number; type: string}) {
  if (!file.size) return "不能上传空文件。";
  if (file.size > MAX_VIDEO_BYTES) return "视频不能超过 500 MiB。";
  if (!/\.mp4$/i.test(file.name) || (file.type && file.type !== "video/mp4")) return "请选择 MP4 视频，文件内容会在上传后校验。";
  return "";
}

export function videoPublicationState(publication: PublicationState) {
  const platform = publication.platformStatus || "";
  if (["submission_unknown", "manual_verification_required", "submitted_for_review"].includes(platform)) return platform;
  return platform || publication.status || "unknown";
}

const labels: Record<string, string> = {
  queued: "等待桌面端", pending: "等待桌面端", running: "发布中", downloading: "下载视频中",
  ai_cover: "正在生成并应用AI封面", topics: "正在关联抖音话题", chapters: "正在生成视频章节", chapters_confirming: "正在确认视频章节",
  uploading: "上传抖音中", submitting: "正在提交", submitted_for_review: "已提交，等待审核",
  scheduled: "已定时，等待计划时间", published: "已公开", manual_verification_required: "需要人工验证", submission_unknown: "提交结果待确认",
  failed: "失败", canceled: "已取消", rejected: "审核未通过", review_required: "等待审核确认"
};
export function videoPublicationLabel(publication: PublicationState) {
  const state = videoPublicationState(publication);
  if (state === "running" && ["downloading", "uploading", "ai_cover", "topics", "chapters", "chapters_confirming"].includes(publication.stage || "")) return labels[publication.stage!];
  return labels[state] || "待确认";
}
export function canDiscoverVideo(publication: PublicationState) {
  return ["scheduled", "submitted_for_review", "submission_unknown", "review_required", "unknown", "succeeded", "manual_verification_required"].includes(videoPublicationState(publication));
}
export function publicVideoUrl(publication: PublicationState) {
  if (videoPublicationState(publication) !== "published") return "";
  try {
    const url = new URL(publication.publicUrl || "");
    return url.protocol === "https:" && url.hostname === "www.douyin.com" && /^\/video\/\d+\/?$/.test(url.pathname) ? url.href : "";
  } catch { return ""; }
}

const errorLabels: Record<string, string> = {
  VIDEO_TITLE_INVALID: "作品标题最多 30 字，也可以留空。",
  VIDEO_PUBLISH_MODE_INVALID: "请选择立即发布或定时发布。",
  VIDEO_SCHEDULE_INVALID: "请选择有效的北京时间，精确到分钟。",
  VIDEO_SCHEDULE_OUT_OF_RANGE: "定时发布须在当前时间 2 小时后至 14 天内。",
  VIDEO_SCHEDULE_UNEXPECTED: "立即发布无需计划时间，请重新选择发布方式。",
  DESKTOP_VIDEO_SCHEDULE_UPGRADE_REQUIRED: "绑定的桌面端尚不支持定时发布，请更新客户端后刷新。",
  DESKTOP_VIDEO_UPGRADE_REQUIRED: "绑定的桌面端尚不支持视频发布，请升级后刷新。",
  VIDEO_VALIDATOR_UNAVAILABLE: "视频校验服务尚未就绪，请联系管理员。",
  VIDEO_PRIVATE_STORAGE_MISCONFIGURED: "视频存储尚未配置完成，请联系管理员。",
  VIDEO_FILE_TOO_LARGE: "文件超过上传上限：视频 500 MiB，封面 10 MiB。",
  VIDEO_INVALID_MEDIA: "文件无法完整解码或编码不受支持，请重新导出 MP4（H.264 视频、AAC 音频）后上传。",
  VIDEO_FILE_TYPE_UNSUPPORTED: "请选择 MP4 视频或 PNG/JPG 封面。",
  VIDEO_EMPTY_FILE: "不能上传空文件。",
  VIDEO_CAPTION_OR_INTENT_INVALID: "请填写 1 至 1000 字的作品文案后提交。",
  VIDEO_IDEMPOTENCY_CONFLICT: "该提交编号已用于另一条任务，请先检查发布记录。",
  VIDEO_ALREADY_HAS_PUBLICATION: "这条视频在所选账号已有发布任务，请先检查发布记录。",
  VIDEO_ITEM_ID_UNCONFIRMED: "尚未获得作品编号，请在抖音创作中心核实是否已发布，勿重复提交。",
  VIDEO_UPLOAD_PROXY_UNAVAILABLE: "视频上传连接中断，请检查服务连接后重新上传。",
  VIDEO_RETRY_NOT_SAFE: "这条作品可能已经提交，请先回查状态，不能重新投稿。",
  VIDEOASSETS_NOT_FOUND: "视频素材不存在或当前账号无权访问，请重新上传。",
  VIDEO_RECORD_NOT_FOUND: "视频或发布记录不存在，或当前账号无权访问。",
  VIDEO_ASSET_REQUIRED: "请先上传并校验视频。",
  VIDEO_COVER_ASSET_REQUIRED: "请重新上传 PNG/JPG 封面。",
  VIDEO_PLATFORM_UNSUPPORTED: "请选择抖音账号发布视频。",
  VIDEO_EXECUTION_LOST: "桌面端执行中断，请先核实作品是否已提交。",
  DESKTOP_DEVICE_OWNER_MISMATCH: "账号绑定的桌面端与当前用户不匹配，请重新授权。",
  DOUYIN_ACCOUNT_ID_REQUIRED: "尚未读取到抖音账号身份，请在桌面端重新授权。",
  AUTHENTICATION_REQUIRED: "登录已失效，请重新登录智心AI。",
  VIDEO_DEVICE_CAPABILITY_REQUIRED: "绑定的桌面端尚不支持视频发布，请升级后重试。",
  VIDEO_DEVICE_OFFLINE: "绑定的桌面端不在线，请启动客户端并刷新。",
  DESKTOP_DEVICE_OFFLINE: "绑定的桌面端不在线，请启动客户端并刷新。",
  MEDIA_ACCOUNT_NOT_AUTHORIZED: "抖音账号需要重新授权，请前往媒体账号。",
  MEDIA_ACCOUNT_DEVICE_BINDING_REQUIRED: "账号未绑定桌面端，请先在桌面端授权抖音。",
  VIDEO_TOO_LARGE: "视频不能超过 500 MiB。",
  VIDEO_ASSET_TOO_LARGE: "视频不能超过 500 MiB。",
  VIDEO_PROBE_UNAVAILABLE: "视频校验服务尚未就绪，请联系管理员。"
};
export function videoErrorMessage(value: unknown) {
  let raw = value instanceof Error ? value.message : String(value || "请求失败");
  try { const parsed = JSON.parse(raw); raw = typeof parsed.detail === "string" ? parsed.detail : raw; } catch { /* plain response */ }
  return errorLabels[raw] || raw;
}

export function canRetryVideo(publication: PublicationState) {
  return videoPublicationState(publication) === "failed" && !publication.submittedAt && !publication.itemId;
}
export function videoCoverPayload(source: "ai" | "custom", coverAssetId?: string): {coverAssetId?: string} {
  if (source === "ai") return {};
  if (!coverAssetId) throw new Error("VIDEO_COVER_ASSET_REQUIRED");
  return {coverAssetId};
}
export function verifiedVideoPreparationLabels(evidence?: VideoPreparationEvidence) {
  const result: string[] = [];
  if (evidence?.topics?.verified === true && Array.isArray(evidence.topics.resolved) && evidence.topics.resolved.length > 0) result.push(`原生话题 ${evidence.topics.resolved.length} 个`);
  const count = evidence?.chapters?.count;
  if (evidence?.chapters?.verified === true && evidence.chapters.source === "platform_smart" && Number.isInteger(count) && (count || 0) > 0) result.push(`智能章节 ${count} 条`);
  if (evidence?.cover?.verified === true) {
    if (evidence.cover.source === "platform_ai") result.push("AI封面已应用");
    if (evidence.cover.source === "custom") result.push("自定义封面已应用");
  }
  return result;
}
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
function shanghaiMinute(timestamp: number) {
  return new Date(timestamp + SHANGHAI_OFFSET_MS).toISOString().slice(0, 16);
}
export function defaultVideoSchedule(now = Date.now()) {
  return shanghaiMinute(Math.ceil((now + 3 * HOUR_MS) / 60000) * 60000);
}
export function videoScheduleBounds(now = Date.now()) {
  return { min: shanghaiMinute(Math.ceil((now + 2 * HOUR_MS) / 60000) * 60000), max: shanghaiMinute(Math.floor((now + 14 * 24 * HOUR_MS) / 60000) * 60000) };
}
export function validateVideoSchedule(value: string, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return "请选择有效的北京时间，精确到分钟。";
  const timestamp = Date.parse(`${value}:00+08:00`);
  if (!Number.isFinite(timestamp) || shanghaiMinute(timestamp) !== value) return "请选择有效的北京时间。";
  if (timestamp - now < 2 * HOUR_MS || timestamp - now > 14 * 24 * HOUR_MS) return "定时发布须在当前时间 2 小时后至 14 天内。";
  return "";
}
export function scheduledVideoPayload(publishMode: "immediate" | "scheduled", value: string, now = Date.now()): {publishMode: "immediate" | "scheduled"; scheduledAt?: string} {
  if (publishMode === "immediate") return {publishMode};
  const error = validateVideoSchedule(value, now);
  if (error) throw new Error(error);
  // datetime-local has no zone. The displayed wall time is always Shanghai,
  // regardless of the browser's locale or operating-system timezone.
  return {publishMode, scheduledAt: `${value}:00+08:00`};
}
export function formatVideoSchedule(value?: string) {
  if (!value || !/(Z|[+-]\d{2}:\d{2})$/i.test(value)) return "";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? `${shanghaiMinute(timestamp).replace("T", " ")} 北京时间` : "";
}