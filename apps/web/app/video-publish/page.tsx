"use client";

import { mediaAccountOptionLabel, selectedMediaAccountPayload } from "@/lib/media-account-actions";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Film, RefreshCcw, Upload } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { EmptyState, LoadingState, PageHeader, PrimaryButton, SecondaryButton, Section } from "@/components/ui";
import { formatAppTimestamp } from "@/lib/app-time";
import { canDiscoverVideo, canRetryVideo, limitVideoTitle, MAX_VIDEO_TITLE_CODE_POINTS, defaultVideoSchedule, scheduledVideoPayload, validateVideoSchedule, videoScheduleBounds, formatVideoSchedule, videoCoverPayload, verifiedVideoPreparationLabels, captionCodePointCount, limitVideoCaption, MAX_VIDEO_CAPTION_CODE_POINTS, MAX_COVER_BYTES, publicVideoUrl, validateVideoFile, videoErrorMessage, videoPublicationLabel, videoPublicationState } from "@/lib/video-publishing";
import type { MediaAccount, VideoAsset, VideoPublication, VideoPublishCapabilities } from "@zengxing/core";

type PublishRequest = { assetId: string; mediaAccountId: string; title: string; caption: string; publishMode: "immediate" | "scheduled"; scheduledAt?: string; coverAssetId?: string; idempotencyKey: string };
type PublishResponse = { publication: VideoPublication; deduplicated: boolean };

class VideoHttpError extends Error { constructor(message: string, readonly status: number) { super(message); } }

async function jsonFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, credentials: "same-origin", headers: { "content-type": "application/json", ...init.headers } });
  if (!response.ok) throw new VideoHttpError(await response.text(), response.status);
  return response.json() as Promise<T>;
}

