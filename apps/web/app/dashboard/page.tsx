"use client";

import { AppShell } from "@/components/app-shell";
import { StatusBadge } from "@/components/status-badge";
import { LoadingState, MetricCard, PageHeader, Section, SecondaryButton } from "@/components/ui";
import { jsonFetch } from "@/lib/tasks";
import { isMediaAccountPublishable } from "@zengxing/core";
import type { DashboardOperationCenter, MediaAccount, TaskItem } from "@zengxing/core";
import { ArrowUpRight, CheckCircle2, CircleAlert, FileText, RefreshCcw, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { formatAppTimestamp } from "@/lib/app-time";

type DashboardMetrics = {
  totalArticles: number;
  drafts: number;
  published: number;
  indexRecords: number;
  submittedIndexes: number;
  includedUrls: number;
  operationCenter: DashboardOperationCenter;
  recentTasks: TaskItem[];
  runningPublishes: number;
  recentPublishes: Array<{
    id: string;
    sourceType: "site" | "media";
    articleTitle: string;
    channelName: string;
    status: string;
    publishedUrl?: string;
    updatedAt: string;
  }>;
};

const emptyOperationCenter: DashboardOperationCenter = {
  today: { generatedArticles: 0, publishedUrls: 0, indexSubmitted: 0, includedUrls: 0 },
  summary: { failedTasks: 0, authorizationExceptions: 0, manualReview: 0, pendingIndex: 0, inclusionProblems: 0 },
  workItems: [],
  shortcuts: [],
};

function severityLabel(severity: string) {
  if (severity === "critical") return "需处理";
  if (severity === "warning") return "请留意";
  return "进行中";
}

function severityClass(severity: string) {
  if (severity === "critical") return "border-red-200 bg-red-50 text-red-700";
  if (severity === "warning") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardMetrics | null>(null);
  const [mediaAccounts, setMediaAccounts] = useState<MediaAccount[]>([]);
  const [errorMessage, setErrorMessage] = useState("");
  const [busy, setBusy] = useState(true);

  async function refreshDashboard() {
    setBusy(true);
    setErrorMessage("");
    try {
      const [nextData, nextAccounts] = await Promise.all([
        jsonFetch<DashboardMetrics>("/api/dashboard/metrics"),
        jsonFetch<MediaAccount[]>("/api/media-accounts"),
      ]);
      setData(nextData);
      setMediaAccounts(nextAccounts);
    } catch (error) {
      console.error("Dashboard refresh failed", error);
      setErrorMessage("工作台暂时无法更新，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refreshDashboard();
  }, []);

  const metrics = data ?? {
    totalArticles: 0,
    drafts: 0,
    published: 0,
    indexRecords: 0,
    submittedIndexes: 0,
    includedUrls: 0,
    operationCenter: emptyOperationCenter,
    recentTasks: [],
    runningPublishes: 0,
    recentPublishes: [],
  };
  const center = metrics.operationCenter;
  const activeMediaAccounts = mediaAccounts.filter(isMediaAccountPublishable).length;
  const incompleteArticles = Math.max(0, metrics.totalArticles - metrics.published);
  const activePublishes = metrics.runningPublishes + center.summary.manualReview;
  const visibleWorkItems = useMemo(() => center.workItems.slice(0, 5), [center.workItems]);
  const hiddenWorkItems = Math.max(0, center.workItems.length - visibleWorkItems.length);

  return (
    <AppShell>
      <PageHeader
        eyebrow="Overview"
        title="工作台"
        description="集中查看创作、媒体账号和发布流程中真正需要处理的事项。"
        action={
          <Link href="/ai-writer" className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-4 text-[13px] font-medium text-white shadow-sm hover:bg-brand/90">
            <Sparkles size={16} />开始创作
          </Link>
        }
      />

      <div className="space-y-5 p-4 sm:p-6">
        {errorMessage ? (
          <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <CircleAlert size={16} className="shrink-0" />
            <span>{errorMessage}</span>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <MetricCard label="文章总数" value={metrics.totalArticles} hint={`${metrics.drafts} 篇草稿`} />
          <MetricCard label="未完成文章" value={incompleteArticles} hint={`${metrics.published} 篇已发布`} />
          <MetricCard label="可用媒体账号" value={activeMediaAccounts} hint="登录状态正常" />
          <MetricCard label="发布处理中" value={activePublishes} hint={`${center.summary.manualReview} 条等待平台处理`} />
        </div>

        <Section
          title="需要处理"
          description={center.workItems.length ? `${center.workItems.length} 类事项，重复错误已自动合并。` : "当前发布流程运行正常。"}
          action={
            <SecondaryButton disabled={busy} onClick={refreshDashboard}>
              <RefreshCcw size={15} />刷新
            </SecondaryButton>
          }
        >
          {busy && !data ? (
            <LoadingState label="正在更新工作台" />
          ) : visibleWorkItems.length ? (
            <div className="divide-y divide-line bg-panel">
              {visibleWorkItems.map((item) => (
                <article key={item.id} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${severityClass(item.severity)}`}>
                        {severityLabel(item.severity)}
                      </span>
                      <p className="truncate text-sm font-semibold text-ink">{item.title}</p>
                      {(item.occurrenceCount ?? 1) > 1 ? (
                        <span className="text-xs text-muted">已合并 {item.occurrenceCount} 次</span>
                      ) : null}
                    </div>
                    <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-muted">{item.description}</p>
                  </div>
                  <div className="flex shrink-0 items-center justify-between gap-3 sm:justify-end">
                    <StatusBadge status={item.status} />
                    <Link href={item.href} className="inline-flex h-8 items-center gap-1 text-xs font-semibold text-brand hover:underline">
                      处理<ArrowUpRight size={13} />
                    </Link>
                  </div>
                </article>
              ))}
              {hiddenWorkItems ? (
                <div className="flex items-center justify-between px-4 py-3 text-xs text-muted">
                  <span>另外 {hiddenWorkItems} 类事项已收起</span>
                  <Link href="/articles/history" className="font-semibold text-brand hover:underline">查看任务记录</Link>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-emerald-200 bg-emerald-50/60 px-5 py-8 text-center">
              <CheckCircle2 className="mx-auto text-emerald-600" size={26} />
              <p className="mt-3 text-sm font-semibold text-ink">目前没有需要处理的事项</p>
              <p className="mt-1 text-xs text-muted">可以继续创作或查看最近的发布结果。</p>
            </div>
          )}
        </Section>

        <Section title="最近发布" description="最近 5 条记录的处理进度。" action={<Link href="/published" className="text-xs font-medium text-brand hover:underline">查看全部记录 →</Link>}>
          <div className="overflow-x-auto rounded-md border border-line bg-panel">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="bg-slate-50 text-xs text-muted">
                <tr>
                  <th className="px-4 py-3 font-medium">文章</th>
                  <th className="px-4 py-3 font-medium">媒体平台</th>
                  <th className="px-4 py-3 font-medium">状态</th>
                  <th className="px-4 py-3 font-medium">更新时间</th>
                  <th className="w-24 px-4 py-3 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {metrics.recentPublishes.slice(0, 5).map((job) => (
                  <tr key={job.id} className="border-t border-line hover:bg-slate-50/70">
                    <td className="max-w-[280px] truncate px-4 py-3 font-medium text-ink">{job.articleTitle}</td>
                    <td className="px-4 py-3 text-muted">{job.channelName}</td>
                    <td className="px-4 py-3"><StatusBadge status={job.status} /></td>
                    <td className="px-4 py-3 text-xs text-muted">{formatAppTimestamp(job.updatedAt)}</td>
                    <td className="px-4 py-3">
                      <Link href="/published" className="inline-flex items-center gap-1 text-xs font-semibold text-brand hover:underline">
                        查看<FileText size={13} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!metrics.recentPublishes.length ? (
              <p className="px-4 py-8 text-center text-sm text-muted">还没有发布记录。</p>
            ) : null}
          </div>
        </Section>
      </div>
    </AppShell>
  );
}
