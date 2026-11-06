import { afterEach, expect, it, vi } from "vitest";
import { ensureDesktopOwnerBinding } from "./desktop-owner-binding";
import { runDesktopAgentCommand } from "./desktop-bridge";

vi.mock("./desktop-bridge", () => ({ isDesktopBridgeAvailable: () => true, runDesktopAgentCommand: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("refreshes registration instead of trusting stale local ownership after logout", async () => {
  vi.stubGlobal("fetch", async (url: string) => Response.json(url.endsWith("/me")
    ? { user: { id: "bob" } } : { id: "binding-bob", pairingCode: "123456" }));
  vi.mocked(runDesktopAgentCommand).mockImplementation(async ({ command }) => {
    if (command === "register") return { device: { id: "fresh-device" } };
    if (command === "bind-owner") return { device: { id: "fresh-device", boundOwnerId: "bob" } };
    throw new Error("stale status is not authoritative");
  });
  expect(await ensureDesktopOwnerBinding()).toEqual({ status: "bound", ownerId: "bob", deviceId: "fresh-device" });
});

it("does not reuse an earlier account's successful binding", async () => {
  let owner = "alice";
  vi.stubGlobal("fetch", async () => Response.json({ user: { id: owner } }));
  vi.mocked(runDesktopAgentCommand).mockImplementation(async () => ({ device: { id: `device-${owner}`, boundOwnerId: owner } }));
  expect((await ensureDesktopOwnerBinding()).ownerId).toBe("alice");
  owner = "bob";
  expect((await ensureDesktopOwnerBinding()).ownerId).toBe("bob");
});

it("refuses to take over a device still owned by someone else", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ user: { id: "bob" } }));
  vi.mocked(runDesktopAgentCommand).mockResolvedValue({ device: { id: "device-alice", boundOwnerId: "alice" } });
  await expect(ensureDesktopOwnerBinding()).rejects.toThrow("DESKTOP_DEVICE_ALREADY_BOUND");
});
