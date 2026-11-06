"use client";

import { AppShell } from "@/components/app-shell";
import { useDesktopRequirement } from "@/components/desktop-requirement-provider";
import { EmptyState, LoadingState, MetricCard, PageHeader, PrimaryButton, Section, SecondaryButton } from "@/components/ui";
import { jsonFetch, pollTask, type AppTask } from "@/lib/tasks";
import { isMediaAccountPublishable, type Article, type AutoPublishTask, type GenerationRule, type Keyword, type MediaAccount } from "@zengxing/core";
import { AlertCircle, CheckCircle2, FileText, Play, RefreshCcw, RotateCcw, Send } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatAppTimestamp } from "@/lib/app-time";

type RuntimeAutoPublishTask = AutoPublishTask & {
  taskId?: string;
  status?: string;
  progress?: number;
  articleIds?: string[];
  mediaAccountIds?: string[];
  desktopCommandIds?: string[];
  queuedPublishCount?: number;
  publishPendingCount?: number;
  publishSucceededCount?: number;
  publishFailedCount?: number;
};

type QueuedAutoPublishResponse = {
  queued: true;
  autoPublishTask: RuntimeAutoPublishTask;
  task: AppTask;
};

type SourceMode = "existing" | "generate";

const platformNames: Record<string, string> = {
  zhihu: "知乎",
  baijiahao: "百家号",
  sohu: "搜狐号",
  csdn: "CSDN",
  netease: "网易号",
  penguin: "企鹅号",
  toutiao: "头条号",
  jianshu: "简书",
  wechat: "微信公众号"
};

function splitKeywords(value: string) {
  return value.split(/\r?\n|,|，|、/).map((item) => item.trim()).filter(Boolean).slice(0, 20);
}

function statusLabel(status?: string) {
  const labels: Record<string, string> = {
    queued: "等待生成",
    pending: "等待队列",
    running: "生成文章中",
    publishing: "媒体发布中",
    partial_failed: "部分失败",
    succeeded: "已下发完成",
    failed: "失败"
  };
  return labels[status || ""] || status || "未知";
}

function statusClass(status?: string) {
  if (status === "succeeded") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "failed" || status === "partial_failed") return "border-red-200 bg-red-50 text-red-700";
  if (status === "publishing" || status === "running") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-blue-200 bg-blue-50 text-blue-700";
}

function taskDisplayStatus(batch: RuntimeAutoPublishTask, task?: AppTask) {
  if (["publishing", "partial_failed", "failed"].includes(batch.status || "")) return batch.status;
  return task?.status || batch.status;
}

function isQueueActive(status?: string) {
  return status === "queued" || status === "pending" || status === "running";
}

