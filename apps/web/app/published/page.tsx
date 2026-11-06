"use client";

import { AppShell } from "@/components/app-shell";
import { useDesktopRequirement } from "@/components/desktop-requirement-provider";
import { DetailPanel } from "@/components/detail-panel";
import { canRetryPublication, publicationGroup, publicationGroups, publicationStatus, type PublicationGroup } from "@/lib/publication-presentation";
import { StatusBadge } from "@/components/status-badge";
import { EmptyState, LoadingState, SecondaryButton } from "@/components/ui";
import type { PublishedCenterRecord, PublishedRecordDetail } from "@zengxing/core";
import {
  CheckCircle2,
  Copy,
  FileText,
  History,
  RefreshCcw,
  RotateCcw,
  Search,
  ChevronRight,
  Circle,
} from "lucide-react";
import { formatAppTimestamp } from "@/lib/app-time";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

type PublishedCenterResponse = {
  records: PublishedCenterRecord[];
  summary: {
    total: number;
    site: number;
    media: number;
    succeeded: number;
    failed: number;
  };
};

type BatchResult = {
  requested: number;
  matched: number;
  retried: number;
  skipped: number;
  errors: string[];
};

type QueuedPublicationRecheckResult = {
  queued: boolean;
  task: { id: string; type: string; queue: string } | null;
  desktopCommand?: { id: string; type: string; status: string };
};

function canRecheckPublicationRecord(record: PublishedCenterRecord) {
  const platform = record.platform ?? "";
  const canDiscoverFromAccount = ["netease", "penguin", "sohu", "toutiao"].includes(platform) && Boolean(record.mediaAccountId);
  return record.sourceType === "media"
    && record.status === "review_required"
    && Boolean(record.reviewUrl || record.publishedUrl || canDiscoverFromAccount);
}

// Platforms whose public article pages reject a plain server-side fetch, so a supplied
// URL can only be confirmed by the desktop browser session.
const BROWSER_VERIFIED_PLATFORMS = ["zhihu"];

function isBrowserVerifiedPlatform(record: PublishedCenterRecord) {
  return BROWSER_VERIFIED_PLATFORMS.includes(record.platform ?? "");
}

function isPlatformPublishUrl(platform: string | undefined, value: string) {
  const text = value.trim();
  if (!text) return false;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (platform === "zhihu") return host === "zhihu.com" || host.endsWith(".zhihu.com");
  return true;
}

// A failed record with no callback URL may still have been published: the platform
// answer was unreadable or non-canonical. The operator pastes the published URL they
// can see on the platform instead of republishing, which would create a second article.
function canSupplyPublicationUrl(record: PublishedCenterRecord) {
  return record.sourceType === "media"
    && record.status === "failed"
    && !record.publishedUrl
    && !record.reviewUrl
    && isBrowserVerifiedPlatform(record)
    && Boolean(record.mediaAccountId);
}

function supplyPublicationUrlText(record: PublishedCenterRecord) {
  if (!canSupplyPublicationUrl(record)) return "";
  return "平台可能已发布成功但回调异常。打开详情粘贴知乎文章地址，由桌面端确认后补回公开 URL，不要直接重试发布。";
}

type SourceFilter = "all" | PublishedCenterRecord["sourceType"];
type StatusFilter = "all" | PublicationGroup;
type BatchAction = "retry-failed";

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}

function formatBatchMessage(result: BatchResult) {
  const pieces = [
    `匹配 ${result.matched}/${result.requested}`,
    result.retried ? `重试发布 ${result.retried}` : "",
    result.skipped ? `跳过 ${result.skipped}` : ""
  ].filter(Boolean);
  return `${pieces.join("，")}${result.errors.length ? `。异常：${result.errors.join("；")}` : ""}`;
}

function isManualVerificationRecord(record: Pick<PublishedCenterRecord, "platformStatus" | "errorMessage">) {
  const text = `${record.platformStatus ?? ""} ${record.errorMessage ?? ""}`;
  return /manual_verification_required|manual_action_required|MANUAL_ACTION_REQUIRED|安全验证|验证码|滑块/i.test(text);
}

