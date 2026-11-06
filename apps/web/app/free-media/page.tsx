"use client";

import { mediaAuthorizationArgs } from "@/lib/media-account-actions";
import { AppShell } from "@/components/app-shell";
import { useDesktopRequirement } from "@/components/desktop-requirement-provider";
import { StatusBadge } from "@/components/status-badge";
import { EmptyState, LoadingState, MetricCard, PageHeader, Section, SecondaryButton } from "@/components/ui";
import { runDesktopAgentCommand } from "@/lib/desktop-bridge";
import type { MediaAccount } from "@zengxing/core";
import { CheckSquare, KeyRound, RefreshCcw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatAppTimestamp as formatDateTime } from "@/lib/app-time";

type Platform = MediaAccount["platform"];
type StatusFilter = MediaAccount["status"] | "all";

type DesktopCommand = {
  id: string;
  deviceId?: string;
  type: string;
  mediaAccountId?: string;
  status: string;
  payload?: Record<string, unknown>;
  result?: Record<string, unknown>;
  errorMessage?: string;
};

type ValidationQueueResult = {
  queued: boolean;
  deduplicated: boolean;
  desktopCommand: DesktopCommand;
};

const platformLabel: Record<Platform, string> = {
  baijiahao: "百家号",
  wechat: "微信公众号",
  zhihu: "知乎",
  sohu: "搜狐号",
  csdn: "CSDN",
  netease: "网易号",
  penguin: "企鹅号",
  toutiao: "头条号",
  jianshu: "简书",
  douyin: "抖音",
  other: "其他平台"
};

const desktopAuthorizablePlatforms: Platform[] = ["zhihu", "baijiahao", "sohu", "csdn", "netease", "penguin", "toutiao", "jianshu", "douyin"];
const terminalCommandStatuses = new Set(["succeeded", "failed", "canceled"]);

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

