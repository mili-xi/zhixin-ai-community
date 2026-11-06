export type AccountUser = { id: string; email: string; displayName: string; role: string };
export const accountSessionEventKey = "zhixin.account-session.changed";

export async function loadAccount(): Promise<AccountUser | null> {
  const response = await fetch("/api/auth/me", {
    credentials: "include", cache: "no-store", signal: AbortSignal.timeout(15000),
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error("暂时无法获取账号信息，请重试。");
  const data = await response.json();
  if (data.authenticated !== true || !data.user?.id || !data.user?.email) {
    throw new Error("账号信息不完整，请重新验证登录状态。");
  }
  return data.user;
}

export async function endAccountSession(desktopDeviceId = "") {
  const response = await fetch("/api/auth/logout", {
    method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ desktopDeviceId }), signal: AbortSignal.timeout(15000),
  }).catch(() => { throw new Error("退出未完成，请检查网络后重试。"); });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    if (data.detail === "DESKTOP_WORK_IN_PROGRESS") {
      throw new Error("桌面端还有待执行或正在执行的任务，请完成或取消任务后重试。");
    }
    if (data.detail === "DESKTOP_AUTH_IN_PROGRESS") {
      throw new Error("媒体账号授权尚未结束，请完成授权后重试；若已关闭授权窗口，请等待本次授权过期后重试（授权有效期为 15 分钟）。");
    }
    if (response.status === 401) throw new Error("登录已失效，请刷新页面重新登录。");
    if (response.status === 403) throw new Error("当前桌面设备属于其他账号，无法退出该设备。");
    throw new Error("退出未完成，请检查网络后重试。");
  }
}

export function clearAccountState() {
  try {
    window.localStorage.removeItem("zhixin-ai.active-creation-task-id");
    window.localStorage.setItem(accountSessionEventKey, `${Date.now()}-${Math.random()}`);
  } catch {
    // Cookie revocation and full navigation remain effective if storage is restricted.
  }
}

export function accountLoginUrl(reason: "switch" | "signed-out" | "expired", desktop: boolean) {
  const query = new URLSearchParams({ reason, next: desktop ? "/dashboard?desktop=1" : "/dashboard" });
  if (desktop) query.set("desktop", "1");
  return `/login?${query}`;
}
