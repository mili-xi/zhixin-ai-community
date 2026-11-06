"use client";

import { accountSessionEventKey, clearAccountState } from "@/lib/account-session";
import { isDesktopBridgeAvailable } from "@/lib/desktop-bridge";

import {
  ArrowRight,
  Eye,
  EyeOff,
  LoaderCircle,
  LockKeyhole,
  LogIn,
  Mail,
  RotateCcw,
  ShieldCheck,
  UserPlus,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useEffect, useMemo, useState } from "react";

type AuthMode = "login" | "register";
type RegisterStep = "account" | "code";

type CodeResponse = {
  accepted: boolean;
  expiresIn: number;
  debugCode?: string;
};

type ErrorPayload = {
  detail?: string | Array<{ msg?: string }>;
};

const errorMessages: Record<string, string> = {
  EMAIL_ALREADY_REGISTERED: "该邮箱已经注册，请直接登录。",
  INVALID_EMAIL_OR_PASSWORD: "邮箱或密码错误。",
  REGISTRATION_CODE_INVALID_OR_EXPIRED: "验证码不正确或已过期，请重新获取。",
  REGISTRATION_DISABLED: "当前暂未开放新账号注册。",
  USER_DISABLED: "该账号已被停用。",
  AUTH_EMAIL_DELIVERY_NOT_CONFIGURED: "注册邮件服务尚未配置，请联系维护人员。",
  AUTH_EMAIL_DELIVERY_FAILED: "验证码发送失败，请稍后重试。",
  AUTH_EMAIL_DELIVERY_UNSUPPORTED: "注册邮件服务配置不正确。",
};

function safeDestination(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/dashboard";
  return value;
}

