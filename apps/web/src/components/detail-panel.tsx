"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Persistent desktop inspector; a focus-managed drawer below the xl breakpoint. */
export function DetailPanel({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const [wide, setWide] = useState(true);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const titleId = useId();

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1280px)");
    const update = () => setWide(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!open || wide) return;
    const previous = document.activeElement as HTMLElement | null;
    const shell = document.querySelector<HTMLElement>("[data-app-shell]");
    const previousInert = shell?.inert ?? false;
    const overflow = document.body.style.overflow;
    if (shell) shell.inert = true;
    document.body.style.overflow = "hidden";
    panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      // The shared desktop requirement dialog can open above this drawer.
      const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"], dialog[open]')];
      if (dialogs.some((dialog) => dialog !== panelRef.current && !panelRef.current?.contains(dialog))) return;
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); }
      if (event.key !== "Tab") return;
      const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex="0"]') ?? [])].filter((element) => element.getClientRects().length);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!panelRef.current?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      if (shell) shell.inert = previousInert;
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", onKey);
      if (previous?.isConnected) previous.focus();
    };
  }, [open, wide]);

  const body = <>
    <div className="flex items-center justify-between gap-3 border-b border-line px-6 py-5">
      <h2 id={titleId} className="text-base font-semibold text-ink">{title}</h2>
      {open ? <button type="button" aria-label={`关闭${title}`} onClick={onClose} className="grid size-8 place-items-center rounded-lg text-muted hover:bg-slate-100"><X size={18} /></button> : null}
    </div>
    <div className="p-6">{children}</div>
  </>;

  if (wide) return <aside aria-labelledby={titleId} className="sticky top-20 hidden max-h-[calc(100dvh-5rem)] min-w-0 self-start overflow-y-auto border-l border-line bg-white xl:block">{body}</aside>;
  if (!open) return null;
  return createPortal(<div className="fixed inset-0 z-50 bg-slate-950/30 backdrop-blur-[2px]" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="absolute inset-y-0 right-0 w-full max-w-md overflow-y-auto overscroll-contain bg-white shadow-2xl">{body}</div>
  </div>, document.body);
}
