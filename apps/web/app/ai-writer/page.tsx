"use client";

import { AppShell } from "@/components/app-shell";
import { useCreationTask } from "@/components/creation-task-provider";
import { PageHeader, PrimaryButton, SecondaryButton } from "@/components/ui";
import { AlertCircle, CheckCircle2, History, LoaderCircle, RefreshCw, Sparkles, Wand2 } from "lucide-react";
import Link from "next/link";
import { Suspense, useState } from "react";
import { QuickCreate } from "./quick-create";
import { WriterWizard } from "./writer-wizard";


function CreationTaskPanel() {
  const { task, viewState, isRestoring, clearTask, refreshTask } = useCreationTask();

  if (!task && !isRestoring) return null;

  const tone = viewState.kind === "failed"
    ? "border-rose-200 bg-rose-50"
    : viewState.kind === "succeeded"
      ? "border-emerald-200 bg-emerald-50"
      : "border-violet-200 bg-violet-50";

  return (
    <section className={`border px-5 py-4 ${tone}`} aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          {isRestoring && !task ? (
            <LoaderCircle size={18} className="mt-0.5 shrink-0 animate-spin text-violet-600" />
          ) : viewState.kind === "failed" ? (
            <AlertCircle size={18} className="mt-0.5 shrink-0 text-rose-600" />
          ) : viewState.kind === "succeeded" ? (
            <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-emerald-600" />
          ) : (
            <LoaderCircle size={18} className="mt-0.5 shrink-0 animate-spin text-violet-600" />
          )}
          <div className="min-w-0">
            <p className="text-sm font-bold text-ink">
              {isRestoring && !task ? "正在恢复创作任务" : viewState.label}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted">
              {viewState.isOpen
                ? "任务在服务器后台继续执行。你可以切换到其他页面，返回后进度仍会保留。"
                : viewState.kind === "succeeded"
                  ? "文章已经生成完成，不会自动打断你当前浏览的页面。"
                  : viewState.errorMessage || "正在与后台任务状态对账。"}
            </p>
            {viewState.isOpen ? (
              <div className="mt-3 h-1.5 w-full max-w-xl overflow-hidden bg-white/80">
                <div className="h-full bg-violet-600 transition-all duration-500" style={{ width: `${Math.max(4, viewState.progress)}%` }} />
              </div>
            ) : null}
          </div>
        </div>

        {task ? (
          <div className="flex shrink-0 flex-wrap gap-2">
            {viewState.kind === "succeeded" && viewState.articleId ? (
              <Link href={`/editor?articleId=${encodeURIComponent(viewState.articleId)}`}>
                <PrimaryButton>
                  <Sparkles size={16} />
                  打开文章
                </PrimaryButton>
              </Link>
            ) : null}
            {viewState.isOpen ? (
              <SecondaryButton onClick={() => void refreshTask()}>
                <RefreshCw size={15} />
                刷新进度
              </SecondaryButton>
            ) : (
              <SecondaryButton onClick={clearTask}>清除状态</SecondaryButton>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
export default function AiWriterPage() {
  const [isWizardOpen, setIsWizardOpen] = useState(false);

  return (
    <AppShell>
      <PageHeader
        eyebrow="Article"
        title="AI 创作"
        description="默认懒人一键写：说一句话就出稿。规则、类型、SERP、知识、素材全还在，只是不逼你先填表。"
        action={
          <div className="flex flex-wrap gap-2">
            <Link href="/articles/history">
              <SecondaryButton>
                <History size={16} />
                创作历史
              </SecondaryButton>
            </Link>
            <PrimaryButton onClick={() => setIsWizardOpen(true)}>
              <Wand2 size={16} />
              分步精修
            </PrimaryButton>
          </div>
        }
      />

      <div className="space-y-6 p-6">
        <CreationTaskPanel />

        <Suspense
          fallback={
            <div className="rounded-3xl border border-line bg-white p-8 text-sm text-muted">
              正在加载一键创作…
            </div>
          }
        >
          <QuickCreate onOpenWizard={() => setIsWizardOpen(true)} />
        </Suspense>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-dashed border-line bg-slate-50 px-5 py-4">
          <div>
            <p className="text-sm font-semibold text-ink">还想精细控权？</p>
            <p className="mt-1 text-xs text-muted">打开老 10 步向导，逐步选 SERP、规则、素材和发布渠道。</p>
          </div>
          <PrimaryButton onClick={() => setIsWizardOpen(true)}>
            <Sparkles size={16} />
            打开分步向导
          </PrimaryButton>
        </div>
      </div>

      <WriterWizard open={isWizardOpen} onClose={() => setIsWizardOpen(false)} />
    </AppShell>
  );
}
