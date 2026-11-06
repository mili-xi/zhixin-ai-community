"use client";

import { AppShell } from "@/components/app-shell";
import { LoadingState, MetricCard, PageHeader, PrimaryButton, SecondaryButton, Section } from "@/components/ui";
import type { Watermark } from "@zengxing/core";
import { CheckSquare, Eye, Image as ImageIcon, Plus, Save, Stamp, Trash2, Type, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatAppTimestamp } from "@/lib/app-time";

type FormState = {
  name: string;
  type: Watermark["type"];
  imageUrl: string;
  text: string;
  opacity: number;
  position: string;
  channels: string;
};

const defaultForm: FormState = {
  name: "右下角品牌水印",
  type: "text",
  imageUrl: "",
  text: "智心AI",
  opacity: 52,
  position: "右下",
  channels: "封面, 正文插图, 免费媒体"
};

const typeLabels: Record<Watermark["type"], string> = {
  image: "图片水印",
  text: "文字水印"
};

const positions = ["左上", "右上", "居中", "左下", "右下", "底部居中", "不应用"];

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

function splitList(value: string) {
  return value.split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean);
}

function toForm(watermark: Watermark): FormState {
  return {
    name: watermark.name,
    type: watermark.type,
    imageUrl: watermark.imageUrl ?? "",
    text: watermark.text ?? "",
    opacity: watermark.opacity,
    position: watermark.position,
    channels: watermark.channels.join(", ")
  };
}

function payloadFromForm(form: FormState): Partial<Watermark> {
  return {
    name: form.name,
    type: form.type,
    imageUrl: form.imageUrl,
    text: form.text,
    opacity: Number(form.opacity) || 0,
    position: form.position,
    channels: splitList(form.channels)
  };
}

