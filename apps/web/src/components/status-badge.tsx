import type { InclusionStatus, PublishStatus, SiteStatus, TaskStatus } from "@zengxing/core";
import { CheckCircle2, Circle, CircleAlert, Clock3, LoaderCircle, MinusCircle } from "lucide-react";

type Status =
  | TaskStatus
  | PublishStatus
  | SiteStatus
  | InclusionStatus
  | "active"
  | "disabled"
  | "draft"
  | "published"
  | "ready"
  | "generating"
  | "archived"
  | "tracking"
  | "suggested"
  | "not_found"
  | "not_published"
  | "not_submitted"
  | "review_required"
  | "submitted_for_review"
  | "manual_action_required"
  | "manual_verification_required"
  | "reviewing"
  | "queued"
  | "pending"
  | "error"
  | "stale"
  | "needs_reauth"
  | string;

const toneByStatus: Record<string, string> = {
  queued: "border-slate-200 bg-slate-50 text-slate-600",
  pending: "border-slate-200 bg-slate-50 text-slate-600",
  submitting: "border-indigo-100 bg-indigo-50 text-indigo-700",
  accepted: "border-emerald-100 bg-emerald-50 text-emerald-700",
  provider_pending: "border-amber-100 bg-amber-50 text-amber-700",
  rejected: "border-red-100 bg-red-50 text-red-700",
  unverified: "border-amber-100 bg-amber-50 text-amber-700",
  official: "border-emerald-100 bg-emerald-50 text-emerald-700",
  observed: "border-indigo-100 bg-indigo-50 text-indigo-700",
  unavailable: "border-slate-200 bg-slate-50 text-slate-600",
  reachable: "border-emerald-100 bg-emerald-50 text-emerald-700",
  unreachable: "border-red-100 bg-red-50 text-red-700",
  unknown: "border-slate-200 bg-slate-50 text-slate-600",
  running: "border-indigo-100 bg-indigo-50 text-indigo-700",
  succeeded: "border-emerald-100 bg-emerald-50 text-emerald-700",
  failed: "border-red-100 bg-red-50 text-red-700",
  canceled: "border-slate-200 bg-slate-50 text-slate-600",
  retry: "border-amber-100 bg-amber-50 text-amber-700",
  review_required: "border-amber-100 bg-amber-50 text-amber-700",
  submitted_for_review: "border-amber-100 bg-amber-50 text-amber-700",
  published_restricted: "border-amber-200 bg-amber-50 text-amber-800",
  distribution_restricted: "border-amber-200 bg-amber-50 text-amber-800",
  restricted: "border-amber-200 bg-amber-50 text-amber-800",
  manual_action_required: "border-amber-100 bg-amber-50 text-amber-700",
  manual_verification_required: "border-amber-100 bg-amber-50 text-amber-700",
  reviewing: "border-amber-100 bg-amber-50 text-amber-700",
  active: "border-emerald-100 bg-emerald-50 text-emerald-700",
  stale: "border-amber-100 bg-amber-50 text-amber-700",
  needs_reauth: "border-red-100 bg-red-50 text-red-700",
  disabled: "border-slate-200 bg-slate-50 text-slate-600",
  test_failed: "border-red-100 bg-red-50 text-red-700",
  unchecked: "border-slate-200 bg-slate-50 text-slate-600",
  checking: "border-indigo-100 bg-indigo-50 text-indigo-700",
  indexed: "border-emerald-100 bg-emerald-50 text-emerald-700",
  not_indexed: "border-amber-100 bg-amber-50 text-amber-700",
  draft: "border-slate-200 bg-slate-50 text-slate-600",
  published: "border-emerald-100 bg-emerald-50 text-emerald-700",
  not_published: "border-slate-200 bg-slate-50 text-slate-600",
  not_submitted: "border-slate-200 bg-slate-50 text-slate-600",
  ready: "border-emerald-100 bg-emerald-50 text-emerald-700",
  generating: "border-indigo-100 bg-indigo-50 text-indigo-700",
  archived: "border-slate-200 bg-slate-50 text-slate-500",
  tracking: "border-indigo-100 bg-indigo-50 text-indigo-700",
  suggested: "border-slate-200 bg-slate-50 text-slate-600",
  not_found: "border-red-100 bg-red-50 text-red-700",
  error: "border-red-100 bg-red-50 text-red-700",
  waiting_desktop: "border-slate-200 bg-slate-50 text-slate-600",
  desktop_ready: "border-indigo-100 bg-indigo-50 text-indigo-700",
  login_opened: "border-indigo-100 bg-indigo-50 text-indigo-700",
  capturing: "border-amber-100 bg-amber-50 text-amber-700",
  submitted: "border-emerald-100 bg-emerald-50 text-emerald-700",
  verified: "border-emerald-100 bg-emerald-50 text-emerald-700",
  bound: "border-emerald-100 bg-emerald-50 text-emerald-700",
  expired: "border-slate-200 bg-slate-50 text-slate-600",
  invalid: "border-red-100 bg-red-50 text-red-700",
  revoked: "border-red-100 bg-red-50 text-red-700"
};

