"use client";

import { AppShell } from "@/components/app-shell";
import { StatusBadge } from "@/components/status-badge";
import { LoadingState, MetricCard, PageHeader, PrimaryButton, SecondaryButton, Section } from "@/components/ui";
import type { ArticleTypeTemplate } from "@zengxing/core";
import { CheckSquare, Copy, Eye, EyeOff, Plus, Save, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatAppTimestamp } from "@/lib/app-time";

type FormState = Omit<ArticleTypeTemplate, "id" | "createdAt" | "updatedAt" | "useCount"> & { useCount?: number };
type Filter = "all" | "visible" | "hidden" | "custom" | "system";

const defaultForm: FormState = {
  name: "新的文章类型",
  category: "自定义",
  sourceType: "custom",
  visible: true,
  prompt: "说明这个文章类型的写作目标、适用场景和输出要求。",
  matchingRules: "",
  readingRules: "",
  outlineRules: "",
  titleRules: "",
  descriptionRules: "",
  writingRules: "",
  rewriteRules: "",
  notes: ""
};

const ruleFields: { key: keyof FormState; label: string; placeholder: string }[] = [
  { key: "matchingRules", label: "匹配规则", placeholder: "什么关键词、意图或场景适合使用这个文章类型。" },
  { key: "readingRules", label: "阅读规则", placeholder: "生成前需要读取哪些 SERP、知识库、竞品或素材信息。" },
  { key: "outlineRules", label: "大纲规则", placeholder: "H2/H3 结构、章节顺序、FAQ 或结论位置。" },
  { key: "titleRules", label: "标题规则", placeholder: "标题长度、必须包含的词、问题式或清单式要求。" },
  { key: "descriptionRules", label: "描述规则", placeholder: "Meta 描述、摘要、搜索结果展示文案要求。" },
  { key: "writingRules", label: "写作规则", placeholder: "语气、段落密度、证据、例子和可执行建议。" },
  { key: "rewriteRules", label: "仿写规则", placeholder: "仿写竞品时保留什么、避开什么结构和表达。" },
  { key: "notes", label: "注意事项", placeholder: "内部备注、禁用词、审核提醒。" }
];

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

function toForm(item: ArticleTypeTemplate): FormState {
  return {
    name: item.name,
    category: item.category,
    sourceType: item.sourceType,
    visible: item.visible,
    prompt: item.prompt,
    matchingRules: item.matchingRules ?? "",
    readingRules: item.readingRules ?? "",
    outlineRules: item.outlineRules ?? "",
    titleRules: item.titleRules ?? "",
    descriptionRules: item.descriptionRules ?? "",
    writingRules: item.writingRules ?? "",
    rewriteRules: item.rewriteRules ?? "",
    notes: item.notes ?? "",
    useCount: item.useCount
  };
}

