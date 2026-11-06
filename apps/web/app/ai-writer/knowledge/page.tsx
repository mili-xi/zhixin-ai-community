"use client";

import { AppShell } from "@/components/app-shell";
import { EmptyState, LoadingState, MetricCard, PageHeader, PrimaryButton, Section, SecondaryButton } from "@/components/ui";
import { jsonFetch, pollTask, type AppTask } from "@/lib/tasks";
import type { KnowledgeItem } from "@zengxing/core";
import { BookOpen, CheckSquare, Database, FileUp, Globe2, Plus, RefreshCw, RotateCcw, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatAppTimestamp } from "@/lib/app-time";

type KnowledgeSource = KnowledgeItem["source"] | "upload";
type KnowledgeStatus = KnowledgeItem["status"] | "queued" | "running";
type SourceFilter = KnowledgeSource | "all";
type StatusFilter = KnowledgeStatus | "all";
type KnowledgeRuntimeItem = Omit<KnowledgeItem, "source" | "status"> & {
  source: KnowledgeSource;
  status: KnowledgeStatus;
  taskId?: string;
  chunkCount?: number;
  vectorCount?: number;
  errorMessage?: string;
};

const sourceLabels: Record<KnowledgeSource, string> = {
  local_file: "本地上传",
  upload: "文件上传",
  asset: "素材上传",
  text: "输入文本",
  url: "网页 URL"
};

const statusLabels: Record<KnowledgeStatus, string> = {
  queued: "已入队",
  running: "处理中",
  parsing: "解析中",
  learning: "学习中",
  completed: "学习完成",
  failed: "学习失败"
};

const refreshLabels: Record<KnowledgeItem["refreshMode"], string> = {
  manual: "手动刷新",
  daily: "每日刷新",
  weekly: "每周刷新"
};

function splitList(value: string) {
  return value.split(/[,\n，、]/).map((item) => item.trim()).filter(Boolean);
}

function statusClass(status: KnowledgeStatus) {
  if (status === "completed") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "failed") return "border-red-200 bg-red-50 text-red-700";
  if (status === "queued") return "border-blue-200 bg-blue-50 text-blue-700";
  return "border-amber-200 bg-amber-50 text-amber-700";
}

function isOpenTask(status: KnowledgeStatus) {
  return ["queued", "running", "parsing", "learning"].includes(status);
}

