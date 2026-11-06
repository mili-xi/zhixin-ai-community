export type PublicationRecordLike = {
  status?: string;
  updatedAt?: string;
  publishedUrl?: string;
  backlinkUrl?: string;
  mediaAccountId?: string;
  resourceId?: string;
};

export type ArticlePublicationLike = {
  status?: string;
  publishStatus?: string;
  publicationStatus?: string;
  mediaPublishStatus?: string;
  publishedUrl?: string;
  mediaPublishedUrl?: string;
};

export type ArticlePublishState =
  | "not_published"
  | "pending"
  | "queued"
  | "running"
  | "publishing"
  | "manual_verification_required"
  | "review_required"
  | "submitted_for_review"
  | "account_under_review"
  | "succeeded"
  | "published"
  | "archived"
  | "failed"
  | "canceled"
  | "cancelled"
  | string;

const RETRYABLE_STATES = new Set(["", "not_published", "failed", "canceled", "cancelled"]);

function normalized(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function recordState(record: PublicationRecordLike | undefined): string {
  if (!record) return "";
  if (normalized(record.publishedUrl || record.backlinkUrl)) return "published";
  return normalized(record.status);
}

export function articlePublishState(
  article: ArticlePublicationLike | null | undefined,
  orders: PublicationRecordLike[] = [],
  jobs: PublicationRecordLike[] = [],
): ArticlePublishState {
  if (!article) return "not_published";

  const articleStatus = normalized(article.status);
  if (articleStatus === "published" || articleStatus === "archived") return articleStatus;
  if (normalized(article.publishedUrl || article.mediaPublishedUrl)) return "published";

  for (const field of [article.publishStatus, article.publicationStatus, article.mediaPublishStatus]) {
    const state = normalized(field);
    if (state) return state;
  }

  const latestRecord = [...orders, ...jobs].at(-1);
  return recordState(latestRecord) || "not_published";
}

export function isArticlePublishLocked(
  article: ArticlePublicationLike | null | undefined,
  orders: PublicationRecordLike[] = [],
  jobs: PublicationRecordLike[] = [],
): boolean {
  return !RETRYABLE_STATES.has(articlePublishState(article, orders, jobs));
}

function mediaAccountIdFromTarget(targetId: string): string {
  return targetId.startsWith("media:") ? targetId.slice("media:".length) : "";
}

function mediaAccountIdFromOrder(order: PublicationRecordLike): string {
  const direct = normalized(order.mediaAccountId);
  if (direct) return direct;
  const resourceId = String(order.resourceId ?? "").trim();
  return resourceId.startsWith("account:") ? resourceId.slice("account:".length) : "";
}

export function isArticleTargetPublishLocked(
  article: ArticlePublicationLike | null | undefined,
  orders: PublicationRecordLike[] = [],
  jobs: PublicationRecordLike[] = [],
  targetId = "",
): boolean {
  const accountId = mediaAccountIdFromTarget(targetId);
  if (!accountId) return isArticlePublishLocked(article, orders, jobs);
  const targetOrders = orders.filter((order) => mediaAccountIdFromOrder(order) === accountId);
  const latestTargetOrder = targetOrders.at(-1);
  return latestTargetOrder ? !RETRYABLE_STATES.has(recordState(latestTargetOrder)) : false;
}

export function articlePublishLabel(stateInput: string): string {
  const state = normalized(stateInput);
  if (state === "pending" || state === "queued") return "已提交发布";
  if (state === "running" || state === "publishing") return "发布中";
  if (state === "manual_verification_required") return "等待人工验证";
  if (state === "review_required" || state === "submitted_for_review" || state === "account_under_review") return "平台审核中";
  if (state === "published_restricted") return "已发布，分发受限";
  if (state === "published" || state === "succeeded" || state === "archived") return "已发布";
  if (state === "failed") return "发布失败，可重试";
  if (state === "canceled" || state === "cancelled") return "已取消，可重试";
  return "未发布";
}
