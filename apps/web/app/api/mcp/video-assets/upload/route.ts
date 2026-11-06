// Production Nginx streams directly to FastAPI. Keep local/standalone Next
// equally usable without cloning large bodies in its external rewrite proxy.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 1800;

export async function POST(request: Request): Promise<Response> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > 502 * 1024 * 1024)) {
    return Response.json({ detail: "VIDEO_FILE_TOO_LARGE" }, { status: 413 });
  }
  const headers = new Headers();
  for (const name of ["authorization", "origin", "content-type", "content-length"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const target = new URL("/api/mcp/video-assets/upload", process.env.FASTAPI_BASE_URL || "http://127.0.0.1:8000");
    const init: RequestInit & { duplex: "half" } = {
      method: "POST", headers, body: request.body, duplex: "half", credentials: "omit", redirect: "manual", cache: "no-store",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(30 * 60 * 1000)])
    };
    const response = await fetch(target, init);
    const outputHeaders = new Headers({ "content-type": response.headers.get("content-type") || "application/json", "cache-control": "no-store" });
    const challenge = response.headers.get("www-authenticate");
    if (challenge) outputHeaders.set("www-authenticate", challenge);
    return new Response(response.body, { status: response.status, headers: outputHeaders });
  } catch {
    return Response.json({ detail: "VIDEO_UPLOAD_PROXY_UNAVAILABLE" }, { status: 502 });
  }
}