function AutoPublishInner() {
  const { requireDesktop } = useDesktopRequirement();
  const searchParams = useSearchParams();
  const requestedArticleId = searchParams.get("articleId") || "";
  const pollingRef = useRef<Set<string>>(new Set());
  const [tasks, setTasks] = useState<RuntimeAutoPublishTask[]>([]);
  const [taskStates, setTaskStates] = useState<Record<string, AppTask>>({});
  const [rules, setRules] = useState<GenerationRule[]>([]);
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [articles, setArticles] = useState<Article[]>([]);
  const [mediaAccounts, setMediaAccounts] = useState<MediaAccount[]>([]);
  const [sourceMode, setSourceMode] = useState<SourceMode>(requestedArticleId ? "existing" : "generate");
  const [selectedArticleId, setSelectedArticleId] = useState(requestedArticleId);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [taskName, setTaskName] = useState("AI 内容自动发布");
  const [ruleId, setRuleId] = useState("");
  const [keywordMode, setKeywordMode] = useState<"top" | "manual">("top");
  const [keywordCount, setKeywordCount] = useState(3);
  const [manualKeywords, setManualKeywords] = useState("AI SEO 优化\nGEO 内容营销\n搜索索引提交");
  const [message, setMessage] = useState("选择文章来源和已授权媒体后，系统会生成文章并直接下发到桌面端发布。" );
  const [busy, setBusy] = useState(false);

  const activeAccounts = useMemo(
    () => mediaAccounts.filter(isMediaAccountPublishable),
    [mediaAccounts]
  );

  const refreshAll = useCallback(async () => {
    const [nextTasks, nextRules, nextKeywords, nextArticles, nextMediaAccounts] = await Promise.all([
      jsonFetch<RuntimeAutoPublishTask[]>("/api/auto-publish"),
      jsonFetch<GenerationRule[]>("/api/generation-rules"),
      jsonFetch<Keyword[]>("/api/keywords"),
      jsonFetch<Article[]>("/api/articles"),
      jsonFetch<MediaAccount[]>("/api/media-accounts")
    ]);
    const usableAccounts = nextMediaAccounts.filter(isMediaAccountPublishable);
    setTasks(nextTasks.slice().reverse());
    setRules(nextRules);
    setKeywords(nextKeywords);
    setArticles(nextArticles);
    setMediaAccounts(nextMediaAccounts);
    setRuleId((current) => current || nextRules[0]?.id || "");
    setSelectedArticleId((current) => current || requestedArticleId || nextArticles[0]?.id || "");
    setSelectedAccountIds((current) => {
      const valid = current.filter((id) => usableAccounts.some((account) => account.id === id));
      return valid.length ? valid : usableAccounts.slice(0, 1).map((account) => account.id);
    });
    const nextStates = await Promise.all(nextTasks.map(async (batch) => {
      if (!batch.taskId) return null;
      try {
        return await jsonFetch<AppTask>(`/api/tasks/${encodeURIComponent(batch.taskId)}`);
      } catch {
        return null;
      }
    }));
    setTaskStates((current) => ({
      ...current,
      ...Object.fromEntries(nextStates.filter((task): task is AppTask => Boolean(task)).map((task) => [task.id, task]))
    }));
  }, [requestedArticleId]);

  async function pollBatchTask(batch: RuntimeAutoPublishTask, taskId: string) {
    if (pollingRef.current.has(taskId)) return;
    pollingRef.current.add(taskId);
    try {
      const completed = await pollTask(taskId, {
        onUpdate: (task) => {
          setTaskStates((current) => ({ ...current, [task.id]: task }));
          setMessage(`${batch.name}：${statusLabel(task.status)}${typeof task.progress === "number" ? ` / ${task.progress}%` : ""}`);
        }
      });
      setTaskStates((current) => ({ ...current, [completed.id]: completed }));
      await refreshAll();
      const articleCount = Array.isArray(completed.result?.articleIds) ? completed.result.articleIds.length : 0;
      const commandCount = Number(completed.result?.queuedPublishCount || 0);
      setMessage(`批次已准备 ${articleCount} 篇文章，并向桌面端下发 ${commandCount} 个发布命令。`);
    } catch (error) {
      await refreshAll();
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      pollingRef.current.delete(taskId);
    }
  }

  useEffect(() => {
    refreshAll().catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
  }, [refreshAll]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      refreshAll().catch(() => undefined);
    }, 10000);
    return () => window.clearInterval(timer);
  }, [refreshAll]);

  useEffect(() => {
    tasks.forEach((batch) => {
      if (!batch.taskId) return;
      const status = taskStates[batch.taskId]?.status || batch.status;
      if (isQueueActive(status)) void pollBatchTask(batch, batch.taskId);
    });
  }, [tasks, taskStates]);

  const selectedRule = rules.find((rule) => rule.id === ruleId);
  const selectedArticle = articles.find((article) => article.id === selectedArticleId);
  const topKeywords = useMemo(
    () => [...keywords].sort((a, b) => b.searchVolume - a.searchVolume).slice(0, keywordCount).map((keyword) => keyword.word),
    [keywordCount, keywords]
  );
  const selectedKeywords = useMemo(
    () => keywordMode === "top" ? topKeywords : splitKeywords(manualKeywords),
    [keywordMode, manualKeywords, topKeywords]
  );
  const selectedAccountNames = activeAccounts
    .filter((account) => selectedAccountIds.includes(account.id))
    .map((account) => account.accountName || account.name);

  const queuedCommands = tasks.reduce((sum, task) => sum + (task.queuedPublishCount ?? 0), 0);
  const publishSucceeded = tasks.reduce((sum, task) => sum + (task.publishSucceededCount ?? 0), 0);
  const publishFailed = tasks.reduce((sum, task) => sum + (task.publishFailedCount ?? 0), 0);

  function toggleAccount(accountId: string) {
    setSelectedAccountIds((current) => current.includes(accountId)
      ? current.filter((id) => id !== accountId)
      : [...current, accountId]);
  }

  async function createBatchTask() {
    if (sourceMode === "existing" && !selectedArticleId) {
      setMessage("请先选择一篇文章。");
      return;
    }
    if (sourceMode === "generate" && !selectedKeywords.length) {
      setMessage("请先选择或输入关键词。");
      return;
    }
    if (!selectedAccountIds.length) {
      setMessage("请先选择至少一个已授权媒体账号。");
      return;
    }
    if (!requireDesktop("自动发布")) return;
    setBusy(true);
    try {
      const result = await jsonFetch<QueuedAutoPublishResponse>("/api/auto-publish", {
        method: "POST",
        body: JSON.stringify({
          async: true,
          name: taskName,
          ruleId: sourceMode === "generate" ? ruleId : "",
          ruleName: sourceMode === "generate" ? selectedRule?.name : "",
          keywordSource: sourceMode === "existing" ? "已有文章" : keywordMode === "top" ? `关键词库 Top ${keywordCount}` : "手动关键词",
          selectedKeywords: sourceMode === "generate" ? selectedKeywords : [],
          articleIds: sourceMode === "existing" ? [selectedArticleId] : [],
          mediaAccountIds: selectedAccountIds,
          targetPlatforms: selectedAccountNames,
          scheduleMode: "once",
          confirmPublish: true,
        })
      });
      setTaskStates((current) => ({ ...current, [result.task.id]: result.task }));
      await refreshAll();
      setMessage(`发布批次已入队：${result.autoPublishTask.name}`);
      await pollBatchTask(result.autoPublishTask, result.task.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function retryBatch(batch: RuntimeAutoPublishTask) {
    if (!requireDesktop("自动发布")) return;
    setBusy(true);
    try {
      if (batch.publishFailedCount) {
        const result = await jsonFetch<{ autoPublishTask: RuntimeAutoPublishTask; desktopCommands: Array<{ id: string }> }>(
          `/api/auto-publish/${encodeURIComponent(batch.id)}/retry-publishes`,
          { method: "POST" }
        );
        await refreshAll();
        setMessage(`已重新下发 ${result.desktopCommands.length} 个失败的媒体发布命令。`);
        return;
      }
      if (!batch.taskId) throw new Error("AUTO_PUBLISH_RETRY_TARGET_MISSING");
      const result = await jsonFetch<{ task: AppTask }>(`/api/failure-center/${encodeURIComponent(batch.taskId)}/retry`, { method: "POST" });
      setTaskStates((current) => ({ ...current, [result.task.id]: result.task }));
      await refreshAll();
      setMessage(`文章准备任务已重新入队：${result.task.id}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell>
      <PageHeader
        eyebrow="Publishing Workflow"
        title="自动发布"
        description="从已有文章或 AI 批量创作开始，向已授权免费媒体下发真实桌面发布命令，并持续回写审核状态和公开 URL。"
        action={<PrimaryButton disabled={busy || !activeAccounts.length} onClick={createBatchTask}><Play size={16} />开始发布</PrimaryButton>}
      />

      <div className="space-y-5 p-6">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="发布批次" value={tasks.length} hint="统一跟踪文章与媒体" />
          <MetricCard label="已下发命令" value={queuedCommands} hint="等待桌面端执行" />
          <MetricCard label="平台已完成" value={publishSucceeded} hint="以桌面端回写为准" />
          <MetricCard label="发布失败" value={publishFailed} hint="可在本页重试" />
        </div>

        <div className="grid gap-5 xl:grid-cols-[380px_minmax(0,1fr)]">
          <Section title="创建发布批次" description="文章和媒体账号确认后立即进入真实发布队列。">
            <div className="space-y-4">
              <label className="grid gap-1.5 text-sm font-medium text-ink">
                批次名称
                <input className="h-10 rounded-md border border-line px-3 text-sm" value={taskName} onChange={(event) => setTaskName(event.target.value)} />
              </label>

              <div className="grid grid-cols-2 gap-1 rounded-md bg-slate-100 p-1">
                <button type="button" onClick={() => setSourceMode("existing")} className={`h-9 rounded-md text-sm font-medium ${sourceMode === "existing" ? "bg-white text-ink shadow-sm" : "text-muted"}`}>选择已有文章</button>
                <button type="button" onClick={() => setSourceMode("generate")} className={`h-9 rounded-md text-sm font-medium ${sourceMode === "generate" ? "bg-white text-ink shadow-sm" : "text-muted"}`}>AI 批量生成</button>
              </div>

              {sourceMode === "existing" ? (
                <label className="grid gap-1.5 text-sm font-medium text-ink">
                  待发布文章
                  <select className="h-10 min-w-0 rounded-md border border-line px-3 text-sm" value={selectedArticleId} onChange={(event) => setSelectedArticleId(event.target.value)}>
                    <option value="">请选择文章</option>
                    {articles.map((article) => <option key={article.id} value={article.id}>{article.title}</option>)}
                  </select>
                  {selectedArticle ? <span className="text-xs font-normal text-muted">{selectedArticle.status} · {selectedArticle.keyword || "无主关键词"}</span> : null}
                </label>
              ) : (
                <div className="space-y-3">
                  <label className="grid gap-1.5 text-sm font-medium text-ink">
                    生成规则
                    <select className="h-10 rounded-md border border-line px-3 text-sm" value={ruleId} onChange={(event) => setRuleId(event.target.value)}>
                      {rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.name}</option>)}
                    </select>
                  </label>
                  <div className="grid grid-cols-2 gap-1 rounded-md bg-slate-100 p-1">
                    <button type="button" onClick={() => setKeywordMode("top")} className={`h-9 rounded-md text-sm font-medium ${keywordMode === "top" ? "bg-white text-ink shadow-sm" : "text-muted"}`}>关键词库</button>
                    <button type="button" onClick={() => setKeywordMode("manual")} className={`h-9 rounded-md text-sm font-medium ${keywordMode === "manual" ? "bg-white text-ink shadow-sm" : "text-muted"}`}>手动输入</button>
                  </div>
                  {keywordMode === "top" ? (
                    <label className="grid gap-1.5 text-sm font-medium text-ink">
                      文章数量
                      <input className="h-10 rounded-md border border-line px-3 text-sm" type="number" min={1} max={20} value={keywordCount} onChange={(event) => setKeywordCount(Math.max(1, Number(event.target.value) || 1))} />
                    </label>
                  ) : (
                    <label className="grid gap-1.5 text-sm font-medium text-ink">
                      每行一个关键词
                      <textarea className="min-h-24 rounded-md border border-line px-3 py-2 text-sm" value={manualKeywords} onChange={(event) => setManualKeywords(event.target.value)} />
                    </label>
                  )}
                </div>
              )}

              <div>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-ink">发布媒体</p>
                  <Link href="/free-media" className="text-xs font-medium text-brand">管理授权</Link>
                </div>
                {activeAccounts.length ? (
                  <div className="mt-2 divide-y divide-line rounded-md border border-line bg-white">
                    {activeAccounts.map((account) => (
                      <label key={account.id} className="flex cursor-pointer items-center gap-3 px-3 py-2.5">
                        <input type="checkbox" checked={selectedAccountIds.includes(account.id)} onChange={() => toggleAccount(account.id)} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-ink">{account.accountName || account.name}</span>
                          <span className="block text-xs text-muted">{platformNames[account.platform] || account.platform}</span>
                        </span>
                        <span className="text-xs text-emerald-700">可发布</span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <div className="mt-2">
                    <EmptyState title="没有可用媒体账号" description="先在媒体账号页完成桌面端一键授权，再返回创建发布批次。" />
                    <Link href="/free-media" className="mt-3 inline-flex text-sm font-medium text-brand">前往媒体账号</Link>
                  </div>
                )}
              </div>

              <div className="rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-800">
                平台接收后会持续同步审核和公开状态；待审核或安全验证不会被误标为发布成功。
              </div>
              <PrimaryButton disabled={busy || !activeAccounts.length} onClick={createBatchTask}><Send size={16} />开始发布</PrimaryButton>
              {busy ? <LoadingState label="正在创建发布批次" /> : <p className="text-sm leading-6 text-muted">{message}</p>}
            </div>
          </Section>

          <Section title="发布批次" description="生成、桌面命令、平台结果和失败状态集中在一张表中。" action={<SecondaryButton onClick={() => void refreshAll()}><RefreshCcw size={15} />刷新</SecondaryButton>}>
            {tasks.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-left text-sm">
                  <thead className="border-b border-line text-xs text-muted">
                    <tr>
                      <th className="px-3 py-2 font-medium">批次</th>
                      <th className="px-3 py-2 font-medium">文章</th>
                      <th className="px-3 py-2 font-medium">媒体</th>
                      <th className="px-3 py-2 font-medium">发布进度</th>
                      <th className="px-3 py-2 font-medium">状态</th>
                      <th className="px-3 py-2 text-right font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {tasks.map((batch) => {
                      const taskState = batch.taskId ? taskStates[batch.taskId] : undefined;
                      const displayStatus = taskDisplayStatus(batch, taskState);
                      const articleIds = batch.articleIds?.length ? batch.articleIds : batch.generatedArticleIds ?? [];
                      return (
                        <tr key={batch.id} className="align-top">
                          <td className="px-3 py-3">
                            <p className="max-w-60 truncate font-medium text-ink">{batch.name}</p>
                            <p className="mt-1 text-xs text-muted">{batch.keywordSource || "已有文章"} · {formatAppTimestamp(batch.createdAt)}</p>
                          </td>
                          <td className="px-3 py-3">
                            <p className="font-medium text-ink">{articleIds.length || batch.publishCount}</p>
                            <p className="mt-1 text-xs text-muted">准备完成 {batch.successCount}</p>
                          </td>
                          <td className="px-3 py-3">
                            <p className="max-w-48 truncate text-ink">{batch.targetPlatforms?.join("、") || `${batch.mediaAccountIds?.length ?? 0} 个账号`}</p>
                            <p className="mt-1 text-xs text-muted">命令 {batch.queuedPublishCount ?? batch.desktopCommandIds?.length ?? 0}</p>
                          </td>
                          <td className="px-3 py-3">
                            <p className="text-ink">成功 {batch.publishSucceededCount ?? 0} · 失败 {batch.publishFailedCount ?? 0}</p>
                            <p className="mt-1 text-xs text-muted">处理中 {batch.publishPendingCount ?? 0}</p>
                          </td>
                          <td className="px-3 py-3">
                            <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium ${statusClass(displayStatus)}`}>
                              {displayStatus === "failed" || displayStatus === "partial_failed" ? <AlertCircle size={13} /> : <CheckCircle2 size={13} />}
                              {statusLabel(displayStatus)}
                            </span>
                            {taskState?.errorMessage || batch.lastError ? <p className="mt-2 max-w-56 text-xs text-red-700">{taskState?.errorMessage || batch.lastError}</p> : null}
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex justify-end gap-2">
                              {articleIds[0] ? <Link href={`/editor?articleId=${articleIds[0]}`} className="inline-flex h-8 items-center gap-1 rounded-md border border-line px-2 text-xs text-ink"><FileText size={13} />文章</Link> : null}
                              <Link href="/published" className="inline-flex h-8 items-center rounded-md border border-line px-2 text-xs text-brand">发布记录</Link>
                              {(displayStatus === "failed" || displayStatus === "partial_failed") && (batch.publishFailedCount || batch.taskId) ? (
                                <button type="button" disabled={busy} onClick={() => void retryBatch(batch)} className="inline-flex h-8 items-center gap-1 rounded-md border border-line px-2 text-xs text-ink disabled:opacity-50"><RotateCcw size={13} />重试</button>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState title="还没有发布批次" description="选择已有文章或使用 AI 批量生成，然后下发到已授权媒体。" />
            )}
          </Section>
        </div>
      </div>
    </AppShell>
  );
}

export default function AutoPublishPage() {
  return (
    <Suspense fallback={<div className="p-7 text-sm text-muted">正在加载自动发布...</div>}>
      <AutoPublishInner />
    </Suspense>
  );
}
