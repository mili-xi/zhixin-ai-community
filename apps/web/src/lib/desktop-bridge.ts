export type DesktopAgentCommandOptions = {
  command: string;
  args?: string[];
  detached?: boolean;
  timeoutMs?: number;
};

type DesktopAgentBridgeResult = {
  type: "zhixin:agent-command-result";
  requestId: string;
  result: unknown;
};

type DesktopAgentBridgeError = {
  type: "zhixin:agent-command-error";
  requestId: string;
  error: string;
};

type DesktopAgentBridgeResponse = DesktopAgentBridgeResult | DesktopAgentBridgeError;
const desktopBridgeSessionKey = "zhixin:desktop-bridge";

function isBridgeResponse(value: unknown): value is DesktopAgentBridgeResponse {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return (
    (data.type === "zhixin:agent-command-result" || data.type === "zhixin:agent-command-error")
    && typeof data.requestId === "string"
  );
}

export function isDesktopBridgeAvailable() {
  if (typeof window === "undefined") return false;
  const isEmbedded = window.parent !== window;
  const hasDesktopQuery = new URLSearchParams(window.location.search).get("desktop") === "1";
  if (hasDesktopQuery) {
    try {
      window.sessionStorage.setItem(desktopBridgeSessionKey, "1");
    } catch {
      // Ignore restricted storage contexts; the current query still proves desktop mode.
    }
  }
  let rememberedDesktopMode = false;
  try {
    rememberedDesktopMode = window.sessionStorage.getItem(desktopBridgeSessionKey) === "1";
  } catch {
    rememberedDesktopMode = false;
  }
  return isEmbedded && (hasDesktopQuery || rememberedDesktopMode);
}

export function runDesktopAgentCommand<T = unknown>({
  command,
  args = [],
  detached = false,
  timeoutMs = 360000
}: DesktopAgentCommandOptions): Promise<T> {
  if (!isDesktopBridgeAvailable()) {
    return Promise.reject(new Error("DESKTOP_BRIDGE_UNAVAILABLE"));
  }
  const requestId = `desktop-agent-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("DESKTOP_BRIDGE_TIMEOUT"));
    }, timeoutMs);

    function onMessage(event: MessageEvent) {
      if (event.source !== window.parent || !isBridgeResponse(event.data)) return;
      if (event.data.requestId !== requestId) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      if (event.data.type === "zhixin:agent-command-error") {
        reject(new Error(event.data.error || "DESKTOP_AGENT_COMMAND_FAILED"));
        return;
      }
      resolve(event.data.result as T);
    }

    window.addEventListener("message", onMessage);
    window.parent.postMessage({
      type: "zhixin:agent-command",
      requestId,
      command,
      args,
      detached
    }, "*");
  });
}
