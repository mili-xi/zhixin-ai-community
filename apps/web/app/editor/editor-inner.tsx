"use client";

import { AppShell } from "@/components/app-shell";
import { useDesktopRequirement } from "@/components/desktop-requirement-provider";
import { StatusBadge } from "@/components/status-badge";
import { EmptyState, LoadingState, PageHeader, PrimaryButton, Section, SecondaryButton } from "@/components/ui";
import { articlePublishLabel, articlePublishState, isArticlePublishLocked, isArticleTargetPublishLocked } from "@/lib/article-publish-state";
import { jsonFetch, pollTask, wait } from "@/lib/tasks";
import { isMediaAccountPublishable, scoreArticleContent } from "@zengxing/core";
import type { Article, ArticleContentBlock, Asset, MediaAccount, MediaOrder, PublishJob } from "@zengxing/core";
import {
  Bold,
  CheckCircle2,
  Code,
  Eye,
  FileText,
  Heading2,
  Heading3,
  ImagePlus,
  Italic,
  Link2,
  List,
  Quote,
  Save,
  Send
} from "lucide-react";
import { formatAppTimestamp } from "@/lib/app-time";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

type ContentViewMode = "edit" | "preview";
type DesktopCommand = {
  id: string;
  type: string;
  mediaAccountId?: string;
  status: "queued" | "pending" | "running" | "succeeded" | "failed" | string;
  result?: {
    publishedUrl?: string;
    draftUrl?: string;
    mediaOrderId?: string;
    platformStatus?: string;
    [key: string]: unknown;
  };
  errorMessage?: string;
};

type PublishWorkflowResult = {
  queued?: boolean;
  channel: "site" | "free-media" | "media-market";
  targetId: string;
  targetName: string;
  publishJob: PublishJob | null;
  mediaOrder: MediaOrder | null;
  task?: { id: string; type: string; queue: string; status: string; title?: string };
  desktopCommand?: DesktopCommand;
};

type PlatformPublishRules = {
  category: string;
  articleType: "original" | "repost" | "translation";
  visibility: "public" | "private" | "fans" | "vip";
  creationStatement: string;
  backupToGitCode: boolean;
  coverImagePath: string;
  coverMode: "auto" | "single" | "three" | "large";
};

const terminalDesktopCommandStatuses = new Set(["succeeded", "failed", "canceled"]);
const defaultPlatformRules: PlatformPublishRules = {
  category: "",
  articleType: "original",
  visibility: "public",
  creationStatement: "none",
  backupToGitCode: false,
  coverImagePath: "",
  coverMode: "auto"
};

function normalizePlatformRules(input: Article["writerContext"] extends { publishRules?: infer Rules } ? Rules : unknown): PlatformPublishRules {
  const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const articleType = ["original", "repost", "translation"].includes(String(value.articleType)) ? String(value.articleType) as PlatformPublishRules["articleType"] : defaultPlatformRules.articleType;
  const visibility = ["public", "private", "fans", "vip"].includes(String(value.visibility)) ? String(value.visibility) as PlatformPublishRules["visibility"] : defaultPlatformRules.visibility;
  const coverMode = ["auto", "single", "three", "large"].includes(String(value.coverMode)) ? String(value.coverMode) as PlatformPublishRules["coverMode"] : defaultPlatformRules.coverMode;
  return {
    category: typeof value.category === "string" ? value.category : defaultPlatformRules.category,
    articleType,
    visibility,
    creationStatement: typeof value.creationStatement === "string" ? value.creationStatement : defaultPlatformRules.creationStatement,
    backupToGitCode: value.backupToGitCode === true,
    coverImagePath: typeof value.coverImagePath === "string" ? value.coverImagePath : defaultPlatformRules.coverImagePath,
    coverMode
  };
}

function humanizePublishError(raw: string) {
  const message = String(raw || "").trim();
  if (!message) return "发布失败，原因未知。";
  if (/ARTICLE_ALREADY_PUBLISHED|ARTICLE_PUBLISHED_LOCKED/i.test(message)) {
    return "这篇文章已经发布过了，不能再改稿、也不能再发。要发新内容请回 AI 创作重新生成一篇。";
  }
  if (/Target page, context or browser has been closed|Browser has been closed|Target closed/i.test(message)) {
    return "桌面端浏览器被关掉了，发布中断。请保持桌面端 agent 运行，不要手动关弹出的 Chromium 窗口，然后重新点「直接发布到平台」。";
  }
  if (/LOGIN_REQUIRED|未登录|login required/i.test(message)) {
    return `登录态失效，请先去免费媒体重新授权：${message}`;
  }
  if (/DEVICE_BINDING|DESKTOP_DEVICE|桌面端/i.test(message)) {
    return `桌面端未就绪：${message}。确认 apps/desktop agent 在 watch，且账号绑定了当前设备。`;
  }
  if (/SOHU_BODY|BODY_FIELD_NOT_FOUND|BODY_NOT_COMMITTED/i.test(message)) {
    return `搜狐正文没写进去：${message}。常见原因是弹出「草稿继续编辑」条挡了编辑器。请关掉弹窗里的旧草稿条后重发；桌面 agent 已加强：会自动关草稿条、锁定主编辑器写正文。`;
  }
  if (/timeout|超时/i.test(message)) {
    return `等待桌面端超时：${message}。看任务栏是否弹出浏览器，没弹就重启 desktop agent。`;
  }
  if (/ZHIHU_STEP_TIMEOUT|ZHIHU_IMAGE_UPLOAD_FAILED|ZHIHU_OSS_UPLOAD/i.test(message)) {
    return `知乎上传图片/写草稿卡住超时了：${message}。常见原因是图太大或 OSS 上传挂起。请重启 desktop agent 后重发；发布中编辑器空白是正常的（API 模式先传图再一次性写正文）。`;
  }
  return message;
}

