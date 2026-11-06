import { afterEach, describe, expect, it, vi } from "vitest";
import { endAccountSession, loadAccount } from "./account-session";

afterEach(() => vi.unstubAllGlobals());

describe("account session", () => {
  it("distinguishes an expired session from a network/server failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    expect(await loadAccount()).toBeNull();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));
    await expect(loadAccount()).rejects.toThrow("暂时无法获取账号信息");
  });

  it("rejects a malformed success instead of displaying a logged-in account", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ authenticated: true })));
    await expect(loadAccount()).rejects.toThrow();
  });

  it("does not report logout success when desktop work blocks it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ detail: "DESKTOP_WORK_IN_PROGRESS" }, { status: 409 })));
    await expect(endAccountSession("device-a")).rejects.toThrow("待执行或正在执行");
  });

  it("ends the requested desktop session and requires a successful response", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    });
    await endAccountSession("device-a");
    expect(calls[0].url).toBe("/api/auth/logout");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ desktopDeviceId: "device-a" });
    expect(calls[0].init.credentials).toBe("include");
  });
});
