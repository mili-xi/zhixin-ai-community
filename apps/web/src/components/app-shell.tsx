"use client";

import { useCreationTask } from "@/components/creation-task-provider";
import { AccountMenu } from "@/components/account-menu";
import { taskStageLabel } from "@/lib/tasks";
import { workspaceNavGroups } from "@zengxing/core";
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  FileCheck2,
  FileText,
  LayoutDashboard,
  LoaderCircle,
  Menu,
  Radio,
  Plug,
  Sparkles,
  X,
  Video,
  Zap
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

type ContextualTab = {
  label: string;
  href: string;
};

type ContextualTabGroup = {
  match: string;
  items: ContextualTab[];
};

const iconByHref = {
  "/dashboard": LayoutDashboard,
  "/ai-writer": Sparkles,
  "/articles": FileText,
  "/free-media": Radio,
  "/auto-publish": Zap,
  "/video-publish": Video,
  "/published": FileCheck2,
  "/agent-access": Plug
};

const contextualTabs: ContextualTabGroup[] = [
  {
    match: "/ai-writer",
    items: [
      { label: "创作", href: "/ai-writer" },
      { label: "SERP", href: "/ai-writer/serp" },
      { label: "知识", href: "/ai-writer/knowledge" },
      { label: "素材", href: "/ai-writer/assets" },
      { label: "生成设置", href: "/ai-writer/rules" },
      { label: "水印", href: "/ai-writer/watermarks" },
      { label: "规则模板", href: "/ai-writer/templates" }
    ]
  },
  {
    match: "/articles",
    items: [
      { label: "所有文章", href: "/articles" },
      { label: "创作任务", href: "/articles/history" }
    ]
  }
];