function publishedUrlOf(article: Article | null, orders: MediaOrder[] = [], jobs: PublishJob[] = []) {
  if (!article) return "";
  const direct = String(article.publishedUrl || article.mediaPublishedUrl || "").trim();
  if (direct) return direct;
  const orderUrl = orders.find((order) => order.backlinkUrl)?.backlinkUrl;
  if (orderUrl) return orderUrl;
  return jobs.find((job) => job.publishedUrl)?.publishedUrl || "";
}

function desktopCommandMessage(command: DesktopCommand) {
  if (command.status === "failed") {
    return `发布失败：${humanizePublishError(command.errorMessage || "")}`;
  }
  if (command.result?.platformStatus === "manual_verification_required") {
    return typeof command.result.message === "string" && command.result.message
      ? command.result.message
      : "请在弹出的平台窗口完成安全验证，验证通过后会继续发布。";
  }
  if (command.result?.platformStatus === "published_restricted") {
    return typeof command.result.message === "string" && command.result.message
      ? command.result.message
      : "网易号已发布，但平台限制内容分发，当前没有公开 URL。请前往网易号内容管理点击申诉。";
  }
  if (command.result?.platformStatus === "submitted_for_review" || command.result?.publiclyVisible === false) {
    return typeof command.result.message === "string" && command.result.message
      ? command.result.message
      : "平台已接收发布请求，公开 URL 尚未验证通过，等待平台审核或公开延迟。";
  }
  const statusLabel = command.result?.platformStatus ? ` / ${command.result.platformStatus}` : "";
  return `桌面端发布命令 ${command.id}：${command.status}${statusLabel}`;
}

