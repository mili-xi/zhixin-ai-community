const REDACTED = "REDACTED";

const SENSITIVE_KEY_PATTERN = /(cookie|token|secret|password|credential|authorization|csrf|xsrf|session|signature|a_bogus|msToken|access[_-]?key|access[_-]?id|ursToken|timestamp|sign)/i;

function sensitiveKey(key) {
  const normalized = String(key || "").replace(/[^a-zA-Z0-9_]/g, "");
  return SENSITIVE_KEY_PATTERN.test(normalized);
}

function sanitizeUrl(value = "") {
  const raw = String(value || "");
  try {
    const parsed = new URL(raw);
    for (const key of [...parsed.searchParams.keys()]) {
      if (sensitiveKey(key)) parsed.searchParams.set(key, REDACTED);
    }
    return parsed.toString();
  } catch {
    return raw;
  }
}

export function sanitizeApiEvidence(value, depth = 0) {
  if (depth > 8) return "[MaxDepth]";
  if (Array.isArray(value)) return value.slice(0, 80).map((item) => sanitizeApiEvidence(item, depth + 1));
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      if (sensitiveKey(key)) {
        result[key] = REDACTED;
      } else if (/url$/i.test(key) || key === "url") {
        result[key] = sanitizeUrl(entry);
      } else {
        result[key] = sanitizeApiEvidence(entry, depth + 1);
      }
    }
    return result;
  }
  if (typeof value === "string") return value.length > 12000 ? `${value.slice(0, 12000)}...` : value;
  if (value === undefined) return "";
  return value;
}

function normalizedHeaders(headers = {}) {
  if (!headers || typeof headers !== "object") return {};
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [String(key), String(value)]));
}

function buildFetchOptions(options = {}) {
  const method = String(options.method || (options.json || options.form || options.data || options.multipart ? "POST" : "GET")).toUpperCase();
  const headers = normalizedHeaders(options.headers);
  const fetchOptions = { ...options, method, headers };
  delete fetchOptions.json;
  delete fetchOptions.form;

  if (options.json !== undefined) {
    fetchOptions.data = JSON.stringify(options.json);
    fetchOptions.headers = {
      "content-type": "application/json",
      ...headers,
    };
  } else if (options.form !== undefined) {
    fetchOptions.data = new URLSearchParams(options.form).toString();
    fetchOptions.headers = {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      ...headers,
    };
  }
  return fetchOptions;
}

function parsePayload(text = "") {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function hasHeader(headers = {}, name = "") {
  const normalized = String(name || "").toLowerCase();
  return Object.keys(headers || {}).some((key) => key.toLowerCase() === normalized);
}

function cookieHeaderFromCookies(cookies = []) {
  return (Array.isArray(cookies) ? cookies : [])
    .filter((cookie) => cookie?.name && typeof cookie.value === "string")
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

async function browserContextCookieHeader(page, url) {
  const context = typeof page?.context === "function" ? page.context() : null;
  if (typeof context?.cookies !== "function") return "";
  let origin = "";
  try {
    origin = new URL(String(url || "")).origin;
  } catch {
    origin = String(url || "");
  }
  const cookies = await context.cookies(origin ? [origin] : undefined).catch(() => []);
  return cookieHeaderFromCookies(cookies);
}

function nodeFetchBody(data) {
  if (data === undefined || data === null) return undefined;
  if (typeof data === "string") return data;
  if (typeof URLSearchParams !== "undefined" && data instanceof URLSearchParams) return data;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data;
  if (typeof ArrayBuffer !== "undefined" && data instanceof ArrayBuffer) return data;
  return JSON.stringify(data);
}

async function withPlatformApiTimeout(promise, timeoutMs = 30000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("PLATFORM_API_PAGE_UNRESPONSIVE")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function platformApiFetch(page, url, options = {}) {
  const fetchOptions = buildFetchOptions(options);
  let response;
  if (page?.request?.fetch) {
    response = await withPlatformApiTimeout(page.request.fetch(url, fetchOptions));
  } else {
    if (typeof globalThis.fetch !== "function") throw new Error("PLATFORM_API_REQUEST_CONTEXT_REQUIRED");
    const headers = { ...(fetchOptions.headers || {}) };
    if (!hasHeader(headers, "cookie")) {
      const cookieHeader = await withPlatformApiTimeout(browserContextCookieHeader(page, url));
      if (cookieHeader) headers.Cookie = cookieHeader;
    }
    fetchOptions.headers = headers;
    response = await globalThis.fetch(url, {
      method: fetchOptions.method,
      headers,
      body: nodeFetchBody(fetchOptions.data),
      redirect: "follow",
    });
  }
  const status = typeof response.status === "function" ? response.status() : Number(response.status || 0);
  const responseUrl = typeof response.url === "function" ? response.url() : String(url || "");
  const text = typeof response.text === "function" ? await response.text() : "";
  const payload = parsePayload(text);
  const requestEvidence = {
    method: fetchOptions.method,
    url,
    headers: fetchOptions.headers || {},
    data: fetchOptions.data || fetchOptions.form ? REDACTED : "",
  };
  const evidence = sanitizeApiEvidence({
    request: requestEvidence,
    response: {
      status,
      url: responseUrl,
      payload,
    },
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    url: responseUrl,
    payload,
    text,
    evidence,
  };
}