function manualVerificationText(record: Pick<PublishedCenterRecord, "platform" | "errorMessage">) {
  if (record.platform === "sohu") return "搜狐号上传图片或封面时触发安全验证，请在桌面端浏览器完成验证后重试发布。";
  return record.errorMessage || "平台触发安全验证，请在桌面端浏览器完成验证后重试发布。";
}

function isDistributionRestrictedRecord(record: Pick<PublishedCenterRecord, "platformStatus" | "publicDiscoveryStatus">) {
  return record.platformStatus === "published_restricted" || record.publicDiscoveryStatus === "restricted";
}

function distributionRestrictedText(record: Pick<PublishedCenterRecord, "errorMessage">) {
  return record.errorMessage || "网易号后台已发布，但平台限制内容分发，当前没有公开 URL。请前往网易号内容管理点击申诉。";
}

function readableRecordMessage(message?: string) {
  const text = String(message ?? "").trim();
  if (!text) return "";
  if (/^\?+(?:\s*URL\??)?$/.test(text)) return "";
  return text;
}

function publicationUrlStatusText(record: PublishedCenterRecord) {
  if (isManualVerificationRecord(record)) return manualVerificationText(record);
  if (isDistributionRestrictedRecord(record)) return distributionRestrictedText(record);
  if (record.status === "failed") return readableRecordMessage(record.errorMessage) || "平台发布失败，未生成公开文章 URL。";
  if (record.publicDiscoveryStatus === "queued") return "正在从平台内容管理发现公开 URL。";
  if (record.publicDiscoveryStatus === "candidate_found") return "已发现候选地址，但还没有确认命中本次文章，暂不作为补回链展示。";
  if (record.reviewUrl) return "已保留平台后台或候选地址用于复验；只有确认命中本次文章后才会展示真实公开 URL。";
  return readableRecordMessage(record.errorMessage) || "等待平台公开文章 URL。";
}

