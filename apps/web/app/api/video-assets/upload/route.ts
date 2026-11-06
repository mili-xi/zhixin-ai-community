// A dedicated stream proxy avoids Next's external-rewrite body cloning and
// 30-second proxy timeout. FastAPI remains responsible for authentication,
// multipart limits, media validation and private asset persistence.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 1800;

export async function POST(request: Request): Promise<Response> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > 502 * 1024 * 1024)) {
    return Response.json({ detail: "VIDEO_FILE_TOO_LARGE" }, { status: 413 });
  }
  const headers = new Headers();
  for (const name of ["content-type", "content-length", "cookie", "x-device-id", "x-device-token"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const target = new URL("/api/video-assets/upload", process.env.FASTAPI_BASE_URL || "http://127.0.0.1:8000");
    // Forward the explicit cookie above, but disable Undici automatic HTTP
    // authentication retries: a streaming body cannot be replayed after 401.
    const init: RequestInit & { duplex: "half" } = {
      method: "POST", headers, body: request.body, duplex: "half", credentials: "omit", redirect: "manual", cache: "no-store",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(30 * 60 * 1000)])
    };
    const response = await fetch(target, init);
    return new Response(response.body, { status: response.status, headers: { "content-type": response.headers.get("content-type") || "application/json", "cache-control": "no-store" } });
  } catch (error) {
    console.error("video upload proxy failed", error instanceof Error ? { message: error.message, cause: error.cause instanceof Error ? error.cause.message : "" } : "unknown");
    return Response.json({ detail: "VIDEO_UPLOAD_PROXY_UNAVAILABLE" }, { status: 502 });
  }
}