function toggleSetValue<T>(set: Set<T>, value: T) {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function platformName(platform: Platform) {
  return platformLabel[platform] ?? platformLabel.other;
}

function shortFingerprint(value?: string) {
  return value ? value.slice(0, 18) : "未绑定";
}

function credentialHealth(account: MediaAccount) {
  if (account.status === "needs_reauth") return "needs_reauth";
  if (account.status === "error") return "error";
  if (account.status === "disabled") return "disabled";
  if (account.credentialStatus) return account.credentialStatus;
  if (account.authArtifactId) return "stale";
  return "pending";
}

export default function FreeMediaPage() {
  const { isDesktop, requireDesktop } = useDesktopRequirement();
  const [accounts, setAccounts] = useState<MediaAccount[]>([]);
  const [validationCommands, setValidationCommands] = useState<Record<string, DesktopCommand>>({});
  const [message, setMessage] = useState("媒体账号会在 Web 与桌面端之间自动同步。");
  const [busy, setBusy] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [platformFilter, setPlatformFilter] = useState<Platform | "all">("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");

  async function refreshAccounts() {
    const nextAccounts = await jsonFetch<MediaAccount[]>("/api/media-accounts");
    setAccounts(nextAccounts);
    setActiveId((current) => {
      if (current && nextAccounts.some((account) => account.id === current)) return current;
      return nextAccounts[0]?.id ?? null;
    });
  }

  async function refreshAll() {
    await refreshAccounts();
  }

  useEffect(() => {
    refreshAll().catch((error) => setMessage(error instanceof Error ? error.message : String(error)));
  }, []);

  const pendingValidationCommands = useMemo(
    () => Object.entries(validationCommands).filter(([, command]) => !terminalCommandStatuses.has(command.status)),
    [validationCommands]
  );

  useEffect(() => {
    if (!pendingValidationCommands.length) return;
    let canceled = false;
    const poll = async () => {
      try {
        const updates = await Promise.all(pendingValidationCommands.map(async ([accountId, command]) => [
          accountId,
          await jsonFetch<DesktopCommand>(`/api/desktop-commands/${command.id}`)
        ] as const));
        if (canceled) return;
        setValidationCommands((current) => ({ ...current, ...Object.fromEntries(updates) }));
        if (updates.some(([, command]) => terminalCommandStatuses.has(command.status))) {
          await refreshAccounts();
          const failed = updates.filter(([, command]) => command.status === "failed").length;
          setMessage(failed ? `登录态检测完成，${failed} 个账号需要处理。` : "登录态检测完成，账号状态已同步。");
        }
      } catch (error) {
        if (!canceled) setMessage(error instanceof Error ? error.message : String(error));
      }
    };
    const timer = window.setInterval(poll, 2000);
    return () => {
      canceled = true;
      window.clearInterval(timer);
    };
  }, [pendingValidationCommands]);

  const filteredAccounts = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return accounts.filter((account) => {
      const platformOk = platformFilter === "all" || account.platform === platformFilter;
      const statusOk = statusFilter === "all" || account.status === statusFilter;
      const haystack = `${account.name} ${account.accountName ?? ""} ${account.lastError ?? ""} ${platformName(account.platform)}`.toLowerCase();
      return platformOk && statusOk && (!keyword || haystack.includes(keyword));
    });
  }, [accounts, platformFilter, query, statusFilter]);

  const activeAccount = accounts.find((account) => account.id === activeId) ?? filteredAccounts[0] ?? null;
  const healthyCount = accounts.filter((account) => credentialHealth(account) === "active").length;
  const staleCount = accounts.filter((account) => credentialHealth(account) === "stale").length;
  const reauthCount = accounts.filter((account) => ["needs_reauth", "error", "expired", "invalid", "revoked"].includes(credentialHealth(account))).length;
  const allVisibleSelected = filteredAccounts.length > 0 && filteredAccounts.every((account) => selectedIds.has(account.id));

  async function queueSessionValidation(accountId: string) {
    const result = await jsonFetch<ValidationQueueResult>(`/api/media-accounts/${accountId}/validate-session`, { method: "POST" });
    setValidationCommands((current) => ({ ...current, [accountId]: result.desktopCommand }));
    return result;
  }

  async function validateAccounts(accountIds: string[]) {
    if (!accountIds.length) return;
    if (!requireDesktop("登录态检测")) return;
    setBusy(true);
    try {
      const results: ValidationQueueResult[] = [];
      for (const accountId of accountIds) results.push(await queueSessionValidation(accountId));
      const deduplicated = results.filter((result) => result.deduplicated).length;
      setMessage(`已下发 ${results.length} 个登录态检测命令${deduplicated ? `，其中 ${deduplicated} 个沿用运行中的命令` : ""}。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function validateSelectedAccounts() {
    const ids = selectedIds.size ? Array.from(selectedIds) : activeAccount ? [activeAccount.id] : [];
    await validateAccounts(ids);
  }

  async function authorizePlatform(platform: Platform, mediaAccountId?: string) {
    if (!requireDesktop("媒体账号授权")) return;
    setBusy(true);
    try {
      setMessage(`正在打开${platformName(platform)}登录环境：登录成功拿到登录态后会自动关闭浏览器。`);
      await runDesktopAgentCommand({
        command: "authorize",
        args: mediaAuthorizationArgs(platform, mediaAccountId),
        timeoutMs: 360000
      });
      await refreshAll();
      setMessage(`${platformName(platform)}授权流程已完成，媒体账号已同步到 Web 和桌面端。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function removeAccount(accountId: string) {
    setBusy(true);
    try {
      await jsonFetch(`/api/media-accounts/${accountId}`, { method: "DELETE" });
      await refreshAccounts();
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(accountId);
        return next;
      });
      setMessage("媒体账号已删除。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const activeValidationCommand = activeAccount ? validationCommands[activeAccount.id] : undefined;

  return (
    <AppShell>
      <PageHeader
        eyebrow="Free Media"
        title="媒体账号"
        description="管理平台授权、检查登录状态，让每一次发布顺利完成。"
        action={<SecondaryButton disabled={busy} onClick={refreshAll}><RefreshCcw size={16} />刷新同步</SecondaryButton>}
      />

      <div className="space-y-5 p-4 sm:p-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <MetricCard label="账号总数" value={accounts.length} hint="已绑定的免费媒体账号" />
          <MetricCard label="登录态正常" value={healthyCount} hint="可执行自动发布" />
          <MetricCard label="待复验" value={staleCount} hint="等待桌面端再次确认" />
          <MetricCard label="需重新授权" value={reauthCount} hint="登录失效或凭据异常" />
        </div>

        <Section
          title="桌面一键授权"
          description={isDesktop ? "抖音支持添加多个独立账号；已有账号请在下方选择重新授权。" : "浏览器中可查看账号；授权时会提示下载并打开智心AI桌面端。"}
        >
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {desktopAuthorizablePlatforms.map((platform) => (
              <button
                key={platform}
                className="flex min-h-16 items-center justify-between rounded-lg border border-line bg-white px-4 py-3 text-left text-[13px] transition-colors hover:border-brand/30 hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={busy}
                onClick={() => authorizePlatform(platform)}
              >
                <span>
                  <span className="block font-semibold text-ink">{platform === "douyin" ? "添加抖音账号" : platformName(platform)}</span>
                  <span className="mt-1 block text-xs text-muted">{isDesktop ? "一键打开登录环境" : "需要桌面端"}</span>
                </span>
                <KeyRound size={17} className="text-brand" />
              </button>
            ))}
          </div>
        </Section>

        <div className="grid gap-5 2xl:grid-cols-[minmax(0,1fr)_360px]">
          <Section
            title="媒体账号"
            description="按账号管理登录态、检测计划和桌面发布能力。"
            action={<SecondaryButton disabled={busy || (!selectedIds.size && !activeAccount)} onClick={validateSelectedAccounts}><RefreshCcw size={15} />检测登录态</SecondaryButton>}
          >
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <input aria-label="搜索媒体账号" className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-white px-3 text-sm outline-none" placeholder="搜索账号、平台或异常原因" value={query} onChange={(event) => setQuery(event.target.value)} />
              <select aria-label="账号平台" className="h-9 rounded-md border border-line bg-white px-3 text-sm" value={platformFilter} onChange={(event) => setPlatformFilter(event.target.value as Platform | "all")}>
                <option value="all">全部平台</option>
                {Object.entries(platformLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <select aria-label="账号状态" className="h-9 rounded-md border border-line bg-white px-3 text-sm" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
                <option value="all">全部状态</option>
                <option value="active">正常</option>
                <option value="pending">待处理</option>
                <option value="needs_reauth">需重新授权</option>
                <option value="error">异常</option>
                <option value="disabled">已停用</option>
              </select>
              <SecondaryButton disabled={selectedIds.size === 0} onClick={() => setSelectedIds(new Set())}><X size={15} />清空选择</SecondaryButton>
            </div>

            {selectedIds.size ? (
              <div className="mb-4 flex items-center gap-2 rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-blue-800">
                <CheckSquare size={15} />已选择 {selectedIds.size} 个账号
              </div>
            ) : null}

            <div className="overflow-x-auto rounded-md border border-line">
              <table className="w-full min-w-[720px] text-left text-[13px]">
                <thead className="bg-slate-50 text-xs text-muted">
                  <tr>
                    <th className="w-12 px-3 py-3"><input aria-label="选择全部媒体账号" type="checkbox" checked={allVisibleSelected} onChange={(event) => setSelectedIds((current) => {
                      const next = new Set(current);
                      filteredAccounts.forEach((account) => event.target.checked ? next.add(account.id) : next.delete(account.id));
                      return next;
                    })} /></th>
                    <th className="px-3 py-3">平台 / 账号</th>
                    <th className="px-3 py-3">账号状态</th>
                    <th className="px-3 py-3">登录态</th>
                    <th className="px-3 py-3">上次验证</th>
                    <th className="px-3 py-3">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAccounts.map((account) => {
                    const command = validationCommands[account.id];
                    const checking = Boolean(command && !terminalCommandStatuses.has(command.status));
                    return (
                      <tr key={account.id} className={`border-t border-line ${activeAccount?.id === account.id ? "bg-violet-50/60" : "bg-white hover:bg-slate-50"}`}>
                        <td className="px-3 py-3"><input aria-label={`选择账号 ${account.name}`} type="checkbox" checked={selectedIds.has(account.id)} onChange={() => setSelectedIds((current) => toggleSetValue(current, account.id))} /></td>
                        <td className="px-3 py-3">
                          <button className="text-left" onClick={() => setActiveId(account.id)}>
                            <p className="font-semibold text-ink">{account.name}</p>
                            <p className="mt-1 text-xs text-muted">{platformName(account.platform)}{account.accountName ? ` · ${account.accountName}` : ""}{account.platform === "douyin" ? ` · 账号 ${account.id.slice(-8)}` : ""}</p>
                          </button>
                        </td>
                        <td className="px-3 py-3"><StatusBadge status={account.status} /></td>
                        <td className="px-3 py-3"><StatusBadge status={checking ? "checking" : credentialHealth(account)} /></td>
                        <td className="px-3 py-3 text-xs text-muted">{formatDateTime(account.lastVerifiedAt || account.lastCheckedAt)}</td>
                        <td className="px-3 py-3">
                          <div className="flex gap-2">
                            <SecondaryButton disabled={busy || checking} onClick={() => validateAccounts([account.id])}><RefreshCcw size={15} />检测</SecondaryButton>
                            {account.platform === "douyin" ? <SecondaryButton disabled={busy} onClick={() => authorizePlatform(account.platform, account.id)}><KeyRound size={15} />重新授权</SecondaryButton> : null}
                            <SecondaryButton disabled={busy} onClick={() => removeAccount(account.id)}><Trash2 size={15} />删除</SecondaryButton>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {filteredAccounts.length === 0 ? <EmptyState title="没有符合条件的媒体账号" description="在桌面端完成一键授权后，账号会自动同步到这里。" /> : null}
            </div>
          </Section>

          <aside className="space-y-6">
            <Section title="账号详情">
              {activeAccount ? (
                <div className="space-y-4 text-sm">
                  <div>
                    <p className="font-semibold text-ink">{activeAccount.name}</p>
                    <p className="mt-1 text-xs text-muted">{platformName(activeAccount.platform)} · {activeAccount.accountName || "未识别昵称"}</p>
                  </div>
                  <dl className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-3">
                    <dt className="text-muted">登录态</dt><dd><StatusBadge status={credentialHealth(activeAccount)} /></dd>
                    <dt className="text-muted">上次验证</dt><dd className="text-ink">{formatDateTime(activeAccount.lastVerifiedAt || activeAccount.lastCheckedAt)}</dd>
                    <dt className="text-muted">下次检测</dt><dd className="text-ink">{formatDateTime(activeAccount.nextCredentialCheckAt)}</dd>
                    <dt className="text-muted">授权到期</dt><dd className="text-ink">{formatDateTime(activeAccount.credentialExpiresAt)}</dd>
                    <dt className="text-muted">连续失败</dt><dd className="text-ink">{activeAccount.consecutiveAuthFailures ?? 0} 次</dd>
                  </dl>
                  <details className="rounded-lg border border-line px-3 py-2 text-xs text-muted">
                    <summary className="cursor-pointer py-1">诊断信息</summary>
                    <dl className="mt-3 grid gap-2 break-all"><dt>凭据指纹</dt><dd className="font-mono">{shortFingerprint(activeAccount.credentialFingerprint)}</dd><dt>Profile Key</dt><dd className="font-mono">{activeAccount.profileKey || "-"}</dd></dl>
                  </details>
                  {activeAccount.lastError ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700">{activeAccount.lastError}</div> : null}
                  {activeValidationCommand ? (
                    <div className="rounded-md border border-line bg-slate-50 px-3 py-2 text-xs">
                      <div className="flex items-center justify-between gap-3"><span className="font-mono text-muted">{activeValidationCommand.id}</span><StatusBadge status={activeValidationCommand.status} /></div>
                      {activeValidationCommand.errorMessage ? <p className="mt-2 text-red-700">{activeValidationCommand.errorMessage}</p> : null}
                    </div>
                  ) : null}
                </div>
              ) : <p className="text-sm text-muted">请选择一个媒体账号。</p>}
            </Section>

          </aside>
        </div>

        {busy ? <LoadingState label="正在处理媒体账号" /> : <p className="text-sm leading-6 text-muted">{message}</p>}
      </div>
    </AppShell>
  );
}