export default function PublishedPage() {
  const { requireDesktop } = useDesktopRequirement();
  const [records, setRecords] = useState<PublishedCenterRecord[]>([]);
  const [summary, setSummary] = useState<PublishedCenterResponse["summary"]>({
    total: 0,
    site: 0,
    media: 0,
    succeeded: 0,
    failed: 0,
  });
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [keyword, setKeyword] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [activeRecordId, setActiveRecordId] = useState("");
  const [detail, setDetail] = useState<PublishedRecordDetail | null>(null);
  const [message, setMessage] = useState("发布记录中心统一展示文章、平台账号、审核状态和真实公开 URL。");
  const [busy, setBusy] = useState(true);
  const [detailBusy, setDetailBusy] = useState(false);
  const [repairUrl, setRepairUrl] = useState("");
  const refreshInFlight = useRef(false);
  const activeRecordRef = useRef("");
  const detailRequest = useRef(0);
  const [detailError, setDetailError] = useState("");

  async function refreshCenter() {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setBusy(true);
    try {
      const data = await jsonFetch<PublishedCenterResponse>("/api/published-center", {
        signal: AbortSignal.timeout(20000),
        cache: "no-store",
      });
      setRecords(data.records);
      setSummary(data.summary);
      setSelectedIds((current) => current.filter((id) => data.records.some((record) => record.id === id)));
      const selected = activeRecordRef.current;
      if (selected && data.records.some((record) => record.id === selected)) {
        await loadDetail(selected, true);
      } else if (selected) {
        closeDetail();
      }
      setMessage(`已刷新 ${data.records.length} 条发布记录。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      refreshInFlight.current = false;
      setBusy(false);
    }
  }

  function closeDetail() {
    detailRequest.current += 1;
    activeRecordRef.current = "";
    setActiveRecordId("");
    setDetail(null);
    setDetailBusy(false);
    setDetailError("");
  }

  async function loadDetail(recordId: string, background = false) {
    const request = ++detailRequest.current;
    activeRecordRef.current = recordId;
    setActiveRecordId(recordId);
    if (!background) { setDetail(null); setRepairUrl(""); setDetailBusy(true); }
    setDetailError("");
    try {
      const nextDetail = await jsonFetch<PublishedRecordDetail>(`/api/published-center/${encodeURIComponent(recordId)}`, { signal: AbortSignal.timeout(20000), cache: "no-store" });
      if (request === detailRequest.current) setDetail(nextDetail);
    } catch (error) {
      if (request === detailRequest.current) setDetailError(error instanceof Error ? error.message : String(error));
    } finally {
      if (request === detailRequest.current) setDetailBusy(false);
    }
  }

  useEffect(() => {
    refreshCenter();
    const timer = window.setInterval(refreshCenter, 10000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredRecords = useMemo(() => {
    const query = keyword.trim().toLowerCase();
    return records.filter((record) => {
      if (sourceFilter !== "all" && record.sourceType !== sourceFilter) return false;
      if (statusFilter !== "all" && publicationGroup(record) !== statusFilter) return false;
      if (query) {
        const haystack = `${record.articleTitle} ${record.channelName} ${record.channelType} ${record.publishedUrl ?? ""} ${record.reviewUrl ?? ""}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }, [keyword, records, sourceFilter, statusFilter]);

  const allSelected = filteredRecords.length > 0 && filteredRecords.every((record) => selectedIds.includes(record.id));
  const eligibleRetries = records.filter((record) => selectedIds.includes(record.id) && canRetryPublication(record));
  const eligibleRechecks = records.filter((record) => selectedIds.includes(record.id) && canRecheckPublicationRecord(record));
  const groups = publicationGroups.map((group) => ({ ...group, records: filteredRecords.filter((record) => publicationGroup(record) === group.id) }));

  async function copyUrl(url?: string) {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setMessage("公开链接已复制。");
    } catch { setMessage("复制失败，请在详情中手动复制链接。"); }
  }

  function toggleAll(checked: boolean) {
    setSelectedIds((current) => checked ? Array.from(new Set([...current, ...filteredRecords.map((record) => record.id)])) : current.filter((id) => !filteredRecords.some((record) => record.id === id)));
  }

  function toggleOne(recordId: string, checked: boolean) {
    setSelectedIds((current) => checked ? Array.from(new Set([...current, recordId])) : current.filter((id) => id !== recordId));
  }

  async function runBatch(action: BatchAction, explicitIds = selectedIds, recoveryCompleted = false) {
    const retryIds = records.filter((record) => explicitIds.includes(record.id) && canRetryPublication(record, recoveryCompleted)).map((record) => record.id);
    if (!retryIds.length) {
      setMessage("所选记录没有可直接重试的失败任务，请在详情中查看处理方式。");
      return;
    }
    if (action === "retry-failed" && !requireDesktop("文章发布")) return;
    setBusy(true);
    try {
      const result = await jsonFetch<BatchResult>("/api/batch-operations", {
        method: "POST",
        body: JSON.stringify({ recordIds: retryIds, action })
      });
      setMessage(formatBatchMessage(result));
      await refreshCenter();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function recheckPublicationRecords(explicitIds = selectedIds, suppliedUrl = "") {
    const targets = records.filter((record) =>
      explicitIds.includes(record.id)
      && (canRecheckPublicationRecord(record) || (Boolean(suppliedUrl) && canSupplyPublicationUrl(record)))
    );
    if (!targets.length) {
      setMessage("请选择待复验或可从平台内容管理发现公开 URL 的媒体记录。");
      return;
    }
    if (!requireDesktop("发布复验")) return;
    setBusy(true);
    try {
      const results: QueuedPublicationRecheckResult[] = [];
      for (const record of targets) {
        results.push(await jsonFetch<QueuedPublicationRecheckResult>("/api/media-orders/recheck-publication", {
          method: "POST",
          body: JSON.stringify({
            orderId: record.sourceId,
            url: (canSupplyPublicationUrl(record) && suppliedUrl) || record.reviewUrl || record.publishedUrl || "",
            checkImmediately: true,
            async: true
          })
        }));
      }
      setMessage(suppliedUrl
        ? `已按提供的地址入队复验 ${results.length} 条；桌面端确认命中后会回写真实公开 URL。`
        : `公开 URL 发现/复验已入队 ${results.length} 条；确认命中本次文章后会回写真实公开 URL。`);
      setRepairUrl("");
      await refreshCenter();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell
        title="发布记录"
        description="关注需要处理的任务，追踪平台审核与公开链接。"
        action={<SecondaryButton disabled={busy} onClick={refreshCenter}><RefreshCcw size={15} className={busy ? "animate-spin" : undefined} />刷新记录</SecondaryButton>}
      >
      <div className="grid min-h-[calc(100dvh-80px)] bg-white xl:grid-cols-[minmax(0,1fr)_360px] 2xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 px-4 pb-6 sm:px-7">
          <div className="flex flex-wrap items-center gap-x-5 border-b border-line" aria-label="发布状态筛选">
            {[{ id: "all", label: "全部" }, ...publicationGroups].map((group) => {
              const count = group.id === "all" ? records.length : records.filter((record) => publicationGroup(record) === group.id).length;
              return <button key={group.id} type="button" aria-pressed={statusFilter === group.id} onClick={() => setStatusFilter(group.id as StatusFilter)} className={`inline-flex h-14 items-center gap-2 border-b-2 text-[13px] transition-colors ${statusFilter === group.id ? "border-brand font-semibold text-brand" : "border-transparent text-muted hover:text-ink"}`}>
                {group.label}<span className={`rounded-md px-1.5 py-0.5 text-[11px] ${statusFilter === group.id ? "bg-violet-50" : "bg-slate-100"}`}>{count}</span>
              </button>;
            })}
          </div>

          <div className="flex flex-wrap items-center gap-3 py-4">
            <button type="button" aria-label="刷新记录" disabled={busy} onClick={refreshCenter} className="grid size-9 shrink-0 place-items-center rounded-lg border border-line text-muted disabled:opacity-50 sm:hidden"><RefreshCcw size={15} className={busy ? "animate-spin" : undefined} /></button>
            <label className="search-field flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line px-3">
              <Search size={16} className="shrink-0 text-muted" />
              <input aria-label="搜索发布记录" className="w-full min-w-0 py-1 text-[13px] outline-none" placeholder="搜索文章、平台账号或链接…" value={keyword} onChange={(event) => setKeyword(event.target.value)} />
            </label>
            <select aria-label="发布来源" className="h-9 px-3 text-xs" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as SourceFilter)}>
              <option value="all">全部来源</option><option value="site">集成网站</option><option value="media">媒体账号</option>
            </select>
            {(keyword || sourceFilter !== "all" || statusFilter !== "all") ? <button type="button" className="text-xs text-muted hover:text-brand" onClick={() => { setKeyword(""); setSourceFilter("all"); setStatusFilter("all"); }}>重置</button> : null}
          </div>

          <div className="flex min-h-10 flex-wrap items-center justify-between gap-3 border-y border-line py-2 text-xs text-muted">
            <label className="flex items-center gap-3"><input aria-label="选择全部发布记录" type="checkbox" checked={allSelected} ref={(node) => { if (node) node.indeterminate = !allSelected && filteredRecords.some((record) => selectedIds.includes(record.id)); }} onChange={(event) => toggleAll(event.target.checked)} />{selectedIds.length ? `已选 ${selectedIds.length} 条` : `共 ${filteredRecords.length} 条记录`}</label>
            {selectedIds.length ? <div className="flex flex-wrap gap-2">
              <SecondaryButton disabled={busy || !eligibleRechecks.length} onClick={() => recheckPublicationRecords()}><RefreshCcw size={14} />复验公开 {eligibleRechecks.length}</SecondaryButton>
              <SecondaryButton disabled={busy || !eligibleRetries.length} onClick={() => runBatch("retry-failed")}><RotateCcw size={14} />重试失败 {eligibleRetries.length}</SecondaryButton>
              <button className="px-1 text-xs hover:text-brand" onClick={() => setSelectedIds([])}>取消选择</button>
            </div> : <span>文章 · 平台账号 · 发布状态</span>}
          </div>

          <div aria-label="发布记录列表">
            {groups.filter((group) => group.records.length).map((group) => <section key={group.id} aria-label={group.label}>
              <h2 className="flex items-center gap-2 border-b border-line py-4 text-[13px] font-semibold text-ink"><Circle size={15} className={group.tone} />{group.label}<span className={`ml-1 text-xs font-normal ${group.tone}`}>{group.records.length}</span></h2>
              {group.records.map((record) => <article key={record.id} className={`group flex items-center gap-3 border-b border-line px-1 transition-colors ${activeRecordId === record.id ? "bg-[#f4f0ff] shadow-[inset_2px_0_0_#6236ff]" : "hover:bg-slate-50"}`}>
                <input className="ml-1" aria-label={`选择 ${record.articleTitle}`} type="checkbox" checked={selectedIds.includes(record.id)} onChange={(event) => toggleOne(record.id, event.target.checked)} />
                <button type="button" aria-label={`查看详情：${record.articleTitle} · ${record.channelName}`} aria-pressed={activeRecordId === record.id} onClick={() => loadDetail(record.id)} className="flex min-w-0 flex-1 items-center gap-3 py-4 pr-2 text-left">
                  <span className="hidden size-10 shrink-0 items-center justify-center rounded-lg border border-line bg-white text-slate-400 sm:flex"><FileText size={20} strokeWidth={1.5} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-ink">{record.articleTitle}</span>
                    <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted"><span>{record.channelName}</span><span aria-hidden="true">·</span><span>{formatAppTimestamp(record.updatedAt)}</span></span>
                    {group.id === "attention" ? <span className="mt-1 block line-clamp-1 text-[11px] text-rose-600">{supplyPublicationUrlText(record) || publicationUrlStatusText(record)}</span> : null}
                  </span>
                  <StatusBadge status={publicationStatus(record)} label={group.id === "public" ? "已公开" : record.status === "succeeded" && group.id === "unconfirmed" ? "公开待确认" : undefined} />
                  <ChevronRight size={15} className="hidden shrink-0 text-slate-400 sm:block" />
                </button>
              </article>)}
            </section>)}
          </div>
          {!filteredRecords.length && !busy ? <EmptyState title={records.length ? "没有匹配的发布记录" : "暂无发布记录"} description={records.length ? "试试其他关键词，或重置筛选条件。" : "完成平台发布后，在这里跟踪审核进度和公开链接。"} /> : null}
          <div className="mt-4" role="status">{busy ? <LoadingState label="正在刷新发布记录" /> : <p className="break-words text-xs leading-6 text-muted">{message}</p>}</div>
          <p className="mt-2 text-[11px] text-muted">共 {summary.total} 条 · 网站 {summary.site} / 媒体 {summary.media}</p>
        </div>

        <DetailPanel title="发布详情" open={Boolean(activeRecordId)} onClose={closeDetail}>
            {detailBusy ? <LoadingState label="正在读取发布详情" /> : null}
            {!activeRecordId && !detailBusy ? <EmptyState title="未选择记录" description="点击任意发布记录，可以查看平台审核时间线、公开 URL 和可执行动作。" /> : null}
            {detailError ? <div role="alert" className="space-y-3 rounded-lg bg-rose-50 p-4 text-xs text-rose-700"><p>{detailError}</p><SecondaryButton onClick={() => loadDetail(activeRecordId)}>重新加载详情</SecondaryButton></div> : null}
            {detail ? (
              <div className="space-y-5">
                <div className="border-b border-line pb-5">
                  <p className="text-lg font-semibold leading-7 text-ink">{detail.record.articleTitle}</p>
                  <p className="mt-2 text-xs leading-5 text-muted">{detail.record.channelName} · {detail.record.channelType}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <StatusBadge status={publicationStatus(detail.record)} label={publicationGroup(detail.record) === "public" ? "已公开" : undefined} />
                    {isDistributionRestrictedRecord(detail.record) ? <StatusBadge status="distribution_restricted" /> : null}
                    {detail.record.backlinkStatus && detail.record.backlinkStatus !== "reviewing" && publicationGroup(detail.record) !== "public" ? <StatusBadge status={detail.record.backlinkStatus} /> : null}
                  </div>
                  {detail.record.publishedUrl ? (
                    <div className="mt-3 rounded-md bg-slate-50 p-3 text-xs leading-5 text-slate-700">
                      <p className="font-semibold text-ink">{detail.record.sourceType === "site" ? "发布 URL" : "公开文章链接"}</p>
                      <a href={detail.record.publishedUrl} target="_blank" rel="noreferrer" className="mt-1 block break-all text-brand hover:underline">{detail.record.publishedUrl}</a>
                      {detail.record.backlinkStatus === "reviewing" ? <p className="mt-2 text-amber-700">平台已接收发布请求，公开后将自动回写真实文章 URL。</p> : null}
                    </div>
                  ) : null}
                  {!detail.record.publishedUrl && detail.record.reviewUrl ? (
                    <div className="mt-3 rounded-md bg-amber-50 p-3 text-xs leading-5 text-amber-800">
                      <p className="font-semibold">公开链接待确认</p>
                      <p className="mt-2">已保留平台审核线索，确认链接命中本次文章后，才会展示真实公开 URL。</p>
                    </div>
                  ) : null}
                  {!detail.record.publishedUrl && !detail.record.reviewUrl && publicationGroup(detail.record) !== "attention" ? <div className="mt-4 rounded-lg border border-line bg-slate-50 p-3 text-xs leading-6 text-muted"><p className="font-medium text-ink">公开链接待确认</p>{publicationUrlStatusText(detail.record)}</div> : null}
                  {isManualVerificationRecord(detail.record) ? (
                    <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">{manualVerificationText(detail.record)}</p>
                  ) : isDistributionRestrictedRecord(detail.record) ? (
                    <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">{distributionRestrictedText(detail.record)}</p>
                  ) : readableRecordMessage(detail.record.errorMessage) ? <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">{readableRecordMessage(detail.record.errorMessage)}</p> : null}
                  {canRecheckPublicationRecord(detail.record) ? (
                    <div className="mt-3">
                      <SecondaryButton disabled={busy} onClick={() => recheckPublicationRecords([detail.record.id])}><RefreshCcw size={15} />{detail.record.reviewUrl ? "复验公开" : "发现公开 URL"}</SecondaryButton>
                    </div>
                  ) : null}
                  {publicationStatus(detail.record) === "needs_reauth" ? <Link href="/free-media" className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg border border-line px-3 text-[13px] font-medium text-brand hover:bg-violet-50">前往媒体账号，重新授权<ChevronRight size={14} /></Link> : null}
                  {canSupplyPublicationUrl(detail.record) ? (
                    <div className="mt-3 rounded-md border border-line bg-slate-50 p-3">
                      <p className="text-xs font-semibold text-ink">补回公开 URL</p>
                      <p className="mt-1 text-xs leading-5 text-muted">平台可能已发布成功但回调异常。粘贴你在平台上看到的文章地址，由桌面端浏览器打开确认命中后回写；请不要直接重试发布，否则会产生第二篇文章。</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <input
                          aria-label={`${detail.record.channelName}公开文章地址`}
                          className="min-w-0 flex-1 rounded-md border border-line px-3 py-2 text-sm"
                          placeholder="https://zhuanlan.zhihu.com/p/..."
                          inputMode="url"
                          value={repairUrl}
                          onChange={(event) => setRepairUrl(event.target.value)}
                        />
                        <SecondaryButton
                          disabled={busy || !isPlatformPublishUrl(detail.record.platform, repairUrl)}
                          onClick={() => recheckPublicationRecords([detail.record.id], repairUrl.trim())}
                        ><RefreshCcw size={15} />补回 URL</SecondaryButton>
                      </div>
                      {repairUrl.trim() && !isPlatformPublishUrl(detail.record.platform, repairUrl) ? (
                        <p className="mt-2 text-xs text-red-700">地址需以 http:// 或 https:// 开头，且为 zhihu.com 域名。</p>
                      ) : null}
                    </div>
                  ) : null}
                  {["manual_verification_required", "needs_reauth"].includes(publicationStatus(detail.record)) && canRetryPublication(detail.record, true) ? <div className="mt-4"><SecondaryButton disabled={busy} onClick={() => {
                    if (!requireDesktop("文章发布")) return;
                    const recovery = publicationStatus(detail.record) === "needs_reauth" ? "账号重新授权" : "平台安全验证";
                    if (window.confirm(`请确认已在桌面端浏览器完成${recovery}。确认后将重试这条失败任务。`)) void runBatch("retry-failed", [detail.record.id], true);
                  }}><RotateCcw size={14} />{publicationStatus(detail.record) === "needs_reauth" ? "授权完成后重试" : "完成验证后重试"}</SecondaryButton></div> : null}
                </div>

                <div>
                  <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink"><History size={16} />时间线</p>
                  <div className="ml-2 border-l border-line pl-5">
                    {detail.timeline.filter((item) => item.type === "created" || item.type === "published" || item.type === "failed").map((item, index) => (
                      <div key={`${item.type}-${index}`} className={`relative mb-5 text-sm ${item.status === "failed" ? "text-rose-700" : "text-ink"}`}>
                        <span className={`absolute -left-[27px] top-1.5 size-3 rounded-full border-2 border-white ring-1 ${item.status === "failed" ? "bg-rose-400 ring-rose-200" : item.status === "succeeded" ? "bg-emerald-500 ring-emerald-200" : item.status === "review_required" ? "bg-amber-400 ring-amber-200" : "bg-slate-300 ring-slate-200"}`} />
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="font-semibold">{item.title}</p>
                          <span className="text-xs opacity-80">{item.at ? formatAppTimestamp(item.at) : "时间未记录"}</span>
                        </div>
                        <p className="mt-1 break-all text-xs leading-5 opacity-90">{item.description}</p>
                      </div>
                    ))}
                    {!detail.timeline.length ? <p className="text-xs text-muted">暂无时间线记录。</p> : null}
                  </div>
                </div>

                <div>
                  <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink"><CheckCircle2 size={16} />下一步动作</p>
                  <div className="grid gap-2">
                    {canRetryPublication(detail.record) && !detail.nextActions.some((action) => action.action === "retry-failed") ? <SecondaryButton disabled={busy} onClick={() => runBatch("retry-failed", [detail.record.id])}><RotateCcw size={15} />重试失败任务</SecondaryButton> : null}
                    {detail.nextActions
                      .filter((action) => (action.action === "retry-failed" && canRetryPublication(detail.record)) || action.action === "copy-url")
                      .map((action) => {
                        const click = action.action === "retry-failed"
                          ? () => runBatch("retry-failed", [detail.record.id])
                          : () => copyUrl(detail.record.publishedUrl);
                        return (
                          <button
                            key={action.action}
                            type="button"
                            disabled={!action.enabled || busy}
                            onClick={click}
                            className="flex items-center justify-between gap-3 rounded-lg border border-line bg-white px-3 py-3 text-left text-[13px] transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <span>
                              <span className="block font-medium text-ink">{action.label}</span>
                              {action.reason ? <span className="text-xs text-muted">{action.reason}</span> : null}
                            </span>
                            {action.action === "retry-failed" ? <RotateCcw size={15} /> : <Copy size={15} />}
                          </button>
                        );
                      })}
                  </div>
                </div>
              </div>
            ) : null}
        </DetailPanel>
      </div>
    </AppShell>
  );
}