const labelByStatus: Record<string, string> = {
  queued: "已入队",
  pending: "待处理",
  submitting: "处理中",
  accepted: "已受理",
  provider_pending: "待配置",
  rejected: "已拒绝",
  unverified: "待复验",
  official: "官方证据",
  observed: "SERP 观测",
  unavailable: "无验证能力",
  reachable: "可访问",
  unreachable: "不可访问",
  unknown: "未知",
  running: "运行中",
  succeeded: "成功",
  failed: "失败",
  canceled: "已取消",
  retry: "重试中",
  review_required: "待平台审核",
  submitted_for_review: "已提交审核",
  published_restricted: "已发布，分发受限",
  distribution_restricted: "内容分发受限",
  restricted: "公开受限",
  manual_action_required: "待人工验证",
  manual_verification_required: "待人工验证",
  reviewing: "审核中",
  active: "正常",
  stale: "待复验",
  needs_reauth: "需重新授权",
  disabled: "已停用",
  test_failed: "连接失败",
  unchecked: "未检测",
  checking: "检测中",
  indexed: "已可见",
  not_indexed: "未可见",
  draft: "草稿",
  published: "已发布",
  not_published: "未发布",
  not_submitted: "未处理",
  ready: "可发布",
  generating: "生成中",
  archived: "已归档",
  tracking: "跟踪中",
  suggested: "建议项",
  not_found: "未找到",
  error: "异常",
  waiting_desktop: "等待桌面端",
  desktop_ready: "桌面端已认领",
  login_opened: "授权环境已打开",
  capturing: "采集中",
  submitted: "已回传",
  verified: "已验证",
  bound: "已绑定",
  expired: "已过期",
  invalid: "凭据无效",
  revoked: "已撤销"
};

export function StatusBadge({ status, label }: { status: Status; label?: string }) {
  const isProcessing = [
    "running",
    "submitting",
    "generating",
    "checking",
    "capturing"
  ].includes(status);
  const isWaiting = ["reviewing", "review_required", "submitted_for_review", "queued", "pending", "stale"].includes(status);
  const isAttention = ["failed", "error", "needs_reauth", "manual_action_required", "manual_verification_required", "published_restricted", "distribution_restricted", "restricted"].includes(status);
  const isComplete = ["succeeded", "published", "active", "ready", "verified", "bound", "reachable", "indexed"].includes(status);
  const Icon = isProcessing ? LoaderCircle : isAttention ? CircleAlert : isWaiting ? Clock3 : isComplete ? CheckCircle2 : status === "canceled" || status === "disabled" ? MinusCircle : Circle;

  return (
    <span className={`inline-flex min-h-6 items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium ${toneByStatus[status] ?? toneByStatus.pending}`}>
      <Icon aria-hidden="true" size={13} strokeWidth={1.8} className={isProcessing ? "animate-spin" : undefined} />
      {label ?? labelByStatus[status] ?? status}
    </span>
  );
}
