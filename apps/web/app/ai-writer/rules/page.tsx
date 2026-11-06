"use client";

import { AppShell } from "@/components/app-shell";
import { EmptyState, LoadingState, PageHeader, PrimaryButton, SecondaryButton, Section } from "@/components/ui";
import type { AssetTagGroup, BrandProfile, CompetitorProfile, GenerationRule, KnowledgeItem, Watermark } from "@zengxing/core";
import { CheckSquare, Copy, FileText, ImageIcon, Pencil, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { formatAppTimestamp } from "@/lib/app-time";

type RuleType = GenerationRule["type"];
type SourceMode = NonNullable<GenerationRule["sourceMode"]>;
type KeywordPickMode = NonNullable<GenerationRule["keywordPickMode"]>;
type ModelProvider = NonNullable<GenerationRule["modelProvider"]>;
type RuleStatus = NonNullable<GenerationRule["status"]>;
type ImageStrategy = NonNullable<GenerationRule["imageStrategy"]>;
type GeoStrategy = NonNullable<GenerationRule["geoStrategy"]>;

type SupportResources = {
  knowledgeItems: KnowledgeItem[];
  assetTagGroups: AssetTagGroup[];
  brandProfiles: BrandProfile[];
  competitorProfiles: CompetitorProfile[];
  watermarks: Watermark[];
};

type FormState = {
  name: string;
  type: RuleType;
  content: string;
  sourceMode: SourceMode;
  keywordLibraryName: string;
  keywordPickMode: KeywordPickMode;
  keywordCount: number;
  forcedTitleKeywords: string;
  contentRequirements: string;
  humanizationRules: string;
  replacementRules: string;
  knowledgeBaseRefs: string[];
  assetTagGroupRefs: string[];
  brandProfileRefs: string[];
  competitorProfileRefs: string[];
  watermarkRefs: string[];
  imageStrategy: ImageStrategy;
  geoStrategy: GeoStrategy;
  formatRules: string;
  structureRules: string;
  internalLinkRules: string;
  externalLinkRules: string;
  fixedIntro: string;
  fixedOutro: string;
  modelProvider: ModelProvider;
  status: RuleStatus;
};

const emptyGeoStrategy: GeoStrategy = {
  includeFaq: false,
  includeCitationSummary: false,
  trackBrandMention: false,
  trackCompetitorMention: false
};

const defaultForm: FormState = {
  name: "",
  type: "article",
  content: "",
  sourceMode: "keyword-library",
  keywordLibraryName: "",
  keywordPickMode: "top10",
  keywordCount: 10,
  forcedTitleKeywords: "",
  contentRequirements: "",
  humanizationRules: "",
  replacementRules: "",
  knowledgeBaseRefs: [],
  assetTagGroupRefs: [],
  brandProfileRefs: [],
  competitorProfileRefs: [],
  watermarkRefs: [],
  imageStrategy: "cover-and-inline",
  geoStrategy: {
    includeFaq: true,
    includeCitationSummary: true,
    trackBrandMention: true,
    trackCompetitorMention: true
  },
  formatRules: "",
  structureRules: "",
  internalLinkRules: "",
  externalLinkRules: "",
  fixedIntro: "",
  fixedOutro: "",
  modelProvider: "DeepSeek",
  status: "active"
};

const typeLabel: Record<RuleType, string> = {
  article: "长文章",
  "image-text": "图文"
};

const sourceLabel: Record<SourceMode, string> = {
  "keyword-library": "关键词库",
  "manual-keywords": "手动关键词",
  serp: "SERP 分析",
  template: "模板"
};

const pickModeLabel: Record<KeywordPickMode, string> = {
  top10: "Top 10",
  manual: "手动选择",
  random: "随机抽取"
};

const imageStrategyLabel: Record<ImageStrategy, string> = {
  none: "不自动配图",
  cover: "仅封面图",
  inline: "仅正文插图",
  "cover-and-inline": "封面图 + 正文插图",
  thumbnail: "仅缩略图"
};

const modelOptions: ModelProvider[] = ["DeepSeek", "OpenAI", "文心一言"];

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

function splitList(value: string) {
  return value
    .split(/[,，、\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinList(value?: string[]) {
  return (value ?? []).join("、");
}

function cleanRefs(value?: string[]) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function ruleToForm(rule: GenerationRule): FormState {
  return {
    name: rule.name,
    type: rule.type,
    content: rule.content,
    sourceMode: rule.sourceMode ?? "keyword-library",
    keywordLibraryName: rule.keywordLibraryName ?? "",
    keywordPickMode: rule.keywordPickMode ?? "top10",
    keywordCount: rule.keywordCount ?? 10,
    forcedTitleKeywords: joinList(rule.forcedTitleKeywords),
    contentRequirements: rule.contentRequirements ?? "",
    humanizationRules: rule.humanizationRules ?? "",
    replacementRules: rule.replacementRules ?? "",
    knowledgeBaseRefs: cleanRefs(rule.knowledgeBaseRefs),
    assetTagGroupRefs: cleanRefs(rule.assetTagGroupRefs),
    brandProfileRefs: cleanRefs(rule.brandProfileRefs),
    competitorProfileRefs: cleanRefs(rule.competitorProfileRefs),
    watermarkRefs: cleanRefs(rule.watermarkRefs),
    imageStrategy: rule.imageStrategy ?? "cover-and-inline",
    geoStrategy: rule.geoStrategy ?? emptyGeoStrategy,
    formatRules: rule.formatRules ?? "",
    structureRules: rule.structureRules ?? "",
    internalLinkRules: rule.internalLinkRules ?? "",
    externalLinkRules: rule.externalLinkRules ?? "",
    fixedIntro: rule.fixedIntro ?? "",
    fixedOutro: rule.fixedOutro ?? "",
    modelProvider: rule.modelProvider ?? "DeepSeek",
    status: rule.status ?? "active"
  };
}

function formToPayload(form: FormState): Partial<GenerationRule> {
  return {
    ...form,
    forcedTitleKeywords: splitList(form.forcedTitleKeywords),
    keywordCount: Math.max(1, Number(form.keywordCount) || 1)
  };
}

function findNames<T extends { id: string; name?: string; title?: string }>(items: T[], refs?: string[]) {
  return cleanRefs(refs).map((id) => items.find((item) => item.id === id)?.name ?? items.find((item) => item.id === id)?.title ?? id);
}

function RuleBadge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "active" | "draft" }) {
  const className = tone === "active"
    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
    : tone === "draft"
      ? "border-amber-200 bg-amber-50 text-amber-700"
      : "border-line bg-slate-50 text-slate-700";
  return <span className={`inline-flex rounded-md border px-2 py-1 text-xs font-medium ${className}`}>{children}</span>;
}

function DetailLine({ label, value }: { label: string; value?: string | number | string[] }) {
  const text = Array.isArray(value) ? value.join("、") : value;
  return (
    <div className="rounded-md bg-slate-50 px-3 py-2">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-sm leading-6 text-ink">{text || "未配置"}</p>
    </div>
  );
}

function ResourcePicker({
  label,
  items,
  selected,
  onChange,
  getSubtitle
}: {
  label: string;
  items: Array<{ id: string; name?: string; title?: string }>;
  selected: string[];
  onChange: (value: string[]) => void;
  getSubtitle?: (id: string) => string;
}) {
  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);
  }

  return (
    <div className="rounded-md border border-line bg-white p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-ink">{label}</p>
        <RuleBadge>{selected.length} 个</RuleBadge>
      </div>
      <div className="grid max-h-52 gap-2 overflow-y-auto pr-1">
        {items.length ? items.map((item) => {
          const checked = selected.includes(item.id);
          return (
            <label key={item.id} className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm ${checked ? "border-brand bg-blue-50" : "border-line bg-white"}`}>
              <input type="checkbox" className="mt-1" checked={checked} onChange={() => toggle(item.id)} />
              <span>
                <span className="block font-medium text-ink">{item.name ?? item.title ?? item.id}</span>
                {getSubtitle ? <span className="mt-1 block text-xs leading-5 text-muted">{getSubtitle(item.id)}</span> : null}
              </span>
            </label>
          );
        }) : <p className="rounded-md bg-slate-50 px-3 py-4 text-sm text-muted">暂无可选资源，先去对应库里创建。</p>}
      </div>
    </div>
  );
}

function ToggleLine({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-md border border-line bg-white px-3 py-2 text-sm text-ink">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

function toggleSetValue<T>(set: Set<T>, value: T) {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export default function GenerationRulesPage() {
  const [rules, setRules] = useState<GenerationRule[]>([]);
  const [resources, setResources] = useState<SupportResources>({
    knowledgeItems: [],
    assetTagGroups: [],
    brandProfiles: [],
    competitorProfiles: [],
    watermarks: []
  });
  const [message, setMessage] = useState("生成规则会被 AI 创作、SERP 创作、自动发布和自动 GEO 复用。");
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(defaultForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedRuleIds, setSelectedRuleIds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"all" | SourceMode>("all");

  async function refreshRules() {
    const nextRules = await jsonFetch<GenerationRule[]>("/api/generation-rules");
    setRules(nextRules);
    setSelectedId((current) => current ?? nextRules[0]?.id ?? null);
  }

  async function refreshResources() {
    const [knowledgeItems, assetTagGroups, brandProfiles, competitorProfiles, watermarks] = await Promise.all([
      jsonFetch<KnowledgeItem[]>("/api/knowledge-base"),
      jsonFetch<AssetTagGroup[]>("/api/assets/tag-groups"),
      jsonFetch<BrandProfile[]>("/api/brand-library"),
      jsonFetch<CompetitorProfile[]>("/api/competitor-library"),
      jsonFetch<Watermark[]>("/api/watermarks")
    ]);
    setResources({ knowledgeItems, assetTagGroups, brandProfiles, competitorProfiles, watermarks });
  }

  useEffect(() => {
    Promise.all([refreshRules(), refreshResources()]).catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
  }, []);

  const filteredRules = useMemo(() => {
    const text = query.trim().toLowerCase();
    return rules.filter((rule) => {
      const sourceMode = rule.sourceMode ?? "keyword-library";
      const matchesSource = sourceFilter === "all" || sourceFilter === sourceMode;
      const haystack = `${rule.name} ${rule.content} ${rule.keywordLibraryName ?? ""} ${(rule.forcedTitleKeywords ?? []).join(" ")}`.toLowerCase();
      return matchesSource && (!text || haystack.includes(text));
    });
  }, [query, rules, sourceFilter]);

  const selectedRule = rules.find((rule) => rule.id === selectedId) ?? filteredRules[0] ?? rules[0];
  const allVisibleSelected = filteredRules.length > 0 && filteredRules.every((rule) => selectedRuleIds.has(rule.id));

  async function saveRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const payload = formToPayload(form);
      const rule = editingId
        ? await jsonFetch<GenerationRule>(`/api/generation-rules/${editingId}`, { method: "PATCH", body: JSON.stringify(payload) })
        : await jsonFetch<GenerationRule>("/api/generation-rules", { method: "POST", body: JSON.stringify(payload) });
      await refreshRules();
      setSelectedId(rule.id);
      setMessage(editingId ? `已更新规则：${rule.name}` : `已创建规则：${rule.name}`);
      setEditingId(null);
      setForm(defaultForm);
      setShowForm(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function cloneRule(rule: GenerationRule) {
    setBusy(true);
    try {
      const clone = await jsonFetch<GenerationRule>("/api/generation-rules", {
        method: "POST",
        body: JSON.stringify({ ...rule, id: undefined, name: `${rule.name} 副本`, status: "draft" })
      });
      await refreshRules();
      setSelectedId(clone.id);
      setMessage(`已克隆规则：${clone.name}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function removeRule(ruleId: string) {
    setBusy(true);
    try {
      await jsonFetch(`/api/generation-rules/${ruleId}`, { method: "DELETE" });
      await refreshRules();
      setSelectedId(null);
      setMessage("已删除规则。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function batchUpdateStatus(status: RuleStatus) {
    const ids = Array.from(selectedRuleIds);
    if (!ids.length) return;
    setBusy(true);
    try {
      const updated: GenerationRule[] = [];
      for (const id of ids) {
        updated.push(await jsonFetch<GenerationRule>(`/api/generation-rules/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }));
      }
      await refreshRules();
      setMessage(`已将 ${updated.length} 条规则切换为${status === "active" ? "启用" : "草稿"}状态。`);
      setSelectedRuleIds(new Set());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function updateRuleStatus(ruleId: string, status: RuleStatus) {
    setBusy(true);
    try {
      const updated = await jsonFetch<GenerationRule>(`/api/generation-rules/${ruleId}`, { method: "PATCH", body: JSON.stringify({ status }) });
      await refreshRules();
      setSelectedId(updated.id);
      setMessage(`已将规则「${updated.name}」切换为${status === "active" ? "启用" : "草稿"}状态。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const ruleScenePresets: Array<{ label: string; description: string; form: Partial<FormState> }> = [
    {
      label: "SEO 长文",
      description: "H2/H3 + FAQ + 可执行结论",
      form: {
        name: "SEO 长文规则",
        type: "article",
        sourceMode: "manual-keywords",
        content: "H2/H3 结构、FAQ、可执行结论",
        contentRequirements: "每个 H2 给一句可引用结论；覆盖定义、方法、案例和 FAQ。",
        structureRules: "问题 → 方法 → 案例 → 清单 → FAQ",
        imageStrategy: "cover-and-inline",
        geoStrategy: { includeFaq: true, includeCitationSummary: true, trackBrandMention: true, trackCompetitorMention: false },
        status: "active"
      }
    },
    {
      label: "图文种草",
      description: "短段落 + 封面插图",
      form: {
        name: "图文种草规则",
        type: "image-text",
        sourceMode: "manual-keywords",
        content: "短段落、封面+插图、适合媒体分发",
        contentRequirements: "标题不超过 28 字，段落短，适合配图阅读。",
        structureRules: "背景 → 痛点 → 方案 → 行动建议",
        imageStrategy: "cover-and-inline",
        status: "active"
      }
    },
    {
      label: "GEO FAQ",
      description: "问答短答 + 引用友好",
      form: {
        name: "GEO FAQ 规则",
        type: "article",
        sourceMode: "serp",
        content: "问题集合、短答案、可摘录句",
        contentRequirements: "每个问题首句先给结论，再解释依据。",
        structureRules: "每个 H3 一个真实问题",
        imageStrategy: "none",
        geoStrategy: { includeFaq: true, includeCitationSummary: true, trackBrandMention: true, trackCompetitorMention: true },
        status: "active"
      }
    }
  ];

  function startCreate(type: RuleType) {
    setEditingId(null);
    setForm({ ...defaultForm, type });
    setShowForm(true);
  }

  function applyScenePreset(preset: (typeof ruleScenePresets)[number]) {
    setEditingId(null);
    setForm({ ...defaultForm, ...preset.form, type: (preset.form.type as RuleType) || "article" });
    setShowForm(true);
  }

  async function aiFillRuleFields() {
    setBusy(true);
    try {
      const result = await jsonFetch<{ draft: Partial<GenerationRule> & { forcedTitleKeywords?: string[] } }>(
        "/api/generation-rules/ai-draft",
        {
          method: "POST",
          body: JSON.stringify({
            name: form.name,
            type: form.type,
            scene: form.name || form.content || "SEO 内容创作",
            hint: form.contentRequirements || form.content || ""
          })
        }
      );
      const draft = result.draft;
      setForm((current) => ({
        ...current,
        name: String(draft.name || current.name || "新规则"),
        type: (draft.type as RuleType) || current.type,
        content: String(draft.content ?? current.content),
        contentRequirements: String(draft.contentRequirements ?? current.contentRequirements),
        humanizationRules: String(draft.humanizationRules ?? current.humanizationRules),
        replacementRules: String(draft.replacementRules ?? current.replacementRules),
        formatRules: String(draft.formatRules ?? current.formatRules),
        structureRules: String(draft.structureRules ?? current.structureRules),
        internalLinkRules: String(draft.internalLinkRules ?? current.internalLinkRules),
        externalLinkRules: String(draft.externalLinkRules ?? current.externalLinkRules),
        fixedIntro: String(draft.fixedIntro ?? current.fixedIntro),
        fixedOutro: String(draft.fixedOutro ?? current.fixedOutro),
        forcedTitleKeywords: Array.isArray(draft.forcedTitleKeywords)
          ? draft.forcedTitleKeywords.join("、")
          : current.forcedTitleKeywords,
        imageStrategy: (draft.imageStrategy as ImageStrategy) || current.imageStrategy,
        geoStrategy: draft.geoStrategy
          ? {
              includeFaq: Boolean(draft.geoStrategy.includeFaq),
              includeCitationSummary: Boolean(draft.geoStrategy.includeCitationSummary),
              trackBrandMention: Boolean(draft.geoStrategy.trackBrandMention),
              trackCompetitorMention: Boolean(draft.geoStrategy.trackCompetitorMention)
            }
          : current.geoStrategy,
        sourceMode: (draft.sourceMode as SourceMode) || current.sourceMode,
        modelProvider: "DeepSeek",
        status: "active"
      }));
      setShowForm(true);
      setMessage("DeepSeek 已把规则字段补全完了，你改改不满意的再保存。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function startEdit(rule: GenerationRule) {
    setEditingId(rule.id);
    setForm(ruleToForm(rule));
    setSelectedId(rule.id);
    setShowForm(true);
  }

  function cancelForm() {
    setEditingId(null);
    setForm(defaultForm);
    setShowForm(false);
  }

  const selectedResourceNames = selectedRule ? {
    knowledge: findNames(resources.knowledgeItems, selectedRule.knowledgeBaseRefs),
    assets: findNames(resources.assetTagGroups, selectedRule.assetTagGroupRefs),
    brands: findNames(resources.brandProfiles, selectedRule.brandProfileRefs),
    competitors: findNames(resources.competitorProfiles, selectedRule.competitorProfileRefs),
    watermarks: findNames(resources.watermarks, selectedRule.watermarkRefs)
  } : null;

  return (
    <AppShell>
      <PageHeader
        eyebrow="Rules"
        title="生成规则"
        description="系统已预置默认规则。新建时先点场景卡片，专家字段能不填就不填。"
        action={
          <div className="flex flex-wrap gap-2">
            <SecondaryButton onClick={() => startCreate("image-text")}><ImageIcon size={16} />新建图文规则</SecondaryButton>
            <PrimaryButton onClick={() => startCreate("article")}><FileText size={16} />新建文章规则</PrimaryButton>
          </div>
        }
      />

      <div className="space-y-6 p-6">
        <div className="grid gap-3 md:grid-cols-3">
          {ruleScenePresets.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => applyScenePreset(preset)}
              className="rounded-2xl border border-line bg-white p-4 text-left transition hover:border-brand hover:bg-[#f8f6ff]"
            >
              <p className="text-sm font-semibold text-ink">套用：{preset.label}</p>
              <p className="mt-1 text-xs leading-5 text-muted">{preset.description}</p>
            </button>
          ))}
        </div>

        <div className="grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
          <Section
            title="规则列表"
            description="一键创作会默认用「系统默认文章规则」。这里只给要精细控权的人用。"
            action={<RuleBadge>{filteredRules.length} 条</RuleBadge>}
          >
            <div className="mb-4 grid gap-3 md:grid-cols-[1fr_180px]">
              <label className="flex h-10 items-center gap-2 rounded-md border border-line bg-white px-3 text-sm text-muted">
                <Search size={16} />
                <input className="w-full bg-transparent text-ink outline-none" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="按名称、关键词库或标题词筛选" />
              </label>
              <select className="h-10 rounded-md border border-line bg-white px-3 text-sm text-ink" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as "all" | SourceMode)}>
                <option value="all">全部创建方式</option>
                <option value="keyword-library">关键词库</option>
                <option value="manual-keywords">手动关键词</option>
                <option value="serp">SERP 分析</option>
                <option value="template">模板</option>
              </select>
            </div>

            {selectedRuleIds.size ? (
              <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-blue-800">
                <CheckSquare size={15} />
                <span>已选 {selectedRuleIds.size} 条规则</span>
                <SecondaryButton disabled={busy} onClick={() => batchUpdateStatus("active")}>批量启用</SecondaryButton>
                <SecondaryButton disabled={busy} onClick={() => batchUpdateStatus("draft")}>转为草稿</SecondaryButton>
                <SecondaryButton onClick={() => setSelectedRuleIds(new Set())}><X size={15} />清空选择</SecondaryButton>
              </div>
            ) : null}

            <div className="overflow-x-auto rounded-md border border-line">
              <table className="w-full min-w-[920px] text-left text-sm">
                <thead className="bg-slate-50 text-xs text-muted">
                  <tr>
                    <th className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        onChange={(event) => {
                          setSelectedRuleIds((current) => {
                            const next = new Set(current);
                            filteredRules.forEach((rule) => event.target.checked ? next.add(rule.id) : next.delete(rule.id));
                            return next;
                          });
                        }}
                      />
                    </th>
                    <th className="px-4 py-3">名称</th>
                    <th className="px-4 py-3">创建方式</th>
                    <th className="px-4 py-3">资源引用</th>
                    <th className="px-4 py-3">图片/GEO</th>
                    <th className="px-4 py-3">时间</th>
                    <th className="px-4 py-3">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRules.map((rule) => {
                    const sourceMode = rule.sourceMode ?? "keyword-library";
                    const status = rule.status ?? "active";
                    const resourceCount = cleanRefs(rule.knowledgeBaseRefs).length
                      + cleanRefs(rule.assetTagGroupRefs).length
                      + cleanRefs(rule.brandProfileRefs).length
                      + cleanRefs(rule.competitorProfileRefs).length
                      + cleanRefs(rule.watermarkRefs).length;
                    return (
                      <tr key={rule.id} className={`border-t border-line ${selectedRule?.id === rule.id ? "bg-blue-50/60" : "bg-white"}`}>
                        <td className="px-4 py-3">
                          <input type="checkbox" checked={selectedRuleIds.has(rule.id)} onChange={() => setSelectedRuleIds((current) => toggleSetValue(current, rule.id))} />
                        </td>
                        <td className="px-4 py-3">
                          <button className="text-left" onClick={() => setSelectedId(rule.id)}>
                            <span className="font-semibold text-ink">{rule.name}</span>
                            <span className="mt-1 flex flex-wrap gap-1">
                              <RuleBadge>{typeLabel[rule.type]}</RuleBadge>
                              <RuleBadge tone={status}>{status === "active" ? "启用" : "草稿"}</RuleBadge>
                            </span>
                          </button>
                        </td>
                        <td className="px-4 py-3 text-muted">
                          <div>{sourceLabel[sourceMode]}</div>
                          <div className="mt-1 text-xs">{pickModeLabel[rule.keywordPickMode ?? "top10"]} / {rule.keywordCount ?? 10} 个</div>
                        </td>
                        <td className="px-4 py-3 text-muted">
                          <div>{resourceCount} 个支撑资源</div>
                          <div className="mt-1 text-xs">{rule.keywordLibraryName || joinList(rule.forcedTitleKeywords) || "未绑定关键词"}</div>
                        </td>
                        <td className="px-4 py-3 text-muted">
                          <div>{imageStrategyLabel[rule.imageStrategy ?? "none"]}</div>
                          <div className="mt-1 text-xs">{rule.geoStrategy?.includeCitationSummary ? "含引用摘要" : "未开引用摘要"}</div>
                        </td>
                        <td className="px-4 py-3 text-muted">{formatAppTimestamp(rule.updatedAt ?? rule.createdAt)}</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-2">
                            <SecondaryButton onClick={() => startEdit(rule)}><Pencil size={15} />编辑</SecondaryButton>
                            <SecondaryButton onClick={() => cloneRule(rule)}><Copy size={15} />克隆</SecondaryButton>
                            <SecondaryButton onClick={() => removeRule(rule.id)}><Trash2 size={15} />删除</SecondaryButton>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {filteredRules.length === 0 ? <EmptyState title="没有符合条件的规则" description="换一个筛选条件，或新建一条文章/图文生成规则。" /> : null}
            </div>
          </Section>

          <Section title="规则预览" description="这里对应快鲸规则详情中的配置模块。">
            {selectedRule && selectedResourceNames ? (
              <div className="space-y-3">
                <div className="rounded-md border border-line bg-white p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-ink">{selectedRule.name}</p>
                      <p className="mt-1 text-xs text-muted">规则状态会影响 AI 创作、自动发布和自动 GEO 是否可调用。</p>
                    </div>
                    <RuleBadge tone={selectedRule.status ?? "active"}>{(selectedRule.status ?? "active") === "active" ? "启用" : "草稿"}</RuleBadge>
                  </div>
                  <div className="mt-3 grid gap-2 text-sm">
                    {(["draft", "active"] as RuleStatus[]).map((status) => (
                      <div key={status} className={`rounded-md px-3 py-2 ${selectedRule.status === status || (!selectedRule.status && status === "active") ? "bg-blue-50 text-brand" : "bg-slate-50 text-muted"}`}>
                        {status === "active" ? "启用：可被创作和发布任务调用" : "草稿：仅保存配置，不进入任务选择"}
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <SecondaryButton disabled={busy} onClick={() => startEdit(selectedRule)}><Pencil size={15} />编辑规则</SecondaryButton>
                    <SecondaryButton disabled={busy} onClick={() => updateRuleStatus(selectedRule.id, (selectedRule.status ?? "active") === "active" ? "draft" : "active")}>
                      {(selectedRule.status ?? "active") === "active" ? "转为草稿" : "启用规则"}
                    </SecondaryButton>
                  </div>
                </div>
                <DetailLine label="基础设置" value={`${sourceLabel[selectedRule.sourceMode ?? "keyword-library"]} / ${typeLabel[selectedRule.type]} / ${selectedRule.modelProvider ?? "DeepSeek"}`} />
                <DetailLine label="关键词策略" value={selectedRule.keywordLibraryName || joinList(selectedRule.forcedTitleKeywords)} />
                <DetailLine label="知识库" value={selectedResourceNames.knowledge} />
                <DetailLine label="素材标签组" value={selectedResourceNames.assets} />
                <DetailLine label="品牌库" value={selectedResourceNames.brands} />
                <DetailLine label="竞品库" value={selectedResourceNames.competitors} />
                <DetailLine label="水印库" value={selectedResourceNames.watermarks} />
                <DetailLine label="图片策略" value={imageStrategyLabel[selectedRule.imageStrategy ?? "none"]} />
                <DetailLine label="GEO 策略" value={[
                  selectedRule.geoStrategy?.includeFaq ? "生成 FAQ" : "",
                  selectedRule.geoStrategy?.includeCitationSummary ? "引用摘要" : "",
                  selectedRule.geoStrategy?.trackBrandMention ? "追踪品牌命中" : "",
                  selectedRule.geoStrategy?.trackCompetitorMention ? "追踪竞品命中" : ""
                ].filter(Boolean) as string[]} />
                <DetailLine label="内容要求" value={selectedRule.contentRequirements ?? selectedRule.content} />
                <DetailLine label="文章结构" value={selectedRule.structureRules} />
                <DetailLine label="内链/外链" value={[selectedRule.internalLinkRules, selectedRule.externalLinkRules].filter(Boolean) as string[]} />
              </div>
            ) : (
              <p className="text-sm text-muted">选择一条规则查看模块配置。</p>
            )}
          </Section>
        </div>

        {showForm ? (
          <Section title={editingId ? "编辑生成规则" : "新建生成规则"} description="写个名字，点「DeepSeek 一键补全」把长字段填上。别手写十段 prompt。">
            <form className="space-y-4" onSubmit={saveRule}>
              <div className="flex flex-wrap gap-2">
                <SecondaryButton type="button" disabled={busy} onClick={() => void aiFillRuleFields()}>
                  DeepSeek 一键补全字段
                </SecondaryButton>
                <p className="self-center text-xs text-muted">用项目里已配的 DeepSeek API，自动写内容要求 / 结构 / 拟人化等。</p>
              </div>
              <div className="grid gap-4 lg:grid-cols-4">
                <label className="grid gap-2 text-sm font-medium text-ink">规则名称<input className="rounded-md border border-line px-3 py-2" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="例如：SEO/GEO 长文章规则" /></label>
                <label className="grid gap-2 text-sm font-medium text-ink">规则类型<select className="rounded-md border border-line px-3 py-2" value={form.type} onChange={(event) => setForm((current) => ({ ...current, type: event.target.value as RuleType }))}><option value="article">长文章</option><option value="image-text">图文</option></select></label>
                <label className="grid gap-2 text-sm font-medium text-ink">创建方式<select className="rounded-md border border-line px-3 py-2" value={form.sourceMode} onChange={(event) => setForm((current) => ({ ...current, sourceMode: event.target.value as SourceMode }))}><option value="keyword-library">关键词库生成</option><option value="manual-keywords">手动关键词</option><option value="serp">SERP 分析生成</option><option value="template">模板生成</option></select></label>
                <label className="grid gap-2 text-sm font-medium text-ink">生成模型<select className="rounded-md border border-line px-3 py-2" value={form.modelProvider} onChange={(event) => setForm((current) => ({ ...current, modelProvider: event.target.value as ModelProvider }))}>{modelOptions.map((model) => <option key={model} value={model}>{model}</option>)}</select></label>
              </div>

              <details className="rounded-md border border-line bg-white" open>
                <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-ink">基础设置与关键词</summary>
                <div className="grid gap-4 border-t border-line p-4 lg:grid-cols-4">
                  <label className="grid gap-2 text-sm font-medium text-ink">关键词库<input className="rounded-md border border-line px-3 py-2" value={form.keywordLibraryName} onChange={(event) => setForm((current) => ({ ...current, keywordLibraryName: event.target.value }))} placeholder="AI SEO 核心词库" /></label>
                  <label className="grid gap-2 text-sm font-medium text-ink">关键词选择<select className="rounded-md border border-line px-3 py-2" value={form.keywordPickMode} onChange={(event) => setForm((current) => ({ ...current, keywordPickMode: event.target.value as KeywordPickMode }))}><option value="top10">Top 10</option><option value="manual">手动选择</option><option value="random">随机抽取</option></select></label>
                  <label className="grid gap-2 text-sm font-medium text-ink">关键词数量<input type="number" min={1} className="rounded-md border border-line px-3 py-2" value={form.keywordCount} onChange={(event) => setForm((current) => ({ ...current, keywordCount: Number(event.target.value) }))} /></label>
                  <label className="grid gap-2 text-sm font-medium text-ink">状态<select className="rounded-md border border-line px-3 py-2" value={form.status} onChange={(event) => setForm((current) => ({ ...current, status: event.target.value as RuleStatus }))}><option value="active">启用</option><option value="draft">草稿</option></select></label>
                  <label className="grid gap-2 text-sm font-medium text-ink lg:col-span-4">标题强制包含词<input className="rounded-md border border-line px-3 py-2" value={form.forcedTitleKeywords} onChange={(event) => setForm((current) => ({ ...current, forcedTitleKeywords: event.target.value }))} placeholder="每行或逗号分隔，例如：AI SEO、GEO 优化" /></label>
                </div>
              </details>

              <details className="rounded-md border border-line bg-white" open>
                <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-ink">支撑资源</summary>
                <div className="grid gap-4 border-t border-line p-4 xl:grid-cols-3">
                  <ResourcePicker label="知识库" items={resources.knowledgeItems} selected={form.knowledgeBaseRefs} onChange={(value) => setForm((current) => ({ ...current, knowledgeBaseRefs: value }))} getSubtitle={(id) => resources.knowledgeItems.find((item) => item.id === id)?.source ?? ""} />
                  <ResourcePicker label="素材库标签组" items={resources.assetTagGroups} selected={form.assetTagGroupRefs} onChange={(value) => setForm((current) => ({ ...current, assetTagGroupRefs: value }))} getSubtitle={(id) => `${resources.assetTagGroups.find((item) => item.id === id)?.tags.length ?? 0} 个标签`} />
                  <ResourcePicker label="水印库" items={resources.watermarks} selected={form.watermarkRefs} onChange={(value) => setForm((current) => ({ ...current, watermarkRefs: value }))} getSubtitle={(id) => resources.watermarks.find((item) => item.id === id)?.position ?? ""} />
                  <ResourcePicker label="品牌库" items={resources.brandProfiles} selected={form.brandProfileRefs} onChange={(value) => setForm((current) => ({ ...current, brandProfileRefs: value }))} getSubtitle={(id) => joinList(resources.brandProfiles.find((item) => item.id === id)?.products)} />
                  <ResourcePicker label="竞品库" items={resources.competitorProfiles} selected={form.competitorProfileRefs} onChange={(value) => setForm((current) => ({ ...current, competitorProfileRefs: value }))} getSubtitle={(id) => resources.competitorProfiles.find((item) => item.id === id)?.relation ?? ""} />
                  <div className="rounded-md border border-line bg-white p-3">
                    <label className="grid gap-2 text-sm font-semibold text-ink">图片策略<select className="rounded-md border border-line px-3 py-2 font-normal" value={form.imageStrategy} onChange={(event) => setForm((current) => ({ ...current, imageStrategy: event.target.value as ImageStrategy }))}>{Object.entries(imageStrategyLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                    <p className="mt-3 text-xs leading-5 text-muted">用于后续 AI 创作自动决定是否生成封面、正文插图或缩略图，并和素材库、水印库联动。</p>
                  </div>
                </div>
              </details>

              <details className="rounded-md border border-line bg-white" open>
                <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-ink">内容要求、拟人化、全文替换</summary>
                <div className="grid gap-4 border-t border-line p-4 lg:grid-cols-3">
                  <label className="grid gap-2 text-sm font-medium text-ink">规则摘要<textarea className="min-h-28 rounded-md border border-line px-3 py-2" value={form.content} onChange={(event) => setForm((current) => ({ ...current, content: event.target.value }))} placeholder="列表里展示的短摘要" /></label>
                  <label className="grid gap-2 text-sm font-medium text-ink">内容要求<textarea className="min-h-28 rounded-md border border-line px-3 py-2" value={form.contentRequirements} onChange={(event) => setForm((current) => ({ ...current, contentRequirements: event.target.value }))} placeholder="文章必须覆盖哪些主题、结论和 FAQ" /></label>
                  <label className="grid gap-2 text-sm font-medium text-ink">拟人化写作<textarea className="min-h-28 rounded-md border border-line px-3 py-2" value={form.humanizationRules} onChange={(event) => setForm((current) => ({ ...current, humanizationRules: event.target.value }))} placeholder="语气、人称、口吻约束" /></label>
                  <label className="grid gap-2 text-sm font-medium text-ink lg:col-span-3">全文替换<textarea className="min-h-24 rounded-md border border-line px-3 py-2" value={form.replacementRules} onChange={(event) => setForm((current) => ({ ...current, replacementRules: event.target.value }))} placeholder="禁用词、替换词、风险表达处理" /></label>
                </div>
              </details>

              <details className="rounded-md border border-line bg-white" open>
                <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-ink">内容格式、文章结构、内外链</summary>
                <div className="grid gap-4 border-t border-line p-4 lg:grid-cols-2">
                  <label className="grid gap-2 text-sm font-medium text-ink">内容格式<textarea className="min-h-24 rounded-md border border-line px-3 py-2" value={form.formatRules} onChange={(event) => setForm((current) => ({ ...current, formatRules: event.target.value }))} placeholder="摘要、H2/H3、FAQ、Meta、图片要求" /></label>
                  <label className="grid gap-2 text-sm font-medium text-ink">文章结构<textarea className="min-h-24 rounded-md border border-line px-3 py-2" value={form.structureRules} onChange={(event) => setForm((current) => ({ ...current, structureRules: event.target.value }))} placeholder="问题、方案、案例、清单、结论" /></label>
                  <label className="grid gap-2 text-sm font-medium text-ink">内部链接<textarea className="min-h-24 rounded-md border border-line px-3 py-2" value={form.internalLinkRules} onChange={(event) => setForm((current) => ({ ...current, internalLinkRules: event.target.value }))} placeholder="链接到哪些站内页面或文章" /></label>
                  <label className="grid gap-2 text-sm font-medium text-ink">外部链接<textarea className="min-h-24 rounded-md border border-line px-3 py-2" value={form.externalLinkRules} onChange={(event) => setForm((current) => ({ ...current, externalLinkRules: event.target.value }))} placeholder="哪些场景允许外链、nofollow/dofollow 规则" /></label>
                  <label className="grid gap-2 text-sm font-medium text-ink">固定开头<textarea className="min-h-24 rounded-md border border-line px-3 py-2" value={form.fixedIntro} onChange={(event) => setForm((current) => ({ ...current, fixedIntro: event.target.value }))} placeholder="每篇文章开头固定要求" /></label>
                  <label className="grid gap-2 text-sm font-medium text-ink">固定结尾<textarea className="min-h-24 rounded-md border border-line px-3 py-2" value={form.fixedOutro} onChange={(event) => setForm((current) => ({ ...current, fixedOutro: event.target.value }))} placeholder="每篇文章结尾固定要求" /></label>
                </div>
              </details>

              <details className="rounded-md border border-line bg-white" open>
                <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-ink">GEO 策略</summary>
                <div className="grid gap-3 border-t border-line p-4 md:grid-cols-2 xl:grid-cols-4">
                  <ToggleLine checked={form.geoStrategy.includeFaq} label="生成 FAQ 问答块" onChange={(checked) => setForm((current) => ({ ...current, geoStrategy: { ...current.geoStrategy, includeFaq: checked } }))} />
                  <ToggleLine checked={form.geoStrategy.includeCitationSummary} label="生成可引用摘要" onChange={(checked) => setForm((current) => ({ ...current, geoStrategy: { ...current.geoStrategy, includeCitationSummary: checked } }))} />
                  <ToggleLine checked={form.geoStrategy.trackBrandMention} label="追踪品牌推荐命中" onChange={(checked) => setForm((current) => ({ ...current, geoStrategy: { ...current.geoStrategy, trackBrandMention: checked } }))} />
                  <ToggleLine checked={form.geoStrategy.trackCompetitorMention} label="追踪竞品对比命中" onChange={(checked) => setForm((current) => ({ ...current, geoStrategy: { ...current.geoStrategy, trackCompetitorMention: checked } }))} />
                </div>
              </details>

              <div className="flex flex-wrap items-center gap-2">
                <PrimaryButton type="submit" disabled={busy}>{editingId ? "保存规则" : "创建规则"}</PrimaryButton>
                <SecondaryButton type="button" onClick={cancelForm}>取消</SecondaryButton>
              </div>
            </form>
          </Section>
        ) : null}

        {busy ? <LoadingState label="正在处理生成规则" /> : <p className="text-sm leading-6 text-muted">{message}</p>}
      </div>
    </AppShell>
  );
}
