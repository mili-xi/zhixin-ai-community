"use client";

import { useCreationTask } from "@/components/creation-task-provider";
import { LoadingState, PrimaryButton, SecondaryButton } from "@/components/ui";
import { jsonFetch, pollTask, taskStageLabel } from "@/lib/tasks";
import type { ArticleTypeTemplate, GenerationRule, SerpAnalysisResult } from "@zengxing/core";
import { BookOpen, ChevronDown, ChevronUp, History, Sparkles, Wand2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

type QueuedTaskResponse = {
  queued: true;
  task: { id: string; type: string; queue: string; status: string; title?: string };
};

type SeoCollectionResponse = {
  record: SerpAnalysisResult & { status?: string; errorMessage?: string };
  task: { id: string; type: string; queue: string; status: string };
};

type KnowledgeSearchHit = {
  knowledgeId?: string;
  knowledgeTitle?: string;
};

function splitTags(value: string) {
  return value
    .split(/[,，、\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function QuickCreate({ onOpenWizard }: { onOpenWizard: () => void }) {
  const searchParams = useSearchParams();
  const { hasOpenTask, isRestoring, registerTask } = useCreationTask();
  const [topic, setTopic] = useState("");
  const [useSerp, setUseSerp] = useState(true);
  const [useKnowledge, setUseKnowledge] = useState(true);
  const [autoImage, setAutoImage] = useState(true);
  const [articleTypeId, setArticleTypeId] = useState("");
  const [ruleId, setRuleId] = useState("");
  const [articleTypes, setArticleTypes] = useState<ArticleTypeTemplate[]>([]);
  const [rules, setRules] = useState<GenerationRule[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("只写你想写什么就行。规则、类型、知识库默认自动搞定。");

  useEffect(() => {
    const keyword = searchParams.get("keyword") || "";
    const serpId = searchParams.get("serpId") || "";
    const useSerpParam = searchParams.get("useSerp");
    if (keyword) setTopic(keyword);
    if (useSerpParam === "1" || serpId) setUseSerp(true);
    if (useSerpParam === "0") setUseSerp(false);
  }, [searchParams]);

  useEffect(() => {
    Promise.all([
      jsonFetch<ArticleTypeTemplate[]>("/api/article-types"),
      jsonFetch<GenerationRule[]>("/api/generation-rules")
    ])
      .then(([types, generationRules]) => {
        const visibleTypes = types.filter((item) => item.visible !== false);
        setArticleTypes(visibleTypes.length ? visibleTypes : types);
        setRules(generationRules.filter((item) => item.status !== "draft"));
        setArticleTypeId((current) => current || visibleTypes[0]?.id || types[0]?.id || "");
        setRuleId((current) => current || generationRules.find((item) => item.status === "active")?.id || generationRules[0]?.id || "");
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
  }, []);

  const selectedType = useMemo(() => articleTypes.find((item) => item.id === articleTypeId), [articleTypes, articleTypeId]);
  const selectedRule = useMemo(() => rules.find((item) => item.id === ruleId), [rules, ruleId]);

  async function resolveKnowledgeIds(query: string) {
    if (!useKnowledge || !query.trim()) return [] as string[];
    try {
      const result = await jsonFetch<{ records?: KnowledgeSearchHit[] }>("/api/knowledge-base/search", {
        method: "POST",
        body: JSON.stringify({ query, limit: 5 })
      });
      const ids = (result.records || [])
        .map((item) => item.knowledgeId)
        .filter((id): id is string => Boolean(id));
      return Array.from(new Set(ids)).slice(0, 5);
    } catch {
      return [];
    }
  }

  async function resolveSerp(keyword: string) {
    const presetSerpId = searchParams.get("serpId");
    if (presetSerpId && !useSerp) return { serpAnalysisId: "", brief: "", warning: "" };
    if (presetSerpId && useSerp) {
      try {
        const list = await jsonFetch<Array<SerpAnalysisResult & { status?: string; errorMessage?: string }>>("/api/serp-analysis");
        const found = list.find((item) => item.id === presetSerpId);
        if (found?.topResults?.length) {
          return { serpAnalysisId: found.id, brief: found.contentBrief || "", warning: "" };
        }
      } catch {
        // fall through to fresh collect
      }
    }
    if (!useSerp) return { serpAnalysisId: "", brief: "", warning: "" };

    setMessage("正在采集 SERP 竞品…");
    try {
      const collected = await jsonFetch<SeoCollectionResponse>("/api/serp-analysis/collect", {
        method: "POST",
        body: JSON.stringify({ keyword, searchEngine: "Google", region: "中国", device: "desktop" })
      });
      try {
        await pollTask(collected.task.id, {
          timeoutMs: 90000,
          onUpdate: (task) => setMessage(`SERP：${taskStageLabel(task)}`)
        });
      } catch (error) {
        return {
          serpAnalysisId: "",
          brief: "",
          warning: error instanceof Error ? error.message : "SERP 采集超时，已降级为直接写作"
        };
      }
      const list = await jsonFetch<Array<SerpAnalysisResult & { status?: string; errorMessage?: string }>>("/api/serp-analysis");
      const record = list.find((item) => item.id === collected.record.id) || list[0];
      if (record?.topResults?.length) {
        return { serpAnalysisId: record.id, brief: record.contentBrief || "", warning: "" };
      }
      return {
        serpAnalysisId: "",
        brief: "",
        warning: record?.errorMessage || record?.contentBrief || "SERP 数据源未就绪，已降级直接写作"
      };
    } catch (error) {
      return {
        serpAnalysisId: "",
        brief: "",
        warning: error instanceof Error ? error.message : "SERP 失败，已降级直接写作"
      };
    }
  }

  async function handleGenerate() {
    if (hasOpenTask) {
      setMessage("已有文章正在后台生成，请等待完成后再开始下一篇。");
      return;
    }
    const keyword = topic.trim();
    if (!keyword) {
      setMessage("先写一句你想创作的主题。");
      return;
    }
    setBusy(true);
    try {
      const serp = await resolveSerp(keyword);
      if (serp.warning) setMessage(`${serp.warning}；继续生成正文…`);
      else setMessage("正在检索知识库并生成文章…");

      const knowledgeIds = await resolveKnowledgeIds(keyword);
      const mode = serp.serpAnalysisId ? "serp" : "free";
      const productDescription = [
        `一键创作主题：${keyword}`,
        serp.brief ? `SERP Brief：${serp.brief}` : "",
        selectedType ? `文章类型：${selectedType.name} — ${selectedType.prompt}` : "",
        selectedRule ? `生成规则：${selectedRule.name} — ${selectedRule.content}` : "",
        knowledgeIds.length ? `已挂载知识库 ${knowledgeIds.length} 条` : "未命中知识库，按通用 SEO 写作"
      ]
        .filter(Boolean)
        .join("\n");

      const queued = await jsonFetch<QueuedTaskResponse>("/api/articles/generate", {
        method: "POST",
        body: JSON.stringify({
          async: true,
          keyword,
          ruleId: ruleId || undefined,
          generationRuleId: ruleId || undefined,
          articleTypeId: articleTypeId || undefined,
          generateImages: autoImage,
          imageStrategy: autoImage ? selectedRule?.imageStrategy || "cover-and-inline" : "none",
          maxInlineImages: autoImage ? 5 : 0,
          knowledgeIds,
          productDescription,
          targetAudience: "搜索用户与内容运营",
          brandProfile: "智心AI",
          intent: selectedType?.name || selectedRule?.name || "一键创作",
          tone: "专业、清晰、可执行",
          wordCount: 1800,
          includeFaq: selectedRule?.geoStrategy?.includeFaq ?? true,
          includeInternalLinks: true,
          writerContext: {
            mode,
            question: keyword,
            title: keyword,
            seoTitle: keyword,
            metaDescription: "",
            secondaryKeywords: splitTags(keyword),
            outline: selectedType?.outlineRules ? [selectedType.outlineRules] : [],
            serpAnalysisId: serp.serpAnalysisId || undefined,
            knowledgeItemIds: knowledgeIds,
            brandProfileIds: [],
            competitorProfileIds: [],
            assetIds: [],
            watermarkIds: [],
            publishTargetIds: [],
            extras: ["FAQ"],
            stepsCompleted: 1
          }
        })
      });

      registerTask(queued.task);
      setMessage(`写作任务已入队：${queued.task.id}。可以切换页面，生成过程会继续在后台运行。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-3xl border border-line bg-white p-6 shadow-soft sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand">懒人模式</p>
            <h2 className="mt-2 text-2xl font-bold text-ink">你想写什么？</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
              不用先建规则、建类型、建库。系统默认套用预设，能采 SERP 就采，采不到就降级直接写，不装。
            </p>
          </div>
          <Link href="/articles/history">
            <SecondaryButton>
              <History size={15} />
              创作历史
            </SecondaryButton>
          </Link>
        </div>

        <label className="mt-6 grid gap-2 text-sm font-medium text-ink">
          关键词 / 标题 / 一句话
          <textarea
            className="min-h-28 rounded-2xl border border-line bg-slate-50 px-4 py-3 text-base text-ink outline-none focus:border-brand focus:bg-white"
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            placeholder="例如：AI SEO 优化怎么做，给中小企业看的实操指南"
          />
        </label>

        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          {[
            {
              key: "serp",
              label: "SERP 竞品分析",
              hint: "真采搜索结果，失败自动降级",
              checked: useSerp,
              onChange: setUseSerp
            },
            {
              key: "knowledge",
              label: "知识库检索",
              hint: "有资料就挂上，没有也照样写",
              checked: useKnowledge,
              onChange: setUseKnowledge
            },
            {
              key: "image",
              label: "自动配图",
              hint: "封面 + 插图",
              checked: autoImage,
              onChange: setAutoImage
            }
          ].map((item) => (
            <label key={item.key} className={`flex cursor-pointer flex-col gap-1 rounded-2xl border px-4 py-3 ${item.checked ? "border-brand bg-[#f3f0ff]" : "border-line bg-panel"}`}>
              <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                <input type="checkbox" checked={item.checked} onChange={(event) => item.onChange(event.target.checked)} />
                {item.label}
              </span>
              <span className="text-xs text-muted">{item.hint}</span>
            </label>
          ))}
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-2">
          <label className="grid gap-2 text-sm font-medium text-ink">
            文章类型
            <select className="h-11 rounded-xl border border-line px-3 text-sm" value={articleTypeId} onChange={(event) => setArticleTypeId(event.target.value)}>
              {!articleTypes.length ? <option value="">系统预设加载中…</option> : null}
              {articleTypes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-2 text-sm font-medium text-ink">
            生成规则
            <select className="h-11 rounded-xl border border-line px-3 text-sm" value={ruleId} onChange={(event) => setRuleId(event.target.value)}>
              {!rules.length ? <option value="">系统默认加载中…</option> : null}
              {rules.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <PrimaryButton disabled={busy || isRestoring || hasOpenTask} onClick={() => void handleGenerate()}>
            <Sparkles size={16} />
            一键生成文章
          </PrimaryButton>
          <SecondaryButton disabled={busy} onClick={onOpenWizard}>
            <Wand2 size={15} />
            分步精修（老向导）
          </SecondaryButton>
          <button type="button" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink" onClick={() => setShowAdvanced((value) => !value)}>
            {showAdvanced ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            高级说明
          </button>
        </div>

        {showAdvanced ? (
          <div className="mt-4 rounded-2xl border border-dashed border-line bg-slate-50 p-4 text-sm leading-6 text-muted">
            <p>当前类型：{selectedType?.name || "未选择"} — {selectedType?.prompt || "无"}</p>
            <p className="mt-2">当前规则：{selectedRule?.name || "未选择"} — {selectedRule?.content || "无"}</p>
            <p className="mt-2">想喂产品资料？去知识库贴 URL 或上传文件。想自己管配图？去素材库真·上传图片。</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link href="/ai-writer/knowledge" className="rounded-md border border-line bg-white px-3 py-1.5 text-xs font-medium text-ink">
                知识库
              </Link>
              <Link href="/ai-writer/assets" className="rounded-md border border-line bg-white px-3 py-1.5 text-xs font-medium text-ink">
                素材库
              </Link>
              <Link href="/ai-writer/rules" className="rounded-md border border-line bg-white px-3 py-1.5 text-xs font-medium text-ink">
                生成规则
              </Link>
              <Link href="/ai-writer/templates" className="rounded-md border border-line bg-white px-3 py-1.5 text-xs font-medium text-ink">
                文章类型
              </Link>
              <Link href="/ai-writer/serp" className="rounded-md border border-line bg-white px-3 py-1.5 text-xs font-medium text-ink">
                SERP 分析
              </Link>
            </div>
          </div>
        ) : null}

        <div className="mt-4">
          {busy ? <LoadingState label="正在帮你搞文章" /> : <p className="text-sm leading-6 text-muted">{message}</p>}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {[
          { title: "1. 说一句", desc: "关键词或 brief，别填 20 个框。" },
          { title: "2. 系统自动补上下文", desc: "SERP / 知识 / 默认规则类型自动挂上。" },
          { title: "3. 出稿进编辑器", desc: "写完直接改稿、发布，不绕路。" }
        ].map((item) => (
          <div key={item.title} className="rounded-2xl border border-line bg-panel p-5">
            <p className="text-sm font-semibold text-ink">{item.title}</p>
            <p className="mt-2 text-xs leading-5 text-muted">{item.desc}</p>
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-line bg-white p-5">
        <div className="flex items-center gap-2 text-sm font-semibold text-ink">
          <BookOpen size={16} className="text-brand" />
          小白提示
        </div>
        <p className="mt-2 text-sm leading-6 text-muted">
          知识库想学别人网页：贴公开 URL。知乎/公众号有登录墙会失败——那时粘贴正文或上传文件，别硬撑。素材库点上传就能传真图，不是以前那种色块假成功。
        </p>
      </div>
    </div>
  );
}
