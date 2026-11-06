import type { PublishedCenterRecord } from "@zengxing/core";

export const publicationGroups = [
  { id: "attention", label: "需处理", tone: "text-rose-600" },
  { id: "publishing", label: "发布中", tone: "text-blue-600" },
  { id: "review", label: "平台审核", tone: "text-amber-600" },
  { id: "public", label: "已公开", tone: "text-emerald-600" },
  { id: "unconfirmed", label: "待确认 / 其他", tone: "text-slate-500" },
] as const;
export type PublicationGroup = (typeof publicationGroups)[number]["id"];

export function publicationStatus(record: PublishedCenterRecord) {
  if (/manual_verification_required|manual_action_required|安全验证|验证码|滑块/i.test(`${record.platformStatus ?? ""} ${record.errorMessage ?? ""}`)) return "manual_verification_required";
  if (/needs_reauth|登录(?:状态)?已?失效|授权已?失效|需要重新授权/i.test(`${record.platformStatus ?? ""} ${record.errorMessage ?? ""}`)) return "needs_reauth";
  if (record.platformStatus === "published_restricted" || record.publicDiscoveryStatus === "restricted") return "published_restricted";
  return record.status;
}

export function publicationGroup(record: PublishedCenterRecord): PublicationGroup {
  const status = publicationStatus(record);
  if (["failed", "needs_reauth", "manual_verification_required", "published_restricted"].includes(status)) return "attention";
  if (status === "review_required" || record.backlinkStatus === "reviewing" || ["pending_review", "reviewing", "pending_public_visibility"].includes(record.reviewStatus ?? "")) return "review";
  if (["running", "pending", "queued"].includes(status)) return "publishing";
  const unresolvedDiscovery = record.publicDiscoveryStatus && record.publicDiscoveryStatus !== "found";
  if (status === "succeeded" && /^https?:\/\//i.test(record.publishedUrl ?? "") && !unresolvedDiscovery) return "public";
  return "unconfirmed";
}

export function canRetryPublication(record: PublishedCenterRecord, recoveryCompleted = false) {
  const status = publicationStatus(record);
  const recovered = recoveryCompleted && ["manual_verification_required", "needs_reauth"].includes(status);
  if (record.status !== "failed" || (status !== "failed" && !recovered) || record.publishedUrl || record.reviewUrl) return false;
  // Existing Zhihu recovery uses supplied-URL verification to avoid duplicate posts.
  return !(record.platform === "zhihu" && record.mediaAccountId);
}
