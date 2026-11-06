import type { MediaAccount } from "@zengxing/core";

export function mediaAuthorizationArgs(platform: MediaAccount["platform"], mediaAccountId?: string) {
  return ["--platform", platform, "--wait-login-ms", "300000", ...(mediaAccountId ? ["--media-account-id", mediaAccountId] : [])];
}

export function mediaAccountOptionLabel(account: Pick<MediaAccount, "id" | "name" | "accountName">) {
  return `${account.accountName || account.name} · 账号 ${account.id.slice(-8)}`;
}

export function selectedMediaAccountPayload(mediaAccountId: string) {
  if (!mediaAccountId) throw new Error("请选择已授权账号");
  return { mediaAccountId };
}
