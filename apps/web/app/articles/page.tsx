"use client";

import { AppShell } from "@/components/app-shell";
import { StatusBadge } from "@/components/status-badge";
import { EmptyState, LoadingState, MetricCard, PageHeader, PrimaryButton, Section, SecondaryButton } from "@/components/ui";
import { articlePublishLabel, articlePublishState, isArticlePublishLocked } from "@/lib/article-publish-state";
import type { Article, ArticleManagementCenter, ArticleManagementRecord, ArticleStatus, PublishStatus } from "@zengxing/core";
import { AlertTriangle, Eye, FileText, RefreshCw, RotateCcw, Search, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatAppTimestamp } from "@/lib/app-time";

type StatusFilter = ArticleStatus | "all";
type PublishFilter = PublishStatus | "not_published" | "all";
type BatchAction = "retry-failed";

type BatchResult = {
  requested: number;
  matched: number;
  retried: number;
  skipped: number;
  errors: string[];
};

type RetainedHistory = {
  publishJobs: number;
  mediaOrders: number;
  completedWorkflows: number;
};

type ArticleDeleteResult = {
  deleted: true;
  articleId: string;
  title: string;
  retainedHistory: RetainedHistory;
};

type BatchDeleteResult = {
  requested: number;
  deleted: number;
  articleIds: string[];
  retainedHistory: RetainedHistory;
  items: ArticleDeleteResult[];
};

type DeleteRequest = {
  ids: string[];
  titles: string[];
};

const articleStatuses: Array<[StatusFilter, string]> = [
  ["all", "全部文章"],
  ["draft", "草稿"],
  ["generating", "生成中"],
  ["ready", "待发布"],
  ["published", "已发布"],
  ["archived", "已归档"]
];

const publishStatuses: Array<[PublishFilter, string]> = [
  ["all", "全部发布"],
  ["not_published", "未发布"],
  ["pending", "待处理"],
  ["running", "发布中"],
  ["succeeded", "发布成功"],
  ["failed", "发布失败"],
  ["review_required", "待审核"]
];

function articleManagementAction(record: ArticleManagementRecord) {
  const state = articlePublishState(record);
  if (isArticlePublishLocked(record)) {
    return { href: "/published", label: `${articlePublishLabel(state)}，查看发布` };
  }
  return {
    href: `/editor?articleId=${record.articleId}`,
    label: state === "failed" ? "重新发布" : "编辑 / 发布",
  };
}

const emptyCenter: ArticleManagementCenter = {
  records: [],
  summary: {
    total: 0,
    draft: 0,
    ready: 0,
    published: 0,
    generating: 0,
    indexedSubmitted: 0,
    included: 0,
    notSubmitted: 0
  },
  facets: {
    articleTypes: [],
    ruleNames: [],
    sources: [],
    tags: []
  }
};

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { detail?: string | { message?: string } } | null;
    const detail = payload?.detail;
    throw new Error(typeof detail === "object" && detail?.message ? detail.message : typeof detail === "string" ? detail : `请求失败（${response.status}）`);
  }
  return response.json() as Promise<T>;
}

function appendParam(params: URLSearchParams, key: string, value: string) {
  if (value && value !== "all") params.set(key, value);
}

function SelectFilter({ value, onChange, options, label }: { value: string; onChange: (value: string) => void; options: string[]; label: string }) {
  return (
    <label className="grid gap-1 text-xs font-medium text-muted">
      {label}
      <select className="rounded-md border border-line bg-panel px-3 py-2 text-sm text-ink" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="all">全部</option>
        {options.map((item) => <option key={item} value={item}>{item}</option>)}
      </select>
    </label>
  );
}

function formatBatchMessage(result: BatchResult) {
  const pieces = [
    `匹配 ${result.matched}/${result.requested}`,
    result.retried ? `重试发布 ${result.retried}` : "",
    result.skipped ? `跳过 ${result.skipped}` : ""
  ].filter(Boolean);
  return `${pieces.join("，")}。${result.errors.length ? `异常：${result.errors.join("，")}` : ""}`;
}