function toggleSetValue<T>(set: Set<T>, value: T) {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export default function ArticleTypesPage() {
  const [items, setItems] = useState<ArticleTypeTemplate[]>([]);
  const [message, setMessage] = useState("系统已预置常用类型。点选套用或只填名称+提示词即可，别手写十个框。");
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<FormState>(defaultForm);
  const [editForm, setEditForm] = useState<FormState>(defaultForm);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  async function refresh() {
    const next = await jsonFetch<ArticleTypeTemplate[]>("/api/article-types");
    setItems(next);
    setActiveId((current) => current ?? next[0]?.id ?? null);
  }

  useEffect(() => {
    refresh().catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
  }, []);

  const filteredItems = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return items.filter((item) => {
      const filterOk =
        filter === "all" ||
        (filter === "visible" && item.visible) ||
        (filter === "hidden" && !item.visible) ||
        (filter === "custom" && item.sourceType === "custom") ||
        (filter === "system" && item.sourceType === "system");
      const haystack = [
        item.name,
        item.category,
        item.prompt,
        item.matchingRules,
        item.readingRules,
        item.outlineRules,
        item.titleRules,
        item.descriptionRules,
        item.writingRules,
        item.rewriteRules,
        item.notes
      ].filter(Boolean).join(" ").toLowerCase();
      return filterOk && (!keyword || haystack.includes(keyword));
    });
  }, [filter, items, query]);

  const activeItem = items.find((item) => item.id === activeId) ?? filteredItems[0] ?? null;
  const allVisibleSelected = filteredItems.length > 0 && filteredItems.every((item) => selectedIds.has(item.id));

  useEffect(() => {
    if (activeItem) setEditForm(toForm(activeItem));
  }, [activeItem]);

  const metrics = {
    total: items.length,
    visible: items.filter((item) => item.visible).length,
    custom: items.filter((item) => item.sourceType === "custom").length,
    used: items.reduce((sum, item) => sum + item.useCount, 0)
  };

  async function aiFillTypeFields(target: "create" | "edit") {
    setBusy(true);
    try {
      const source = target === "create" ? form : editForm;
      const result = await jsonFetch<{ draft: FormState }>("/api/article-types/ai-draft", {
        method: "POST",
        body: JSON.stringify({
          name: source.name,
          category: source.category,
          hint: source.prompt || ""
        })
      });
      const draft = result.draft;
      const next: FormState = {
        ...source,
        name: draft.name || source.name,
        category: draft.category || source.category,
        prompt: draft.prompt || source.prompt,
        matchingRules: draft.matchingRules || "",
        readingRules: draft.readingRules || "",
        outlineRules: draft.outlineRules || "",
        titleRules: draft.titleRules || "",
        descriptionRules: draft.descriptionRules || "",
        writingRules: draft.writingRules || "",
        rewriteRules: draft.rewriteRules || "",
        notes: draft.notes || "",
        sourceType: "custom",
        visible: true
      };
      if (target === "create") setForm(next);
      else setEditForm(next);
      setMessage("DeepSeek 已补全文章类型字段，你改改再保存。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function createArticleType(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const created = await jsonFetch<ArticleTypeTemplate>("/api/article-types", {
        method: "POST",
        body: JSON.stringify(form)
      });
      await refresh();
      setActiveId(created.id);
      setForm(defaultForm);
      setShowCreate(false);
      setMessage(`已创建文章类型：${created.name}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveActiveItem() {
    if (!activeItem) return;
    setBusy(true);
    try {
      const updated = await jsonFetch<ArticleTypeTemplate>(`/api/article-types/${activeItem.id}`, {
        method: "PATCH",
        body: JSON.stringify(editForm)
      });
      await refresh();
      setActiveId(updated.id);
      setMessage(`已保存文章类型：${updated.name}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function cloneItem(item: ArticleTypeTemplate) {
    setBusy(true);
    try {
      const cloned = await jsonFetch<ArticleTypeTemplate>("/api/article-types", {
        method: "POST",
        body: JSON.stringify({ ...toForm(item), name: `${item.name} 副本`, sourceType: "custom", visible: false, useCount: 0 })
      });
      await refresh();
      setActiveId(cloned.id);
      setMessage(`已克隆文章类型：${cloned.name}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function updateVisibility(ids: string[], visible: boolean) {
    if (!ids.length) return;
    setBusy(true);
    try {
      for (const id of ids) await jsonFetch<ArticleTypeTemplate>(`/api/article-types/${id}`, { method: "PATCH", body: JSON.stringify({ visible }) });
      await refresh();
      setSelectedIds(new Set());
      setMessage(`已将 ${ids.length} 个文章类型${visible ? "显示到" : "隐藏出"} AI 创作入口。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function deleteItems(ids: string[]) {
    if (!ids.length) return;
    setBusy(true);
    try {
      for (const id of ids) await jsonFetch(`/api/article-types/${id}`, { method: "DELETE" });
      await refresh();
      setSelectedIds(new Set());
      setActiveId(null);
      setMessage(`已删除 ${ids.length} 个文章类型。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell>
      <PageHeader
        eyebrow="Article Type Base"
        title="文章类型库"
        description="系统预设开箱即用。自定义时优先点「套用」卡片，只改名称和核心提示词就够。"
        action={<PrimaryButton disabled={busy} onClick={() => setShowCreate((current) => !current)}><Plus size={16} />创建要求</PrimaryButton>}
      />

      <div className="space-y-6 p-6">
        <div className="grid gap-4 md:grid-cols-4">
          <MetricCard label="类型总数" value={metrics.total} hint="系统预设 + 自定义" />
          <MetricCard label="创作中展示" value={metrics.visible} hint="可在 AI 创作选择" />
          <MetricCard label="自定义要求" value={metrics.custom} hint="团队专属规则" />
          <MetricCard label="累计使用" value={metrics.used} hint="生成文章时自动递增" />
        </div>

        {showCreate ? (
          <Section title="创建文章类型" description="写个名字 → DeepSeek 补全 → 保存。高级字段可不填。">
            <form className="space-y-4" onSubmit={createArticleType}>
              <div className="flex flex-wrap gap-2">
                <SecondaryButton type="button" disabled={busy} onClick={() => void aiFillTypeFields("create")}>
                  DeepSeek 一键补全
                </SecondaryButton>
                <p className="self-center text-xs text-muted">用项目已配的 DeepSeek，自动写提示词和 8 条规则字段。</p>
              </div>
              <ArticleTypeFields form={form} onChange={setForm} />
              <div className="flex gap-2">
                <PrimaryButton type="submit" disabled={busy}><Save size={16} />保存</PrimaryButton>
                <SecondaryButton type="button" onClick={() => setShowCreate(false)}>取消</SecondaryButton>
              </div>
            </form>
          </Section>
        ) : null}

        <div className="grid gap-6 xl:grid-cols-[1fr_460px]">
          <Section
            title="写作要求表"
            description="按列表统一管理文章类型、可见性、来源和使用次数，支持批量显示、隐藏和删除。"
            action={<SecondaryButton disabled={!selectedIds.size || busy} onClick={() => updateVisibility(Array.from(selectedIds), true)}><Eye size={15} />批量显示</SecondaryButton>}
          >
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <input className="h-9 min-w-64 rounded-md border border-line bg-white px-3 text-sm outline-none" placeholder="搜索名称、分类、提示词或规则字段" value={query} onChange={(event) => setQuery(event.target.value)} />
              <select className="h-9 rounded-md border border-line bg-white px-3 text-sm" value={filter} onChange={(event) => setFilter(event.target.value as Filter)}>
                <option value="all">全部</option>
                <option value="visible">创作中展示</option>
                <option value="hidden">已隐藏</option>
                <option value="custom">自定义</option>
                <option value="system">系统预设</option>
              </select>
              <SecondaryButton disabled={!selectedIds.size || busy} onClick={() => updateVisibility(Array.from(selectedIds), false)}><EyeOff size={15} />批量隐藏</SecondaryButton>
              <SecondaryButton disabled={!selectedIds.size || busy} onClick={() => deleteItems(Array.from(selectedIds))}><Trash2 size={15} />删除选中</SecondaryButton>
              <SecondaryButton disabled={!selectedIds.size} onClick={() => setSelectedIds(new Set())}><X size={15} />清空选择</SecondaryButton>
            </div>

            {selectedIds.size ? (
              <div className="mb-4 flex items-center gap-2 rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-blue-800">
                <CheckSquare size={15} />
                已选择 {selectedIds.size} 个文章类型，可批量调整可见性。
              </div>
            ) : null}

            <div className="overflow-x-auto rounded-md border border-line">
              <table className="w-full min-w-[980px] text-left text-sm">
                <thead className="bg-slate-50 text-xs text-muted">
                  <tr>
                    <th className="px-4 py-3"><input type="checkbox" checked={allVisibleSelected} onChange={(event) => {
                      setSelectedIds((current) => {
                        const next = new Set(current);
                        filteredItems.forEach((item) => event.target.checked ? next.add(item.id) : next.delete(item.id));
                        return next;
                      });
                    }} /></th>
                    <th className="px-4 py-3">要求名称</th>
                    <th className="px-4 py-3">分类</th>
                    <th className="px-4 py-3">来源</th>
                    <th className="px-4 py-3">可见性</th>
                    <th className="px-4 py-3">使用</th>
                    <th className="px-4 py-3">更新</th>
                    <th className="px-4 py-3">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredItems.map((item) => (
                    <tr key={item.id} className={`border-t border-line align-top ${activeItem?.id === item.id ? "bg-blue-50/60" : "bg-white"}`}>
                      <td className="px-4 py-3"><input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => setSelectedIds((current) => toggleSetValue(current, item.id))} /></td>
                      <td className="px-4 py-3">
                        <button className="text-left" onClick={() => setActiveId(item.id)}>
                          <span className="block font-semibold text-ink">{item.name}</span>
                          <span className="mt-1 line-clamp-2 max-w-xl text-xs leading-5 text-muted">{item.prompt || "未配置核心提示词"}</span>
                        </button>
                      </td>
                      <td className="px-4 py-3 text-muted">{item.category}</td>
                      <td className="px-4 py-3 text-muted">{item.sourceType === "system" ? "系统预设" : "自定义"}</td>
                      <td className="px-4 py-3"><StatusBadge status={item.visible ? "active" : "disabled"} /></td>
                      <td className="px-4 py-3 text-muted">{item.useCount}</td>
                      <td className="px-4 py-3 text-muted">{formatAppTimestamp(item.updatedAt)}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-2">
                          <SecondaryButton onClick={() => setActiveId(item.id)}><Eye size={15} />详情</SecondaryButton>
                          <SecondaryButton disabled={busy} onClick={() => cloneItem(item)}><Copy size={15} />克隆</SecondaryButton>
                          <SecondaryButton disabled={busy} onClick={() => updateVisibility([item.id], !item.visible)}>{item.visible ? <EyeOff size={15} /> : <Eye size={15} />}{item.visible ? "隐藏" : "显示"}</SecondaryButton>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredItems.length === 0 ? <p className="px-4 py-8 text-center text-sm text-muted">当前筛选下没有文章类型。</p> : null}
            </div>
          </Section>

          <aside className="space-y-6">
            <Section
              title="文章类型详情抽屉"
              description={activeItem ? `${activeItem.name} / ${formatAppTimestamp(activeItem.updatedAt)}` : "选择一条文章类型后编辑规则。"}
              action={<SecondaryButton disabled={!activeItem || busy} onClick={() => activeItem ? deleteItems([activeItem.id]) : undefined}><Trash2 size={15} />删除</SecondaryButton>}
            >
              {activeItem ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-white p-3">
                    <div>
                      <p className="text-sm font-semibold text-ink">{activeItem.name}</p>
                      <p className="mt-1 text-xs text-muted">{activeItem.sourceType === "system" ? "系统预设" : "自定义"} / 使用 {activeItem.useCount} 次</p>
                    </div>
                    <StatusBadge status={activeItem.visible ? "active" : "disabled"} />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <SecondaryButton type="button" disabled={busy} onClick={() => void aiFillTypeFields("edit")}>
                      DeepSeek 一键补全
                    </SecondaryButton>
                  </div>
                  <ArticleTypeFields form={editForm} onChange={setEditForm} />
                  <PrimaryButton disabled={busy} onClick={saveActiveItem}><Save size={16} />保存修改</PrimaryButton>
                </div>
              ) : (
                <p className="text-sm text-muted">选择一条文章类型后查看详情。</p>
              )}
            </Section>

            <Section title="字段说明" description="这些字段会组合为大模型上下文，而不是在代码里硬编码规则。">
              <div className="grid gap-2">
                {ruleFields.map((field) => (
                  <div key={field.key} className="rounded-md border border-line bg-white p-3">
                    <p className="text-sm font-semibold text-ink">{field.label}</p>
                    <p className="mt-1 text-xs leading-5 text-muted">{field.placeholder}</p>
                  </div>
                ))}
              </div>
            </Section>
          </aside>
        </div>

        {busy ? <LoadingState label="正在处理文章类型" /> : <p className="text-sm leading-6 text-muted">{message}</p>}
      </div>
    </AppShell>
  );
}

const categoryPresets = ["系统预设", "SEO", "GEO", "媒体分发", "品牌", "自定义"];

const typeQuickPresets: Array<Partial<FormState> & { label: string }> = [
  {
    label: "操作指南",
    name: "操作指南",
    category: "系统预设",
    prompt: "面向搜索用户解释步骤、注意事项和执行清单，输出 H2/H3、FAQ 和可执行结论。",
    outlineRules: "背景 → 准备 → 步骤 → 检查 → FAQ → 下一步",
    writingRules: "每步给动作、判断标准和常见错误。"
  },
  {
    label: "列表盘点",
    name: "列表文章",
    category: "SEO",
    prompt: "把方案拆成可扫描清单，适合工具推荐和对比。",
    outlineRules: "选择标准 → 清单项 → 决策建议",
    writingRules: "每项写适用场景、优势、限制。"
  },
  {
    label: "FAQ / GEO",
    name: "GEO 引用友好 FAQ",
    category: "GEO",
    prompt: "围绕真实问题给短答案和可摘录句，方便 AI 引用。",
    outlineRules: "每个 H3 一个问题，首句先给结论",
    writingRules: "先短答，再依据，再行动建议。"
  }
];

function ArticleTypeFields({ form, onChange }: { form: FormState; onChange: (value: FormState) => void }) {
  const fieldClass = "rounded-md border border-line px-3 py-2";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {typeQuickPresets.map((preset) => (
          <button
            key={preset.label}
            type="button"
            className="rounded-full border border-line bg-white px-3 py-1.5 text-xs font-medium text-ink hover:border-brand hover:bg-[#f3f0ff]"
            onClick={() => onChange({ ...form, ...preset, sourceType: "custom", visible: true })}
          >
            套用：{preset.label}
          </button>
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="grid gap-2 text-sm font-medium text-ink">名称<input className={fieldClass} value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} /></label>
        <label className="grid gap-2 text-sm font-medium text-ink">分类
          <select className={fieldClass} value={form.category} onChange={(event) => onChange({ ...form, category: event.target.value })}>
            {categoryPresets.map((item) => <option key={item} value={item}>{item}</option>)}
            {!categoryPresets.includes(form.category) ? <option value={form.category}>{form.category}</option> : null}
          </select>
        </label>
        <label className="grid gap-2 text-sm font-medium text-ink">来源<select className={fieldClass} value={form.sourceType} onChange={(event) => onChange({ ...form, sourceType: event.target.value as ArticleTypeTemplate["sourceType"] })}><option value="system">系统预设</option><option value="custom">自定义</option></select></label>
        <label className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm font-medium text-ink"><input type="checkbox" checked={form.visible} onChange={(event) => onChange({ ...form, visible: event.target.checked })} />在 AI 创作中展示</label>
      </div>
      <label className="grid gap-2 text-sm font-medium text-ink">核心提示词（够用就行）<textarea className="min-h-24 rounded-md border border-line px-3 py-2" value={form.prompt} onChange={(event) => onChange({ ...form, prompt: event.target.value })} placeholder="一句话说清楚这种文章怎么写" /></label>
      <details className="rounded-md border border-line bg-slate-50 px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium text-ink">高级规则字段（可选，不填也能用）</summary>
        <div className="mt-3 grid gap-3">
          {ruleFields.map((field) => (
            <label key={field.key} className="grid gap-2 text-sm font-medium text-ink">
              {field.label}
              <textarea
                className="min-h-20 rounded-md border border-line px-3 py-2"
                placeholder={field.placeholder}
                value={String(form[field.key] ?? "")}
                onChange={(event) => onChange({ ...form, [field.key]: event.target.value })}
              />
            </label>
          ))}
        </div>
      </details>
    </div>
  );
}
