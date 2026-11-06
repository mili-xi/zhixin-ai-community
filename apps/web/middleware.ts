import { NextRequest, NextResponse } from "next/server";

const authCookieName = process.env.AUTH_COOKIE_NAME || "zhixin_session";

function isPublicRequest(pathname: string) {
  return (
    pathname === "/login" ||
    pathname === "/health" ||
    pathname === "/mcp" ||
    pathname === "/mcp/" ||
    pathname === "/favicon.ico" ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/uploads/") ||
    pathname.startsWith("/downloads/") ||
    pathname.startsWith("/_next/")
  );
}

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (pathname === "/login") {
    return NextResponse.next();
  }

  if (isPublicRequest(pathname)) {
    return NextResponse.next();
  }

  if (request.cookies.get(authCookieName)?.value) {
    return NextResponse.next();
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  if (pathname !== "/") {
    url.searchParams.set("next", `${pathname}${search}`);
  }
  return NextResponse.redirect(url);
}

export const config = {
  // FastAPI authenticates this stream; middleware would clone and truncate it at 10 MiB.
  matcher: ["/((?!_next/static|_next/image|api/video-assets/upload|api/mcp/video-assets/upload|api/mcp/article-assets/upload).*)"],
};
