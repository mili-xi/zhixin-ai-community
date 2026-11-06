"use client";

import { AppShell } from "@/components/app-shell";
import { LoadingState, MetricCard, PageHeader, PrimaryButton, SecondaryButton, Section } from "@/components/ui";
import type { Asset, AssetTagGroup } from "@zengxing/core";
import { CheckSquare, Eye, Plus, Save, Tags, Trash2, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatAppTimestamp } from "@/lib/app-time";

type AssetType = Asset["type"];
type AssetSource = Asset["source"];

const typeLabels: Record<AssetType, string> = {
  cover: "封面",
  inline: "插图",
  brand: "品牌"
};

const sourceLabels: Record<AssetSource, string> = {
  upload: "本地上传",
  website: "网站导入",
  ai: "AI 生成"
};

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

function toggleSetValue<T>(set: Set<T>, value: T) {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function assetPreviewUrl(asset: Asset) {
  return asset.url || "";
}

function AssetThumb({ asset, className }: { asset: Asset; className?: string }) {
  const url = assetPreviewUrl(asset);
  if (url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={url} alt={asset.altText || asset.filename} className={`${className ?? ""} object-cover`} />
    );
  }
  return <div className={className} style={{ background: asset.color || "#e2e8f0" }} />;
}

export default function AssetsPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [tagGroups, setTagGroups] = useState<AssetTagGroup[]>([]);
  const [message, setMessage] = useState("把图片拖进来或点上传就行，标签和高级管理可选。");
  const [busy, setBusy] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const [activeAssetId, setActiveAssetId] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState("全部");
  const [sourceFilter, setSourceFilter] = useState<AssetSource | "all">("all");
  const [typeFilter, setTypeFilter] = useState<AssetType | "all">("all");
  const [query, setQuery] = useState("");
  const [editForm, setEditForm] = useState({ filename: "", altText: "", relatedArticle: "", tags: "", type: "inline" as AssetType });
  const [newGroup, setNewGroup] = useState({ name: "发布阶段", description: "用于批量标记素材发布阶段", tags: "精选, 待发布" });
  const [newTagName, setNewTagName] = useState("");

  async function refreshAll() {
    const [assetList, groupList] = await Promise.all([
      jsonFetch<Asset[]>("/api/assets"),
      jsonFetch<AssetTagGroup[]>("/api/assets/tag-groups")
    ]);
    setAssets(assetList);
    setTagGroups(groupList);
    setActiveAssetId((current) => current ?? assetList[0]?.id ?? null);
  }

  useEffect(() => {
    refreshAll().catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
  }, []);

  const activeAsset = assets.find((asset) => asset.id === activeAssetId) ?? null;

  useEffect(() => {
    if (!activeAsset) return;
    setEditForm({
      filename: activeAsset.filename,
      altText: activeAsset.altText,
      relatedArticle: activeAsset.relatedArticle,
      tags: activeAsset.tags.join(", "),
      type: activeAsset.type
    });
  }, [activeAsset]);

  const allTags = useMemo(() => Array.from(new Set(assets.flatMap((asset) => asset.tags))).sort(), [assets]);
  const selectedTagNames = useMemo(() => tagGroups.flatMap((group) => group.tags).filter((tag) => selectedTagIds.has(tag.id)).map((tag) => tag.name), [tagGroups, selectedTagIds]);
  const filteredAssets = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return assets.filter((asset) => {
      const tagOk = tagFilter === "全部" || asset.tags.includes(tagFilter);
      const sourceOk = sourceFilter === "all" || asset.source === sourceFilter;
      const typeOk = typeFilter === "all" || asset.type === typeFilter;
      const haystack = `${asset.filename} ${asset.altText} ${asset.relatedArticle} ${asset.tags.join(" ")}`.toLowerCase();
      return tagOk && sourceOk && typeOk && (!keyword || haystack.includes(keyword));
    });
  }, [assets, query, sourceFilter, tagFilter, typeFilter]);

  async function uploadFiles(files: FileList | File[] | null) {
    const list = files ? Array.from(files) : [];
    if (!list.length) return;
    setBusy(true);
    try {
      let lastId: string | null = null;
      for (const file of list) {
        const body = new FormData();
        body.set("file", file);
        body.set("altText", file.name.replace(/\.[^.]+$/, ""));
        body.set("tags", "本地上传");
        const response = await fetch("/api/assets/upload", { method: "POST", body });
        if (!response.ok) throw new Error(await response.text());
        const asset = (await response.json()) as Asset;
        lastId = asset.id;
      }
      await refreshAll();
      if (lastId) setActiveAssetId(lastId);
      setMessage(`已上传 ${list.length} 个素材，可直接在 AI 创作里选用。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function bindSelectedTags() {
    if (!selectedIds.size || !selectedTagIds.size) return;
    setBusy(true);
    try {
      await jsonFetch<Asset[]>("/api/assets", {
        method: "PATCH",
        body: JSON.stringify({ ids: Array.from(selectedIds), tagIds: Array.from(selectedTagIds) })
      });
      await refreshAll();
      setMessage(`已为 ${selectedIds.size} 个素材绑定标签：${selectedTagNames.join("、")}`);
      setSelectedTagIds(new Set());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelectedAssets() {
    if (!selectedIds.size) return;
    setBusy(true);
    try {
      const result = await jsonFetch<{ deleted: number }>("/api/assets", {
        method: "DELETE",
        body: JSON.stringify({ ids: Array.from(selectedIds) })
      });
      await refreshAll();
      setSelectedIds(new Set());
      setActiveAssetId(null);
      setMessage(`已删除 ${result.deleted} 个素材。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveActiveAsset() {
    if (!activeAsset) return;
    setBusy(true);
    try {
      const updated = await jsonFetch<Asset>("/api/assets", {
        method: "PATCH",
        body: JSON.stringify({
          id: activeAsset.id,
          filename: editForm.filename,
          altText: editForm.altText,
          relatedArticle: editForm.relatedArticle,
          tags: splitList(editForm.tags),
          type: editForm.type
        })
      });
      await refreshAll();
      setMessage(`已保存素材：${updated.filename}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function createTagGroup() {
    setBusy(true);
    try {
      const group = await jsonFetch<AssetTagGroup>("/api/assets/tag-groups", {
        method: "POST",
        body: JSON.stringify({ ...newGroup, tags: splitList(newGroup.tags) })
      });
      await refreshAll();
      setMessage(`已创建标签组：${group.name}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function createTag(groupId: string) {
    if (!newTagName.trim()) return;
    setBusy(true);
    try {
      await jsonFetch("/api/assets/tag-groups", {
        method: "POST",
        body: JSON.stringify({ groupId, tagName: newTagName })
      });
      await refreshAll();
      setNewTagName("");
      setMessage("已新增标签。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const allVisibleSelected = filteredAssets.length > 0 && filteredAssets.every((asset) => selectedIds.has(asset.id));

  return (
    <AppShell>
      <PageHeader
        eyebrow="Material Library"
        title="素材库"
        description="管理图片素材、标签组、批量绑定、上传导入、预览和名称编辑，作为 AI 创作和发布配图的素材中心。"
        action={
          <PrimaryButton disabled={busy} onClick={() => fileInputRef.current?.click()}>
            <Upload size={16} />
            上传素材
          </PrimaryButton>
        }
      />

      <div className="space-y-6 p-6">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(event) => void uploadFiles(event.target.files)}
        />

        <div
          className="rounded-2xl border-2 border-dashed border-brand/30 bg-[#f8f6ff] px-6 py-8 text-center"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            void uploadFiles(event.dataTransfer.files);
          }}
        >
          <p className="text-base font-semibold text-ink">拖拽图片到这里，或点右上角「上传素材」</p>
          <p className="mt-2 text-sm text-muted">支持多选 PNG / JPG / WebP。上传后自动进素材库，创作配图可直接用。</p>
          <div className="mt-4 flex justify-center">
            <SecondaryButton disabled={busy} onClick={() => fileInputRef.current?.click()}>
              <Upload size={15} />
              选择本地图片
            </SecondaryButton>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-4">
          <MetricCard label="素材数量" value={assets.length} hint="封面、插图、品牌素材" />
          <MetricCard label="标签组" value={tagGroups.length} hint="按场景组织标签" />
          <MetricCard label="标签数量" value={allTags.length} hint="可批量绑定" />
          <MetricCard label="已选择" value={selectedIds.size} hint="用于批量操作" />
        </div>

        <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
          <Section
            title="素材资源表"
            description="上传后可筛选、批量打标签、删掉不要的。网站导入 / AI 生图后续会接真链路，不再假装成功。"
            action={<SecondaryButton disabled={selectedIds.size === 0 || selectedTagIds.size === 0 || busy} onClick={bindSelectedTags}><CheckSquare size={15} />批量绑定标签</SecondaryButton>}
          >
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <input className="h-9 min-w-64 rounded-md border border-line bg-white px-3 text-sm text-ink outline-none" placeholder="搜索文件名、Alt、关联文章或标签" value={query} onChange={(event) => setQuery(event.target.value)} />
              <select className="h-9 rounded-md border border-line bg-white px-3 text-sm" value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}>
                <option value="全部">全部标签</option>
                {allTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
              </select>
              <select className="h-9 rounded-md border border-line bg-white px-3 text-sm" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as AssetType | "all")}>
                <option value="all">全部类型</option>
                <option value="cover">封面</option>
                <option value="inline">插图</option>
                <option value="brand">品牌</option>
              </select>
              <select className="h-9 rounded-md border border-line bg-white px-3 text-sm" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as AssetSource | "all")}>
                <option value="all">全部来源</option>
                <option value="upload">本地上传</option>
                <option value="website">网站导入</option>
                <option value="ai">AI 生成</option>
              </select>
              <SecondaryButton disabled={selectedIds.size === 0 || busy} onClick={deleteSelectedAssets}><Trash2 size={15} />删除选中</SecondaryButton>
              <SecondaryButton disabled={selectedIds.size === 0} onClick={() => setSelectedIds(new Set())}><X size={15} />清空选择</SecondaryButton>
            </div>

            {selectedIds.size ? (
              <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-blue-800">
                <span>已选 {selectedIds.size} 个素材</span>
                <span className="text-blue-500">|</span>
                <span>待绑定标签：{selectedTagNames.length ? selectedTagNames.join("、") : "请在右侧标签组中选择"}</span>
              </div>
            ) : null}

            <div className="overflow-x-auto rounded-md border border-line">
              <table className="w-full min-w-[980px] text-left text-sm">
                <thead className="bg-slate-50 text-xs text-muted">
                  <tr>
                    <th className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        onChange={(event) => {
                          setSelectedIds((current) => {
                            const next = new Set(current);
                            filteredAssets.forEach((asset) => event.target.checked ? next.add(asset.id) : next.delete(asset.id));
                            return next;
                          });
                        }}
                      />
                    </th>
                    <th className="px-4 py-3">预览</th>
                    <th className="px-4 py-3">文件信息</th>
                    <th className="px-4 py-3">类型/来源</th>
                    <th className="px-4 py-3">标签</th>
                    <th className="px-4 py-3">关联文章</th>
                    <th className="px-4 py-3">大小</th>
                    <th className="px-4 py-3">更新</th>
                    <th className="px-4 py-3">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAssets.map((asset) => (
                    <tr key={asset.id} className={`border-t border-line ${activeAssetId === asset.id ? "bg-blue-50/60" : "bg-white"}`}>
                      <td className="px-4 py-3"><input type="checkbox" checked={selectedIds.has(asset.id)} onChange={() => setSelectedIds((current) => toggleSetValue(current, asset.id))} /></td>
                      <td className="px-4 py-3">
                        <button type="button" className="h-12 w-16 overflow-hidden rounded-md border border-line" onClick={() => setActiveAssetId(asset.id)} aria-label={`预览 ${asset.filename}`}>
                          <AssetThumb asset={asset} className="h-full w-full" />
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-semibold text-ink">{asset.filename}</p>
                        <p className="mt-1 max-w-sm truncate text-xs text-muted">{asset.altText || "未填写 Alt 文本"}</p>
                      </td>
                      <td className="px-4 py-3 text-muted">{typeLabels[asset.type]} / {sourceLabels[asset.source]}</td>
                      <td className="px-4 py-3"><div className="flex max-w-xs flex-wrap gap-1">{asset.tags.map((tag) => <span key={tag} className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-700">{tag}</span>)}</div></td>
                      <td className="px-4 py-3 text-muted">{asset.relatedArticle || "未关联"}</td>
                      <td className="px-4 py-3 text-muted">{asset.size}</td>
                      <td className="px-4 py-3 text-muted">{formatAppTimestamp(asset.updatedAt)}</td>
                      <td className="px-4 py-3"><SecondaryButton onClick={() => setActiveAssetId(asset.id)}><Eye size={15} />详情</SecondaryButton></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredAssets.length === 0 ? <p className="px-4 py-8 text-center text-sm text-muted">没有符合条件的素材。</p> : null}
            </div>
          </Section>

          <aside className="space-y-6">
            <Section title="素材详情抽屉" description="查看素材效果并编辑名称、Alt、关联文章和标签。">
              {activeAsset ? (
                <div className="space-y-4">
                  <div className="h-44 overflow-hidden rounded-md border border-line">
                    <AssetThumb asset={activeAsset} className="h-full w-full" />
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-xs text-muted">
                    <div className="rounded-md bg-slate-50 px-3 py-2">来源：{sourceLabels[activeAsset.source] || activeAsset.source}</div>
                    <div className="rounded-md bg-slate-50 px-3 py-2">大小：{activeAsset.size}</div>
                    <div className="rounded-md bg-slate-50 px-3 py-2">类型：{typeLabels[activeAsset.type]}</div>
                    <div className="rounded-md bg-slate-50 px-3 py-2">更新：{formatAppTimestamp(activeAsset.updatedAt)}</div>
                  </div>
                  <div className="space-y-3 text-sm">
                    <label className="grid gap-1 font-medium text-ink">文件名<input className="rounded-md border border-line px-3 py-2" value={editForm.filename} onChange={(event) => setEditForm({ ...editForm, filename: event.target.value })} /></label>
                    <label className="grid gap-1 font-medium text-ink">类型<select className="rounded-md border border-line px-3 py-2" value={editForm.type} onChange={(event) => setEditForm({ ...editForm, type: event.target.value as AssetType })}>
                      <option value="cover">封面</option>
                      <option value="inline">插图</option>
                      <option value="brand">品牌</option>
                    </select></label>
                    <label className="grid gap-1 font-medium text-ink">Alt 文本<textarea className="min-h-20 rounded-md border border-line px-3 py-2" value={editForm.altText} onChange={(event) => setEditForm({ ...editForm, altText: event.target.value })} /></label>
                    <label className="grid gap-1 font-medium text-ink">关联文章<input className="rounded-md border border-line px-3 py-2" value={editForm.relatedArticle} onChange={(event) => setEditForm({ ...editForm, relatedArticle: event.target.value })} /></label>
                    <label className="grid gap-1 font-medium text-ink">标签<input className="rounded-md border border-line px-3 py-2" value={editForm.tags} onChange={(event) => setEditForm({ ...editForm, tags: event.target.value })} /></label>
                    <PrimaryButton disabled={busy} onClick={saveActiveAsset}><Save size={16} />保存修改</PrimaryButton>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted">选择一条素材后查看详情。</p>
              )}
            </Section>

            <Section title="标签组" description="选择标签后可对素材执行批量绑定。">
              <div className="space-y-3">
                {tagGroups.map((group) => (
                  <div key={group.id} className="rounded-md border border-line p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-ink">{group.name}</p>
                        <p className="mt-1 text-xs leading-5 text-muted">{group.description}</p>
                      </div>
                      <Tags size={16} className="text-muted" />
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {group.tags.map((tag) => (
                        <button key={tag.id} type="button" onClick={() => setSelectedTagIds((current) => toggleSetValue(current, tag.id))} className={`rounded-md border px-2 py-1 text-xs ${selectedTagIds.has(tag.id) ? "border-brand bg-blue-50 text-brand" : "border-line bg-white text-muted"}`}>
                          {tag.name} · {tag.usageCount}
                        </button>
                      ))}
                    </div>
                    <div className="mt-3 flex gap-2">
                      <input className="min-w-0 flex-1 rounded-md border border-line px-2 py-1 text-xs" placeholder="新标签" value={newTagName} onChange={(event) => setNewTagName(event.target.value)} />
                      <SecondaryButton disabled={busy} onClick={() => createTag(group.id)}><Plus size={14} /></SecondaryButton>
                    </div>
                  </div>
                ))}
              </div>
            </Section>

            <Section title="新建标签组">
              <div className="space-y-3 text-sm">
                <input className="w-full rounded-md border border-line px-3 py-2" value={newGroup.name} onChange={(event) => setNewGroup({ ...newGroup, name: event.target.value })} />
                <textarea className="min-h-16 w-full rounded-md border border-line px-3 py-2" value={newGroup.description} onChange={(event) => setNewGroup({ ...newGroup, description: event.target.value })} />
                <input className="w-full rounded-md border border-line px-3 py-2" value={newGroup.tags} onChange={(event) => setNewGroup({ ...newGroup, tags: event.target.value })} />
                <PrimaryButton disabled={busy} onClick={createTagGroup}><Plus size={16} />创建标签组</PrimaryButton>
              </div>
            </Section>
          </aside>
        </div>
        {busy ? <LoadingState label="正在处理素材库" /> : <p className="text-sm leading-6 text-muted">{message}</p>}
      </div>
    </AppShell>
  );
}