function statusButtonClass(active: boolean) {
  return `rounded-md border px-3 py-2 text-sm transition-all duration-150 ${active ? "border-brand bg-[#f3f0ff] text-brand font-bold shadow-sm" : "border-line bg-panel text-slate-650 hover:border-brand/40 hover:bg-slate-50"}`;
}

function resolveImageUrl(url?: string, path?: string) {
  const candidate = String(url || path || "").trim();
  if (!candidate) return "";
  if (/^https?:\/\//i.test(candidate) || candidate.startsWith("data:")) return candidate;
  if (candidate.startsWith("/")) return candidate;
  if (candidate.includes("uploads/") || candidate.includes("assets/")) {
    return `/${candidate.replace(/^\/+/, "")}`;
  }
  return candidate;
}

/** Lightweight readable body preview for the management drawer. */
function ArticleBodyPreview({ article }: { article: Article }) {
  const coverUrl = resolveImageUrl(article.coverImage?.url, article.coverImage?.path);
  const sections = Array.isArray(article.sections) ? article.sections : [];
  const inlineImages = Array.isArray(article.inlineImages) ? article.inlineImages : [];
  const markdown = String(article.contentMarkdown || "").trim();

  if (sections.length > 0) {
    return (
      <div className="space-y-4">
        {coverUrl ? (
          <figure className="overflow-hidden rounded-lg border border-line bg-white">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={coverUrl} alt={article.coverImage?.altText || article.title || "封面"} className="max-h-40 w-full object-cover" />
            <figcaption className="px-2 py-1.5 text-[11px] text-muted">封面</figcaption>
          </figure>
        ) : null}
        {sections.map((section) => {
          const image = inlineImages.find((item) => item.sectionId && item.sectionId === section.id);
          const imageUrl = resolveImageUrl(image?.url, image?.path);
          return (
            <section key={section.id || section.title} className="space-y-2">
              {section.title ? <h3 className="text-sm font-semibold text-ink">{section.title}</h3> : null}
              <p className="whitespace-pre-wrap text-xs leading-6 text-slate-700">{section.content || "（本节暂无正文）"}</p>
              {imageUrl ? (
                <figure className="overflow-hidden rounded-md border border-line bg-white">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={imageUrl} alt={image?.altText || section.title || "正文配图"} className="max-h-48 w-full object-contain" />
                </figure>
              ) : null}
            </section>
          );
        })}
      </div>
    );
  }

  if (markdown) {
    const plain = markdown
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_`>~-]/g, "")
      .trim();
    return (
      <div className="space-y-3">
        {coverUrl ? (
          <figure className="overflow-hidden rounded-lg border border-line bg-white">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={coverUrl} alt={article.coverImage?.altText || article.title || "封面"} className="max-h-40 w-full object-cover" />
          </figure>
        ) : null}
        {article.summary ? <p className="rounded-md bg-slate-50 px-3 py-2 text-xs leading-6 text-slate-700">{article.summary}</p> : null}
        <div className="whitespace-pre-wrap text-xs leading-6 text-slate-700">{plain || markdown}</div>
      </div>
    );
  }

  return <EmptyState title="暂无正文可预览" description="这篇文章还没有正文内容，生成完成或进入编辑器补充后再看。" />;
}

export default function ArticlesPage() {
  const [center, setCenter] = useState<ArticleManagementCenter>(emptyCenter);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [publishStatus, setPublishStatus] = useState<PublishFilter>("all");
  const [articleType, setArticleType] = useState("all");
  const [ruleName, setRuleName] = useState("all");
  const [source, setSource] = useState("all");
  const [tag, setTag] = useState("all");
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [activeId, setActiveId] = useState("");
  const [activeArticle, setActiveArticle] = useState<Article | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [deleteRequest, setDeleteRequest] = useState<DeleteRequest | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [message, setMessage] = useState("正在读取文章管理中心...");
  const [busy, setBusy] = useState(true);
  const [deleting, setDeleting] = useState(false);

  const requestUrl = useMemo(() => {
    const params = new URLSearchParams({ view: "management" });
    appendParam(params, "status", status);
    appendParam(params, "publishStatus", publishStatus);
    appendParam(params, "articleType", articleType);
    appendParam(params, "ruleName", ruleName);
    appendParam(params, "source", source);
    appendParam(params, "tag", tag);
    appendParam(params, "query", query.trim());
    return `/api/articles?${params.toString()}`;
  }, [articleType, publishStatus, query, ruleName, source, status, tag]);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const next = await jsonFetch<ArticleManagementCenter>(requestUrl);
      setCenter(next);
      setSelectedIds((current) => current.filter((id) => next.records.some((record) => record.articleId === id)));
      setActiveId((current) => current && next.records.some((record) => record.articleId === current) ? current : next.records[0]?.articleId ?? "");
      setMessage(`当前筛选结果 ${next.records.length} 篇，文章库总计 ${next.summary.total} 篇。`);
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
    if (!activeId) {
      setActiveArticle(null);
      setPreviewError("");
      setPreviewLoading(false);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError("");
    jsonFetch<Article>(`/api/articles/${encodeURIComponent(activeId)}`)
      .then((article) => {
        if (!cancelled) setActiveArticle(article);
      })
      .catch((error) => {
        if (!cancelled) {
          setActiveArticle(null);
          setPreviewError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  useEffect(() => {
    if (!deleteRequest) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !deleting) {
        setDeleteRequest(null);
        setDeleteError("");
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [deleteRequest, deleting]);

  const selectedRecords = useMemo(
    () => center.records.filter((record) => selectedIds.includes(record.articleId)),
    [center.records, selectedIds]
  );
  const activeRecord = center.records.find((record) => record.articleId === activeId) ?? null;

  function resetFilters() {
    setStatus("all");
    setPublishStatus("all");
    setArticleType("all");
    setRuleName("all");
    setSource("all");
    setTag("all");
    setQuery("");
  }

  function toggleAll(checked: boolean) {
    setSelectedIds(checked ? center.records.map((record) => record.articleId) : []);
  }

  function toggleOne(recordId: string, checked: boolean) {
    setSelectedIds((current) => checked ? Array.from(new Set([...current, recordId])) : current.filter((id) => id !== recordId));
  }

  async function runBatch(action: BatchAction) {
    if (!selectedIds.length) {
      setMessage("请先选择需要操作的文章。");
      return;
    }
    setBusy(true);
    try {
      const result = await jsonFetch<BatchResult>("/api/batch-operations", {
        method: "POST",
        body: JSON.stringify({ recordIds: selectedIds, action })
      });
      setMessage(formatBatchMessage(result));
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function requestSingleDelete(record: ArticleManagementRecord) {
    setDeleteError("");
    setDeleteRequest({ ids: [record.articleId], titles: [record.title] });
  }

  function requestBatchDelete() {
    if (!selectedRecords.length) {
      setMessage("请先选择需要删除的文章。");
      return;
    }
    setDeleteError("");
    setDeleteRequest({
      ids: selectedRecords.map((record) => record.articleId),
      titles: selectedRecords.map((record) => record.title)
    });
  }

  async function confirmDelete() {
    if (!deleteRequest?.ids.length) return;
    setDeleteError("");
    setDeleting(true);
    try {
      const { ids } = deleteRequest;
      const result = ids.length === 1
        ? await jsonFetch<ArticleDeleteResult>(`/api/articles/${encodeURIComponent(ids[0])}`, { method: "DELETE" })
        : await jsonFetch<BatchDeleteResult>("/api/articles/batch-delete", {
            method: "POST",
            body: JSON.stringify({ articleIds: ids })
          });
      const deletedCount = "items" in result ? result.deleted : 1;
      const retained = result.retainedHistory;
      setDeleteRequest(null);
      setDeleteError("");
      setSelectedIds((current) => current.filter((id) => !ids.includes(id)));
      setActiveId((current) => ids.includes(current) ? "" : current);
      await refresh();
      const publishHistory = retained.publishJobs + retained.mediaOrders;
      setMessage(`已删除 ${deletedCount} 篇本地文章；保留发布记录 ${publishHistory} 条。`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setDeleteError(errorMessage);
      setMessage(errorMessage);
    } finally {
      setDeleting(false);
    }
  }

  const allSelected = center.records.length > 0 && center.records.every((record) => selectedIds.includes(record.articleId));

  return (
    <AppShell>
      <PageHeader
        eyebrow="Article library"
        title="所有文章"
        description="按文章类型、生成规则、来源和发布状态统一管理文章。"
        action={<Link href="/ai-writer"><PrimaryButton><FileText size={16} />新建 AI 文章</PrimaryButton></Link>}
      />

      <div className="space-y-5 p-4 sm:p-6">
        <div className="grid gap-4 md:grid-cols-3">
          <MetricCard label="文章总数" value={center.summary.total} hint={`草稿 ${center.summary.draft} / 待发布 ${center.summary.ready}`} />
          <MetricCard label="生成中" value={center.summary.generating} hint="完成后进入待发布队列" />
          <MetricCard label="已发布" value={center.summary.published} hint="进入发布记录链路" />
        </div>

        <Section title="筛选文章" description="按内容、创作配置和发布进度快速查找。">
          <div className="grid gap-3 xl:grid-cols-[1.3fr_repeat(4,1fr)]">
            <label className="grid gap-1 text-xs font-medium text-muted">
              搜索
              <div className="search-field flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2">
                <Search size={16} />
                <input aria-label="搜索文章" className="w-full min-w-0 bg-transparent text-sm text-ink outline-none" placeholder="标题、关键词或标签" value={query} onChange={(event) => setQuery(event.target.value)} />
              </div>
            </label>
            <SelectFilter label="文章类型" value={articleType} onChange={setArticleType} options={center.facets.articleTypes} />
            <SelectFilter label="生成规则" value={ruleName} onChange={setRuleName} options={center.facets.ruleNames} />
            <SelectFilter label="来源" value={source} onChange={setSource} options={center.facets.sources} />
            <SelectFilter label="标签" value={tag} onChange={setTag} options={center.facets.tags} />
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {articleStatuses.map(([value, label]) => (
              <button key={value} className={statusButtonClass(status === value)} onClick={() => setStatus(value)}>
                {label}
              </button>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {publishStatuses.map(([value, label]) => (
              <button key={value} className={statusButtonClass(publishStatus === value)} onClick={() => setPublishStatus(value)}>
                {label}
              </button>
            ))}
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <SecondaryButton onClick={resetFilters}>重置</SecondaryButton>
            <SecondaryButton onClick={refresh} disabled={busy}><RefreshCw size={15} />刷新</SecondaryButton>
          </div>
          <div className="mt-3">{busy ? <LoadingState label="正在读取文章管理中心" /> : <p className="text-sm text-muted">{message}</p>}</div>
        </Section>

        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <Section
            title="文章列表"
            description="同一行里可以看到创作配置、文章状态和平台发布状态。"
            action={
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted">已选 {selectedRecords.length}</span>
                <SecondaryButton disabled={busy || !selectedIds.length} onClick={() => runBatch("retry-failed")}><RotateCcw size={15} />重试失败发布</SecondaryButton>
                <button
                  type="button"
                  disabled={busy || deleting || !selectedIds.length}
                  onClick={requestBatchDelete}
                  className="focus-ring inline-flex h-9 items-center justify-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 text-sm font-medium text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
                >
                  <Trash2 size={15} />批量删除
                </button>
              </div>
            }
          >
            {center.records.length ? (
              <div className="overflow-auto rounded-xl border border-line bg-panel">
                <table className="w-full min-w-[720px] text-left text-[13px]">
                  <thead className="bg-slate-50 text-xs text-muted">
                    <tr>
                      <th className="px-4 py-3">
                        <input aria-label="选择全部文章" type="checkbox" checked={allSelected} onChange={(event) => toggleAll(event.target.checked)} />
                      </th>
                      <th className="px-4 py-3">文章</th>
                      <th className="px-4 py-3">文章状态</th>
                      <th className="px-4 py-3">发布</th>
                      <th className="px-4 py-3">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {center.records.map((record) => (
                      <tr key={record.articleId} className={`border-t border-line transition-all duration-150 ${activeId === record.articleId ? "bg-[#f3f0ff]/50 border-l-2 border-brand font-semibold" : "bg-panel hover:bg-slate-50/70"}`}>
                        <td className="max-w-[320px] px-4 py-4">
                          <input aria-label={`选择 ${record.title}`} type="checkbox" checked={selectedIds.includes(record.articleId)} onChange={(event) => toggleOne(record.articleId, event.target.checked)} />
                        </td>
                        <td className="px-4 py-3">
                          <button type="button" className="text-left font-medium text-ink hover:text-brand transition-colors" onClick={() => setActiveId(record.articleId)}>
                            {record.title}
                          </button>
                          <p className="mt-1.5 text-xs text-muted">{record.keyword} · {formatAppTimestamp(record.updatedAt)}</p>
                          <p className="mt-1 text-[11px] text-muted">{record.articleType || "未分类"} · {record.ruleName || "未绑定规则"}{record.score ? ` · ${record.score.totalScore} 分` : ""}</p>
                        </td>
                        <td className="px-4 py-3"><StatusBadge status={record.status} /></td>
                        <td className="px-4 py-3"><StatusBadge status={record.publishStatus} /></td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-2">
                            <Link href={articleManagementAction(record).href}><SecondaryButton>{articleManagementAction(record).label}</SecondaryButton></Link>
                            <button
                              type="button"
                              aria-label={`删除 ${record.title}`}
                              title="删除文章"
                              disabled={busy || deleting}
                              onClick={() => requestSingleDelete(record)}
                              className="focus-ring inline-flex size-9 items-center justify-center rounded-md border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState title="没有符合条件的文章" description="切换筛选条件，或先到 AI 创作页生成一篇新文章。" />
            )}
          </Section>

          <Section
            title="文章详情"
            description="正文预览、创作配置与后续操作。"
            action={activeRecord ? <button aria-label="关闭详情" className="text-muted hover:text-ink" onClick={() => setActiveId("")}><X size={16} /></button> : null}
          >
            {activeRecord ? (
              <div className="space-y-4">
                <div>
                  <p className="text-sm font-semibold text-ink">{activeRecord.title}</p>
                  <p className="mt-2 text-xs leading-5 text-muted">{activeRecord.keyword} / {formatAppTimestamp(activeRecord.updatedAt)}</p>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-xl bg-slate-50 p-3 border border-line">
                    <p className="text-muted">文章状态</p>
                    <div className="mt-2"><StatusBadge status={activeRecord.status} /></div>
                  </div>
                  <div className="rounded-xl bg-slate-50 p-3 border border-line">
                    <p className="text-muted">发布状态</p>
                    <div className="mt-2"><StatusBadge status={activeRecord.publishStatus} /></div>
                  </div>
                </div>
                <div className="rounded-xl border border-line bg-slate-50 p-4 text-xs leading-6">
                  <p className="font-semibold text-ink text-sm">创作配置</p>
                  <p className="mt-2 text-muted">规则：{activeRecord.ruleName || "未绑定规则"}</p>
                  <p className="text-muted">类型：{activeRecord.articleType || "未分类"}</p>
                  <p className="text-muted">来源：{activeRecord.source || "未知来源"}</p>
                  <p className="text-muted">标签：{activeRecord.tags.join("、") || "无标签"}</p>
                </div>

                <div className="rounded-xl border border-line bg-white p-4">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <p className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink">
                      <Eye size={15} className="text-brand" />
                      正文预览
                    </p>
                    {previewLoading ? <span className="text-[11px] text-muted">加载中…</span> : null}
                  </div>
                  {previewError ? (
                    <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{previewError}</p>
                  ) : null}
                  {!previewLoading && !previewError && activeArticle ? <div className="max-h-[480px] overflow-y-auto pr-1"><ArticleBodyPreview article={activeArticle} /></div> : null}
                  {!previewLoading && !previewError && !activeArticle ? (
                    <EmptyState title="暂无正文可预览" description="点标题加载正文，或进入编辑器查看完整图文预览。" />
                  ) : null}
                  {previewLoading ? <LoadingState label="正在加载正文" /> : null}
                </div>

                {activeRecord.publishedUrl ? (
                  <div className="rounded-xl border border-line bg-slate-50 p-4 text-xs leading-6">
                    <p className="font-semibold text-ink text-sm">发布 URL</p>
                    <a className="mt-2 block break-all text-brand hover:underline" href={activeRecord.publishedUrl} target="_blank" rel="noreferrer">{activeRecord.publishedUrl}</a>
                  </div>
                ) : null}
                <div className="grid gap-2">
                  <Link href={articleManagementAction(activeRecord).href}><PrimaryButton>{articleManagementAction(activeRecord).label}</PrimaryButton></Link>
                  {!isArticlePublishLocked(activeRecord) ? <Link href="/published"><SecondaryButton>查看发布中心</SecondaryButton></Link> : null}
                  <button
                    type="button"
                    disabled={busy || deleting}
                    onClick={() => requestSingleDelete(activeRecord)}
                    className="focus-ring inline-flex h-9 items-center justify-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 text-sm font-medium text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
                  >
                    <Trash2 size={15} />删除本地文章
                  </button>
                </div>
              </div>
            ) : (
              <EmptyState title="未选择文章" description="点击文章标题后，这里会显示正文预览、状态、配置和后续动作。" />
            )}
          </Section>
        </div>
      </div>

      {deleteRequest ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !deleting) {
            setDeleteRequest(null);
            setDeleteError("");
          }
        }}>
          <div role="dialog" aria-modal="true" aria-labelledby="delete-article-title" className="w-full max-w-md rounded-2xl border border-line bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-700 border border-red-100">
                  <AlertTriangle size={18} />
                </span>
                <div>
                  <h2 id="delete-article-title" className="text-base font-bold text-ink">确认删除</h2>
                  <p className="mt-1 text-xs text-muted">本次将删除 {deleteRequest.ids.length} 篇本地文章。</p>
                </div>
              </div>
              <button type="button" aria-label="关闭删除确认" title="关闭" disabled={deleting} onClick={() => { setDeleteRequest(null); setDeleteError(""); }} className="focus-ring inline-flex size-8 items-center justify-center text-muted hover:text-ink disabled:opacity-60">
                <X size={17} />
              </button>
            </div>
            <div className="space-y-3 px-5 py-4 text-xs leading-5 text-slate-650">
              <p>{deleteRequest.ids.length === 1 ? `将永久删除《${deleteRequest.titles[0]}》的本地正文和编辑内容。` : `将永久删除选中的 ${deleteRequest.ids.length} 篇本地正文和编辑内容。`}</p>
              <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800 font-medium">已发布到外部平台的内容不会被删除，发布记录和公开 URL 会继续保留。</p>
              <p className="text-[11px] text-muted">存在执行中的发布任务时，系统会阻止整次删除，不会产生部分删除。</p>
              {deleteError ? <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-red-750 font-semibold">{deleteError}</p> : null}
            </div>
            <div className="flex justify-end gap-2 border-t border-line px-5 py-4">
              <SecondaryButton disabled={deleting} onClick={() => { setDeleteRequest(null); setDeleteError(""); }}>取消</SecondaryButton>
              <button
                type="button"
                autoFocus
                disabled={deleting}
                onClick={confirmDelete}
                className="focus-ring inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-red-600 px-4 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Trash2 size={15} />{deleting ? "正在删除..." : "确认删除"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}
