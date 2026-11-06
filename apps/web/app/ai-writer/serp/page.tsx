"use client";

import { AppShell } from "@/components/app-shell";
import { EmptyState, LoadingState, PageHeader, PrimaryButton, Section, SecondaryButton } from "@/components/ui";
import { pollTask } from "@/lib/tasks";
import type { SerpAnalysisResult } from "@zengxing/core";
import { ClipboardList, FileText, ListTree, Search, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type Device = SerpAnalysisResult["device"];
type SeoCollectionResponse<T> = {
  record: T & { status?: string; errorMessage?: string; taskId?: string };
  task: { id: string; type: string; queue: string; status: string; title?: string };
};

type SeoProviderConfig = {
  id: string;
  name: string;
  provider: string;
  status?: string;
  capabilities?: string[];
};

type SerpRecord = SerpAnalysisResult & {
  status?: string;
  errorMessage?: string;
  provider?: string;
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
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}

function getContentOutline(analysis: SerpRecord) {
  const titles = analysis.topResults.slice(0, 4).map((item) => item.title).filter(Boolean);
  return [
    `H1 ${analysis.keyword}完整指南`,
    `H2 ${analysis.keyword}是什么，解决什么搜索意图`,
    ...(titles.length
      ? titles.map((title, index) => `H2 竞品角度 ${index + 1}：${title}`)
      : ["H2 核心方法与操作步骤"]),
    "H2 执行清单与注意事项",
    ...(analysis.relatedQuestions.slice(0, 3).map((question) => `H3 ${question}`) ?? []),
    "H2 常见问题 FAQ"
  ];
}

function getCompetitorOutline(title: string, keyword: string) {
  return [
    `H1 ${title}`,
    `H2 ${keyword}的核心问题`,
    "H2 操作流程与案例",
    "H3 工具、渠道、检查项",
    "H3 FAQ 与下一步行动"
  ];
}

function statusLabel(status?: string) {
  if (status === "collected") return "已采集";
  if (status === "provider_pending") return "数据源未就绪";
  if (status === "failed") return "失败";
  if (status === "queued" || status === "running") return "采集中";
  return status || "未知";
}

export default function SerpAnalysisPage() {
  const [analyses, setAnalyses] = useState<SerpRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [message, setMessage] = useState("输入关键词点分析即可。系统用项目里已配置的 DataForSEO 真采 Google 搜索结果。");
  const [busy, setBusy] = useState(false);
  const [keyword, setKeyword] = useState("AI SEO 优化");
  const [engine, setEngine] = useState<SerpAnalysisResult["searchEngine"]>("Google");
  const [region, setRegion] = useState("中国");
  const [device, setDevice] = useState<Device>("desktop");
  const [providerConfigs, setProviderConfigs] = useState<SeoProviderConfig[]>([]);
  const [providerConfigId, setProviderConfigId] = useState("");
  const [serpReady, setSerpReady] = useState<{ configured: boolean; hint: string }>({ configured: false, hint: "检查中…" });

  async function refreshAnalyses(nextSelectedId?: string) {
    const next = await jsonFetch<SerpRecord[]>("/api/serp-analysis");
    setAnalyses(next);
    setSelectedId(nextSelectedId ?? selectedId ?? next[0]?.id);
  }

  useEffect(() => {
    refreshAnalyses().catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
    jsonFetch<{ serp?: { configured?: boolean; hint?: string; provider?: string } }>("/api/ai/providers/status")
      .then((data) => {
        setSerpReady({
          configured: Boolean(data.serp?.configured),
          hint: data.serp?.hint || "SERP 状态未知"
        });
      })
      .catch(() => setSerpReady({ configured: false, hint: "无法读取 SERP 配置状态" }));
    jsonFetch<SeoProviderConfig[]>("/api/seo-provider-configs")
      .then((data) => {
        setProviderConfigs(data);
        setProviderConfigId((current) => current || data.find((item) => item.capabilities?.includes("serp-collect"))?.id || data[0]?.id || "");
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = useMemo(
    () => analyses.find((analysis) => analysis.id === selectedId) ?? analyses[0],
    [analyses, selectedId]
  );

  const hasRealResults = (selected?.topResults.length ?? 0) > 0;
  const isPendingProvider = selected?.status === "provider_pending" || (!hasRealResults && Boolean(selected?.errorMessage));
  const isCollecting = selected?.status === "queued" || selected?.status === "running";

  const summary = useMemo(() => {
    const resultCount = selected?.topResults.length ?? 0;
    const questionCount = selected?.relatedQuestions.length ?? 0;
    const keywordCount = selected?.relatedKeywords.length ?? 0;
    return [
      { label: "竞品结果", value: resultCount, hint: "Top SERP" },
      { label: "相关问题", value: questionCount, hint: "可转 FAQ" },
      { label: "扩展词", value: keywordCount, hint: "可入关键词库" }
    ];
  }, [selected]);

  async function runAnalysis(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!keyword.trim()) {
      setMessage("请先输入要分析的关键词。");
      return;
    }
    setBusy(true);
    try {
      const result = await jsonFetch<SeoCollectionResponse<SerpRecord>>("/api/serp-analysis/collect", {
        method: "POST",
        body: JSON.stringify({
          keyword,
          searchEngine: engine,
          region,
          device,
          providerConfigId: providerConfigId || undefined
        })
      });
      await refreshAnalyses(result.record.id);
      setMessage(`SERP 任务已入队，正在采集「${keyword}」…`);
      try {
        await pollTask(result.task.id, {
          timeoutMs: 120000,
          onUpdate: (task) => {
            setMessage(`SERP 采集中：${task.status}${task.progress != null ? ` / ${task.progress}%` : ""}`);
          }
        });
        await refreshAnalyses(result.record.id);
        const latest = await jsonFetch<SerpRecord[]>("/api/serp-analysis");
        const record = latest.find((item) => item.id === result.record.id);
        if (record?.status === "provider_pending" || !(record?.topResults.length)) {
          setMessage(
            record?.errorMessage ||
              "未拉到真实竞品结果。请配置 DataForSEO / SEO Provider，或关掉 SERP 直接写文章。"
          );
        } else {
          setMessage(`SERP 分析完成：${record.topResults.length} 条竞品结果，可进入创作。`);
        }
      } catch (pollError) {
        await refreshAnalyses(result.record.id);
        setMessage(pollError instanceof Error ? pollError.message : String(pollError));
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function copyBrief() {
    if (!selected) return;
    await navigator.clipboard.writeText(selected.contentBrief);
    setMessage(`已复制《${selected.keyword}》的创作 brief。`);
  }

  return (
    <AppShell>
      <PageHeader
        eyebrow="SERP Analysis & Writing"
        title="SERP分析及创作"
        description="用项目 .env 里的 DataForSEO 真采 Google 搜索结果，不是空壳。采完可一键带进创作。"
        action={
          <PrimaryButton disabled={busy} onClick={() => (document.getElementById("serp-form") as HTMLFormElement | null)?.requestSubmit()}>
            <Search size={16} />
            开始分析
          </PrimaryButton>
        }
      />

      <div className="space-y-6 p-6">
        <div
          className={`rounded-2xl border px-4 py-3 text-sm leading-6 ${
            serpReady.configured ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900"
          }`}
        >
          <p className="font-semibold">{serpReady.configured ? "DataForSEO 已就绪" : "DataForSEO 未就绪"}</p>
          <p className="mt-1">{serpReady.hint}</p>
          <p className="mt-1 text-xs opacity-80">你不用管什么 SEO Provider——那是给自建接口用的高级项。正常情况点分析就行。</p>
        </div>

        <div className="grid gap-6 xl:grid-cols-[380px_1fr]">
          <div className="space-y-6">
            <Section title="分析任务" description="填关键词就行。默认 Google + DataForSEO。">
              <form id="serp-form" className="space-y-4" onSubmit={runAnalysis}>
                <label className="grid gap-2 text-sm font-medium text-ink">
                  关键词
                  <input
                    className="h-10 rounded-md border border-line px-3 text-sm"
                    value={keyword}
                    onChange={(event) => setKeyword(event.target.value)}
                    placeholder="例如：AI SEO 优化"
                  />
                </label>
                <details className="rounded-md border border-line bg-slate-50 px-3 py-2">
                  <summary className="cursor-pointer text-sm font-medium text-ink">高级选项（一般不用动）</summary>
                  <div className="mt-3 grid gap-3">
                    <label className="grid gap-2 text-sm font-medium text-ink">
                      搜索引擎
                      <select className="h-10 rounded-md border border-line px-3 text-sm" value={engine} onChange={(event) => setEngine(event.target.value as SerpAnalysisResult["searchEngine"])}>
                        <option value="Google">Google（DataForSEO 真采）</option>
                        <option value="Baidu">Baidu（当前 DataForSEO 路径未接通，别选）</option>
                        <option value="Bing">Bing（当前 DataForSEO 路径未接通，别选）</option>
                      </select>
                    </label>
                    <label className="grid gap-2 text-sm font-medium text-ink">
                      地区
                      <input className="h-10 rounded-md border border-line px-3 text-sm" value={region} onChange={(event) => setRegion(event.target.value)} />
                    </label>
                    <div className="grid grid-cols-2 gap-2 rounded-md bg-slate-100 p-1">
                      {(["desktop", "mobile"] as Device[]).map((item) => (
                        <button
                          key={item}
                          type="button"
                          onClick={() => setDevice(item)}
                          className={`h-9 rounded-md text-sm font-medium ${device === item ? "bg-white text-ink shadow-sm" : "text-muted"}`}
                        >
                          {item === "desktop" ? "桌面端" : "移动端"}
                        </button>
                      ))}
                    </div>
                    {providerConfigs.length ? (
                      <label className="grid gap-2 text-sm font-medium text-ink">
                        可选：额外 Provider 配置（可忽略）
                        <select className="h-10 rounded-md border border-line px-3 text-sm" value={providerConfigId} onChange={(event) => setProviderConfigId(event.target.value)}>
                          <option value="">用系统默认 DataForSEO</option>
                          {providerConfigs.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.name} / {item.provider}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                  </div>
                </details>
                <PrimaryButton type="submit" disabled={busy}>
                  <Search size={16} />
                  分析SERP
                </PrimaryButton>
              </form>
            </Section>

            <Section title="分析记录" description="每次真实采集都会留下记录，可反复带入创作。">
              <div className="space-y-2">
                {analyses.map((analysis) => (
                  <button
                    key={analysis.id}
                    type="button"
                    onClick={() => setSelectedId(analysis.id)}
                    className={`w-full rounded-md border p-3 text-left transition ${selected?.id === analysis.id ? "border-brand bg-blue-50" : "border-line bg-white hover:border-brand/50"}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-ink">{analysis.keyword}</p>
                      <span className="text-xs text-muted">{statusLabel(analysis.status)}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      {analysis.searchEngine} / {analysis.region} / {analysis.topResults?.length ?? 0} 条竞品
                    </p>
                  </button>
                ))}
                {!analyses.length ? <EmptyState title="暂无分析记录" description="提交关键词后，这里会出现真实 SERP 记录。" /> : null}
              </div>
            </Section>
          </div>

          {selected ? (
            <div className="space-y-6">
              <Section
                title={`${selected.keyword} / ${selected.searchEngine}`}
                description={`${selected.region} / ${selected.device === "desktop" ? "桌面端" : "移动端"} / ${statusLabel(selected.status)}`}
                action={
                  <div className="flex flex-wrap gap-2">
                    <SecondaryButton onClick={copyBrief} disabled={!selected.contentBrief}>
                      <ClipboardList size={15} />
                      复制Brief
                    </SecondaryButton>
                    <Link
                      href={`/ai-writer?keyword=${encodeURIComponent(selected.keyword)}&serpId=${selected.id}&useSerp=1`}
                      className="focus-ring inline-flex h-9 items-center justify-center gap-2 rounded-md border border-line bg-white px-3 text-sm font-medium text-ink"
                    >
                      <Sparkles size={15} />
                      一键带入创作
                    </Link>
                  </div>
                }
              >
                <div className="grid gap-3 md:grid-cols-3">
                  {summary.map((item) => (
                    <div key={item.label} className="rounded-md border border-line bg-white p-4">
                      <p className="text-xs text-muted">{item.label}</p>
                      <p className="mt-2 text-2xl font-semibold text-ink">{item.value}</p>
                      <p className="mt-1 text-xs text-muted">{item.hint}</p>
                    </div>
                  ))}
                </div>
              </Section>

              {isCollecting ? (
                <Section title="采集中" description="正在等待 worker 回写真实搜索结果。">
                  <LoadingState label="SERP 采集进行中" />
                </Section>
              ) : null}

              {isPendingProvider || selected.status === "failed" ? (
                <Section title="没有真实竞品数据" description="系统不会用假结果糊弄你。">
                  <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
                    <p className="font-semibold">原因</p>
                    <p className="mt-1">
                      {selected.errorMessage ||
                        selected.contentBrief ||
                        "SEO 数据源未配置或采集失败。"}
                    </p>
                    <p className="mt-3 font-semibold">你可以：</p>
                    <ul className="mt-1 list-disc space-y-1 pl-5">
                      <li>确认 API / Worker 用了 apps/api/.env 里的 DATAFORSEO_LOGIN / PASSWORD</li>
                      <li>确认 worker 进程在跑（任务得靠它去采）</li>
                      <li>
                        <Link href="/ai-writer" className="text-brand underline">
                          或关掉 SERP，直接一键写文章
                        </Link>
                      </li>
                    </ul>
                  </div>
                </Section>
              ) : null}

              <Section title="竞品SERP拆解" description="只有真实 topResults 才会出现在这里。">
                <div className="space-y-3">
                  {selected.topResults.map((result) => (
                    <div key={`${selected.id}-${result.position}`} className="grid gap-4 rounded-md border border-line bg-white p-4 lg:grid-cols-[1fr_280px]">
                      <div>
                        <div className="flex items-start gap-3">
                          <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-md bg-slate-100 text-xs font-semibold text-ink">#{result.position}</span>
                          <div>
                            <p className="text-sm font-semibold leading-6 text-ink">{result.title}</p>
                            <p className="mt-1 text-xs text-brand">{result.domain}</p>
                          </div>
                        </div>
                        <p className="mt-3 text-sm leading-6 text-muted">{result.snippet}</p>
                        <p className="mt-2 truncate text-xs text-muted">{result.url}</p>
                      </div>
                      <div className="rounded-md bg-slate-50 p-3">
                        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
                          <ListTree size={15} />
                          结构参考
                        </div>
                        <ul className="space-y-1 text-xs leading-5 text-muted">
                          {getCompetitorOutline(result.title, selected.keyword).map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  ))}
                  {!selected.topResults.length && !isPendingProvider && !isCollecting ? (
                    <EmptyState title="暂无竞品结果" description="重新分析，或检查搜索数据源是否可用。" />
                  ) : null}
                </div>
              </Section>

              {hasRealResults ? (
                <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
                  <Section title="问题与扩展词" description="来自真实 SERP 的 PAA / 相关词。">
                    <div className="space-y-5">
                      <div>
                        <p className="text-sm font-semibold text-ink">相关问题</p>
                        <div className="mt-2 space-y-2">
                          {selected.relatedQuestions.map((question) => (
                            <div key={question} className="rounded-md border border-line bg-white px-3 py-2 text-sm text-ink">
                              {question}
                            </div>
                          ))}
                          {!selected.relatedQuestions.length ? <p className="text-sm text-muted">本次未返回相关问题。</p> : null}
                        </div>
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-ink">相关关键词</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {selected.relatedKeywords.map((word) => (
                            <span key={word} className="rounded-full border border-line bg-white px-3 py-1 text-xs text-slate-700">
                              {word}
                            </span>
                          ))}
                          {!selected.relatedKeywords.length ? <p className="text-sm text-muted">本次未返回扩展词。</p> : null}
                        </div>
                      </div>
                    </div>
                  </Section>

                  <Section title="创作Brief" description="基于真实竞品标题生成，可直接驱动 AI 创作。">
                    <div className="space-y-4">
                      <div className="rounded-md bg-slate-50 p-4">
                        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
                          <FileText size={15} />
                          推荐文章结构
                        </div>
                        <ul className="space-y-1 text-xs leading-5 text-muted">
                          {getContentOutline(selected).map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </div>
                      <p className="rounded-md border border-line bg-white p-4 text-sm leading-6 text-muted whitespace-pre-wrap">{selected.contentBrief}</p>
                    </div>
                  </Section>
                </div>
              ) : null}
            </div>
          ) : (
            <EmptyState title="请选择或创建一条 SERP 分析" description="分析结果会展示竞品结构、相关问题、关键词和创作 brief。" />
          )}
        </div>

        {busy ? <LoadingState label="正在分析 SERP" /> : <p className="text-sm leading-6 text-muted">{message}</p>}
      </div>
    </AppShell>
  );
}
