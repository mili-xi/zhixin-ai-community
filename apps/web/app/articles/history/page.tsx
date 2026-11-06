"use client";

import { AppShell } from "@/components/app-shell";
import { StatusBadge } from "@/components/status-badge";
import { EmptyState, LoadingState, MetricCard, PageHeader, PrimaryButton, Section, SecondaryButton } from "@/components/ui";
import type { CreationTaskCenter, CreationTaskRecord, CreationTaskSourceType } from "@zengxing/core";
import { ClipboardList, History, RefreshCw, Search } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatAppTimestamp } from "@/lib/app-time";

type SourceFilter = CreationTaskSourceType | "all";

const emptyCenter: CreationTaskCenter = {
  tasks: [],
  summary: {
    totalTasks: 0,
    autoPublish: 0,
    serp: 0,
    rule: 0,
    manualAi: 0,
    totalArticles: 0,
    publishedArticles: 0,
    indexedArticles: 0,
    includedArticles: 0,
    failedTasks: 0
  },
  facets: {
    sourceTypes: [],
    ruleNames: [],
    targetPlatforms: []
  }
};

const sourceLabels: Record<CreationTaskSourceType, string> = {
  auto_publish: "自动创作发布",
  serp: "SERP 分析创作",
  rule: "生成规则创作",
  manual_ai: "手动 AI 创作"
};

async function jsonFetch<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { "content-type": "application/json" } });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}

function appendParam(params: URLSearchParams, key: string, value: string) {
  if (value && value !== "all") params.set(key, value);
}

function progressWidth(task: CreationTaskRecord) {
  if (!task.articleCount) return "0%";
  return `${Math.round((task.publishedCount / task.articleCount) * 100)}%`;
}