function insertMarkdown(textarea: HTMLTextAreaElement, prefix: string, suffix = "") {
  const start = textarea.selectionStart ?? 0;
  const end = textarea.selectionEnd ?? 0;
  const value = textarea.value;
  const next = `${value.slice(0, start)}${prefix}${value.slice(start, end)}${suffix}${value.slice(end)}`;
  textarea.value = next;
  textarea.focus();
  const cursor = start + prefix.length + value.slice(start, end).length + suffix.length;
  textarea.setSelectionRange(cursor, cursor);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function targetLabel(targetId: string, accounts: MediaAccount[]) {
  if (targetId.startsWith("media:")) {
    const account = accounts.find((item) => item.id === targetId.replace(/^media:/, ""));
    return account ? `${account.name} / 免费媒体 / ${account.platform}` : targetId;
  }
  return targetId;
}

function targetOptions(accounts: MediaAccount[]) {
  return accounts
    .filter(isMediaAccountPublishable)
    .map((account) => ({
      id: `media:${account.id}`,
      label: `${account.name} / ${account.platform}`,
      meta: `免费媒体 / ${account.credentialStatus ?? account.status}`
    }));
}

function headingsFrom(content: string) {
  return content
    .split("\n")
    .filter((line) => /^#{2,3}\s/.test(line))
    .slice(0, 10)
    .map((line) => ({
      level: line.startsWith("###") ? "H3" : "H2",
      text: line.replace(/^#+\s*/, "")
    }));
}

function resolveArticleImageUrl(url?: string, path?: string) {
  const candidate = (url || path || "").trim();
  if (!candidate) return "";
  if (/^(https?:|data:|blob:)/i.test(candidate)) return candidate;
  if (candidate.startsWith("/")) return candidate;
  if (candidate.includes("uploads/") || candidate.includes("assets/")) {
    return candidate.startsWith("/") ? candidate : `/${candidate.replace(/^\/+/, "")}`;
  }
  return candidate;
}

function previewBlocksFromArticle(article: Article | null, contentMarkdown: string, title: string): ArticleContentBlock[] {
  const blocks = article?.contentBlocks;
  if (Array.isArray(blocks) && blocks.length > 0) {
    return blocks.filter((block): block is ArticleContentBlock => !!block && typeof block === "object" && "type" in block);
  }

  const sections = Array.isArray(article?.sections) ? article.sections : [];
  if (sections.length > 0) {
    const result: ArticleContentBlock[] = [{ type: "title", text: title || article?.title || "未命名文章" }];
    const images = Array.isArray(article?.inlineImages) ? article.inlineImages : [];
    for (const section of sections) {
      if (!section || typeof section !== "object") continue;
      result.push({
        type: "section",
        sectionId: section.id || "",
        title: section.title || "",
        content: section.content || ""
      });
      const matched = images.find((image) => image.sectionId && image.sectionId === section.id);
      if (matched?.url || matched?.path) {
        result.push({
          type: "image",
          sectionId: matched.sectionId || section.id || "",
          assetId: matched.assetId,
          url: resolveArticleImageUrl(matched.url, matched.path),
          path: matched.path,
          altText: matched.altText || section.title || "正文配图"
        });
      }
    }
    return result;
  }

  // Fallback: parse Markdown headings / images so pure-text drafts still get a readable preview.
  const lines = (contentMarkdown || "").split("\n");
  const result: ArticleContentBlock[] = [{ type: "title", text: title || "未命名文章" }];
  let current: { sectionId: string; title: string; content: string } | null = null;
  let sectionIndex = 0;
  const flush = () => {
    if (!current) return;
    result.push({
      type: "section",
      sectionId: current.sectionId,
      title: current.title,
      content: current.content.trim()
    });
    current = null;
  };

  for (const raw of lines) {
    const heading = raw.match(/^#{1,3}\s+(.+)$/);
    const image = raw.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (heading) {
      flush();
      sectionIndex += 1;
      current = {
        sectionId: `md-section-${sectionIndex}`,
        title: heading[1].trim(),
        content: ""
      };
      continue;
    }
    if (image) {
      flush();
      result.push({
        type: "image",
        sectionId: `md-image-${result.length}`,
        url: resolveArticleImageUrl(image[2]),
        altText: image[1] || "正文配图"
      });
      continue;
    }
    if (!current) {
      sectionIndex += 1;
      current = { sectionId: `md-section-${sectionIndex}`, title: "", content: "" };
    }
    current.content += `${raw}\n`;
  }
  flush();
  return result;
}

function unmatchedInlineImages(article: Article | null, blocks: ArticleContentBlock[]) {
  const images = Array.isArray(article?.inlineImages) ? article.inlineImages : [];
  if (!images.length) return [];
  const used = new Set(
    blocks
      .filter((block): block is Extract<ArticleContentBlock, { type: "image" }> => block.type === "image")
      .flatMap((block) => [block.url, block.path, block.assetId].filter(Boolean) as string[])
  );
  return images.filter((image) => {
    const keys = [image.url, image.path, image.assetId].filter(Boolean) as string[];
    return keys.length > 0 && !keys.some((key) => used.has(key));
  });
}

async function pollDesktopCommand(
  commandId: string,
  options: {
    intervalMs?: number;
    timeoutMs?: number;
    onUpdate?: (command: DesktopCommand) => void;
  } = {}
) {
  const intervalMs = options.intervalMs ?? 2500;
  const timeoutMs = options.timeoutMs ?? 300000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const command = await jsonFetch<DesktopCommand>(`/api/desktop-commands/${encodeURIComponent(commandId)}`);
    options.onUpdate?.(command);
    if (command.status === "failed") throw new Error(command.errorMessage || `桌面端发布命令失败：${commandId}`);
    if (terminalDesktopCommandStatuses.has(command.status)) return command;
    await wait(intervalMs);
  }

  throw new Error(`桌面端发布命令等待超时：${commandId}`);
}

export default function EditorInner() {
  const { requireDesktop } = useDesktopRequirement();
  const articleId = useSearchParams().get("articleId");
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const [article, setArticle] = useState<Article | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [mediaAccounts, setMediaAccounts] = useState<MediaAccount[]>([]);
  const [publishJobs, setPublishJobs] = useState<PublishJob[]>([]);
  const [mediaOrders, setMediaOrders] = useState<MediaOrder[]>([]);
  const [title, setTitle] = useState("");
  const [seoTitle, setSeoTitle] = useState("");
  const [metaDescription, setMetaDescription] = useState("");
  const [keywords, setKeywords] = useState("");
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<Article["status"]>("draft");
  const [contentViewMode, setContentViewMode] = useState<ContentViewMode>("preview");
  const [selectedTargetId, setSelectedTargetId] = useState("");
  const [platformRules, setPlatformRules] = useState<PlatformPublishRules>(defaultPlatformRules);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"info" | "error" | "success">("info");
  const [busy, setBusy] = useState(false);
  const [lastPublishCommandId, setLastPublishCommandId] = useState("");

  function pushMessage(text: string, tone: "info" | "error" | "success" = "info") {
    setMessage(text);
    setMessageTone(tone);
  }

  async function refreshOperationalData() {
    const [nextJobs, nextOrders] = await Promise.all([
      jsonFetch<PublishJob[]>("/api/publish-jobs"),
      jsonFetch<MediaOrder[]>("/api/media-orders"),
    ]);
    setPublishJobs(nextJobs);
    setMediaOrders(nextOrders);
  }

  async function refreshArticle() {
    if (!articleId) return;
    const nextArticle = await jsonFetch<Article>(`/api/articles/${articleId}`);
    setArticle(nextArticle);
    setStatus(nextArticle.status);
    // Keep preview fields in sync when worker finishes Step 配图
    setTitle(nextArticle.title || "");
    setContent(nextArticle.contentMarkdown ?? "");
    setSeoTitle(nextArticle.seoTitle ?? "");
    setMetaDescription(nextArticle.metaDescription ?? "");
    setKeywords((nextArticle.keywords ?? []).join(", "));
    return nextArticle;
  }

  useEffect(() => {
    Promise.all([
      jsonFetch<Asset[]>("/api/assets"),
      jsonFetch<MediaAccount[]>("/api/media-accounts"),
      jsonFetch<PublishJob[]>("/api/publish-jobs"),
      jsonFetch<MediaOrder[]>("/api/media-orders"),
    ]).then(([nextAssets, nextAccounts, nextJobs, nextOrders]) => {
      setAssets(nextAssets);
      setMediaAccounts(nextAccounts);
      setPublishJobs(nextJobs);
      setMediaOrders(nextOrders);
      const firstActiveAccount = nextAccounts.find(isMediaAccountPublishable);
      setSelectedTargetId(firstActiveAccount ? `media:${firstActiveAccount.id}` : "");
    }).catch((error) => pushMessage(error instanceof Error ? error.message : String(error), "error"));
  }, []);

  useEffect(() => {
    if (!articleId) return;
    setBusy(true);
    jsonFetch<Article>(`/api/articles/${articleId}`)
      .then((nextArticle) => {
        setArticle(nextArticle);
        setTitle(nextArticle.title);
        setSeoTitle(nextArticle.seoTitle ?? "");
        setMetaDescription(nextArticle.metaDescription ?? "");
        setKeywords((nextArticle.keywords ?? []).join(", "));
        setContent(nextArticle.contentMarkdown ?? "");
        setStatus(nextArticle.status);
        const writerTarget = nextArticle.writerContext?.publishTargetIds?.[0];
        if (writerTarget?.startsWith("media:")) setSelectedTargetId(writerTarget);
        if (nextArticle.writerContext?.publishRules) {
          setPlatformRules((current) => ({ ...current, ...normalizePlatformRules(nextArticle.writerContext?.publishRules) }));
        }
        const bodyTooShort = Array.isArray(nextArticle.quality?.issues) && nextArticle.quality.issues.includes("CONTENT_TOO_SHORT");
        const sectionBodyChars = (nextArticle.sections || []).reduce((sum, section) => sum + String(section?.content || "").replace(/\s+/g, "").length, 0);
        pushMessage(
          bodyTooShort || sectionBodyChars < 80
            ? "正文几乎是空的（模型只吐了标题骨架）。请回 AI 创作重新生成；系统已加强「每节必须写满正文 + 一段一图」规则。"
            : nextArticle.imageGenerationStatus === "pending"
            ? "正文已生成，Step 正在配图，左侧预览会自动刷新。"
            : "成品已就绪：左侧是排版预览（一节正文一张图），右侧选平台直接发，基本不用改稿。",
          bodyTooShort || sectionBodyChars < 80 ? "error" : "info"
        );
      })
      .catch((error) => pushMessage(error instanceof Error ? error.message : String(error), "error"))
      .finally(() => setBusy(false));
  }, [articleId]);

  // Poll while cover / inline images are still generating so left preview fills in.
  useEffect(() => {
    if (!articleId) return;
    const imageStatus = article?.imageGenerationStatus;
    if (!imageStatus || imageStatus === "completed" || imageStatus === "disabled" || imageStatus === "failed") {
      return;
    }
    let cancelled = false;
    const timer = setInterval(() => {
      refreshArticle()
        .then((next) => {
          if (cancelled || !next) return;
          if (next.imageGenerationStatus === "completed") {
            pushMessage("配图完成，左侧已是带封面/插图的成品预览，选平台直接发就行。", "success");
          } else if (next.imageGenerationStatus === "partial") {
            pushMessage("配图部分完成，可先发，或等剩余图回写后再发。");
          } else if (next.imageGenerationStatus === "failed") {
            pushMessage("配图失败，正文仍可发布；也可进 Markdown 手动补图。", "error");
          }
        })
        .catch(() => {});
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [articleId, article?.imageGenerationStatus]);

  const options = useMemo(() => targetOptions(mediaAccounts), [mediaAccounts]);
  const score = useMemo(() => scoreArticleContent({
    title,
    summary: metaDescription,
    contentMarkdown: content,
    keywords: keywords.split(",").map((item) => item.trim()).filter(Boolean)
  }), [content, keywords, metaDescription, title]);
  const headings = useMemo(() => headingsFrom(content), [content]);
  const previewBlocks = useMemo(() => previewBlocksFromArticle(article, content, title), [article, content, title]);
  const orphanImages = useMemo(() => unmatchedInlineImages(article, previewBlocks), [article, previewBlocks]);
  const coverImageUrl = useMemo(
    () => resolveArticleImageUrl(article?.coverImage?.url, article?.coverImage?.path),
    [article?.coverImage?.path, article?.coverImage?.url]
  );
  const articlePublishJobs = useMemo(() => publishJobs.filter((job) => job.articleId === articleId || (!job.articleId && job.articleTitle === title)).slice(-6), [articleId, publishJobs, title]);
  const articleMediaOrders = useMemo(() => mediaOrders.filter((order) => order.articleId === articleId || (!order.articleId && order.articleTitle === title)).slice(-6), [articleId, mediaOrders, title]);

  const publishState = useMemo(
    () => articlePublishState(article, articleMediaOrders, articlePublishJobs),
    [article, articleMediaOrders, articlePublishJobs]
  );
  const publishStateLabel = articlePublishLabel(publishState);
  const isPublishLocked = useMemo(
    () => isArticlePublishLocked(article, articleMediaOrders, articlePublishJobs),
    [article, articleMediaOrders, articlePublishJobs]
  );
  const selectedTargetPublishLocked = useMemo(
    () => isArticleTargetPublishLocked(article, articleMediaOrders, articlePublishJobs, selectedTargetId),
    [article, articleMediaOrders, articlePublishJobs, selectedTargetId]
  );
  const lockedPublishedUrl = useMemo(
    () => publishedUrlOf(article, articleMediaOrders, articlePublishJobs),
    [article, articleMediaOrders, articlePublishJobs]
  );

  useEffect(() => {
    if (isPublishLocked && contentViewMode === "edit") {
      setContentViewMode("preview");
    }
  }, [isPublishLocked, contentViewMode]);

  async function persistArticle(nextStatus = status) {
    if (!articleId) throw new Error("ARTICLE_ID_REQUIRED");
    if (isPublishLocked) throw new Error("ARTICLE_PUBLISHED_LOCKED");
    const updated = await jsonFetch<Article>(`/api/articles/${articleId}`, {
      method: "PATCH",
      body: JSON.stringify({
        title,
        status: nextStatus,
        seoTitle,
        metaDescription,
        keywords: keywords.split(",").map((item) => item.trim()).filter(Boolean),
        contentMarkdown: content
      })
    });
    setArticle(updated);
    setStatus(updated.status);
    return updated;
  }

  async function saveArticle() {
    if (isPublishLocked) {
      pushMessage(humanizePublishError("ARTICLE_PUBLISHED_LOCKED"), "error");
      return;
    }
    setBusy(true);
    try {
      await persistArticle();
      pushMessage("草稿已保存。", "success");
    } catch (error) {
      pushMessage(humanizePublishError(error instanceof Error ? error.message : String(error)), "error");
    } finally {
      setBusy(false);
    }
  }

  async function publishFromEditor() {
    if (!articleId) return;
    if (selectedTargetPublishLocked) {
      pushMessage(humanizePublishError("ARTICLE_ALREADY_PUBLISHED"), "error");
      return;
    }
    if (!selectedTargetId) {
      pushMessage("先选右边「发布到」里的知乎/媒体账号，再点发布。", "error");
      return;
    }
    if (!requireDesktop("文章发布")) return;
    setBusy(true);
    try {
      if (!isPublishLocked) {
        await persistArticle("ready");
      }
      const result = await jsonFetch<PublishWorkflowResult>(`/api/articles/${articleId}/publish-from-context`, {
        method: "POST",
        body: JSON.stringify({
          targetId: selectedTargetId || undefined,
          confirmPublish: true,
          publishMode: "publish",
          platformRules,
          async: true
        })
      });
      if (result.queued && result.desktopCommand) {
        setLastPublishCommandId(result.desktopCommand.id);
        pushMessage(`已下发到桌面端：${result.targetName} / ${result.desktopCommand.id}。请盯着弹出的浏览器，别手动关掉，等写完标题正文并点发布。`);
        const completed = await pollDesktopCommand(result.desktopCommand.id, {
          onUpdate: (command) => {
            pushMessage(desktopCommandMessage(command), command.status === "failed" ? "error" : "info");
          }
        });
        await Promise.all([refreshOperationalData(), refreshArticle()]);
        const commandResult = completed.result ?? {};
        pushMessage(commandResult.platformStatus === "published_restricted"
          ? (typeof commandResult.message === "string" ? commandResult.message : "网易号已发布，但平台限制内容分发，当前没有公开 URL。")
          : commandResult.publiclyVisible === false || commandResult.platformStatus === "submitted_for_review"
          ? `平台已接收发布请求，已回写待审核记录：${commandResult.draftUrl ?? completed.id}`
          : commandResult.publishedUrl
          ? `真实发布完成，已回写公开 URL：${commandResult.publishedUrl}`
          : commandResult.draftUrl
          ? `桌面端已生成草稿，等待平台确认：${commandResult.draftUrl}`
          : `桌面端发布命令已完成：${completed.id}`, "success");
      } else if (result.queued && result.task) {
        pushMessage(`发布任务已入队：${result.targetName} / ${result.task.id}，正在等待平台结果回写...`);
        const completed = await pollTask(result.task.id, {
          onUpdate: (task) => {
            const progress = typeof task.progress === "number" ? ` / ${task.progress}%` : "";
            pushMessage(`发布任务 ${task.id}：${task.status}${progress}`);
          }
        });
        await Promise.all([refreshOperationalData(), refreshArticle()]);
        const taskResult = completed.result ?? {};
        pushMessage(taskResult.backlinkUrl
          ? `媒体发布完成，公开 URL 已回写：${taskResult.backlinkUrl}`
          : `发布任务已完成：${completed.id}`, "success");
      } else {
        await Promise.all([refreshOperationalData(), refreshArticle()]);
      }
      if (!result.queued) pushMessage(`已创建发布任务：${result.targetName}`, "success");
    } catch (error) {
      pushMessage(humanizePublishError(error instanceof Error ? error.message : String(error)), "error");
    } finally {
      setBusy(false);
    }
  }

  const markdownTools = [
    { icon: Bold, title: "加粗", action: () => contentRef.current && insertMarkdown(contentRef.current, "**", "**") },
    { icon: Italic, title: "斜体", action: () => contentRef.current && insertMarkdown(contentRef.current, "*", "*") },
    { icon: Code, title: "代码", action: () => contentRef.current && insertMarkdown(contentRef.current, "`", "`") },
    { icon: Heading2, title: "H2", action: () => contentRef.current && insertMarkdown(contentRef.current, "## ") },
    { icon: Heading3, title: "H3", action: () => contentRef.current && insertMarkdown(contentRef.current, "### ") },
    { icon: Quote, title: "引用", action: () => contentRef.current && insertMarkdown(contentRef.current, "> ") },
    { icon: List, title: "列表", action: () => contentRef.current && insertMarkdown(contentRef.current, "- ") },
    { icon: Link2, title: "链接", action: () => contentRef.current && insertMarkdown(contentRef.current, "[", "](url)") },
    { icon: ImagePlus, title: "图片", action: () => contentRef.current && insertMarkdown(contentRef.current, "![alt](", ")") }
  ];

  const imageStatus = article?.imageGenerationStatus;
  const imagesPending = imageStatus === "pending" || imageStatus === "partial";
  const sectionCount = previewBlocks.filter((block) => block.type === "section").length;
  const imageCount = previewBlocks.filter((block) => block.type === "image").length + (coverImageUrl ? 1 : 0);

  return (
    <AppShell>
      <PageHeader
        eyebrow={isPublishLocked ? `${publishStateLabel} · 只读` : publishState === "failed" ? "发布失败 · 可重试" : "成品预览 · 直接发布"}
        title={article ? article.title : "文章成品"}
        description={
          isPublishLocked
            ? `这篇文章当前状态为“${publishStateLabel}”，在明确失败或取消前不能编辑、也不能再次发布。`
            : "DeepSeek 写正文，Step 配封面/插图并自动排版。左边看成品，右边选平台发出去，别手改一堆 Markdown。"
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            <SecondaryButton
              disabled={busy || !articleId || isPublishLocked}
              onClick={() => setContentViewMode(contentViewMode === "preview" ? "edit" : "preview")}
            >
              {contentViewMode === "preview" ? <><FileText size={16} />改稿（可选）</> : <><Eye size={16} />回成品预览</>}
            </SecondaryButton>
            <SecondaryButton disabled={busy || !articleId || isPublishLocked} onClick={saveArticle}>
              <Save size={16} />保存
            </SecondaryButton>
            {isPublishLocked ? (
              lockedPublishedUrl ? (
                <a href={lockedPublishedUrl} target="_blank" rel="noreferrer">
                  <PrimaryButton>
                    <Eye size={16} />
                    查看已发布链接
                  </PrimaryButton>
                </a>
              ) : (
                <PrimaryButton disabled>
                  <CheckCircle2 size={16} />
                  {publishStateLabel}
                </PrimaryButton>
              )
            ) : (
              <PrimaryButton disabled={busy || !articleId || !selectedTargetId} onClick={publishFromEditor}>
                <Send size={16} />
                直接发布到平台
              </PrimaryButton>
            )}
          </div>
        }
      />

      {busy && !article ? (
        <div className="p-7"><LoadingState label="正在读取成品文章" /></div>
      ) : (
        <div className="grid gap-6 p-6 xl:grid-cols-[minmax(0,1fr)_380px]">
          {/* LEFT: finished article preview */}
          <div className="min-w-0 space-y-4">
            {isPublishLocked ? (
              <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-300 bg-slate-100 px-4 py-3 text-sm text-slate-800">
                <CheckCircle2 size={16} className="text-emerald-600" />
                <span className="font-semibold">{publishStateLabel} · 只读锁定</span>
                <span className="text-slate-600">排队、发布中、平台审核中或已发布但分发受限时均不能重复提交；明确失败后会自动开放重试。</span>
                {lockedPublishedUrl ? (
                  <a href={lockedPublishedUrl} target="_blank" rel="noreferrer" className="font-semibold text-brand underline">
                    打开发布链接
                  </a>
                ) : null}
                <Link href="/ai-writer" className="font-semibold text-brand underline">去创作新文</Link>
              </div>
            ) : null}
            {(() => {
              const sectionBodyChars = (article?.sections || []).reduce((sum, section) => sum + String(section?.content || "").replace(/\s+/g, "").length, 0);
              const bodyEmpty = !isPublishLocked && (sectionBodyChars < 80 || (Array.isArray(article?.quality?.issues) && article.quality.issues.includes("CONTENT_TOO_SHORT")));
              if (bodyEmpty) {
                return (
                  <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
                    <span className="font-semibold">正文为空</span>
                    <span>模型只给了章节标题、没写段落。请回 AI 创作页重新生成（已规定：每节完整正文 + 一节一图）。</span>
                    <Link href="/ai-writer" className="font-semibold text-brand underline">去重新生成</Link>
                  </div>
                );
              }
              if (isPublishLocked) {
                return (
                  <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
                    <CheckCircle2 size={16} />
                    <span className="font-semibold">发布成品预览</span>
                    <span className="text-emerald-800/80">{sectionCount} 个章节 · {imageCount} 张图 · 只读</span>
                    <StatusBadge status={publishState} />
                  </div>
                );
              }
              return (
                <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
                  <CheckCircle2 size={16} />
                  <span className="font-semibold">懒人发布台</span>
                  <span className="text-emerald-800/80">
                    {imagesPending
                      ? "正文已好，配图生成中，预览会自动刷新…"
                      : `成品预览 · ${sectionCount} 个章节 · ${imageCount} 张图 · 一节一图 · 选右边平台直接发`}
                  </span>
                  {imageStatus ? <StatusBadge status={imageStatus === "completed" ? "succeeded" : imageStatus === "failed" ? "failed" : "running"} /> : null}
                </div>
              );
            })()}

            {contentViewMode === "edit" ? (
              <Section title="改稿（可选）" description="大多数情况不用进来。改完点保存，再回成品预览。">
                <div className="mb-3 flex flex-wrap gap-1">
                  {markdownTools.map((tool) => {
                    const Icon = tool.icon;
                    return (
                      <button key={tool.title} type="button" className="grid h-8 w-8 place-items-center rounded-md border border-line bg-white text-slate-700 hover:text-brand" onClick={tool.action} title={tool.title}>
                        <Icon size={16} />
                      </button>
                    );
                  })}
                </div>
                <input className="mb-3 w-full rounded-md border border-line px-3 py-2 text-lg font-semibold outline-none" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="标题" />
                <textarea ref={contentRef} className="min-h-[640px] w-full resize-none rounded-md border border-line bg-white p-5 font-mono text-sm leading-7 outline-none" value={content} onChange={(event) => setContent(event.target.value)} placeholder="Markdown 正文..." />
              </Section>
            ) : (
              <div className="min-h-[70vh] space-y-6 rounded-2xl border border-line bg-white p-6 shadow-soft sm:p-8">
                {imagesPending ? (
                  <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-900">
                    <LoadingState label="Step 正在按正文生成封面和插图，完成后自动插到对应章节" />
                  </div>
                ) : null}

                {coverImageUrl ? (
                  <figure className="overflow-hidden rounded-2xl border border-line bg-slate-50">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={coverImageUrl} alt={article?.coverImage?.altText || title || "封面图"} className="max-h-[360px] w-full object-cover" />
                    <figcaption className="px-4 py-2 text-xs text-muted">封面（Step 生成）</figcaption>
                  </figure>
                ) : (
                  <div className="grid h-36 place-items-center rounded-2xl border border-dashed border-line bg-slate-50 text-sm text-muted">
                    {imagesPending ? "封面生成中…" : "暂无封面图"}
                  </div>
                )}

                <h1 className="text-3xl font-bold leading-tight text-ink">{title || "未命名文章"}</h1>
                {metaDescription ? <p className="text-sm leading-7 text-slate-600">{metaDescription}</p> : null}

                {previewBlocks.map((block, index) => {
                  if (block.type === "title") return null;
                  if (block.type === "section") {
                    return (
                      <section key={`section-${block.sectionId || index}`} className="space-y-3">
                        {block.title ? <h2 className="border-l-4 border-brand pl-3 text-xl font-semibold text-ink">{block.title}</h2> : null}
                        <div className="whitespace-pre-wrap text-[15px] leading-8 text-slate-750">
                          {block.content || "（本节暂无正文）"}
                        </div>
                      </section>
                    );
                  }
                  const imageUrl = resolveArticleImageUrl(block.url, block.path);
                  return (
                    <figure key={`image-${block.sectionId || index}-${imageUrl}`} className="overflow-hidden rounded-2xl border border-line bg-slate-50">
                      {imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={imageUrl} alt={block.altText || "正文配图"} className="max-h-[480px] w-full object-contain bg-white" />
                      ) : (
                        <div className="grid h-40 place-items-center text-sm text-muted">插图生成中或地址缺失</div>
                      )}
                      <figcaption className="px-4 py-2 text-xs text-muted">
                        插图 · {block.altText || "inline"}{block.sectionId ? ` · 已插入章节` : ""}
                      </figcaption>
                    </figure>
                  );
                })}

                {!previewBlocks.some((block) => block.type === "section" || block.type === "image") ? (
                  <EmptyState title="暂无正文" description="生成完成后这里会显示排版好的正文和插图。" />
                ) : null}

                {orphanImages.length ? (
                  <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
                    <p className="text-sm font-semibold text-amber-900">还有图未绑定章节（一般也能发）</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {orphanImages.map((image, index) => {
                        const url = resolveArticleImageUrl(image.url, image.path);
                        return (
                          <figure key={`orphan-${image.assetId || image.url || index}`} className="overflow-hidden rounded-lg border border-amber-100 bg-white">
                            {url ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={url} alt={image.altText || "配图"} className="h-36 w-full object-cover" />
                            ) : null}
                          </figure>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </div>

          {/* RIGHT: publish first */}
          <div className="space-y-4 xl:sticky xl:top-4 xl:self-start">
            <Section
              title={selectedTargetPublishLocked ? `${publishStateLabel}（当前平台不可重复发布）` : publishState === "failed" ? "发布失败，重新选择平台" : "选平台，直接发"}
              description={selectedTargetPublishLocked ? "当前选择的平台已有有效发布流程；切换到其他平台可继续发布同一篇文章。" : "选择目标平台并提交；同一平台失败后可重新发布。"}
            >
              <div className="space-y-4">
                {selectedTargetPublishLocked ? (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm leading-6 text-slate-700">
                    <p className="font-semibold text-ink">发布状态：{publishStateLabel}</p>
                    <p className="mt-1 text-xs text-muted">当前平台已有排队、执行、审核中或已发布记录；切换其他平台仍可继续发布这篇文章。</p>
                    {lockedPublishedUrl ? (
                      <a href={lockedPublishedUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-sm font-semibold text-brand underline">
                        {lockedPublishedUrl}
                      </a>
                    ) : null}
                  </div>
                ) : null}
                <label className="grid gap-2 text-sm font-medium text-ink">
                  发布到
                  <select
                    className="h-11 rounded-xl border border-line px-3 text-sm disabled:bg-slate-100 disabled:text-muted"
                    value={selectedTargetId}
                    disabled={busy}
                    onChange={(event) => setSelectedTargetId(event.target.value)}
                  >
                    {!options.length ? <option value="">暂无可用媒体账号</option> : null}
                    {options.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                </label>
                {!options.length ? (
                  <Link href="/free-media" className="text-sm font-semibold text-brand underline">
                    先去媒体账号一键授权
                  </Link>
                ) : null}

                <details className="rounded-xl border border-line bg-slate-50 px-3 py-2">
                  <summary className="cursor-pointer text-sm font-medium text-ink">高级（一般不用动）</summary>
                  <div className="mt-3 space-y-3">
                    {selectedTargetId.startsWith("media:") ? (
                      <>
                        <label className="grid gap-1 text-xs font-medium text-ink">
                          分类/专栏
                          <input className="rounded-md border border-line px-3 py-2 text-sm" value={platformRules.category} onChange={(event) => setPlatformRules({ ...platformRules, category: event.target.value })} placeholder="例如：AI工具" />
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                          <label className="grid gap-1 text-xs font-medium text-ink">
                            类型
                            <select className="rounded-md border border-line px-3 py-2 text-sm" value={platformRules.articleType} onChange={(event) => setPlatformRules({ ...platformRules, articleType: event.target.value as PlatformPublishRules["articleType"] })}>
                              <option value="original">原创</option>
                              <option value="repost">转载</option>
                              <option value="translation">翻译</option>
                            </select>
                          </label>
                          <label className="grid gap-1 text-xs font-medium text-ink">
                            可见
                            <select className="rounded-md border border-line px-3 py-2 text-sm" value={platformRules.visibility} onChange={(event) => setPlatformRules({ ...platformRules, visibility: event.target.value as PlatformPublishRules["visibility"] })}>
                              <option value="public">公开</option>
                              <option value="private">仅我</option>
                              <option value="fans">粉丝</option>
                              <option value="vip">VIP</option>
                            </select>
                          </label>
                        </div>
                        <label className="flex items-center gap-2 text-xs">
                          <input type="checkbox" checked={platformRules.creationStatement === "none"} onChange={(event) => setPlatformRules({ ...platformRules, creationStatement: event.target.checked ? "none" : "" })} />
                          创作声明选「无」
                        </label>
                      </>
                    ) : null}
                    <label className="grid gap-1 text-xs font-medium text-ink">
                      SEO 标题
                      <input className="rounded-md border border-line px-3 py-2 text-sm" value={seoTitle} onChange={(event) => setSeoTitle(event.target.value)} />
                    </label>
                    <label className="grid gap-1 text-xs font-medium text-ink">
                      Meta 描述
                      <textarea className="min-h-16 rounded-md border border-line px-3 py-2 text-sm" value={metaDescription} onChange={(event) => setMetaDescription(event.target.value)} />
                    </label>
                  </div>
                </details>

                <div className="rounded-xl border border-line bg-white p-3 text-sm leading-6 text-slate-700">
                  <p className="font-semibold text-ink">{targetLabel(selectedTargetId, mediaAccounts) || "未选平台"}</p>
                  <p className="text-xs text-muted">DeepSeek 正文 + Step 图 + 自动排版，发布后回写审核状态和公开 URL。</p>
                  <p className="mt-1 text-xs text-muted">评分 {score.totalScore} · 规则 {article?.ruleName || "系统默认"}</p>
                </div>

                <PrimaryButton disabled={busy || !articleId || !selectedTargetId || selectedTargetPublishLocked} onClick={publishFromEditor}>
                  <Send size={16} />
                  {selectedTargetPublishLocked ? publishStateLabel : busy ? "发布处理中…" : publishState === "failed" ? "重新发布到平台" : "直接发布到平台"}
                </PrimaryButton>
                {busy ? (
                  <div className="space-y-2">
                    <LoadingState label="桌面端执行中：会弹 Chromium，别关窗口" />
                    <p className="text-xs leading-5 text-muted">
                      知乎发布靠本机 desktop agent 操控浏览器。任务栏/桌面若弹出窗口，保持登录并等它写完。
                      {lastPublishCommandId ? ` 命令 ${lastPublishCommandId}` : ""}
                    </p>
                  </div>
                ) : null}
              </div>
            </Section>

            <Section title="发布记录" description="发完在这里看审核/公开 URL。">
              <div className="space-y-2">
                {articleMediaOrders.map((order) => (
                  <Link key={order.id} href="/published" className="block rounded-md border border-line bg-white p-3 text-sm hover:border-brand">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium text-ink">{order.resourceName}</span>
                      <span className="text-xs text-muted">{order.status}</span>
                    </div>
                    <p className="mt-1 truncate text-xs text-muted">{order.backlinkUrl || formatAppTimestamp(order.updatedAt)}</p>
                  </Link>
                ))}
                {articlePublishJobs.map((job) => (
                  <Link key={job.id} href="/published" className="block rounded-md border border-line bg-white p-3 text-sm hover:border-brand">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium text-ink">{job.siteName}</span>
                      <StatusBadge status={job.status} />
                    </div>
                    <p className="mt-1 truncate text-xs text-muted">{job.publishedUrl || job.errorMessage || formatAppTimestamp(job.updatedAt)}</p>
                  </Link>
                ))}
                {!articlePublishJobs.length && !articleMediaOrders.length ? (
                  <p className="text-xs text-muted">还没发过。选平台点上面的按钮就行。</p>
                ) : null}
              </div>
            </Section>

            {headings.length ? (
              <Section title="目录" description="自动从正文抽出。">
                <div className="space-y-1.5">
                  {headings.map((heading, index) => (
                    <div key={`${heading.text}-${index}`} className="rounded-md bg-slate-50 px-3 py-1.5 text-xs text-slate-700">
                      <span className="mr-2 font-semibold text-brand">{heading.level}</span>
                      {heading.text}
                    </div>
                  ))}
                </div>
              </Section>
            ) : null}
          </div>
        </div>
      )}

      {message ? (
        <div
          className={
            messageTone === "error"
              ? "sticky bottom-0 border-t border-red-300 bg-red-50 px-6 py-4 text-sm leading-6 text-red-950"
              : messageTone === "success"
              ? "sticky bottom-0 border-t border-emerald-200 bg-emerald-50 px-6 py-3 text-sm leading-6 text-emerald-950"
              : "sticky bottom-0 border-t border-line bg-slate-50 px-6 py-3 text-sm leading-6 text-slate-700"
          }
        >
          {messageTone === "error" ? <p className="mb-1 font-semibold">发布/操作失败</p> : null}
          <p>{message}</p>
        </div>
      ) : null}
    </AppShell>
  );
}