export default function VideoPublishPage() {
  const [accounts, setAccounts] = useState<MediaAccount[]>([]);
  const [capabilities, setCapabilities] = useState<VideoPublishCapabilities | null>(null);
  const [publications, setPublications] = useState<VideoPublication[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("上传成品视频后，在线桌面端会将视频发布到你选择的抖音账号。");
  const [asset, setAsset] = useState<VideoAsset | null>(null);
  const [cover, setCover] = useState<VideoAsset | null>(null);
  const [coverSource, setCoverSource] = useState<"ai" | "custom">("ai");
  const [accountId, setAccountId] = useState("");
  const [caption, setCaption] = useState("");
  const [title, setTitle] = useState("");
  const [publishMode, setPublishMode] = useState<"immediate" | "scheduled">("immediate");
  const [scheduledAt, setScheduledAt] = useState(() => defaultVideoSchedule());
  const [uploading, setUploading] = useState<"video" | "cover" | null>(null);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [requestPending, setRequestPending] = useState(false);
  const [localVideo, setLocalVideo] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const uploadRef = useRef<XMLHttpRequest | null>(null);
  const actionLock = useRef(false);
  const requestRef = useRef<PublishRequest | null>(null);
  const retryKeys = useRef(new Map<string, string>());
  const mounted = useRef(true);
  const videoInput = useRef<HTMLInputElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const [nextAccounts, nextCapabilities, nextPublications] = await Promise.all([
      jsonFetch<MediaAccount[]>("/api/media-accounts", { signal }),
      jsonFetch<VideoPublishCapabilities>("/api/video-publications/capabilities", { signal }),
      jsonFetch<VideoPublication[]>("/api/video-publications", { signal })
    ]);
    if (signal?.aborted || !mounted.current) return;
    setAccounts(nextAccounts.filter((account) => account.platform === "douyin" && account.isCanonical !== false));
    setCapabilities(nextCapabilities);
    setPublications(nextPublications);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refresh(controller.signal); }
      catch (error) { if (!controller.signal.aborted) setMessage(videoErrorMessage(error)); }
      finally {
        if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(poll, 5000); }
      }
    };
    void poll();
    return () => { mounted.current = false; controller.abort(); clearTimeout(timer); uploadRef.current?.abort(); };
  }, [refresh]);

  useEffect(() => {
    if (!localVideo) { setPreview(""); return; }
    const url = URL.createObjectURL(localVideo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [localVideo]);

  const selectedCapability = capabilities?.accounts.find((entry) => entry.mediaAccountId === accountId);
  const locked = Boolean(uploading) || busy || submitted || requestPending;
  const scheduleError = publishMode === "scheduled" ? validateVideoSchedule(scheduledAt) : "";
  const scheduleBounds = videoScheduleBounds();
  const scheduleReady = publishMode === "immediate" || (selectedCapability?.supportsScheduled === true && !scheduleError);
  // A lost response is a lookup of the frozen intent, even if its time window
  // has since elapsed or the device is now offline. Never create a new intent.
  const canPublish = Boolean(!uploading && !busy && !submitted && (requestPending || (asset && (coverSource === "ai" || cover) && accountId && selectedCapability?.ready && scheduleReady && caption.trim() && captionCodePointCount(caption) <= MAX_VIDEO_CAPTION_CODE_POINTS && captionCodePointCount(title) <= MAX_VIDEO_TITLE_CODE_POINTS)));

  async function upload(file: File | undefined, kind: "video" | "cover") {
    if (!file || actionLock.current || submitted || requestPending) return;
    const error = kind === "video" ? validateVideoFile(file) : file.size === 0 ? "不能上传空文件。" : file.size > MAX_COVER_BYTES ? "封面不能超过 10 MiB。" : !["image/png", "image/jpeg"].includes(file.type) ? "封面支持 PNG、JPG。" : "";
    if (error) { setMessage(error); return; }
    actionLock.current = true;
    setUploading(kind);
    setProgress(0);
    if (kind === "video") { setAsset(null); setLocalVideo(file); } else { setCover(null); }
    requestRef.current = null;
    setMessage(`正在上传${kind === "video" ? "视频" : "封面"}，上传后会校验文件。`);
    try {
      const uploaded = await new Promise<VideoAsset>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        uploadRef.current = xhr;
        xhr.open("POST", "/api/video-assets/upload");
        xhr.withCredentials = true;
        xhr.timeout = 30 * 60 * 1000;
        xhr.upload.onprogress = (event) => { if (mounted.current && event.lengthComputable) setProgress(Math.round(event.loaded / event.total * 100)); };
        xhr.onload = () => {
          if (xhr.status < 200 || xhr.status >= 300) { reject(new Error(xhr.responseText || `上传失败（${xhr.status}）`)); return; }
          try { resolve(JSON.parse(xhr.responseText) as VideoAsset); } catch { reject(new Error("上传响应无法解析，请刷新检查后重试。")); }
        };
        xhr.onerror = () => reject(new Error("上传连接中断，请重新上传。"));
        xhr.ontimeout = () => reject(new Error("上传超时，请重新上传。"));
        xhr.onabort = () => reject(new Error("上传已取消。"));
        const body = new FormData(); body.set("file", file); body.set("kind", kind); xhr.send(body);
      });
      if (!mounted.current) return;
      if (kind === "video") setAsset(uploaded); else setCover(uploaded);
      setMessage(`${kind === "video" ? "视频" : "封面"}已上传并通过校验。`);
    } catch (error) { if (mounted.current) setMessage(videoErrorMessage(error)); }
    finally { actionLock.current = false; uploadRef.current = null; if (mounted.current) setUploading(null); }
  }

  async function publish() {
    if (!canPublish || !asset || actionLock.current) return;
    // Build before locking: a schedule that just became too near can be fixed.
    const freshRequest = requestRef.current === null;
    if (freshRequest) {
      try {
        requestRef.current = { assetId: asset.id, ...selectedMediaAccountPayload(accountId), title: title.trim(), caption: caption.trim(), ...scheduledVideoPayload(publishMode, scheduledAt), ...videoCoverPayload(coverSource, cover?.id), idempotencyKey: crypto.randomUUID() };
      } catch (error) { setMessage(videoErrorMessage(error)); return; }
    }
    actionLock.current = true;
    setBusy(true);
    // Retain title, caption, mode and time on a lost response.
    setRequestPending(true);
    try {
      const result = await jsonFetch<PublishResponse>("/api/video-publications", { method: "POST", body: JSON.stringify(requestRef.current) });
      setSubmitted(true);
      setRequestPending(false);
      setPublications((current) => [result.publication, ...current.filter((item) => item.id !== result.publication.id)]);
      setMessage(result.deduplicated ? "已找到同一次发布任务，请在下方查看进度。" : "任务已创建，等待绑定的桌面端执行。创建任务不代表视频已经公开。");
    } catch (error) {
      if (freshRequest && error instanceof VideoHttpError && error.status >= 400 && error.status < 500) {
        requestRef.current = null; setRequestPending(false);
        setMessage(videoErrorMessage(error));
      } else {
        setMessage(`${videoErrorMessage(error)}。发布请求保留，可点击「重查本次提交」使用同一请求重试；请勿另建重复任务。`);
      }
    }
    finally { actionLock.current = false; if (mounted.current) setBusy(false); }
  }

  async function discover(id: string) {
    if (actionLock.current) return;
    actionLock.current = true; setBusy(true);
    try {
      await jsonFetch(`/api/video-publications/${encodeURIComponent(id)}/discover`, { method: "POST" });
      setMessage("已请求回查作品状态，此操作不会重新发布视频。");
      await refresh();
    } catch (error) { setMessage(videoErrorMessage(error)); }
    finally { actionLock.current = false; setBusy(false); }
  }

  async function retry(publication: VideoPublication) {
    if (actionLock.current || !canRetryVideo(publication)) return;
    actionLock.current = true; setBusy(true);
    const key = retryKeys.current.get(publication.id) || crypto.randomUUID();
    retryKeys.current.set(publication.id, key);
    try {
      const result = await jsonFetch<PublishResponse>(`/api/video-publications/${encodeURIComponent(publication.id)}/retry`, { method: "POST", body: JSON.stringify({ idempotencyKey: key }) });
      setPublications((current) => current.map((item) => item.id === publication.id ? result.publication : item));
      retryKeys.current.delete(publication.id);
      setMessage("已重新排队。这条任务此前尚未向抖音提交作品。");
    } catch (error) { setMessage(videoErrorMessage(error)); }
    finally { actionLock.current = false; if (mounted.current) setBusy(false); }
  }

  function startNew() {
    if (actionLock.current || requestPending) return;
    setAsset(null); setCover(null); setCoverSource("ai"); setLocalVideo(null); setCaption(""); setTitle(""); setPublishMode("immediate"); setScheduledAt(defaultVideoSchedule()); setSubmitted(false); requestRef.current = null;
    if (videoInput.current) videoInput.current.value = "";
    if (coverInput.current) coverInput.current.value = "";
    setMessage("请选择下一条成品视频。之前的任务会继续显示在发布记录中。");
  }

  return <AppShell>
    <PageHeader eyebrow="Douyin Video" title="抖音视频发布" description="手动上传成品视频，由绑定的桌面端完成抖音发布并回查作品状态。" action={<Link href="/free-media" className="text-sm font-semibold text-brand">管理抖音账号 →</Link>} />
    <div className="space-y-6 p-6">
      <p role="status" aria-live="polite" className="rounded-lg border border-line bg-panel px-4 py-3 text-sm text-muted">{message}</p>
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <Section title="1. 上传成品" description="支持 MP4（H.264 / HEVC），最长 20 分钟、最大 500 MiB。默认使用抖音 AI 封面，也可自行上传封面。">
          <div className="space-y-4">
            <label className="grid gap-2 text-sm font-medium text-ink">视频文件
              <input ref={videoInput} type="file" accept="video/mp4,.mp4" disabled={locked} onChange={(event) => void upload(event.target.files?.[0], "video")} className="block w-full rounded-lg border border-line p-3 text-sm file:mr-3 file:rounded file:border-0 file:bg-slate-100 file:px-3 file:py-1 disabled:opacity-50" />
            </label>
            {preview ? <video src={preview} controls preload="metadata" className="max-h-64 w-full rounded-lg bg-slate-950" aria-label="成品视频预览" /> : <div className="flex h-32 items-center justify-center gap-2 rounded-lg border border-dashed border-line text-sm text-muted"><Film size={20} />选择视频后可预览</div>}
            {uploading ? <div role="status"><p className="mb-2 text-xs text-muted">{progress === 100 ? "传输完成，正在校验文件…" : `正在上传${uploading === "video" ? "视频" : "封面"} ${progress}%`}</p><progress className="h-2 w-full accent-brand" max={100} value={progress} aria-label="文件上传进度" /></div> : null}
            {asset ? <p className="text-xs text-emerald-700">已就绪：{asset.filename} · {(asset.sizeBytes / 1024 / 1024).toFixed(1)} MiB</p> : null}
            <label className="grid gap-2 text-sm font-medium text-ink">封面来源
              <select aria-label="封面来源" value={coverSource} disabled={locked} onChange={(event) => { if (locked) return; setCoverSource(event.target.value as "ai" | "custom"); requestRef.current = null; }} className="rounded-lg border border-line bg-panel p-3 text-sm disabled:opacity-50">
                <option value="ai">抖音 AI 封面</option><option value="custom">自定义封面</option>
              </select>
            </label>
            {coverSource === "custom" ? <div className="space-y-2">
              <label className="grid gap-2 text-sm font-medium text-ink">自定义封面
                <input ref={coverInput} type="file" accept="image/png,image/jpeg" disabled={locked || !asset} onChange={(event) => void upload(event.target.files?.[0], "cover")} className="block w-full rounded-lg border border-line p-3 text-sm disabled:opacity-50" />
              </label>
              {cover ? <div className="flex items-center justify-between gap-2 text-xs text-muted"><span>{cover.filename}</span><button type="button" disabled={locked} className="text-brand disabled:opacity-50" onClick={() => { setCover(null); if (coverInput.current) coverInput.current.value = ""; }}>移除封面</button></div> : <p className="text-xs text-muted">请选择 PNG / JPG，最大 10 MiB。上传后才可发布。</p>}
            </div> : <p className="text-xs leading-5 text-muted">由抖音原生 AI 生成并应用封面，生成失败会在提交前停止。切换到 AI 封面后，不会使用已上传的自定义封面。</p>}
          </div>
        </Section>
        <Section title="2. 发布到抖音" description="选择立即发布或抖音原生定时发布，提交后持续回查作品状态。">
          <div className="space-y-4">
            <label className="grid gap-2 text-sm font-medium text-ink">抖音账号
              <select aria-label="抖音账号" value={accountId} disabled={locked} onChange={(event) => setAccountId(event.target.value)} className="rounded-lg border border-line bg-panel p-3 text-sm disabled:opacity-50"><option value="">请选择已授权账号</option>{accounts.map((account) => <option key={account.id} value={account.id}>{mediaAccountOptionLabel(account)}{account.status !== "active" ? "（需检查授权）" : ""}</option>)}</select>
            </label>
            {accountId ? <p className={`text-xs ${selectedCapability?.ready ? "text-emerald-700" : "text-amber-700"}`}>{selectedCapability?.ready ? "绑定的桌面端在线，可以执行视频发布。" : videoErrorMessage(selectedCapability?.error || "绑定的桌面端尚未就绪，请启动支持视频发布的客户端并刷新。")}</p> : <p className="text-xs text-muted">首次使用请在桌面端的「媒体账号」授权抖音，然后刷新账号列表。</p>}
            <label className="grid gap-2 text-sm font-medium text-ink">作品标题（可选）
              <input aria-label="作品标题" type="text" value={title} disabled={locked} onChange={(event) => setTitle(limitVideoTitle(event.target.value))} placeholder="可选，最多 30 字" className="w-full rounded-lg border border-line p-3 text-sm disabled:opacity-50" />
            </label>
            <p className="text-right text-xs text-muted">{captionCodePointCount(title)} / {MAX_VIDEO_TITLE_CODE_POINTS} 字</p>
            <label className="grid gap-2 text-sm font-medium text-ink">作品简介
              <textarea aria-label="作品简介" value={caption} disabled={locked} rows={5} onChange={(event) => setCaption(limitVideoCaption(event.target.value))} placeholder="填写作品简介，可包含 #话题" className="w-full rounded-lg border border-line p-3 text-sm disabled:opacity-50" />
            </label>
            <p className="text-right text-xs text-muted" aria-live="polite">{captionCodePointCount(caption)} / {MAX_VIDEO_CAPTION_CODE_POINTS} 字</p>
            <label className="grid gap-2 text-sm font-medium text-ink">发布方式
              <select aria-label="发布方式" value={publishMode} disabled={locked} onChange={(event) => setPublishMode(event.target.value as "immediate" | "scheduled")} className="rounded-lg border border-line bg-panel p-3 text-sm disabled:opacity-50">
                <option value="immediate">立即发布</option><option value="scheduled">定时发布</option>
              </select>
            </label>
            {publishMode === "scheduled" ? <div className="space-y-2">
              <label className="grid gap-2 text-sm font-medium text-ink">计划时间（北京时间）
                <input aria-label="计划时间（北京时间）" type="datetime-local" step={60} min={scheduleBounds.min} max={scheduleBounds.max} value={scheduledAt} disabled={locked} onChange={(event) => setScheduledAt(event.target.value)} className="w-full rounded-lg border border-line p-3 text-sm disabled:opacity-50" />
              </label>
              <p className="text-xs text-muted">按北京时间（Asia/Shanghai，UTC+8）提交，须在 2 小时后至 14 天内。默认约 3 小时后。</p>
              {accountId && selectedCapability?.supportsScheduled !== true ? <p className="text-xs text-amber-700">当前桌面端尚不支持定时发布，请更新客户端后刷新；仍可选择立即发布。</p> : null}
              {scheduleError && !requestPending ? <p role="alert" className="text-xs text-amber-700">{scheduleError}</p> : null}
            </div> : null}
            <p className="text-xs leading-5 text-muted">新任务默认使用抖音 AI 封面，并关联简介中的 #话题、生成智能章节；选择自定义封面时使用上传图片。准备失败会在提交前停止。点击发布会提交真实作品，请先确认视频、标题、简介、账号和发布时间。</p>
            <div className="flex flex-wrap gap-3"><PrimaryButton disabled={!canPublish} onClick={() => void publish()}><Upload size={15} />{busy ? "正在处理…" : submitted ? "已创建发布任务" : requestPending ? "重查本次提交" : publishMode === "scheduled" ? "提交定时发布" : "立即发布"}</PrimaryButton><SecondaryButton disabled={busy || Boolean(uploading)} onClick={() => void refresh().catch((error) => setMessage(videoErrorMessage(error)))}><RefreshCcw size={14} />刷新账号</SecondaryButton>{submitted ? <SecondaryButton disabled={busy} onClick={startNew}>新建视频任务</SecondaryButton> : null}</div>
          </div>
        </Section>
      </div>
      <Section title="视频发布记录" description="审核等待与提交结果不明不会显示为已公开。回查只查询状态，不会再次投稿。">
        {loading ? <LoadingState label="正在加载发布记录…" /> : publications.length === 0 ? <EmptyState title="还没有视频发布任务" description="上传视频并选择账号后，即可创建第一条任务。" /> : <div className="space-y-3">{publications.map((publication) => {
          const state = videoPublicationState(publication);
          const publicUrl = publicVideoUrl(publication);
          const preparationLabels = verifiedVideoPreparationLabels(publication.preparationEvidence);
          return <article key={publication.id} className="rounded-lg border border-line p-4">
            <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><p className="break-words text-sm font-semibold text-ink">{publication.title || publication.caption || publication.filename || "视频作品"}</p><p className="mt-1 text-xs text-muted">{publication.accountName || accounts.find((account) => account.id === publication.mediaAccountId)?.accountName || "抖音账号"} · {formatAppTimestamp(publication.createdAt)}</p></div><span className={`rounded-full px-3 py-1 text-xs font-medium ${state === "published" ? "bg-emerald-50 text-emerald-700" : state === "failed" || state === "rejected" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-800"}`}>{videoPublicationLabel(publication)}</span></div>
            {publication.title && publication.caption ? <p className="mt-2 whitespace-pre-wrap break-words text-xs text-muted">{publication.caption}</p> : null}
            {publication.publishMode === "scheduled" && formatVideoSchedule(publication.scheduledAt) ? <p className="mt-2 text-xs text-muted">计划发布时间：{formatVideoSchedule(publication.scheduledAt)}</p> : null}
            {publication.message || publication.errorMessage ? <p className="mt-3 break-words text-xs text-muted">{videoErrorMessage(publication.message || publication.errorMessage)}</p> : null}
            {state === "submission_unknown" ? <p className="mt-2 text-xs text-amber-800">提交可能已被抖音接收，请先回查或在创作中心确认，勿重复发布。</p> : null}
            {preparationLabels.length ? <div className="mt-3 flex flex-wrap gap-2">{preparationLabels.map((label) => <span key={label} className="rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-800">{label}</span>)}</div> : null}
            {publication.itemId ? <p className="mt-2 break-all text-xs text-muted">作品 ID：{publication.itemId}</p> : null}
            <div className="mt-3 flex flex-wrap gap-3">{canDiscoverVideo(publication) ? <SecondaryButton disabled={busy || Boolean(uploading)} onClick={() => void discover(publication.id)}><RefreshCcw size={14} />回查状态</SecondaryButton> : null}{canRetryVideo(publication) ? <SecondaryButton disabled={busy || Boolean(uploading)} onClick={() => void retry(publication)}>重试发布</SecondaryButton> : null}{publicUrl ? <a className="self-center text-xs font-semibold text-brand" href={publicUrl} target="_blank" rel="noopener noreferrer">查看公开作品 ↗</a> : null}</div>
          </article>;
        })}</div>}
      </Section>
    </div>
  </AppShell>;
}