export default function CreationHistoryPage() {
  const [center, setCenter] = useState<CreationTaskCenter>(emptyCenter);
  const [sourceType, setSourceType] = useState<SourceFilter>("all");
  const [ruleName, setRuleName] = useState("all");
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string>();
  const [message, setMessage] = useState("正在读取创作任务历史...");
  const [busy, setBusy] = useState(true);

  const requestUrl = useMemo(() => {
    const params = new URLSearchParams();
    appendParam(params, "sourceType", sourceType);
    appendParam(params, "ruleName", ruleName);
    appendParam(params, "query", query.trim());
    const suffix = params.toString();
    return suffix ? `/api/creation-history?${suffix}` : "/api/creation-history";
  }, [query, ruleName, sourceType]);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const next = await jsonFetch<CreationTaskCenter>(requestUrl);
      setCenter(next);
      setExpandedId((current) => current && next.tasks.some((task) => task.id === current) ? current : next.tasks[0]?.id);
      setMessage(`当前筛选出 ${next.tasks.length} 个创作任务，关联 ${next.summary.totalArticles} 篇文章。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [requestUrl]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const hasActiveTasks = center.tasks.some((task) => task.articleCount === 0 && task.failedCount === 0);
    if (!hasActiveTasks) return;
    const timer = window.setInterval(() => {
      refresh();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [center.tasks, refresh]);

  function resetFilters() {
    setSourceType("all");
    setRuleName("all");
    setQuery("");
  }

  return (
    <AppShell>
      <PageHeader
        eyebrow="AI creation history"
        title="创作历史"
        description="按自动创作任务、SERP 来源和生成规则版本聚合文章产出，统一查看发布、公开可见性和失败原因。"
        action={<Link href="/ai-writer"><PrimaryButton><History size={16} />继续创作</PrimaryButton></Link>}
      />

      <div className="space-y-6 p-7">
        <div className="grid gap-4 md:grid-cols-4">
          <MetricCard label="创作任务" value={center.summary.totalTasks} hint={`自动 ${center.summary.autoPublish} / SERP ${center.summary.serp}`} />
          <MetricCard label="产出文章" value={center.summary.totalArticles} hint={`已发布 ${center.summary.publishedArticles}`} />
          <MetricCard label="公开可见" value={center.summary.includedArticles} hint="来自公开页或 SERP 观察" />
          <MetricCard label="异常任务" value={center.summary.failedTasks} hint="发布失败、检测失败或任务记录错误" />
        </div>

        <Section title="筛选任务" description="任务维度用于复盘一次自动创作、一次 SERP 创作或一个规则版本下的批次产出。">
          <div className="grid gap-3 lg:grid-cols-[1.4fr_190px_220px_auto_auto]">
            <label className="grid gap-1 text-xs font-medium text-muted">
              搜索
              <div className="flex items-center gap-2 rounded-md border border-line bg-white px-3 py-2">
                <Search size={16} />
                <input className="w-full bg-transparent text-sm text-ink outline-none" placeholder="任务名、关键词、规则、文章标题" value={query} onChange={(event) => setQuery(event.target.value)} />
              </div>
            </label>
            <label className="grid gap-1 text-xs font-medium text-muted">
              来源
              <select className="rounded-md border border-line bg-white px-3 py-2 text-sm text-ink" value={sourceType} onChange={(event) => setSourceType(event.target.value as SourceFilter)}>
                <option value="all">全部来源</option>
                <option value="auto_publish">自动创作发布</option>
                <option value="serp">SERP 分析创作</option>
                <option value="rule">生成规则创作</option>
                <option value="manual_ai">手动 AI 创作</option>
              </select>
            </label>
            <label className="grid gap-1 text-xs font-medium text-muted">
              生成规则
              <select className="rounded-md border border-line bg-white px-3 py-2 text-sm text-ink" value={ruleName} onChange={(event) => setRuleName(event.target.value)}>
                <option value="all">全部规则</option>
                {center.facets.ruleNames.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
            <SecondaryButton onClick={resetFilters}>重置</SecondaryButton>
            <SecondaryButton onClick={refresh} disabled={busy}><RefreshCw size={15} />刷新</SecondaryButton>
          </div>
          <div className="mt-4">{busy ? <LoadingState label="正在读取创作任务历史" /> : <p className="text-sm text-muted">{message}</p>}</div>
        </Section>

        <Section title="创作任务批次" description="每个任务都汇总了产出文章、生成规则版本、目标渠道、发布进度、公开可见性和异常原因。">
          {center.tasks.length ? (
            <div className="space-y-4">
              {center.tasks.map((task) => {
                const expanded = expandedId === task.id;
                return (
                  <div key={task.id} className="rounded-md border border-line bg-white">
                    <button className="flex w-full flex-col gap-4 p-4 text-left lg:flex-row lg:items-start lg:justify-between" onClick={() => setExpandedId(expanded ? undefined : task.id)}>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-md bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700">{sourceLabels[task.sourceType]}</span>
                          {task.ruleVersion ? <span className="rounded-md bg-slate-100 px-2 py-1 text-xs text-muted">规则版本 {task.ruleVersion}</span> : null}
                          {task.failedCount ? <span className="rounded-md bg-rose-50 px-2 py-1 text-xs font-medium text-rose-700">异常 {task.failedCount}</span> : null}
                        </div>
                        <h3 className="mt-3 truncate text-base font-semibold text-ink">{task.title}</h3>
                        <p className="mt-2 line-clamp-2 text-sm leading-6 text-muted">{task.description}</p>
                        <p className="mt-2 text-xs text-muted">
                          {task.ruleName || "未绑定规则"} / {task.keywordSource || "未记录关键词来源"} / {task.createdAt}
                        </p>
                      </div>
                      <div className="grid w-full gap-3 text-sm lg:w-[460px] lg:grid-cols-4">
                        <div><p className="text-xs text-muted">文章</p><p className="mt-1 font-semibold text-ink">{task.articleCount}</p></div>
                        <div><p className="text-xs text-muted">已发布</p><p className="mt-1 font-semibold text-ink">{task.publishedCount}</p></div>
                        <div><p className="text-xs text-muted">已公开</p><p className="mt-1 font-semibold text-ink">{task.publishedCount}</p></div>
                        <div><p className="text-xs text-muted">已可见</p><p className="mt-1 font-semibold text-ink">{task.includedCount}</p></div>
                        <div className="col-span-full">
                          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                            <div className="h-full rounded-full bg-brand" style={{ width: progressWidth(task) }} />
                          </div>
                        </div>
                      </div>
                    </button>

                    {expanded ? (
                      <div className="border-t border-line p-4">
                        {task.failureReasons.length ? (
                          <div className="mb-4 rounded-md border border-rose-100 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                            {task.failureReasons.join("；")}
                          </div>
                        ) : null}
                        <div className="mb-4 flex flex-wrap gap-2">
                          {task.targetPlatforms.map((platform) => <span key={platform} className="rounded-md bg-slate-100 px-2 py-1 text-xs text-muted">{platform}</span>)}
                        </div>
                        {task.articles.length ? (
                          <div className="overflow-hidden rounded-md border border-line">
                            <table className="w-full text-left text-sm">
                              <thead className="bg-slate-50 text-xs text-muted">
                                <tr>
                                  <th className="px-4 py-3">文章</th>
                                  <th className="px-4 py-3">文章状态</th>
                                  <th className="px-4 py-3">发布</th>
                                  <th className="px-4 py-3">可见性</th>
                                  <th className="px-4 py-3">操作</th>
                                </tr>
                              </thead>
                              <tbody>
                                {task.articles.map((article) => (
                                  <tr key={article.articleId} className="border-t border-line">
                                    <td className="px-4 py-3">
                                      <p className="font-medium text-ink">{article.title}</p>
                                      <p className="mt-1 text-xs text-muted">{article.keyword} / {formatAppTimestamp(article.updatedAt)}</p>
                                    </td>
                                    <td className="px-4 py-3"><StatusBadge status={article.status} /></td>
                                    <td className="px-4 py-3"><StatusBadge status={article.publishStatus} /></td>
                                    <td className="px-4 py-3"><StatusBadge status={article.inclusionStatus} /></td>
                                    <td className="px-4 py-3">
                                      <div className="flex flex-wrap gap-2">
                                        <Link href={`/editor?articleId=${article.articleId}`}><SecondaryButton>编辑</SecondaryButton></Link>
                                        <Link href="/published"><SecondaryButton>发布中心</SecondaryButton></Link>
                                      </div>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <EmptyState title="暂无文章产出" description="这个任务目前只有任务记录，还没有写入生成文章。" />
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState title="没有符合条件的创作任务" description="切换筛选条件，或从 AI 创作、SERP 分析、自动创作发布入口生成新的任务。" />
          )}
        </Section>

        <Section title="下一步入口" description="任务复盘后可以继续进入创作、自动发布或所有文章统一管理。">
          <div className="flex flex-wrap gap-3">
            <Link href="/ai-writer"><PrimaryButton><ClipboardList size={16} />AI 创作</PrimaryButton></Link>
            <Link href="/auto-publish"><SecondaryButton>自动创作发布</SecondaryButton></Link>
            <Link href="/ai-writer/serp"><SecondaryButton>SERP 分析及创作</SecondaryButton></Link>
            <Link href="/articles"><SecondaryButton>所有文章</SecondaryButton></Link>
          </div>
        </Section>
      </div>
    </AppShell>
  );
}