function pathMatches(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function resolvePrimaryItem(pathname: string) {
  return workspaceNavGroups
    .flatMap((group) => group.items.map((item) => ({ ...item, groupLabel: group.label })))
    .find((item) => pathMatches(pathname, item.href));
}

function resolveContextualTabs(pathname: string) {
  return contextualTabs.find((group) => pathMatches(pathname, group.match));
}

function contextualPageTitle(pathname: string, fallback: string) {
  const tab = resolveContextualTabs(pathname)?.items.find((item) => pathname === item.href);
  return tab?.label ?? fallback;
}

export function AppShell({ children, title, description, action }: { children: ReactNode; title?: string; description?: string; action?: ReactNode }) {
  const pathname = usePathname();
  const { task: creationTask, viewState: creationViewState } = useCreationTask();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const content = contentRef.current;
    const overflow = document.body.style.overflow;
    if (content) content.inert = true;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => navRef.current?.querySelector<HTMLElement>('button[aria-label="关闭导航"]')?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileNavOpen(false);
      if (event.key !== "Tab") return;
      const items = [...(navRef.current?.querySelectorAll<HTMLElement>('a[href], button') ?? [])].filter((item) => item.getClientRects().length);
      const first = items[0]; const last = items.at(-1);
      if (!navRef.current?.contains(document.activeElement)) { event.preventDefault(); first?.focus(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    const desktop = window.matchMedia("(min-width: 1024px)");
    const onResize = () => { if (desktop.matches) setMobileNavOpen(false); };
    desktop.addEventListener("change", onResize);
    document.addEventListener("keydown", onKey);
    return () => {
      if (content) content.inert = false;
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", onKey);
      window.cancelAnimationFrame(focusFrame);
      desktop.removeEventListener("change", onResize);
      if (previous?.isConnected) previous.focus();
    };
  }, [mobileNavOpen]);

  const primaryItem = resolvePrimaryItem(pathname);
  const tabs = resolveContextualTabs(pathname);
  const pageTitle = contextualPageTitle(pathname, primaryItem?.label ?? "工作台");
  const creationTaskLabel = creationTask
    ? creationViewState.isOpen
      ? taskStageLabel(creationTask)
      : creationViewState.label
    : "";

  return (
    <div data-app-shell className="relative flex min-h-screen flex-col overflow-x-hidden bg-canvas text-ink">
      {mobileNavOpen ? (
        <button
          type="button"
          aria-label="关闭导航遮罩"
          className="fixed inset-0 z-20 bg-black/40 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileNavOpen(false)}
        />
      ) : null}

      <aside ref={navRef} role={mobileNavOpen ? "dialog" : undefined} aria-modal={mobileNavOpen ? true : undefined} aria-label="工作区导航" className={`fixed inset-y-0 left-0 z-30 w-60 max-w-[82vw] flex-col border-r border-line bg-[#f8f9fd] text-ink lg:flex lg:translate-x-0 ${mobileNavOpen ? "flex translate-x-0" : "hidden -translate-x-full"}`}>
        <div className="relative px-5 py-6">
          <Link href="/dashboard" className="flex items-center gap-3.5" onClick={() => setMobileNavOpen(false)}>
            <div className="grid size-9 shrink-0 place-items-center text-brand"><Sparkles size={29} strokeWidth={2.3} /></div>
            <div className="min-w-0">
              <p className="truncate text-xl font-semibold tracking-tight text-ink">智心AI</p>
              <p className="mt-1 truncate text-[11px] text-muted">内容创作与媒体发布</p>
            </div>
          </Link>
          {mobileNavOpen ? <button
            type="button"
            aria-label="关闭导航"
            autoFocus
            className="absolute right-3 top-4 grid h-8 w-8 place-items-center rounded-md text-slate-400 hover:bg-slate-100 lg:hidden"
            onClick={() => setMobileNavOpen(false)}
          >
            <X size={16} />
          </button> : null}
        </div>

        <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-3" aria-label="主导航">
          {workspaceNavGroups.map((group) => (
            <section key={group.label} className="mb-4">
              <p className="mb-2 px-3 text-[11px] font-medium tracking-wider text-muted">{group.label}</p>
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = iconByHref[item.href as keyof typeof iconByHref] ?? FileText;
                  const active = pathMatches(pathname, item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      title={item.description}
                      aria-current={active ? "page" : undefined}
                      onClick={() => setMobileNavOpen(false)}
                      className={`group relative flex h-11 items-center gap-3 rounded-lg px-3 text-[13px] transition-colors duration-150 ${active ? "bg-[#ece6ff] font-semibold text-brand" : "text-slate-600 hover:bg-slate-100 hover:text-ink"}`}
                    >
                      <Icon size={18} strokeWidth={1.7} className={`shrink-0 ${active ? "text-brand" : "text-slate-500"}`} />
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </section>
          ))}
        </nav>

        <div className="mx-5 border-t border-line py-5 text-xs text-muted">
          AI 创作到媒体发布
        </div>
      </aside>

      <div ref={contentRef} className="min-w-0 lg:pl-60 z-10 flex-1 flex flex-col">
        <header className="sticky top-0 z-10 border-b border-line bg-white/95 backdrop-blur-md">
          <div className={`flex items-center justify-between gap-3 px-4 sm:px-7 ${title ? "min-h-20" : "min-h-16"}`}>
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                aria-label="打开导航"
                className="focus-ring grid h-8 w-8 shrink-0 place-items-center rounded-md border border-line bg-white text-slate-600 lg:hidden hover:bg-slate-50"
                onClick={() => setMobileNavOpen(true)}
              >
                <Menu size={16} />
              </button>
              <div className="min-w-0">
                {title ? <><h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>{description ? <p className="mt-1 hidden text-xs text-muted md:block">{description}</p> : null}</> : (
                <div className="flex items-center gap-2 text-xs font-medium text-muted">
                  <span>{primaryItem?.groupLabel ?? "运营"}</span>
                  <ChevronRight size={8} />
                  <span className="truncate text-ink">{pageTitle}</span>
                </div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              {action ? <div className="hidden sm:block">{action}</div> : null}
              {creationTask ? (
                <Link
                  href="/ai-writer"
                  title={creationTaskLabel}
                  className={`hidden h-8 max-w-64 items-center gap-2 rounded-lg border px-2.5 text-[10px] font-bold md:flex ${
                    creationViewState.kind === "failed"
                      ? "border-rose-200 bg-rose-50 text-rose-700"
                      : creationViewState.kind === "succeeded"
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : "border-violet-200 bg-violet-50 text-violet-700"
                  }`}
                >
                  {creationViewState.kind === "failed" ? (
                    <AlertCircle size={13} className="shrink-0" />
                  ) : creationViewState.kind === "succeeded" ? (
                    <CheckCircle2 size={13} className="shrink-0" />
                  ) : (
                    <LoaderCircle size={13} className="shrink-0 animate-spin" />
                  )}
                  <span className="truncate">{creationTaskLabel}</span>
                </Link>
              ) : null}
              <Link href="/auto-publish" aria-label="新建发布" className="focus-ring inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-3 text-[13px] font-medium text-white shadow-sm transition-colors hover:bg-brand/90">
                <Zap size={13} />
                <span className="hidden sm:inline">新建发布</span>
              </Link>
              <AccountMenu />
            </div>
          </div>

          {tabs ? (
            <nav className="overflow-x-auto border-t border-line px-3 sm:px-6" aria-label={`${primaryItem?.label ?? "页面"}子导航`}>
              <div className="flex min-w-max gap-1.5 py-1.5">
                {tabs.items.map((item) => {
                  const active = pathname === item.href;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={`inline-flex h-9 items-center rounded-lg px-3 text-[13px] transition-colors duration-150 ${active ? "bg-violet-50 font-medium text-brand" : "text-muted hover:bg-slate-50 hover:text-ink"}`}
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </nav>
          ) : null}
        </header>
        <main className="min-w-0 flex-1 animate-fade-in-up">{children}</main>
      </div>
    </div>
  );
}