function toggleSetValue<T>(set: Set<T>, value: T) {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export default function KnowledgeBasePage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollingRef = useRef<Set<string>>(new Set());
  const [items, setItems] = useState<KnowledgeRuntimeItem[]>([]);
  const [taskStates, setTaskStates] = useState<Record<string, AppTask>>({});
  const [message, setMessage] = useState("贴链接、上传文件或粘贴正文，系统自动学习。知乎等登录墙请改粘贴正文。");
  const [busy, setBusy] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [form, setForm] = useState({
    title: "",
    source: "url" as KnowledgeSource,
    url: "",
    content: "",
    tags: "",
    refreshMode: "manual" as KnowledgeItem["refreshMode"]
  });
  const [fetchEngine, setFetchEngine] = useState<{ available: boolean; hint: string; mode?: string }>({
    available: false,
    hint: "检查抓取引擎中…"
  });

  async function refresh() {
    const nextItems = (await jsonFetch<KnowledgeRuntimeItem[]>("/api/knowledge-base")).map((item) => ({
      ...item,
      // legacy API used source=web; normalize for filters
      source: (item.source as string) === "web" ? "url" : item.source
    }));
    setItems(nextItems);
    setActiveId((current) => current ?? nextItems[0]?.id ?? null);
  }

  async function pollKnowledgeTask(item: KnowledgeRuntimeItem) {
    if (!item.taskId || pollingRef.current.has(item.taskId)) return;
    pollingRef.current.add(item.taskId);
    try {
      const completed = await pollTask(item.taskId, {
        onUpdate: (task) => {
          setTaskStates((current) => ({ ...current, [task.id]: task }));
          const progress = typeof task.progress === "number" ? ` / ${task.progress}%` : "";
          setMessage(`知识库任务 ${task.id}：${task.status}${progress}`);
        }
      });
      setTaskStates((current) => ({ ...current, [completed.id]: completed }));
      await refresh();
      setMessage(`知识库解析完成：${item.title}`);
    } catch (error) {
      await refresh();
      const text = error instanceof Error ? error.message : String(error);
      setMessage(text.includes("登录") || text.includes("反爬") || text.includes("知乎")
        ? `${text}（建议：粘贴正文或上传文件）`
        : text);
    } finally {
      pollingRef.current.delete(item.taskId);
    }
  }

  useEffect(() => {
    refresh().catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
    jsonFetch<{ knowledgeFetch?: { available?: boolean; hint?: string; mode?: string } }>("/api/ai/providers/status")
      .then((data) => {
        setFetchEngine({
          available: Boolean(data.knowledgeFetch?.available),
          hint: data.knowledgeFetch?.hint || "抓取状态未知",
          mode: data.knowledgeFetch?.mode
        });
      })
      .catch(() => setFetchEngine({ available: false, hint: "无法读取抓取引擎状态" }));
  }, []);

  useEffect(() => {
    items
      .filter((item) => item.taskId && isOpenTask(item.status))
      .forEach((item) => void pollKnowledgeTask(item));
  }, [items]);

  const metrics = useMemo(() => ({
    total: items.length,
    completed: items.filter((item) => item.status === "completed").length,
    learning: items.filter((item) => isOpenTask(item.status)).length,
    chunks: items.reduce((sum, item) => sum + (item.chunkCount ?? 0), 0),
    scheduled: items.filter((item) => item.refreshMode !== "manual").length
  }), [items]);

  const filteredItems = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return items.filter((item) => {
      const sourceOk = sourceFilter === "all" || item.source === sourceFilter;
      const statusOk = statusFilter === "all" || item.status === statusFilter;
      const haystack = `${item.title} ${item.content} ${item.url ?? ""} ${item.tags.join(" ")}`.toLowerCase();
      return sourceOk && statusOk && (!keyword || haystack.includes(keyword));
    });
  }, [items, query, sourceFilter, statusFilter]);

  const activeItem = items.find((item) => item.id === activeId) ?? filteredItems[0] ?? null;
  const allVisibleSelected = filteredItems.length > 0 && filteredItems.every((item) => selectedIds.has(item.id));

  async function createItem(source?: KnowledgeSource) {
    setBusy(true);
    try {
      const selectedSource = source ?? form.source;
      let created: KnowledgeRuntimeItem;
      if (selectedSource === "url") {
        if (!form.url.trim()) throw new Error("请先填写网页 URL。");
        created = await jsonFetch<KnowledgeRuntimeItem>("/api/knowledge-base/fetch-url", {
          method: "POST",
          body: JSON.stringify({
            title: form.title,
            url: form.url,
            tags: splitList(form.tags),
            refreshMode: form.refreshMode
          })
        });
      } else if (selectedSource === "local_file" || selectedSource === "asset" || selectedSource === "upload") {
        const file = fileInputRef.current?.files?.[0];
        if (!file) throw new Error("请先选择要上传的知识文件。");
        const body = new FormData();
        body.set("file", file);
        body.set("title", form.title || file.name);
        body.set("tags", form.tags);
        const response = await fetch("/api/knowledge-base/upload", { method: "POST", body });
        if (!response.ok) throw new Error(await response.text());
        created = await response.json() as KnowledgeRuntimeItem;
      } else {
        created = await jsonFetch<KnowledgeRuntimeItem>("/api/knowledge-base", {
          method: "POST",
          body: JSON.stringify({
            title: form.title,
            source: selectedSource,
            content: form.content,
            tags: splitList(form.tags),
            refreshMode: form.refreshMode,
            status: "completed"
          })
        });
      }
      await refresh();
      setActiveId(created.id);
      if (created.taskId) {
        setMessage(`知识库任务已入队：${created.taskId}，正在等待解析和向量化。`);
        await pollKnowledgeTask(created);
      } else {
        setMessage(`已加入知识库：${created.title}`);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function refreshItem(itemId: string) {
    return jsonFetch<KnowledgeRuntimeItem>("/api/knowledge-base", {
      method: "POST",
      body: JSON.stringify({ refreshId: itemId })
    });
  }

  async function refreshSelected() {
    const ids = selectedIds.size ? Array.from(selectedIds) : activeItem ? [activeItem.id] : [];
    if (!ids.length) return;
    setBusy(true);
    try {
      for (const id of ids) await refreshItem(id);
      await refresh();
      setMessage(`已刷新 ${ids.length} 条知识资料，学习状态已回写。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function refreshOne(itemId: string) {
    setBusy(true);
    try {
      const updated = await refreshItem(itemId);
      await refresh();
      setActiveId(updated.id);
      setMessage(`已刷新知识资料：${updated.title}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function retryTask(taskId: string) {
    setBusy(true);
    try {
      const result = await jsonFetch<{ task: AppTask }>(`/api/failure-center/${encodeURIComponent(taskId)}/retry`, { method: "POST" });
      setTaskStates((current) => ({ ...current, [result.task.id]: result.task }));
      setMessage(`知识库任务已重新入队：${result.task.id}`);
      await pollTask(result.task.id, { onUpdate: (task) => setTaskStates((current) => ({ ...current, [task.id]: task })) });
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell>
      <PageHeader
        eyebrow="AI Support"
        title="知识库"
        description="三种喂法：①贴网页链接（已接 Scrapling 增强抓取）②上传 PDF/Word/TXT ③粘贴正文。难抓站点会自动升到隐身浏览器。"
        action={<PrimaryButton disabled={busy} onClick={() => createItem()}><Plus size={16} />新增资料</PrimaryButton>}
      />

      <div className="space-y-6 p-6">
        <div
          className={`rounded-2xl border px-4 py-3 text-sm leading-6 ${
            fetchEngine.available ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900"
          }`}
        >
          <p className="font-semibold">{fetchEngine.available ? "Scrapling 增强抓取已启用" : "Scrapling 未装上"}</p>
          <p className="mt-1">{fetchEngine.hint}</p>
          <p className="mt-1 text-xs opacity-80">
            分层策略：伪装浏览器 TLS 请求 → 难站自动隐身浏览器 → 最后 httpx。模式：{fetchEngine.mode || "auto"}
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-4">
          <MetricCard label="资料总数" value={metrics.total} hint="文本、URL、上传资料" />
          <MetricCard label="学习完成" value={metrics.completed} hint="可进入 AI 检索上下文" />
          <MetricCard label="处理中" value={metrics.learning} hint="解析、抓取、向量化任务" />
          <MetricCard label="知识分块" value={metrics.chunks} hint={`${metrics.scheduled} 条启用定时刷新`} />
        </div>

        <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
          <Section
            title="知识资料台账"
            description="按来源、学习状态、刷新策略和标签统一管理，上传/抓取后会轮询任务并回写结果。"
            action={<SecondaryButton disabled={busy || (!selectedIds.size && !activeItem)} onClick={refreshSelected}><RefreshCw size={15} />刷新选中</SecondaryButton>}
          >
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <input className="h-9 min-w-64 rounded-md border border-line bg-white px-3 text-sm outline-none" placeholder="搜索标题、内容、URL 或标签" value={query} onChange={(event) => setQuery(event.target.value)} />
              <select className="h-9 rounded-md border border-line bg-white px-3 text-sm" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as SourceFilter)}>
                <option value="all">全部来源</option>
                <option value="text">输入文本</option>
                <option value="url">网页 URL</option>
                <option value="local_file">本地上传</option>
                <option value="upload">文件上传</option>
                <option value="asset">素材上传</option>
              </select>
              <select className="h-9 rounded-md border border-line bg-white px-3 text-sm" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
                <option value="all">全部状态</option>
                <option value="queued">已入队</option>
                <option value="running">处理中</option>
                <option value="parsing">解析中</option>
                <option value="learning">学习中</option>
                <option value="completed">学习完成</option>
                <option value="failed">学习失败</option>
              </select>
              <SecondaryButton disabled={busy} onClick={() => createItem("local_file")}><FileUp size={15} />本地上传</SecondaryButton>
              <SecondaryButton disabled={busy} onClick={() => createItem("url")}><Globe2 size={15} />抓取 URL</SecondaryButton>
              <SecondaryButton disabled={selectedIds.size === 0} onClick={() => setSelectedIds(new Set())}><X size={15} />清空选择</SecondaryButton>
            </div>

            {selectedIds.size ? (
              <div className="mb-4 flex items-center gap-2 rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-blue-800">
                <CheckSquare size={15} />
                已选 {selectedIds.size} 条资料，可批量刷新学习状态。
              </div>
            ) : null}

            <div className="overflow-x-auto rounded-md border border-line">
              <table className="w-full min-w-[1080px] text-left text-sm">
                <thead className="bg-slate-50 text-xs text-muted">
                  <tr>
                    <th className="px-4 py-3"><input type="checkbox" checked={allVisibleSelected} onChange={(event) => {
                      setSelectedIds((current) => {
                        const next = new Set(current);
                        filteredItems.forEach((item) => event.target.checked ? next.add(item.id) : next.delete(item.id));
                        return next;
                      });
                    }} /></th>
                    <th className="px-4 py-3">资料</th>
                    <th className="px-4 py-3">来源</th>
                    <th className="px-4 py-3">学习状态</th>
                    <th className="px-4 py-3">分块/向量</th>
                    <th className="px-4 py-3">标签</th>
                    <th className="px-4 py-3">刷新策略</th>
                    <th className="px-4 py-3">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredItems.map((item) => {
                    const taskState = item.taskId ? taskStates[item.taskId] : undefined;
                    const displayStatus = taskState?.status === "succeeded" ? item.status : (taskState?.status as KnowledgeStatus | undefined) ?? item.status;
                    return (
                      <tr key={item.id} className={`border-t border-line align-top ${activeItem?.id === item.id ? "bg-blue-50/60" : "bg-white"}`}>
                        <td className="px-4 py-3"><input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => setSelectedIds((current) => toggleSetValue(current, item.id))} /></td>
                        <td className="px-4 py-3">
                          <button className="text-left" onClick={() => setActiveId(item.id)}>
                            <p className="font-semibold text-ink">{item.title}</p>
                            <p className="mt-1 line-clamp-2 max-w-lg text-xs leading-5 text-muted">{item.content}</p>
                            {item.url ? <span className="mt-1 inline-flex items-center gap-1 text-xs text-brand"><Globe2 size={12} />{item.url}</span> : null}
                          </button>
                        </td>
                        <td className="px-4 py-3 text-muted">{sourceLabels[item.source] ?? item.source}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex rounded-md border px-2 py-1 text-xs font-medium ${statusClass(displayStatus)}`}>
                            {statusLabels[displayStatus] ?? displayStatus}
                          </span>
                          {typeof taskState?.progress === "number" && taskState.status !== "succeeded" ? <p className="mt-1 text-xs text-muted">{taskState.progress}%</p> : null}
                        </td>
                        <td className="px-4 py-3 text-muted">{item.chunkCount ?? 0} / {item.vectorCount ?? 0}</td>
                        <td className="px-4 py-3"><div className="flex max-w-xs flex-wrap gap-1">{item.tags.map((tag) => <span key={tag} className="rounded-md bg-slate-100 px-2 py-1 text-xs text-muted">{tag}</span>)}</div></td>
                        <td className="px-4 py-3 text-muted">{refreshLabels[item.refreshMode]}</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-2">
                            <SecondaryButton disabled={busy} onClick={() => refreshOne(item.id)}><RefreshCw size={15} />刷新</SecondaryButton>
                            {item.status === "failed" && item.taskId ? <SecondaryButton disabled={busy} onClick={() => retryTask(item.taskId!)}><RotateCcw size={15} />重试</SecondaryButton> : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {filteredItems.length === 0 ? <EmptyState title="没有符合条件的知识资料" description="新增文本、上传文件或抓取网页后，这里会展示学习状态和向量化结果。" /> : null}
            </div>
          </Section>

          <aside className="space-y-6">
            <Section title="资料详情抽屉" description="查看来源、内容摘要、学习状态和任务回写。">
              {activeItem ? (
                <div className="space-y-4">
                  <div>
                    <p className="text-base font-semibold text-ink">{activeItem.title}</p>
                    <p className="mt-2 text-sm leading-6 text-muted">{activeItem.content}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-xs text-muted">
                    <div className="rounded-md bg-slate-50 px-3 py-2">来源：{sourceLabels[activeItem.source] ?? activeItem.source}</div>
                    <div className="rounded-md bg-slate-50 px-3 py-2">刷新：{refreshLabels[activeItem.refreshMode]}</div>
                    <div className="rounded-md bg-slate-50 px-3 py-2">分块：{activeItem.chunkCount ?? 0}</div>
                    <div className="rounded-md bg-slate-50 px-3 py-2">向量：{activeItem.vectorCount ?? 0}</div>
                    <div className="rounded-md bg-slate-50 px-3 py-2">更新：{formatAppTimestamp(activeItem.updatedAt)}</div>
                    <div className="rounded-md bg-slate-50 px-3 py-2">刷新时间：{activeItem.lastRefreshedAt ?? "未刷新"}</div>
                  </div>
                  {activeItem.taskId ? (
                    <div className="rounded-md border border-line bg-white p-3 text-xs text-muted">
                      <p className="font-semibold text-ink">任务 ID</p>
                      <p className="mt-1 font-mono">{activeItem.taskId}</p>
                      <Link className="mt-2 inline-flex text-brand hover:underline" href="/dashboard">查看工作台待办</Link>
                    </div>
                  ) : null}
                  <div className="rounded-md border border-line bg-white p-3">
                    <p className="text-xs font-semibold text-muted">状态流转</p>
                    <div className="mt-3 grid gap-2 text-sm">
                      {(["queued", "parsing", "learning", "completed"] as KnowledgeStatus[]).map((status) => (
                        <div key={status} className={`rounded-md px-3 py-2 ${activeItem.status === status ? "bg-blue-50 text-brand" : "bg-slate-50 text-muted"}`}>{statusLabels[status]}</div>
                      ))}
                      {activeItem.status === "failed" ? <div className="rounded-md bg-red-50 px-3 py-2 text-red-700">{activeItem.errorMessage ?? "学习失败"}</div> : null}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">{activeItem.tags.map((tag) => <span key={tag} className="rounded-md bg-slate-100 px-2 py-1 text-xs text-muted">{tag}</span>)}</div>
                  {activeItem.url ? <a className="inline-flex items-center gap-1 text-sm text-brand hover:underline" href={activeItem.url} target="_blank" rel="noreferrer"><Globe2 size={14} />打开来源网页</a> : null}
                </div>
              ) : <p className="text-sm text-muted">选择一条资料查看详情。</p>}
            </Section>

            <Section title="新增资料" description="文本会直接完成学习；文件上传和网页抓取会进入队列并回写分块/向量结果。">
              <div className="space-y-3 text-sm">
                <label className="grid gap-1 font-medium text-ink">名称<input className="rounded-md border border-line px-3 py-2" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
                <label className="grid gap-1 font-medium text-ink">来源<select className="rounded-md border border-line px-3 py-2" value={form.source} onChange={(event) => setForm({ ...form, source: event.target.value as KnowledgeSource })}>
                  <option value="text">输入文本</option>
                  <option value="url">网页 URL</option>
                  <option value="local_file">本地上传</option>
                  <option value="asset">素材上传</option>
                </select></label>
                <label className="grid gap-1 font-medium text-ink">网页 URL<input className="rounded-md border border-line px-3 py-2" value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} /></label>
                <label className="grid gap-1 font-medium text-ink">知识文件<input ref={fileInputRef} className="rounded-md border border-line px-3 py-2 text-sm" type="file" /></label>
                <label className="grid gap-1 font-medium text-ink">内容<textarea className="min-h-28 rounded-md border border-line px-3 py-2" value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} /></label>
                <label className="grid gap-1 font-medium text-ink">标签<input className="rounded-md border border-line px-3 py-2" value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} /></label>
                <label className="grid gap-1 font-medium text-ink">刷新方式<select className="rounded-md border border-line px-3 py-2" value={form.refreshMode} onChange={(event) => setForm({ ...form, refreshMode: event.target.value as KnowledgeItem["refreshMode"] })}>
                  <option value="manual">手动刷新</option>
                  <option value="daily">每日刷新</option>
                  <option value="weekly">每周刷新</option>
                </select></label>
                <PrimaryButton disabled={busy} onClick={() => createItem()}><BookOpen size={16} />保存到知识库</PrimaryButton>
              </div>
            </Section>
          </aside>
        </div>
        {busy ? <LoadingState label="正在处理知识资料" /> : <p className="text-sm leading-6 text-muted">{message}</p>}
      </div>
    </AppShell>
  );
}
