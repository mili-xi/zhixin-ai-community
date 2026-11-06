"use client";

import { useCreationTask } from "@/components/creation-task-provider";
import { LoadingState, PrimaryButton, SecondaryButton } from "@/components/ui";
import { jsonFetch } from "@/lib/tasks";
import { isMediaAccountPublishable } from "@zengxing/core";
import type {
  Article,
  ArticleTypeTemplate,
  Asset,
  BrandProfile,
  CompetitorProfile,
  GenerationRule,
  KnowledgeItem,
  MediaAccount,
  SerpAnalysisResult,
  Watermark
} from "@zengxing/core";
import {
  BookOpen,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Image as ImageIcon,
  Lock,
  Settings,
  Sparkles,
  Stamp,
  X
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  buildWriterWizardNavigationState,
  getWriterModeCapabilities,
  joinSelectionNames,
  splitWriterLines,
  toggleWriterSelection,
  writerExtraOptions,
  writerInitialDraft,
  writerModeCards,
  type ImageStrategy,
  type WriterDraft
} from "./writer-form-state";

type QueuedTaskResponse = {
  queued: true;
  task: { id: string; type: string; queue: string; status: string; title?: string };
};

type AiProviderStatus = {
  text: { provider: string; model: string; configured: boolean; mode: string };
  image: { provider: string; model: string; configured: boolean; mode: string };
};

type Selectable = { id: string; name: string; meta?: string };

const fallbackArticleType: ArticleTypeTemplate = {
  id: "fallback-guide",
  name: "操作指南",
  category: "系统预设",
  sourceType: "system",
  visible: true,
  prompt: "输出步骤、检查清单、FAQ 和可执行结论。",
  useCount: 0,
  createdAt: "",
  updatedAt: ""
};

function makeOutline(keyword: string, serp?: SerpAnalysisResult, rule?: GenerationRule) {
  const ruleLines = rule?.structureRules ? splitWriterLines(rule.structureRules).slice(0, 5) : [];
  if (ruleLines.length) return ruleLines;
  return [
    `H2 ${keyword} 的搜索意图与用户问题`,
    "H2 SERP 暴露的内容差距",
    "H2 生成规则、知识库与品牌素材如何参与创作",
    "H2 发布渠道、公开 URL 和可见性观察闭环",
    ...(serp?.relatedQuestions.slice(0, 3).map((question) => `H3 ${question}`) ?? ["H2 FAQ 与可引用结论"])
  ];
}

