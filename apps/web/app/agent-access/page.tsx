"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { PageHeader, PrimaryButton, SecondaryButton } from "@/components/ui";
import { AppShell } from "@/components/app-shell";

type AgentToken = { id: string; name: string; scopes: string[]; createdAt: string; expiresAt: string; revokedAt: string };
type IssuedToken = AgentToken & { token: string };

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, cache: "no-store", headers: { "Content-Type": "application/json", ...init.headers } });
  if (!response.ok) {
    if (response.status === 401) throw new Error("请先登录智心AI，再管理接入凭据。");
    const body = await response.json().catch(() => null);
    throw new Error(typeof body?.detail === "string" ? body.detail : `请求失败（${response.status}）`);
  }
  return response.status === 204 ? undefined as T : response.json();
}

export default function AgentAccessPage() {
  const [tokens, setTokens] = useState<AgentToken[]>([]);
  const [name, setName] = useState("");
  const [days, setDays] = useState("30");
  const [canPublish, setCanPublish] = useState(false);
  const [canPublishArticles, setCanPublishArticles] = useState(false);
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [client, setClient] = useState<"codex" | "claude">("codex");
  const [endpoint, setEndpoint] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const actionLock = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setEndpoint(`${window.location.origin}/mcp`);
    api<AgentToken[]>("/api/mcp/tokens", { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setTokens(result); })
      .catch((error: Error) => { if (!controller.signal.aborted) setMessage(error.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (actionLock.current) return;
    actionLock.current = true; setBusy(true); setMessage("");
    try {
      const scopes = ["publish:read", ...(canPublish ? ["publish:write"] : []), ...(canPublishArticles ? ["article:write"] : [])];
      const result = await api<IssuedToken>("/api/mcp/tokens", { method: "POST", body: JSON.stringify({ name: name.trim(), expiresInDays: Number(days), scopes }) });
      setIssued(result); setName("");
      const { token: _secret, ...metadata } = result;
      setTokens((current) => [metadata, ...current]);
      setMessage("凭据已创建。请保存下方凭据，关闭后无法再次查看。");
    } catch (error) { setMessage((error as Error).message); }
    finally { actionLock.current = false; setBusy(false); }
  }

  async function revoke(token: AgentToken) {
    if (actionLock.current) return;
    actionLock.current = true; setBusy(true); setMessage("");
    try {
      await api<void>(`/api/mcp/tokens/${encodeURIComponent(token.id)}`, { method: "DELETE" });
      setTokens((current) => current.map((item) => item.id === token.id ? { ...item, revokedAt: new Date().toISOString() } : item));
      if (issued?.id === token.id) setIssued(null);
      setMessage("凭据已撤销。使用它的 Agent 无法继续接入，已入队任务继续执行。");
    } catch (error) { setMessage((error as Error).message); }
    finally { actionLock.current = false; setBusy(false); }
  }

  async function copy(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); setMessage(`${label}已复制。`); }
    catch { setMessage("无法自动复制，请手动选择文本复制。"); }
  }

  const config = client === "codex"
    ? `[mcp_servers.zhixin-ai]\nurl = "${endpoint}"\nbearer_token_env_var = "ZHIXIN_MCP_TOKEN"`
    : JSON.stringify({ mcpServers: { "zhixin-ai": { type: "http", url: endpoint, headers: { Authorization: "Bearer ${ZHIXIN_MCP_TOKEN}" } } } }, null, 2);
  const inputClass = "mt-2 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand/30";

  return <AppShell>
    <PageHeader eyebrow="Automation access" title="自动化接入" description="让 Claude Code、Codex 等 Agent 通过远程 MCP 发布成品文章和抖音视频。账号登录与发布由你绑定的桌面端执行。" />
    <div data-agent-access className="mx-auto grid w-full min-w-0 max-w-6xl grid-cols-1 gap-6 p-5 lg:grid-cols-2 lg:p-7">
      <section className="min-w-0 rounded-xl border border-line bg-panel p-6">
        <h2 className="text-base font-bold">创建接入凭据</h2>
        <p className="mt-2 text-sm leading-6 text-muted">每个 Agent 使用独立凭据，仅能访问你自己的账号、素材和发布任务。</p>
        <form onSubmit={create} className="mt-5 space-y-4">
          <label className="block text-sm font-medium">凭据名称<input className={inputClass} maxLength={80} required placeholder="例如：我的 Codex" value={name} onChange={(e) => setName(e.target.value)} disabled={busy || !!issued} /></label>
          <label className="block text-sm font-medium">有效期<select className={inputClass} value={days} onChange={(e) => setDays(e.target.value)} disabled={busy || !!issued}><option value="7">7 天</option><option value="30">30 天</option><option value="90">90 天</option><option value="365">365 天</option></select></label>
          <label className="flex items-start gap-3 text-sm leading-6"><input type="checkbox" checked={canPublish} onChange={(e) => setCanPublish(e.target.checked)} disabled={busy || !!issued} className="mt-1" /><span>允许上传和发布视频<span className="block text-xs text-muted">开启后 Agent 可上传视频并创建真实抖音发布任务。</span></span></label>
          <label className="flex items-start gap-3 text-sm leading-6"><input type="checkbox" checked={canPublishArticles} onChange={(e) => setCanPublishArticles(e.target.checked)} disabled={busy || !!issued} className="mt-1" /><span>允许上传和发布文章<span className="block text-xs text-muted">可导入成品图文并向已授权媒体账号发布。旧视频凭据不会自动获得此权限。</span></span></label>
          <PrimaryButton type="submit" disabled={busy || !!issued || !name.trim()}>{busy ? "处理中…" : "创建凭据"}</PrimaryButton>
        </form>
        {issued && <div className="mt-5 rounded-lg border border-brand/30 bg-brand/5 p-4">
          <h3 className="text-sm font-bold">仅本次展示，请立即保存</h3>
          <p className="mt-2 text-xs leading-5 text-muted">将它设置为客户端运行环境中的 ZHIXIN_MCP_TOKEN。下方连接配置通过环境变量引用凭据。</p>
          <textarea aria-label="新建接入凭据" readOnly value={issued.token} className="mt-3 w-full resize-none rounded border border-line bg-white p-3 font-mono text-xs" rows={3} autoComplete="off" spellCheck={false} />
          <div className="mt-3 flex flex-wrap gap-2"><SecondaryButton onClick={() => copy(issued.token, "凭据")}>复制凭据</SecondaryButton><SecondaryButton onClick={() => setIssued(null)}>我已保存，关闭展示</SecondaryButton></div>
        </div>}
      </section>
      <section className="min-w-0 rounded-xl border border-line bg-panel p-6">
        <h2 className="text-base font-bold">连接你的 Agent</h2>
        <p className="mt-2 break-all font-mono text-xs text-muted">{endpoint || "正在读取服务地址…"}</p>
        <div className="mt-5 flex gap-2" role="group" aria-label="客户端配置">
          <button className={`rounded-lg px-4 py-2 text-sm ${client === "codex" ? "bg-brand text-white" : "bg-canvas text-muted"}`} onClick={() => setClient("codex")} aria-pressed={client === "codex"}>Codex</button>
          <button className={`rounded-lg px-4 py-2 text-sm ${client === "claude" ? "bg-brand text-white" : "bg-canvas text-muted"}`} onClick={() => setClient("claude")} aria-pressed={client === "claude"}>Claude Code</button>
        </div>
        <p className="mt-4 text-sm leading-6 text-muted">{client === "codex" ? "将配置合并到 Codex 的 config.toml。" : "将配置合并到 Claude Code 的 .mcp.json。"}先设置环境变量 ZHIXIN_MCP_TOKEN，再重新打开客户端。</p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-950 p-4 text-xs leading-6 text-slate-100" aria-label="MCP 连接配置">{config}</pre>
        <div className="mt-3"><SecondaryButton onClick={() => copy(config, "连接配置")} disabled={!endpoint}>复制连接配置</SecondaryButton></div>
        <ol className="mt-5 list-decimal space-y-2 pl-5 text-sm leading-6 text-muted"><li>在媒体账号页完成平台授权，并保持绑定桌面端在线；抖音需要支持视频发布的桌面版本。</li><li>接入后先查询发布能力，再上传图片或视频；成品文章通过 import_article 导入。</li><li>确认内容后创建发布任务，用任务 ID 查询审核状态和公开结果。</li></ol>
        <p className="mt-4 text-xs leading-5 text-muted">文章支持知乎、百家号、搜狐号、CSDN、网易号、企鹅号、头条号、简书；微信公众号尚未接入。</p>
        <p className="mt-3 text-xs leading-5 text-muted">文章图片沿用素材库公开链接，视频使用私有存储；请勿将保密图片上传到文章素材库。审核中尚未公开；提交结果不明时应先核查，避免重复发布。</p>
      </section>
      <section className="min-w-0 rounded-xl border border-line bg-panel p-6 lg:col-span-2">
        <h2 className="text-base font-bold">我的接入凭据</h2>
        <p role="status" className="mt-3 text-sm leading-6 text-brand">{message}</p>
        {loading ? <p className="mt-4 text-sm text-muted">正在加载…</p> : tokens.length === 0 ? <p className="mt-4 text-sm text-muted">尚未创建接入凭据。</p> : <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-b border-line text-xs text-muted"><tr><th className="pb-3">名称</th><th>权限</th><th>到期时间</th><th>状态</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{tokens.map((token) => {
          const expired = Date.parse(token.expiresAt) <= Date.now();
          const permissions = ["查询", ...(token.scopes.includes("publish:write") ? ["视频发布"] : []), ...(token.scopes.includes("article:write") ? ["文章发布"] : [])].join("、");
          return <tr key={token.id} className="border-b border-line/60"><td className="py-4 pr-4 font-medium">{token.name}</td><td className="pr-4 whitespace-nowrap">{permissions}</td><td className="pr-4 whitespace-nowrap">{new Date(token.expiresAt).toLocaleString("zh-CN")}</td><td className="pr-4 whitespace-nowrap">{token.revokedAt ? "已撤销" : expired ? "已过期" : "有效"}</td><td>{!token.revokedAt && !expired && <SecondaryButton disabled={busy} onClick={() => revoke(token)}>撤销 {token.name}</SecondaryButton>}</td></tr>;
        })}</tbody></table></div>}
      </section>
    </div>
  </AppShell>;
}