function toggleSetValue<T>(set: Set<T>, value: T) {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export default function WatermarksPage() {
  const [watermarks, setWatermarks] = useState<Watermark[]>([]);
  const [message, setMessage] = useState("水印库用于给 AI 生成图文、封面和媒体发布图统一叠加品牌标识。");
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<FormState>(defaultForm);
  const [editForm, setEditForm] = useState<FormState>(defaultForm);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<Watermark["type"] | "all">("all");

  async function refresh() {
    const next = await jsonFetch<Watermark[]>("/api/watermarks");
    setWatermarks(next);
    setActiveId((current) => current ?? next[0]?.id ?? null);
  }

  useEffect(() => {
    refresh().catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
  }, []);

  const filteredWatermarks = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return watermarks.filter((item) => {
      const typeOk = typeFilter === "all" || item.type === typeFilter;
      const haystack = `${item.name} ${item.text ?? ""} ${item.imageUrl ?? ""} ${item.position} ${item.channels.join(" ")}`.toLowerCase();
      return typeOk && (!keyword || haystack.includes(keyword));
    });
  }, [query, typeFilter, watermarks]);

  const activeWatermark = watermarks.find((item) => item.id === activeId) ?? filteredWatermarks[0] ?? null;
  const allVisibleSelected = filteredWatermarks.length > 0 && filteredWatermarks.every((item) => selectedIds.has(item.id));

  useEffect(() => {
    if (activeWatermark) setEditForm(toForm(activeWatermark));
  }, [activeWatermark]);

  const metrics = {
    total: watermarks.length,
    image: watermarks.filter((item) => item.type === "image").length,
    text: watermarks.filter((item) => item.type === "text").length,
    channels: new Set(watermarks.flatMap((item) => item.channels)).size
  };

  async function createWatermark(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const created = await jsonFetch<Watermark>("/api/watermarks", {
        method: "POST",
        body: JSON.stringify(payloadFromForm(form))
      });
      await refresh();
      setActiveId(created.id);
      setForm(defaultForm);
      setShowCreate(false);
      setMessage(`已创建水印：${created.name}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveActiveWatermark() {
    if (!activeWatermark) return;
    setBusy(true);
    try {
      const updated = await jsonFetch<Watermark>(`/api/watermarks/${activeWatermark.id}`, {
        method: "PATCH",
        body: JSON.stringify(payloadFromForm(editForm))
      });
      await refresh();
      setActiveId(updated.id);
      setMessage(`已保存水印：${updated.name}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function deleteWatermarks(ids: string[]) {
    if (!ids.length) return;
    setBusy(true);
    try {
      for (const id of ids) await jsonFetch(`/api/watermarks/${id}`, { method: "DELETE" });
      await refresh();
      setSelectedIds(new Set());
      setActiveId(null);
      setMessage(`已删除 ${ids.length} 个水印模板。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell>
      <PageHeader
        eyebrow="AI support"
        title="水印库"
        description="管理图片水印、文字水印、透明度、位置和应用渠道，作为图文规则、自动发布和媒体分发的统一品牌素材。"
        action={<PrimaryButton disabled={busy} onClick={() => setShowCreate((current) => !current)}><Plus size={16} />新增水印</PrimaryButton>}
      />

      <div className="space-y-6 p-6">
        <div className="grid gap-4 md:grid-cols-4">
          <MetricCard label="水印总数" value={metrics.total} hint="全部可被规则调用" />
          <MetricCard label="图片水印" value={metrics.image} hint="适合封面和插图" />
          <MetricCard label="文字水印" value={metrics.text} hint="适合媒体发布图" />
          <MetricCard label="应用渠道" value={metrics.channels} hint="按发布场景复用" />
        </div>

        {showCreate ? (
          <Section title="新增水印" description="创建后可在生成规则和自动发布任务中选择。">
            <form className="grid gap-4 lg:grid-cols-4" onSubmit={createWatermark}>
              <WatermarkFields form={form} onChange={setForm} compact />
              <div className="flex items-end gap-2">
                <PrimaryButton type="submit" disabled={busy}><Save size={16} />保存</PrimaryButton>
                <SecondaryButton type="button" onClick={() => setShowCreate(false)}>取消</SecondaryButton>
              </div>
            </form>
          </Section>
        ) : null}

        <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
          <Section
            title="水印模板表"
            description="按快鲸式后台表格管理水印，支持筛选、勾选、批量删除和右侧详情编辑。"
            action={<SecondaryButton disabled={!selectedIds.size || busy} onClick={() => deleteWatermarks(Array.from(selectedIds))}><Trash2 size={15} />删除选中</SecondaryButton>}
          >
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <input className="h-9 min-w-64 rounded-md border border-line bg-white px-3 text-sm outline-none" placeholder="搜索名称、文字、渠道或位置" value={query} onChange={(event) => setQuery(event.target.value)} />
              <select className="h-9 rounded-md border border-line bg-white px-3 text-sm" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as Watermark["type"] | "all")}>
                <option value="all">全部类型</option>
                <option value="image">图片水印</option>
                <option value="text">文字水印</option>
              </select>
              <SecondaryButton disabled={!selectedIds.size} onClick={() => setSelectedIds(new Set())}><X size={15} />清空选择</SecondaryButton>
            </div>

            {selectedIds.size ? (
              <div className="mb-4 flex items-center gap-2 rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-blue-800">
                <CheckSquare size={15} />
                已选择 {selectedIds.size} 个水印，可执行批量删除。
              </div>
            ) : null}

            <div className="overflow-x-auto rounded-md border border-line">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="bg-slate-50 text-xs text-muted">
                  <tr>
                    <th className="px-4 py-3"><input type="checkbox" checked={allVisibleSelected} onChange={(event) => {
                      setSelectedIds((current) => {
                        const next = new Set(current);
                        filteredWatermarks.forEach((item) => event.target.checked ? next.add(item.id) : next.delete(item.id));
                        return next;
                      });
                    }} /></th>
                    <th className="px-4 py-3">水印</th>
                    <th className="px-4 py-3">类型</th>
                    <th className="px-4 py-3">透明度</th>
                    <th className="px-4 py-3">位置</th>
                    <th className="px-4 py-3">应用渠道</th>
                    <th className="px-4 py-3">创建时间</th>
                    <th className="px-4 py-3">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredWatermarks.map((item) => (
                    <tr key={item.id} className={`border-t border-line align-top ${activeWatermark?.id === item.id ? "bg-blue-50/60" : "bg-white"}`}>
                      <td className="px-4 py-3"><input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => setSelectedIds((current) => toggleSetValue(current, item.id))} /></td>
                      <td className="px-4 py-3">
                        <button className="text-left" onClick={() => setActiveId(item.id)}>
                          <span className="block font-semibold text-ink">{item.name}</span>
                          <span className="mt-1 block max-w-md truncate text-xs text-muted">{item.type === "image" ? item.imageUrl || "未配置图片 URL" : item.text || "未配置文字内容"}</span>
                        </button>
                      </td>
                      <td className="px-4 py-3 text-muted">{typeLabels[item.type]}</td>
                      <td className="px-4 py-3 text-muted">{item.opacity}%</td>
                      <td className="px-4 py-3 text-muted">{item.position}</td>
                      <td className="px-4 py-3"><TagList tags={item.channels} /></td>
                      <td className="px-4 py-3 text-muted">{formatAppTimestamp(item.createdAt)}</td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2">
                          <SecondaryButton onClick={() => setActiveId(item.id)}><Eye size={15} />详情</SecondaryButton>
                          <SecondaryButton disabled={busy} onClick={() => deleteWatermarks([item.id])}><Trash2 size={15} />删除</SecondaryButton>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredWatermarks.length === 0 ? <p className="px-4 py-8 text-center text-sm text-muted">没有符合条件的水印模板。</p> : null}
            </div>
          </Section>

          <aside className="space-y-6">
            <Section title="水印详情抽屉" description="预览水印效果，编辑透明度、位置和应用渠道。">
              {activeWatermark ? (
                <div className="space-y-4">
                  <div className="flex h-40 items-center justify-center rounded-md border border-line bg-slate-50">
                    {activeWatermark.type === "image" && activeWatermark.imageUrl ? (
                      <img src={activeWatermark.imageUrl} alt={activeWatermark.name} className="max-h-full max-w-full" />
                    ) : (
                      <span className="text-2xl font-semibold text-ink" style={{ opacity: activeWatermark.opacity / 100 }}>{activeWatermark.text || activeWatermark.name}</span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-xs text-muted">
                    <div className="rounded-md bg-slate-50 px-3 py-2">类型：{typeLabels[activeWatermark.type]}</div>
                    <div className="rounded-md bg-slate-50 px-3 py-2">透明度：{activeWatermark.opacity}%</div>
                    <div className="rounded-md bg-slate-50 px-3 py-2">位置：{activeWatermark.position}</div>
                    <div className="rounded-md bg-slate-50 px-3 py-2">渠道：{activeWatermark.channels.length}</div>
                  </div>
                  <div className="space-y-3">
                    <WatermarkFields form={editForm} onChange={setEditForm} />
                    <PrimaryButton disabled={busy} onClick={saveActiveWatermark}><Save size={16} />保存修改</PrimaryButton>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted">选择一条水印后查看详情。</p>
              )}
            </Section>

            <Section title="状态流转" description="水印被生成规则引用后，会进入图文生成和自动发布链路。">
              <div className="grid gap-2 text-sm">
                {["创建模板", "绑定生成规则", "图文生成预览", "发布渠道应用"].map((item, index) => (
                  <div key={item} className={`rounded-md px-3 py-2 ${index <= 1 ? "bg-blue-50 text-brand" : "bg-slate-50 text-muted"}`}>{item}</div>
                ))}
              </div>
            </Section>
          </aside>
        </div>

        {busy ? <LoadingState label="正在处理水印库" /> : <p className="text-sm leading-6 text-muted">{message}</p>}
      </div>
    </AppShell>
  );
}

function TagList({ tags }: { tags: string[] }) {
  return <div className="flex max-w-xs flex-wrap gap-1">{tags.map((tag) => <span key={tag} className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-700">{tag}</span>)}</div>;
}

function WatermarkFields({ form, onChange, compact = false }: { form: FormState; onChange: (value: FormState) => void; compact?: boolean }) {
  const fieldClass = "rounded-md border border-line px-3 py-2";
  return (
    <>
      <label className={`grid gap-2 text-sm font-medium text-ink ${compact ? "" : ""}`}>
        名称
        <input className={fieldClass} value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} />
      </label>
      <label className="grid gap-2 text-sm font-medium text-ink">
        类型
        <select className={fieldClass} value={form.type} onChange={(event) => onChange({ ...form, type: event.target.value as Watermark["type"] })}>
          <option value="image">图片水印</option>
          <option value="text">文字水印</option>
        </select>
      </label>
      {form.type === "image" ? (
        <label className="grid gap-2 text-sm font-medium text-ink">
          图片 URL
          <div className="flex items-center gap-2">
            <ImageIcon size={16} className="text-muted" />
            <input className={`${fieldClass} min-w-0 flex-1`} value={form.imageUrl} onChange={(event) => onChange({ ...form, imageUrl: event.target.value })} placeholder="https://example.com/watermark.png" />
          </div>
        </label>
      ) : (
        <label className="grid gap-2 text-sm font-medium text-ink">
          文字内容
          <div className="flex items-center gap-2">
            <Type size={16} className="text-muted" />
            <input className={`${fieldClass} min-w-0 flex-1`} value={form.text} onChange={(event) => onChange({ ...form, text: event.target.value })} />
          </div>
        </label>
      )}
      <label className="grid gap-2 text-sm font-medium text-ink">
        透明度
        <input type="number" min={0} max={100} className={fieldClass} value={form.opacity} onChange={(event) => onChange({ ...form, opacity: Number(event.target.value) })} />
      </label>
      <label className="grid gap-2 text-sm font-medium text-ink">
        位置
        <select className={fieldClass} value={form.position} onChange={(event) => onChange({ ...form, position: event.target.value })}>
          {positions.map((position) => <option key={position}>{position}</option>)}
        </select>
      </label>
      <label className="grid gap-2 text-sm font-medium text-ink">
        应用渠道
        <input className={fieldClass} value={form.channels} onChange={(event) => onChange({ ...form, channels: event.target.value })} placeholder="封面, 正文插图, 媒体发布" />
      </label>
    </>
  );
}