function SelectionGrid({
  items,
  selectedIds,
  onToggle,
  empty
}: {
  items: Selectable[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  empty: string;
}) {
  if (!items.length) {
    return <p className="rounded-xl border border-dashed border-line bg-panel px-4 py-6 text-sm text-muted">{empty}</p>;
  }

  return (
    <div className="grid gap-2 md:grid-cols-2">
      {items.map((item) => {
        const selected = selectedIds.includes(item.id);
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onToggle(item.id)}
            className={`min-h-20 rounded-xl border px-4 py-3 text-left transition-all duration-150 ${
              selected ? "border-brand bg-[#f3f0ff] text-brand font-bold" : "border-line bg-panel text-ink hover:border-brand/40 hover:bg-slate-50"
            }`}
          >
            <span className="flex items-start justify-between gap-2 text-sm font-semibold">
              {item.name}
              {selected ? <CheckCircle2 size={16} className="shrink-0" /> : null}
            </span>
            {item.meta ? <span className="mt-1 block text-xs leading-5 text-muted">{item.meta}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

function StepChip({
  index,
  label,
  status,
  accessible,
  onClick
}: {
  index: number;
  label: string;
  status: "completed" | "active" | "pending";
  accessible: boolean;
  onClick: () => void;
}) {
  const stateClass =
    status === "completed"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700 font-medium"
      : status === "active"
        ? "border-brand/30 bg-[#f3f0ff] text-brand font-bold shadow-sm"
        : "border-slate-200 bg-slate-50 text-slate-500 hover:bg-slate-100 hover:text-slate-800";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!accessible}
      className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-60 ${stateClass}`}
    >
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-current text-xs font-semibold">
        {status === "completed" ? <CheckCircle2 size={14} /> : index + 1}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

export function WriterWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { hasOpenTask, isRestoring, registerTask } = useCreationTask();
  const [articles, setArticles] = useState<Article[]>([]);
  const [articleTypes, setArticleTypes] = useState<ArticleTypeTemplate[]>([fallbackArticleType]);
  const [rules, setRules] = useState<GenerationRule[]>([]);
  const [serpAnalyses, setSerpAnalyses] = useState<SerpAnalysisResult[]>([]);
  const [knowledgeItems, setKnowledgeItems] = useState<KnowledgeItem[]>([]);
  const [brandProfiles, setBrandProfiles] = useState<BrandProfile[]>([]);
  const [competitors, setCompetitors] = useState<CompetitorProfile[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [watermarks, setWatermarks] = useState<Watermark[]>([]);
  const [mediaAccounts, setMediaAccounts] = useState<MediaAccount[]>([]);
  const [providerStatus, setProviderStatus] = useState<AiProviderStatus | null>(null);
  const [draft, setDraft] = useState<WriterDraft>(writerInitialDraft);
  const [activeStep, setActiveStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("按当前创作模式配置上下文。任务提交后可切换页面，完成后再主动打开文章。");
  const [dirty, setDirty] = useState(false);
  const [exitConfirmOpen, setExitConfirmOpen] = useState(false);
  const [panelReady, setPanelReady] = useState(true);
  const [portalMounted, setPortalMounted] = useState(false);

  useEffect(() => {
    setPortalMounted(true);
  }, []);

  useEffect(() => {
    let canceled = false;

    async function load() {
      try {
        const [
          articleList,
          articleTypeList,
          ruleList,
          serpList,
          knowledgeList,
          brandList,
          competitorList,
          assetList,
          watermarkList,
          mediaList,
          provider
        ] = await Promise.all([
          jsonFetch<Article[]>("/api/articles"),
          jsonFetch<ArticleTypeTemplate[]>("/api/article-types"),
          jsonFetch<GenerationRule[]>("/api/generation-rules"),
          jsonFetch<SerpAnalysisResult[]>("/api/serp-analysis"),
          jsonFetch<KnowledgeItem[]>("/api/knowledge-base"),
          jsonFetch<BrandProfile[]>("/api/brand-library"),
          jsonFetch<CompetitorProfile[]>("/api/competitor-library"),
          jsonFetch<Asset[]>("/api/assets"),
          jsonFetch<Watermark[]>("/api/watermarks"),
          jsonFetch<MediaAccount[]>("/api/media-accounts"),
          jsonFetch<AiProviderStatus>("/api/ai/providers/status")
        ]);

        if (canceled) return;

        setArticles(articleList);
        const visibleArticleTypes = articleTypeList.filter((item) => item.visible);
        const nextArticleTypes = visibleArticleTypes.length ? visibleArticleTypes : [fallbackArticleType];
        setArticleTypes(nextArticleTypes);
        setRules(ruleList);
        setSerpAnalyses(serpList);
        setKnowledgeItems(knowledgeList);
        setBrandProfiles(brandList);
        setCompetitors(competitorList);
        setAssets(assetList);
        setWatermarks(watermarkList);
        setMediaAccounts(mediaList);
        setProviderStatus(provider);

        const selectedArticleType = nextArticleTypes[0] ?? fallbackArticleType;
        const activeRule = ruleList.find((item) => (item.status ?? "active") === "active") ?? ruleList[0];
        const selectedSerp = serpList[0];

        setDraft((prev) => ({
          ...prev,
          articleTypeId: prev.articleTypeId || selectedArticleType.id,
          ruleId: prev.ruleId || activeRule?.id || prev.ruleId,
          serpAnalysisId: prev.serpAnalysisId || selectedSerp?.id || prev.serpAnalysisId,
          keyword: prev.keyword || selectedSerp?.keyword || prev.keyword,
          question: prev.question || selectedSerp?.relatedQuestions[0] || prev.question,
          title: prev.title || `${selectedSerp?.keyword ?? prev.keyword} 创作流程`,
          seoTitle: prev.seoTitle || `${selectedSerp?.keyword ?? prev.keyword} 创作流程`,
          outline: prev.outline || makeOutline(prev.keyword || selectedSerp?.keyword || "AI Writer", selectedSerp, activeRule).join("\n")
        }));
      } catch (error) {
        if (!canceled) {
          setMessage(error instanceof Error ? error.message : String(error));
        }
      }
    }

    void load();
    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, dirty, busy]);

  useEffect(() => {
    const timer = window.requestAnimationFrame(() => setPanelReady(true));
    setPanelReady(false);
    return () => window.cancelAnimationFrame(timer);
  }, [activeStep]);

  function markDirty() {
    setDirty(true);
  }

  function updateDraft<K extends keyof WriterDraft>(key: K, value: WriterDraft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
    markDirty();
  }

  function patchDraft(next: Partial<WriterDraft>) {
    setDraft((prev) => ({ ...prev, ...next }));
    markDirty();
  }

  function resetDraft() {
    setDraft(writerInitialDraft);
    setActiveStep(0);
    setDirty(false);
    setMessage("已放弃本次向导内容，重新开始即可继续创作。");
  }

  function requestClose() {
    if (busy) return;
    if (dirty) {
      setExitConfirmOpen(true);
      return;
    }
    onClose();
  }

  function saveAndClose() {
    setExitConfirmOpen(false);
    setDirty(false);
    onClose();
  }

  function discardAndClose() {
    resetDraft();
    setExitConfirmOpen(false);
    onClose();
  }

  function applySerp(id: string) {
    const serp = serpAnalyses.find((item) => item.id === id);
    if (!serp) return;
    const selectedRule = rules.find((item) => item.id === draft.ruleId) ?? rules[0];
    patchDraft({
      serpAnalysisId: serp.id,
      keyword: serp.keyword,
      question: serp.relatedQuestions[0] ?? `${serp.keyword} 应该如何创作？`,
      title: `${serp.keyword} 创作流程：从 SERP 到发布闭环`,
      seoTitle: `${serp.keyword} 创作流程`,
      metaDescription: `围绕 ${serp.keyword} 提炼 SERP、结构、发布和公开可见性闭环。`,
      secondaryKeywords: Array.from(new Set([...serp.relatedKeywords.slice(0, 5), "发布渠道", "公开可见性", "媒体发布"])).join("\n"),
      outline: makeOutline(serp.keyword, serp, selectedRule).join("\n"),
      mode: "serp"
    });
    setMessage(`已应用 SERP 分析：${serp.keyword}`);
  }

  function applyRule(id: string) {
    const rule = rules.find((item) => item.id === id);
    if (!rule) return;
    patchDraft({
      ruleId: id,
      knowledgeIds: rule.knowledgeBaseRefs ?? [],
      brandIds: rule.brandProfileRefs ?? [],
      competitorIds: rule.competitorProfileRefs ?? [],
      watermarkIds: rule.watermarkRefs ?? [],
      secondaryKeywords: rule.forcedTitleKeywords?.length
        ? Array.from(new Set([...splitWriterLines(draft.secondaryKeywords), ...rule.forcedTitleKeywords])).join("\n")
        : draft.secondaryKeywords,
      outline: rule.structureRules || draft.outline,
      generateImages: rule.imageStrategy ? rule.imageStrategy !== "none" : draft.generateImages,
      imageStrategy: rule.imageStrategy || draft.imageStrategy
    });
    setMessage(`已应用生成规则：${rule.name}`);
  }

  async function generateArticle() {
    if (hasOpenTask) {
      setMessage("已有文章正在后台生成，请等待完成后再开始下一篇。");
      return;
    }
    setBusy(true);
    try {
      const capabilities = getWriterModeCapabilities(draft.mode);
      const selectedRule = capabilities.usesRule ? rules.find((item) => item.id === draft.ruleId) : undefined;
      const selectedArticleType = capabilities.usesArticleType
        ? articleTypes.find((item) => item.id === draft.articleTypeId) ?? articleTypes[0] ?? fallbackArticleType
        : undefined;
      const selectedSerp = capabilities.usesSerp ? serpAnalyses.find((item) => item.id === draft.serpAnalysisId) : undefined;
      const stepsCompleted = activeStep + 1;
      const queued = await jsonFetch<QueuedTaskResponse>("/api/articles/generate", {
        method: "POST",
        body: JSON.stringify({
          async: true,
          ruleId: capabilities.usesRule ? draft.ruleId || undefined : undefined,
          generationRuleId: capabilities.usesRule ? draft.ruleId || undefined : undefined,
          articleTypeId: capabilities.usesArticleType ? draft.articleTypeId || undefined : undefined,
          keyword: draft.keyword,
          generateImages: draft.generateImages,
          imageStrategy: draft.generateImages ? draft.imageStrategy : "none",
          maxInlineImages: draft.maxInlineImages,
          knowledgeIds: draft.knowledgeIds,
          assetIds: draft.assetIds,
          brandProfileIds: draft.brandIds,
          competitorProfileIds: draft.competitorIds,
          productDescription: [
            `创作问题：${draft.question}`,
            selectedSerp ? `SERP Brief：${selectedSerp.contentBrief}` : "",
            selectedArticleType ? `文章类型：${selectedArticleType.name}` : "",
            selectedRule ? `生成规则：${selectedRule.name}` : "",
            `辅助资源：知识库 ${draft.knowledgeIds.length} / 品牌 ${draft.brandIds.length} / 竞品 ${draft.competitorIds.length} / 素材 ${draft.assetIds.length}`
          ]
            .filter(Boolean)
            .join("\n"),
          targetAudience: "SEO/GEO 内容运营、品牌增长和发布运营人员",
          brandProfile:
            brandProfiles
              .filter((item) => draft.brandIds.includes(item.id))
              .map((item) => `${item.name}: ${item.description}`)
              .join("\n") || "智心AI",
          intent: selectedRule?.name ?? selectedArticleType?.name ?? "自由创作",
          tone: "专业、清晰、可执行",
          wordCount: 1800,
          includeFaq: draft.extras.includes("FAQ"),
          includeInternalLinks: draft.extras.includes("internal links"),
          writerContext: {
            mode: draft.mode,
            question: draft.question,
            title: draft.title,
            seoTitle: draft.seoTitle,
            metaDescription: draft.metaDescription,
            secondaryKeywords: splitWriterLines(draft.secondaryKeywords),
            outline: splitWriterLines(draft.outline || makeOutline(draft.keyword, selectedSerp, selectedRule).join("\n")),
            serpAnalysisId: capabilities.usesSerp ? draft.serpAnalysisId || undefined : undefined,
            knowledgeItemIds: draft.knowledgeIds,
            brandProfileIds: draft.brandIds,
            competitorProfileIds: draft.competitorIds,
            assetIds: draft.assetIds,
            watermarkIds: draft.watermarkIds,
            publishTargetIds: draft.publishTargetIds,
            extras: draft.extras,
            stepsCompleted
          }
        })
      });
      registerTask(queued.task);
      setDirty(false);
      setMessage(`AI 创作任务已入队：${queued.task.id}。可以切换页面，生成过程会继续在后台运行。`);
      onClose();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const activeMediaAccounts = mediaAccounts.filter(isMediaAccountPublishable);
  const publishTargets: Selectable[] = activeMediaAccounts.map((account) => ({
    id: `media:${account.id}`,
    name: account.name,
    meta: `免费媒体 / ${account.platform} / ${account.credentialStatus ?? account.status}`
  }));

  const knowledgeOptions: Selectable[] = knowledgeItems.map((item) => ({
    id: item.id,
    name: item.title,
    meta: `${item.source} / ${item.status} / ${(Array.isArray(item.tags) ? item.tags : []).join("、") || "无标签"}`
  }));
  const brandOptions: Selectable[] = brandProfiles.map((item) => ({
    id: item.id,
    name: item.name,
    meta: `${(Array.isArray(item.products) ? item.products : []).join("、") || "未配置产品"} / ${item.website || "未配置官网"}`
  }));
  const competitorOptions: Selectable[] = competitors.map((item) => ({
    id: item.id,
    name: item.name,
    meta: `${item.relation} / ${(Array.isArray(item.products) ? item.products : []).join("、") || "未配置产品"}`
  }));
  const assetOptions: Selectable[] = assets.map((item) => ({
    id: item.id,
    name: item.filename,
    meta: `${item.type} / ${item.source} / ${(Array.isArray(item.tags) ? item.tags : []).join("、") || "无标签"}`
  }));
  const watermarkOptions: Selectable[] = watermarks.map((item) => ({
    id: item.id,
    name: item.name,
    meta: `${item.type} / ${item.position} / opacity ${item.opacity}`
  }));

  const modeCapabilities = getWriterModeCapabilities(draft.mode);
  const selectedRule = modeCapabilities.usesRule ? rules.find((item) => item.id === draft.ruleId) : undefined;
  const selectedArticleType = modeCapabilities.usesArticleType
    ? articleTypes.find((item) => item.id === draft.articleTypeId) ?? articleTypes[0] ?? fallbackArticleType
    : undefined;
  const selectedSerp = modeCapabilities.usesSerp ? serpAnalyses.find((item) => item.id === draft.serpAnalysisId) : undefined;
  const outlineLines = splitWriterLines(draft.outline || makeOutline(draft.keyword, selectedSerp, selectedRule).join("\n"));
  const titleCandidates = Array.from(
    new Set([
      draft.title,
      selectedSerp ? `${selectedSerp.keyword} 完整实战指南：从 SERP 分析到媒体发布` : "",
      `${draft.keyword} 10 步创作流程：规则、素材、媒体发布`,
      selectedArticleType ? `${selectedArticleType.name}：${draft.keyword} 如何提升搜索可见度` : "",
      selectedRule ? `${selectedRule.name}：${draft.keyword} 创作方案` : ""
    ].filter(Boolean))
  );
  const supportSummary = [
    `知识库 ${draft.knowledgeIds.length}`,
    `品牌 ${draft.brandIds.length}`,
    `竞品 ${draft.competitorIds.length}`,
    `素材 ${draft.assetIds.length}`,
    `水印 ${draft.watermarkIds.length}`
  ].join(" / ");
  const navigation = buildWriterWizardNavigationState(draft.mode, activeStep);
  const currentStep = navigation.steps[navigation.activeStep];
  const selectedMode = writerModeCards.find((item) => item.id === draft.mode);

  const mainPanel = (() => {
    switch (navigation.activeStepId) {
      case "mode":
        return (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {writerModeCards.map((card) => (
              <button
                key={card.id}
                type="button"
                onClick={() => updateDraft("mode", card.id)}
                className={`rounded-xl border p-4 text-left transition-all duration-150 ${
                  draft.mode === card.id ? "border-brand bg-[#f3f0ff] text-brand font-bold" : "border-line bg-panel hover:border-brand/40 hover:bg-slate-50"
                }`}
              >
                <Sparkles size={18} />
                <span className="mt-3 block text-sm font-semibold">{card.title}</span>
                <span className="mt-1 block text-xs leading-5 text-muted">{card.description}</span>
              </button>
            ))}
          </div>
        );
      case "topic":
        return (
          <div className="grid gap-5 xl:grid-cols-[1fr_280px]">
            <div className="space-y-4">
              <label className="grid gap-2 text-sm font-medium text-ink">
                主关键词
                <input
                  className="rounded-xl border border-line px-3 py-2"
                  value={draft.keyword}
                  onChange={(event) => updateDraft("keyword", event.target.value)}
                  placeholder="例如：企业 AI SEO"
                />
              </label>
              <label className="grid gap-2 text-sm font-medium text-ink">
                核心创作问题
                <textarea
                  className="min-h-32 rounded-xl border border-line px-3 py-2"
                  value={draft.question}
                  onChange={(event) => updateDraft("question", event.target.value)}
                  placeholder="读者希望通过这篇文章解决什么问题？"
                />
              </label>
            </div>
            <div className="rounded-xl border border-line bg-slate-50 p-4 text-sm leading-6 text-slate-600">
              <p className="font-semibold text-ink">普通创作路径</p>
              <p className="mt-2">系统会继续让你选择文章类型和生成规则，再组合知识、素材和发布渠道。</p>
            </div>
          </div>
        );
      case "brief":
        return (
          <div className="space-y-5">
            <div className="rounded-xl border border-brand/20 bg-[#f3f0ff] px-4 py-3 text-sm leading-6 text-slate-700">
              自由创作以人工 Brief 为核心，不要求选择 SERP、文章类型或生成规则。知识库和素材仍可在后续步骤自由补充。
            </div>
            <label className="grid gap-2 text-sm font-medium text-ink">
              创作主题
              <input
                className="rounded-xl border border-line px-3 py-2"
                value={draft.keyword}
                onChange={(event) => updateDraft("keyword", event.target.value)}
                placeholder="用一句话概括想写的主题"
              />
            </label>
            <label className="grid gap-2 text-sm font-medium text-ink">
              自由 Brief
              <textarea
                className="min-h-56 rounded-xl border border-line px-3 py-2"
                value={draft.question}
                onChange={(event) => updateDraft("question", event.target.value)}
                placeholder="说明目标读者、写作目的、必须包含的信息、语气和期望结果"
              />
            </label>
          </div>
        );
      case "serp":
        return (
          <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
            <div className="space-y-4">
              <label className="grid gap-2 text-sm font-medium text-ink">
                关键词
                <input
                  className="rounded-xl border border-line px-3 py-2"
                  value={draft.keyword}
                  onChange={(event) => updateDraft("keyword", event.target.value)}
                />
              </label>
              <label className="grid gap-2 text-sm font-medium text-ink">
                创作问题
                <textarea
                  className="min-h-28 rounded-xl border border-line px-3 py-2"
                  value={draft.question}
                  onChange={(event) => updateDraft("question", event.target.value)}
                />
              </label>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-semibold text-ink">SERP 来源</p>
              {serpAnalyses.slice(0, 6).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => applySerp(item.id)}
                  className={`w-full rounded-xl border px-3 py-2 text-left text-sm transition-all duration-150 ${
                    draft.serpAnalysisId === item.id ? "border-brand bg-[#f3f0ff] text-brand font-bold" : "border-line bg-panel hover:border-brand/40 hover:bg-slate-50"
                  }`}
                >
                  <span className="block font-medium">{item.keyword}</span>
                  <span className="text-xs text-muted">
                    {item.searchEngine} / {item.region} / {item.analyzedAt}
                  </span>
                </button>
              ))}
            </div>
          </div>
        );
      case "type":
        return (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {articleTypes.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => updateDraft("articleTypeId", item.id)}
                className={`rounded-xl border p-4 text-left transition-all duration-150 ${
                  draft.articleTypeId === item.id ? "border-brand bg-[#f3f0ff] text-brand font-bold" : "border-line bg-panel hover:border-brand/40 hover:bg-slate-50"
                }`}
              >
                <BookOpen size={17} />
                <span className="mt-2 block text-sm font-semibold">{item.name}</span>
                <span className="mt-1 block text-xs leading-5 text-muted">
                  {item.category} / 使用 {item.useCount}
                </span>
                <span className="mt-2 line-clamp-2 block text-xs leading-5 text-muted">{item.prompt}</span>
              </button>
            ))}
          </div>
        );
      case "variables":
        return (
          <div className="grid gap-5 xl:grid-cols-[280px_1fr]">
            <div className="rounded-xl border border-line bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">当前文章模板</p>
              <p className="mt-2 text-base font-semibold text-ink">{selectedArticleType?.name ?? "尚未选择模板"}</p>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                {selectedArticleType?.prompt ?? "返回上一步选择文章类型后，再填写本次生成变量。"}
              </p>
            </div>
            <div className="space-y-4">
              <label className="grid gap-2 text-sm font-medium text-ink">
                本次主题变量
                <input
                  className="rounded-xl border border-line px-3 py-2"
                  value={draft.keyword}
                  onChange={(event) => updateDraft("keyword", event.target.value)}
                  placeholder="例如：2026 年企业 AI SEO 实施指南"
                />
              </label>
              <label className="grid gap-2 text-sm font-medium text-ink">
                补充变量与要求
                <textarea
                  className="min-h-40 rounded-xl border border-line px-3 py-2"
                  value={draft.question}
                  onChange={(event) => updateDraft("question", event.target.value)}
                  placeholder="填写受众、产品信息、案例、地区或必须写入的观点"
                />
              </label>
            </div>
          </div>
        );
      case "rule":
        return (
          <div className="space-y-3">
            {rules.map((rule) => (
              <button
                key={rule.id}
                type="button"
                onClick={() => applyRule(rule.id)}
                className={`w-full rounded-xl border p-4 text-left transition-all duration-150 ${
                  draft.ruleId === rule.id ? "border-brand bg-[#f3f0ff] text-brand font-bold" : "border-line bg-panel hover:border-brand/40 hover:bg-slate-50"
                }`}
              >
                <span className="flex items-center gap-2 text-sm font-semibold">
                  <Settings size={16} />
                  {rule.name}
                </span>
                <span className="mt-1 block text-xs text-muted">
                  {rule.type} / {rule.sourceMode ?? "manual"} / {rule.status ?? "active"}
                </span>
                <span className="mt-2 block text-sm leading-6 text-slate-650">{rule.content || "未填写规则说明"}</span>
              </button>
            ))}
            {!rules.length ? (
              <Link href="/ai-writer/rules" className="block rounded-xl border border-line bg-panel p-4 text-sm font-semibold text-brand hover:border-brand/40 hover:bg-slate-50 transition-all duration-150">
                新建生成规则
              </Link>
            ) : null}
          </div>
        );
      case "library":
        return (
          <div className="grid gap-5 xl:grid-cols-3">
            <div>
              <p className="mb-2 text-sm font-semibold text-ink">知识库</p>
              <SelectionGrid
                items={knowledgeOptions}
                selectedIds={draft.knowledgeIds}
                onToggle={(id) => updateDraft("knowledgeIds", toggleWriterSelection(id, draft.knowledgeIds))}
                empty="暂无知识库记录"
              />
            </div>
            <div>
              <p className="mb-2 text-sm font-semibold text-ink">品牌库</p>
              <SelectionGrid
                items={brandOptions}
                selectedIds={draft.brandIds}
                onToggle={(id) => updateDraft("brandIds", toggleWriterSelection(id, draft.brandIds))}
                empty="暂无品牌库记录"
              />
            </div>
            <div>
              <p className="mb-2 text-sm font-semibold text-ink">竞品库</p>
              <SelectionGrid
                items={competitorOptions}
                selectedIds={draft.competitorIds}
                onToggle={(id) => updateDraft("competitorIds", toggleWriterSelection(id, draft.competitorIds))}
                empty="暂无竞品库记录"
              />
            </div>
          </div>
        );
      case "media":
        return (
          <div className="grid gap-5 xl:grid-cols-3">
            <div>
              <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
                <ImageIcon size={16} />
                素材库
              </p>
              <SelectionGrid
                items={assetOptions}
                selectedIds={draft.assetIds}
                onToggle={(id) => updateDraft("assetIds", toggleWriterSelection(id, draft.assetIds))}
                empty="暂无素材记录"
              />
            </div>
            <div>
              <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
                <Stamp size={16} />
                水印库
              </p>
              <SelectionGrid
                items={watermarkOptions}
                selectedIds={draft.watermarkIds}
                onToggle={(id) => updateDraft("watermarkIds", toggleWriterSelection(id, draft.watermarkIds))}
                empty="暂无水印记录"
              />
            </div>
            <div className="space-y-4">
              <div>
                <p className="text-sm font-semibold text-ink">AI 图文模型</p>
                <p className="mt-1 text-xs leading-5 text-muted">
                  写作：{providerStatus?.text.model ?? "读取中"} / 配图：{providerStatus?.image.model ?? "读取中"}
                </p>
                <p className={`mt-1 text-xs font-medium ${providerStatus?.image.configured ? "text-emerald-700" : "text-amber-700"}`}>
                  {providerStatus?.image.configured ? "图片 API 已加载，可在生成时创建封面和正文配图。" : "图片 API 未配置或仍在离线模式。"}
                </p>
              </div>
              <label className="flex items-center justify-between gap-4 text-sm font-medium text-ink">
                自动生成相关配图
                <input type="checkbox" checked={draft.generateImages} onChange={(event) => updateDraft("generateImages", event.target.checked)} />
              </label>
              <label className="grid gap-2 text-sm font-medium text-ink">
                配图策略
                <select
                  className="rounded-xl border border-line px-3 py-2"
                  disabled={!draft.generateImages}
                  value={draft.imageStrategy}
                  onChange={(event) => updateDraft("imageStrategy", event.target.value as ImageStrategy)}
                >
                  <option value="cover-and-inline">封面 + 正文插图</option>
                  <option value="cover">仅封面</option>
                  <option value="inline">仅正文插图</option>
                  <option value="thumbnail">缩略封面</option>
                  <option value="none">不配图</option>
                </select>
              </label>
              <label className="grid gap-2 text-sm font-medium text-ink">
                正文配图动态上限
                <input
                  className="rounded-xl border border-line px-3 py-2"
                  type="number"
                  min={0}
                  max={5}
                  disabled={!draft.generateImages || !["inline", "cover-and-inline"].includes(draft.imageStrategy)}
                  value={draft.maxInlineImages}
                  onChange={(event) => updateDraft("maxInlineImages", Math.max(0, Math.min(5, Number(event.target.value))))}
                />
                <span className="text-xs font-normal leading-5 text-muted">系统按文章长度和重点章节自动分配，通常每 500-700 字一张，最多生成该数量。</span>
              </label>
            </div>
          </div>
        );
      case "seo":
        return (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              {titleCandidates.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => updateDraft("title", item)}
                  className={`rounded-xl border p-3 text-left text-sm transition-all duration-150 ${
                    draft.title === item ? "border-brand bg-[#f3f0ff] text-brand font-bold" : "border-line bg-panel hover:border-brand/40 hover:bg-slate-50"
                  }`}
                >
                  {item}
                </button>
              ))}
            </div>
            <label className="grid gap-2 text-sm font-medium text-ink">
              SEO 标题
              <input className="rounded-xl border border-line px-3 py-2" value={draft.seoTitle} onChange={(event) => updateDraft("seoTitle", event.target.value)} />
            </label>
            <label className="grid gap-2 text-sm font-medium text-ink">
              Meta 描述
              <textarea
                className="min-h-20 rounded-xl border border-line px-3 py-2"
                value={draft.metaDescription}
                onChange={(event) => updateDraft("metaDescription", event.target.value)}
              />
            </label>
          </div>
        );
      case "structure":
        return (
          <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
            <label className="grid gap-2 text-sm font-medium text-ink">
              文章结构
              <textarea
                className="min-h-72 rounded-xl border border-line px-3 py-2 font-mono text-xs leading-6"
                value={draft.outline || makeOutline(draft.keyword, selectedSerp, selectedRule).join("\n")}
                onChange={(event) => updateDraft("outline", event.target.value)}
              />
            </label>
            <div>
              <p className="mb-2 text-sm font-semibold text-ink">增强能力</p>
              <div className="flex flex-wrap gap-2">
                {writerExtraOptions.map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => updateDraft("extras", toggleWriterSelection(item, draft.extras))}
                    className={`rounded-full border px-3 py-2 text-sm transition-all duration-150 ${
                      draft.extras.includes(item) ? "border-brand bg-[#f3f0ff] text-brand font-bold" : "border-line bg-panel hover:border-brand/40 hover:bg-slate-50"
                    }`}
                  >
                    {item}
                  </button>
                ))}
              </div>
              <label className="mt-4 grid gap-2 text-sm font-medium text-ink">
                次关键词
                <textarea
                  className="min-h-28 rounded-xl border border-line px-3 py-2"
                  value={draft.secondaryKeywords}
                  onChange={(event) => updateDraft("secondaryKeywords", event.target.value)}
                />
              </label>
            </div>
          </div>
        );
      case "publish":
        return (
          <div className="grid gap-4">
            <SelectionGrid
              items={publishTargets}
              selectedIds={draft.publishTargetIds}
              onToggle={(id) => updateDraft("publishTargetIds", toggleWriterSelection(id, draft.publishTargetIds))}
              empty="暂无可用媒体账号，请先在桌面端完成一键授权"
            />
          </div>
        );
      case "confirm":
        return (
          <div className="grid gap-4 xl:grid-cols-[1fr_300px]">
            <div className="rounded-2xl border border-line bg-panel p-5 text-sm leading-7 text-slate-700 shadow-soft">
              <p className="font-semibold text-ink text-base">{draft.title}</p>
              <p className="mt-2">
                模式：{selectedMode?.title ?? draft.mode} / 关键词：{draft.keyword} / 类型：
                {modeCapabilities.usesArticleType ? selectedArticleType?.name ?? "未选择" : "此模式不使用"}
              </p>
              <p>
                规则：{modeCapabilities.usesRule ? selectedRule?.name ?? "未选择" : "此模式不使用"} / SERP：
                {modeCapabilities.usesSerp ? selectedSerp?.keyword ?? "未选择" : "此模式不使用"}
              </p>
              <p>辅助资源：{supportSummary}</p>
              <p>
                AI 配图：{draft.generateImages ? `${draft.imageStrategy} / 正文上限 ${draft.maxInlineImages} 张` : "关闭"}
              </p>
              <p>发布渠道：{joinSelectionNames(publishTargets.filter((item) => draft.publishTargetIds.includes(item.id)))}</p>
              <div className="mt-4 rounded-xl bg-slate-50 border border-line p-3.5 font-mono text-xs leading-6 text-slate-600">
                {outlineLines.map((item) => (
                  <p key={item}>{item}</p>
                ))}
              </div>
            </div>
            <div className="space-y-3">
              <PrimaryButton disabled={busy || isRestoring || hasOpenTask} onClick={generateArticle}>
                <Sparkles size={16} />
                生成文案
              </PrimaryButton>
              {busy ? <LoadingState label="正在生成文章" /> : null}
              <p className="text-xs leading-5 text-muted">{message}</p>
              <div className="rounded-2xl border border-line bg-panel p-4 shadow-soft">
                <p className="text-sm font-semibold text-ink">最近文章</p>
                <div className="mt-3 space-y-2">
                  {articles.slice(0, 4).map((article) => (
                    <Link key={article.id} href={`/editor?articleId=${article.id}`} className="block rounded-lg border border-line bg-slate-50 px-3 py-2 text-sm hover:border-brand/40 hover:bg-slate-100 transition-all duration-150">
                      <span className="line-clamp-1 font-medium text-ink">{article.title}</span>
                      <span className="text-[11px] text-muted block mt-1">
                        {article.source ?? "AI 创作"} / {article.status}
                      </span>
                    </Link>
                  ))}
                  {!articles.length ? <p className="text-xs text-muted">暂无创作记录</p> : null}
                </div>
              </div>
            </div>
          </div>
        );
    }
  })();

  if (!open || !portalMounted) return null;

  return createPortal(
    <>
      <div className="fixed inset-0 z-[1000] bg-black/40 backdrop-blur-sm flex flex-col justify-end">
        <div className="absolute inset-0 bg-canvas text-ink">
          <div className="flex h-full flex-col relative z-10">
            <header className="flex items-center justify-between gap-4 border-b border-line bg-panel px-4 py-4 sm:px-6 shadow-soft">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand">AI Writer</p>
                <div className="mt-1 flex items-center gap-2">
                  <h2 className="truncate text-lg font-bold text-ink">沉浸式全屏向导</h2>
                  <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
                    草稿保留中
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted">将关键词、SERP、规则、素材和发布连成一条可执行的创作链路。</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="hidden rounded-full border border-line bg-panel px-3 py-1.5 text-xs text-muted md:inline-flex shadow-soft">
                  {navigation.progressText}
                </span>
                <button
                  type="button"
                  onClick={requestClose}
                  className="focus-ring inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border border-line bg-panel px-3 text-sm font-semibold text-ink hover:border-brand/40 hover:bg-slate-50 transition-colors shadow-soft"
                >
                  <X size={16} className="text-muted" />
                  退出
                </button>
              </div>
            </header>

            <div className="grid min-h-0 flex-1 lg:grid-cols-[280px_minmax(0,1fr)]">
              <aside className="flex min-h-0 flex-col border-r border-line bg-[#ffffff] text-slate-700">
                <div className="border-b border-line p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">步骤进度</p>
                      <p className="mt-1 text-xs text-slate-700 font-medium">
                         第 {navigation.activeStep + 1} 步 / 共 {navigation.steps.length} 步
                      </p>
                    </div>
                    <div className="rounded-full bg-[#f3f0ff] border border-brand/20 px-2.5 py-0.5 text-[11px] text-brand font-bold">{navigation.progressText}</div>
                  </div>
                  <div className="mt-3.5 h-2 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-brand transition-all duration-300 motion-reduce:transition-none"
                       style={{ width: `${((navigation.activeStep + 1) / navigation.steps.length) * 100}%` }}
                    />
                  </div>
                </div>

                <div className="hidden flex-1 overflow-y-auto p-3 lg:block">
                  <div className="space-y-1">
                    {navigation.steps.map((step) => (
                      <StepChip
                        key={step.id}
                        index={step.index}
                        label={step.label}
                        status={step.status}
                        accessible={step.accessible}
                        onClick={() => {
                          if (!navigation.canJumpToStep(step.index) || busy) return;
                          setActiveStep(step.index);
                        }}
                      />
                    ))}
                  </div>
                </div>

                <div className="border-t border-line p-4 lg:hidden">
                  <p className="text-xs uppercase tracking-[0.14em] text-slate-400">当前步骤</p>
                   <p className="mt-1 text-sm font-semibold text-slate-900">{currentStep?.label}</p>
                   <p className="mt-1 text-xs text-slate-500">{currentStep?.description}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {navigation.steps.map((step) => (
                      <button
                        key={step.id}
                        type="button"
                        disabled={!navigation.canJumpToStep(step.index) || busy}
                        onClick={() => setActiveStep(step.index)}
                        className={`rounded-full border px-3 py-1.5 text-xs transition disabled:cursor-not-allowed disabled:opacity-60 ${
                          step.status === "active"
                            ? "border-brand bg-brand text-white font-bold"
                            : step.status === "completed"
                              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                              : "border-slate-200 bg-slate-50 text-slate-400"
                        }`}
                      >
                        {step.index + 1}
                      </button>
                    ))}
                  </div>
                </div>
              </aside>

              <section className="flex min-w-0 flex-col">
                <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6 lg:px-8 bg-canvas">
                  <div className="mx-auto flex max-w-[800px] flex-col gap-4">
                    <div className="rounded-2xl border border-line bg-panel p-4 shadow-soft">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand">
                             {navigation.activeStep + 1}. {currentStep?.label}
                          </p>
                           <p className="mt-1 text-xs text-muted">{currentStep?.description}</p>
                        </div>
                        <div className="rounded-full bg-slate-50 px-3 py-1.5 text-xs text-muted border border-line">
                          {supportSummary}
                        </div>
                      </div>
                    </div>

                    <div className={`rounded-2xl border border-line bg-panel p-5 shadow-soft transition-all duration-300 motion-reduce:transition-none motion-reduce:transform-none ${panelReady ? "opacity-100 translate-x-0" : "opacity-0 translate-x-3"}`}>
                      {mainPanel}
                    </div>
                  </div>
                </div>

                <footer className="sticky bottom-0 border-t border-line bg-panel px-4 py-4 sm:px-6 shadow-soft">
                  <div className="mx-auto flex max-w-[800px] items-center justify-between gap-3">
                    <SecondaryButton
                      disabled={!navigation.canGoBack || busy}
                      onClick={() => setActiveStep((step) => Math.max(0, step - 1))}
                    >
                      <ChevronLeft size={16} />
                      上一步
                    </SecondaryButton>
                    <p className="hidden max-w-xl truncate text-sm text-muted md:block">{message}</p>
                    {navigation.canGoNext ? (
                      <PrimaryButton
                        disabled={busy}
                        onClick={() => setActiveStep((step) => Math.min(navigation.steps.length - 1, step + 1))}
                      >
                        {navigation.primaryActionLabel}
                        <ChevronRight size={16} />
                      </PrimaryButton>
                    ) : (
                      <PrimaryButton disabled={busy || isRestoring || hasOpenTask} onClick={generateArticle}>
                        <Sparkles size={16} />
                        {navigation.primaryActionLabel}
                      </PrimaryButton>
                    )}
                  </div>
                </footer>
              </section>
            </div>
          </div>
        </div>
      </div>

      {exitConfirmOpen ? (
        <div className="fixed inset-0 z-[1100] grid place-items-center bg-black/40 backdrop-blur-sm px-4">
          <div className="w-full max-w-lg rounded-2xl border border-line bg-white p-6 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                <Lock size={18} />
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-ink">退出前要怎么处理这份草稿？</h3>
                <p className="mt-1.5 text-xs leading-5 text-slate-650">
                  你已经修改了向导内容。保存并退出会保留当前草稿，放弃退出会恢复到初始内容。
                </p>
              </div>
            </div>
            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <SecondaryButton disabled={busy} onClick={() => setExitConfirmOpen(false)}>
                继续编辑
              </SecondaryButton>
              <SecondaryButton disabled={busy} onClick={discardAndClose}>
                放弃退出
              </SecondaryButton>
              <PrimaryButton disabled={busy} onClick={saveAndClose}>
                保存并退出
              </PrimaryButton>
            </div>
          </div>
        </div>
      ) : null}
    </>,
    document.body
  );
}