async function responseError(response: Response) {
  const payload = (await response.json().catch(() => ({}))) as ErrorPayload;
  if (typeof payload.detail === "string") {
    return errorMessages[payload.detail] ?? payload.detail;
  }
  if (Array.isArray(payload.detail)) {
    return payload.detail[0]?.msg ?? "提交信息不完整，请检查后重试。";
  }
  return "操作没有完成，请稍后重试。";
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const destination = useMemo(() => safeDestination(searchParams.get("next")), [searchParams]);
  const [mode, setMode] = useState<AuthMode>("login");
  const [registerStep, setRegisterStep] = useState<RegisterStep>("account");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [code, setCode] = useState("");
  const [debugCode, setDebugCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const sessionNotices: Record<string, string> = {
    switch: "已退出原账号，请使用其他邮箱登录。",
    "signed-out": "你已安全退出登录。",
    expired: "登录已失效，请重新登录。",
  };
  const sessionNotice = sessionNotices[searchParams.get("reason") || ""];

  useEffect(() => {
    isDesktopBridgeAvailable();
    let active = true;
    const onSessionChanged = (event: StorageEvent) => {
      if (event.key === accountSessionEventKey) window.location.reload();
    };
    window.addEventListener("storage", onSessionChanged);
    void fetch("/api/auth/me", { credentials: "include", cache: "no-store" })
      .then((response) => {
        if (active && response.ok) {
          router.replace(destination);
          router.refresh();
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
      window.removeEventListener("storage", onSessionChanged);
    };
  }, [destination, router]);

  function switchMode(nextMode: AuthMode) {
    setMode(nextMode);
    setRegisterStep("account");
    setCode("");
    setDebugCode("");
    setErrorMessage("");
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setErrorMessage("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      clearAccountState();
      window.location.replace(destination);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "登录失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function requestRegistrationCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password.length < 8) {
      setErrorMessage("密码至少需要 8 位。");
      return;
    }
    if (password !== confirmPassword) {
      setErrorMessage("两次输入的密码不一致。");
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();
    setBusy(true);
    setErrorMessage("");
    try {
      const response = await fetch("/api/auth/register/request-code", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: normalizedEmail }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const payload = (await response.json()) as CodeResponse;
      setEmail(normalizedEmail);
      setDebugCode(payload.debugCode ?? "");
      setRegisterStep("code");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "验证码发送失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setErrorMessage("");
    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          code: code.trim(),
          displayName: displayName.trim(),
        }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      clearAccountState();
      window.location.replace(destination);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "注册失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  const showingRegisterCode = mode === "register" && registerStep === "code";

  return (
    <main className="min-h-screen bg-white lg:grid lg:grid-cols-[minmax(320px,38%)_1fr]">
      <section className="hidden border-r border-slate-200 bg-slate-950 px-12 py-14 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-md bg-white text-base font-black text-slate-950">智</span>
          <div>
            <p className="text-lg font-bold">智心 AI</p>
            <p className="text-xs text-slate-400">内容创作与媒体发布工作台</p>
          </div>
        </div>
        <div className="max-w-md">
          <p className="text-3xl font-bold leading-tight">登录你的独立工作空间</p>
          <p className="mt-4 text-sm leading-7 text-slate-400">文章、媒体账号、桌面设备和发布记录会持续同步。</p>
        </div>
        <p className="text-xs text-slate-500">Zhixin AI Workspace</p>
      </section>

      <section className="flex min-h-screen items-center justify-center px-5 py-10 sm:px-8">
        <div className="w-full max-w-[440px]">
          <div className="mb-9 flex items-center gap-3 lg:hidden">
            <span className="grid h-10 w-10 place-items-center rounded-md bg-slate-950 text-base font-black text-white">智</span>
            <div>
              <p className="text-lg font-bold text-slate-950">智心 AI</p>
              <p className="text-xs text-slate-500">内容创作与媒体发布工作台</p>
            </div>
          </div>

          <div className="mb-7 grid grid-cols-2 border-b border-slate-200" role="tablist" aria-label="账号入口">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "login"}
              onClick={() => switchMode("login")}
              className={`h-11 border-b-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#6236ff]/20 ${mode === "login" ? "border-[#6236ff] text-[#6236ff]" : "border-transparent text-slate-500 hover:text-slate-800"}`}
            >
              邮箱密码登录
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "register"}
              onClick={() => switchMode("register")}
              className={`h-11 border-b-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#6236ff]/20 ${mode === "register" ? "border-[#6236ff] text-[#6236ff]" : "border-transparent text-slate-500 hover:text-slate-800"}`}
            >
              验证码注册
            </button>
          </div>

          <div className="mb-7">
            {sessionNotice ? <p role="status" className="mb-4 rounded-lg border border-violet-100 bg-violet-50 px-4 py-3 text-sm text-violet-800">{sessionNotice}</p> : null}
            <div className="mb-4 grid h-11 w-11 place-items-center rounded-md border border-slate-200 bg-slate-50 text-slate-700">
              {mode === "login" ? <LogIn size={20} /> : showingRegisterCode ? <ShieldCheck size={20} /> : <UserPlus size={20} />}
            </div>
            <h1 className="text-2xl font-bold text-slate-950">
              {mode === "login" ? "登录账号" : showingRegisterCode ? "验证邮箱" : "创建账号"}
            </h1>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              {mode === "login"
                ? "使用注册邮箱和密码继续。"
                : showingRegisterCode
                  ? `验证码已发送至 ${email}`
                  : "注册时验证一次邮箱，之后直接使用密码登录。"}
            </p>
          </div>

          {mode === "login" ? (
            <form className="space-y-5" onSubmit={login}>
              <Field id="login-email" label="邮箱地址" icon={<Mail size={16} />}>
                <input
                  id="login-email"
                  type="email"
                  autoComplete="email"
                  autoFocus
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="name@example.com"
                  className="auth-field-input"
                />
              </Field>
              <PasswordField
                id="login-password"
                label="密码"
                autoComplete="current-password"
                value={password}
                onChange={setPassword}
                placeholder="输入登录密码"
              />
              <PrimaryButton busy={busy} disabled={!email.trim() || !password} label="登录" />
            </form>
          ) : registerStep === "account" ? (
            <form className="space-y-5" onSubmit={requestRegistrationCode}>
              <Field id="register-email" label="邮箱地址" icon={<Mail size={16} />}>
                <input
                  id="register-email"
                  type="email"
                  autoComplete="email"
                  autoFocus
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="name@example.com"
                  className="auth-field-input"
                />
              </Field>
              <label className="block" htmlFor="register-display-name">
                <span className="mb-2 block text-sm font-semibold text-slate-700">昵称</span>
                <input
                  id="register-display-name"
                  type="text"
                  autoComplete="name"
                  maxLength={160}
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="可选，默认使用邮箱前缀"
                  className="auth-standalone-input"
                />
              </label>
              <PasswordField
                id="register-password"
                label="设置密码"
                autoComplete="new-password"
                minLength={8}
                value={password}
                onChange={setPassword}
                placeholder="至少 8 位"
              />
              <PasswordField
                id="register-confirm-password"
                label="确认密码"
                autoComplete="new-password"
                minLength={8}
                value={confirmPassword}
                onChange={setConfirmPassword}
                placeholder="再次输入密码"
              />
              <PrimaryButton busy={busy} disabled={!email.trim() || password.length < 8 || !confirmPassword} label="发送注册验证码" />
            </form>
          ) : (
            <form className="space-y-5" onSubmit={register}>
              <label className="block" htmlFor="registration-code">
                <span className="mb-2 block text-sm font-semibold text-slate-700">6 位验证码</span>
                <input
                  id="registration-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  required
                  maxLength={6}
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="000000"
                  className="auth-standalone-input text-center text-lg font-bold tracking-[0.35em]"
                />
              </label>
              {debugCode ? <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">本地调试验证码：{debugCode}</p> : null}
              <PrimaryButton busy={busy} disabled={code.length !== 6} label="验证并创建账号" />
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setRegisterStep("account");
                  setCode("");
                  setDebugCode("");
                  setErrorMessage("");
                }}
                className="focus-ring flex h-10 w-full items-center justify-center gap-2 text-sm font-semibold text-slate-500 hover:text-slate-800 disabled:opacity-50"
              >
                <RotateCcw size={15} />
                返回修改注册信息
              </button>
            </form>
          )}

          {errorMessage ? <p role="alert" className="mt-5 rounded-md border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700">{errorMessage}</p> : null}
          <p className="mt-8 border-t border-slate-200 pt-5 text-xs leading-5 text-slate-400">登录后，当前设备将进入你的独立工作空间。请勿在公共设备上保留登录状态。</p>
        </div>
      </section>
    </main>
  );
}

function Field({ id, label, icon, children, trailing }: { id: string; label: string; icon: React.ReactNode; children: React.ReactNode; trailing?: React.ReactNode }) {
  return (
    <div className="block">
      <label htmlFor={id} className="mb-2 block text-sm font-semibold text-slate-700">{label}</label>
      <div className="flex h-[46px] items-center gap-2.5 rounded-md border border-slate-300 bg-white px-3 transition-[border-color,box-shadow] focus-within:border-[#6236ff] focus-within:ring-2 focus-within:ring-[#6236ff]/15">
        <span aria-hidden="true" className="shrink-0 text-slate-400">{icon}</span>
        {children}
        {trailing}
      </div>
    </div>
  );
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  placeholder,
  autoComplete,
  minLength,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  autoComplete: string;
  minLength?: number;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <Field
      id={id}
      label={label}
      icon={<LockKeyhole size={16} />}
      trailing={(
        <button
          type="button"
          aria-label={visible ? "隐藏密码" : "显示密码"}
          aria-pressed={visible}
          onClick={() => setVisible((current) => !current)}
          className="grid h-8 w-8 shrink-0 place-items-center rounded text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6236ff]/25"
        >
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      )}
    >
      <input
        id={id}
        type={visible ? "text" : "password"}
        autoComplete={autoComplete}
        required
        minLength={minLength}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="auth-field-input"
      />
    </Field>
  );
}

function PrimaryButton({ busy, disabled, label }: { busy: boolean; disabled: boolean; label: string }) {
  return (
    <button
      type="submit"
      disabled={busy || disabled}
      className="focus-ring flex h-11 w-full items-center justify-center gap-2 rounded-md bg-[#6236ff] px-4 text-sm font-bold text-white transition-colors hover:bg-[#5428e8] disabled:cursor-not-allowed disabled:opacity-50"
    >
      {busy ? <LoaderCircle size={17} className="animate-spin" /> : <ArrowRight size={17} />}
      {label}
    </button>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="grid min-h-screen place-items-center bg-white text-sm text-slate-500">正在加载账号入口...</main>}>
      <LoginForm />
    </Suspense>
  );
}
