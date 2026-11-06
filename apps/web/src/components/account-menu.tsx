"use client";

import { accountLoginUrl, accountSessionEventKey, clearAccountState, endAccountSession, loadAccount, type AccountUser } from "@/lib/account-session";
import { isDesktopBridgeAvailable, runDesktopAgentCommand } from "@/lib/desktop-bridge";
import { ensureDesktopOwnerBinding } from "@/lib/desktop-owner-binding";
import { ArrowLeftRight, ChevronDown, LoaderCircle, LogOut, RefreshCw, UserRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export function AccountMenu() {
  const [user, setUser] = useState<AccountUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<"switch" | "signed-out" | null>(null);
  const [busy, setBusy] = useState(false);
  const [desktopState, setDesktopState] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const userRef = useRef<AccountUser | null>(null);
  const inFlight = useRef(false);
  const leaving = useRef(false);
  const mounted = useRef(false);

  const verify = useCallback(async () => {
    if (inFlight.current || leaving.current) return;
    inFlight.current = true;
    try {
      const current = await loadAccount();
      if (!mounted.current || leaving.current) return;
      if (!current) {
        window.location.replace(accountLoginUrl("expired", isDesktopBridgeAvailable()));
        return;
      }
      if (userRef.current && userRef.current.id !== current.id) {
        window.location.reload();
        return;
      }
      userRef.current = current;
      setUser(current);
      setError("");
    } catch {
      if (mounted.current) setError("暂时无法验证登录状态，请检查网络后重试。");
    } finally {
      inFlight.current = false;
      if (mounted.current) setLoading(false);
    }
  }, []);

  const bindDesktop = useCallback(async () => {
    if (!isDesktopBridgeAvailable()) return;
    setDesktopState("正在连接桌面…");
    try {
      await ensureDesktopOwnerBinding();
      if (mounted.current) setDesktopState("桌面已连接");
    } catch (cause) {
      if (!mounted.current) return;
      setDesktopState(cause instanceof Error && cause.message === "DESKTOP_DEVICE_ALREADY_BOUND"
        ? "桌面仍绑定其他账号，请先登录原账号退出桌面授权。"
        : "桌面连接失败，自动发布暂不可用，请重试。");
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void verify();
    const onFocus = () => { void verify(); };
    const onStorage = (event: StorageEvent) => {
      if (event.key === accountSessionEventKey) window.location.reload();
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void verify();
    }, 60000);
    window.addEventListener("focus", onFocus);
    window.addEventListener("storage", onStorage);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("storage", onStorage);
    };
  }, [verify]);

  useEffect(() => { if (user?.id) void bindDesktop(); }, [user?.id, bindDesktop]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); triggerRef.current?.focus(); }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  useEffect(() => {
    if (action) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [action]);

  async function signOut() {
    if (leaving.current) return;
    leaving.current = true;
    setBusy(true);
    setError("");
    try {
      const desktop = isDesktopBridgeAvailable();
      let deviceId = "";
      if (desktop) {
        // Await any in-flight binding before deciding which device to revoke.
        await ensureDesktopOwnerBinding().catch(() => undefined);
        const status = await runDesktopAgentCommand<{ device?: { id?: string; boundOwnerId?: string } }>({ command: "status", timeoutMs: 15000 });
        if (status.device?.boundOwnerId === userRef.current?.id) deviceId = status.device?.id || "";
      }
      await endAccountSession(deviceId);
      clearAccountState();
      window.location.replace(accountLoginUrl(action || "signed-out", desktop));
    } catch (cause) {
      setError(cause instanceof Error && !cause.message.startsWith("DESKTOP_")
        ? cause.message : "无法确认桌面状态，退出未完成，请稍后重试。");
      leaving.current = false;
      setBusy(false);
    }
  }

  const name = user?.displayName?.trim() || user?.email || "个人账号";
  return (
    <div ref={menuRef} className="relative shrink-0">
      <button ref={triggerRef} type="button" aria-label={`个人账号：${loading ? "验证中" : name}`} aria-expanded={open} aria-controls="account-panel"
        onClick={() => setOpen(value => !value)}
        className="focus-ring flex h-10 items-center gap-2 rounded-lg border border-line bg-white px-2 text-left hover:bg-slate-50 sm:px-3">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-violet-50 text-xs font-bold text-brand">
          {loading ? <LoaderCircle size={15} className="animate-spin" /> : user ? name.slice(0, 1).toUpperCase() : <UserRound size={15} />}
        </span>
        <span className="hidden min-w-0 sm:block">
          <span className="block max-w-32 truncate text-xs font-semibold text-slate-800">{loading ? "验证登录状态…" : name}</span>
          <span className={`block text-[10px] ${error ? "text-amber-700" : "text-emerald-700"}`}>{loading ? "请稍候" : error ? "登录状态待确认" : user ? "已登录" : "未登录"}</span>
        </span>
        <ChevronDown size={13} className="text-slate-400" />
      </button>
      {open ? (
        <section id="account-panel" aria-label="个人账号" className="absolute right-0 top-12 z-50 w-72 max-w-[calc(100vw-24px)] rounded-xl border border-line bg-white p-2 shadow-xl">
          <div className="border-b border-line px-3 py-3">
            <p className="text-[10px] text-muted">智心 AI 个人账号</p>
            <p className="mt-1 break-words text-sm font-bold text-ink">{name}</p>
            {user ? <p className="mt-1 break-all text-xs text-muted">{user.email}</p> : null}
            {user ? <p className="mt-2 text-[10px] text-muted">{user.role === "admin" ? "管理员" : "成员"} · 独立工作空间</p> : null}
            {desktopState ? <div className="mt-2 text-xs text-muted"><p role="status">{desktopState}</p>{desktopState !== "桌面已连接" && desktopState !== "正在连接桌面…" ? <button type="button" className="mt-1 text-brand underline" onClick={() => void bindDesktop()}>重新连接桌面</button> : null}</div> : null}
          </div>
          {error ? <div role="alert" className="px-3 py-2 text-xs text-amber-700">{error}<button type="button" className="mt-2 flex items-center gap-1 text-brand" onClick={() => void verify()}><RefreshCw size={12} />重新验证</button></div> : null}
          <button type="button" disabled={!user || busy} onClick={() => { setOpen(false); setError(""); setAction("switch"); }} className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"><ArrowLeftRight size={15} />切换账号</button>
          <button type="button" disabled={!user || busy} onClick={() => { setOpen(false); setError(""); setAction("signed-out"); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-xs text-rose-600 hover:bg-rose-50 disabled:opacity-50"><LogOut size={15} />退出登录</button>
        </section>
      ) : null}
      <dialog ref={dialogRef} onCancel={(event) => { event.preventDefault(); if (!busy) setAction(null); }} onClose={() => { if (!busy) { setAction(null); triggerRef.current?.focus(); } }} aria-labelledby="account-action-title"
        className="w-[calc(100%-32px)] max-w-sm rounded-xl border border-line bg-white p-6 text-ink shadow-2xl backdrop:bg-slate-950/40">
        <h2 id="account-action-title" className="text-base font-bold">{action === "switch" ? "切换账号" : "退出登录"}</h2>
        <p className="mt-3 break-all text-sm text-muted">即将退出 {user?.email}。请先保存当前页面的修改。</p>
        <p className="mt-2 text-xs leading-5 text-muted">{action === "switch" ? "退出后可使用其他邮箱登录。" : "退出后需要重新登录才能使用工作台。"}桌面端会断开当前账号的发布连接，已保存的文章和媒体账号会保留。</p>
        {error ? <p role="alert" className="mt-3 text-xs leading-5 text-rose-600">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" autoFocus disabled={busy} onClick={() => setAction(null)} className="focus-ring rounded-lg border border-line px-4 py-2 text-xs disabled:opacity-50">取消</button>
          <button type="button" disabled={busy} onClick={() => void signOut()} className="focus-ring inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-xs text-white disabled:opacity-50">{busy ? <LoaderCircle size={13} className="animate-spin" /> : null}{busy ? "正在退出…" : action === "switch" ? "退出并切换" : "确认退出"}</button>
        </div>
      </dialog>
    </div>
  );
}
