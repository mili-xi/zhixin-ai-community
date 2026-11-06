"use client";

import { desktopDownloadUrl, type DesktopRequirement } from "@/lib/desktop-download";
import { isDesktopBridgeAvailable } from "@/lib/desktop-bridge";
import { Download, MonitorDown, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type DesktopRequirementContextValue = {
  isDesktop: boolean;
  requireDesktop: (requirement?: DesktopRequirement) => boolean;
};

const DesktopRequirementContext = createContext<DesktopRequirementContextValue | null>(null);

export function DesktopRequirementProvider({ children }: { children: ReactNode }) {
  const [isDesktop, setIsDesktop] = useState(false);
  const [requirement, setRequirement] = useState<DesktopRequirement | null>(null);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setIsDesktop(isDesktopBridgeAvailable());
  }, []);

  useEffect(() => {
    if (!requirement) return;
    const previous = document.activeElement as HTMLElement | null;
    const underlyingDialog = previous?.closest<HTMLElement>('[role="dialog"]');
    const previousInert = underlyingDialog?.inert ?? false;
    if (underlyingDialog) underlyingDialog.inert = true;
    dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRequirement(null);
      if (event.key !== "Tab") return;
      const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]') ?? [])];
      const first = items[0]; const last = items.at(-1);
      if (!dialogRef.current?.contains(document.activeElement)) { event.preventDefault(); first?.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (underlyingDialog) underlyingDialog.inert = previousInert;
      if (previous?.isConnected) previous.focus();
    };
  }, [requirement]);

  const requireDesktop = useCallback((nextRequirement: DesktopRequirement = "文章发布") => {
    if (isDesktopBridgeAvailable()) return true;
    setRequirement(nextRequirement);
    return false;
  }, []);

  const value = useMemo(() => ({ isDesktop, requireDesktop }), [isDesktop, requireDesktop]);

  return (
    <DesktopRequirementContext.Provider value={value}>
      {children}
      {requirement ? (
        <div className="fixed inset-0 z-[1200] grid place-items-center bg-slate-950/45 p-4 backdrop-blur-sm" role="presentation" onMouseDown={() => setRequirement(null)}>
          <section
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="desktop-required-title"
            className="relative w-full max-w-md rounded-lg border border-line bg-white p-6 shadow-2xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              aria-label="关闭"
              className="absolute right-4 top-4 grid h-8 w-8 place-items-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              onClick={() => setRequirement(null)}
            >
              <X size={17} />
            </button>
            <div className="grid h-11 w-11 place-items-center rounded-lg bg-violet-50 text-brand">
              <MonitorDown size={22} />
            </div>
            <h2 id="desktop-required-title" className="mt-4 text-lg font-bold text-ink">请在智心AI桌面端继续</h2>
            <p className="mt-2 text-sm leading-6 text-muted">
              {requirement}需要本机浏览器环境。安装后使用同一账号登录，文章、媒体账号和发布记录会自动同步。
            </p>
            <div className="mt-6 flex items-center justify-end gap-2">
              <button type="button" className="h-10 rounded-md border border-line px-4 text-sm font-medium text-ink hover:bg-slate-50" onClick={() => setRequirement(null)}>
                稍后再说
              </button>
              <a
                href={desktopDownloadUrl}
                className="inline-flex h-10 items-center gap-2 rounded-md bg-brand px-4 text-sm font-bold text-white hover:bg-brand/90"
              >
                <Download size={16} />下载 Windows 桌面端
              </a>
            </div>
          </section>
        </div>
      ) : null}
    </DesktopRequirementContext.Provider>
  );
}

export function useDesktopRequirement() {
  const context = useContext(DesktopRequirementContext);
  if (!context) throw new Error("DESKTOP_REQUIREMENT_PROVIDER_MISSING");
  return context;
}
