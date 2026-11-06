import { isDesktopBridgeAvailable, runDesktopAgentCommand } from "./desktop-bridge";

type CurrentMemberResponse = {
  authenticated: boolean;
  user: {
    id: string;
    email: string;
  };
};

type DesktopStatus = {
  registered: boolean;
  device: {
    id?: string;
    boundOwnerId?: string;
  } | null;
};

type OwnerBinding = {
  id: string;
  pairingCode: string;
};

type OwnerBindingClaim = {
  device?: {
    id?: string;
    boundOwnerId?: string;
  };
};

export type DesktopOwnerBindingResult = {
  status: "unavailable" | "already_bound" | "bound";
  ownerId?: string;
  deviceId?: string;
};

let bindingPromise: Promise<DesktopOwnerBindingResult> | null = null;

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    cache: "no-store",
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof payload?.detail === "string" ? payload.detail : `HTTP_${response.status}`;
    throw new Error(detail);
  }
  return payload as T;
}

async function bindDesktopToCurrentMember(): Promise<DesktopOwnerBindingResult> {
  if (!isDesktopBridgeAvailable()) return { status: "unavailable" };

  const [me, desktopStatus] = await Promise.all([
    jsonRequest<CurrentMemberResponse>("/api/auth/me"),
    runDesktopAgentCommand<DesktopStatus>({ command: "register", timeoutMs: 30000 }),
  ]);
  const ownerId = me.user.id;
  const currentDevice = desktopStatus.device;
  if (currentDevice?.boundOwnerId === ownerId) {
    return { status: "already_bound", ownerId, deviceId: currentDevice.id };
  }
  if (currentDevice?.boundOwnerId && currentDevice.boundOwnerId !== ownerId) {
    throw new Error("DESKTOP_DEVICE_ALREADY_BOUND");
  }

  const binding = await jsonRequest<OwnerBinding>("/api/desktop-owner-bindings", {
    method: "POST",
    body: JSON.stringify({}),
  });
  const claimed = await runDesktopAgentCommand<OwnerBindingClaim>({
    command: "bind-owner",
    args: [
      "--binding-id",
      binding.id,
      "--pairing-code",
      binding.pairingCode,
    ],
    timeoutMs: 30000,
  });
  if (claimed.device?.boundOwnerId !== ownerId) {
    throw new Error("DESKTOP_OWNER_BINDING_NOT_CONFIRMED");
  }
  return {
    status: "bound",
    ownerId,
    deviceId: claimed.device.id,
  };
}

export function ensureDesktopOwnerBinding(): Promise<DesktopOwnerBindingResult> {
  if (!bindingPromise) {
    bindingPromise = bindDesktopToCurrentMember().finally(() => {
      bindingPromise = null;
    });
  }
  return bindingPromise;
}
