from __future__ import annotations

import re

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.responses import Response
from starlette.concurrency import run_in_threadpool

from .context import ActorContext, ActorRole, actor_scope
from .service import actor_for_user, resolve_web_session
from ..config import get_settings
from ..database import SessionLocal
from ..desktop_identity import desktop_actor_for_device


_PUBLIC_PATHS = {"/health"}
_PUBLIC_ROUTES = {("POST", "/api/public-snapshots/csdn")}
_PUBLIC_PREFIXES = ("/api/auth/", "/uploads/")
_DESKTOP_AGENT_ROUTES = (
    re.compile(r"^/api/desktop-devices/register$"),
    re.compile(r"^/api/desktop-devices/[^/]+/verify$"),
    re.compile(r"^/api/desktop-devices/[^/]+/owner-bindings/[^/]+/claim$"),
)


def _is_public_request(request: Request) -> bool:
    path = request.url.path
    return (
        request.method == "OPTIONS"
        or (request.method, path) in _PUBLIC_ROUTES
        or path in _PUBLIC_PATHS
        or any(path.startswith(prefix) for prefix in _PUBLIC_PREFIXES)
    )


def _is_desktop_agent_request(request: Request) -> bool:
    return any(pattern.match(request.url.path) for pattern in _DESKTOP_AGENT_ROUTES)


def _resolve_request_actor(raw_token: str, device_id: str, device_token: str) -> ActorContext | None:
    # Keep the session and all ORM access in one worker thread. Blocking the
    # event loop here stalls unrelated UI refreshes and even health requests.
    with SessionLocal() as db:
        if raw_token:
            resolved = resolve_web_session(db, raw_token)
            if resolved is not None:
                return actor_for_user(resolved[0])
        if device_id and device_token:
            return desktop_actor_for_device(db, device_id, device_token)
    return None


class AuthenticationMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        # These narrowly scoped agent endpoints authenticate Bearer credentials
        # themselves. Never accept a web cookie, desktop token or test bypass.
        from ..mcp_access import MCP_PATHS, MCP_UPLOAD_SCOPES
        if request.url.path in MCP_UPLOAD_SCOPES:
            from ..mcp_access import authenticate_request
            try:
                await run_in_threadpool(authenticate_request, request, MCP_UPLOAD_SCOPES[request.url.path])
            except HTTPException as exc:
                return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail}, headers=exc.headers)
            return await call_next(request)
        if request.url.path in MCP_PATHS:
            return await call_next(request)
        if request.headers.get("authorization", "").lower().startswith("bearer zx_mcp_"):
            return JSONResponse(status_code=403, content={"detail": "MCP_TOKEN_ENDPOINT_FORBIDDEN"})
        if _is_public_request(request):
            return await call_next(request)

        settings = get_settings()
        raw_token = request.cookies.get(settings.auth_cookie_name, "")
        device_id = str(request.headers.get("x-device-id") or "").strip()
        device_token = str(request.headers.get("x-device-token") or "").strip()
        actor = None
        if raw_token or (device_id and device_token):
            try:
                actor = await run_in_threadpool(_resolve_request_actor, raw_token, device_id, device_token)
            except HTTPException as exc:
                return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

        if actor is None and settings.auth_test_bypass_user_id:
            actor = ActorContext(
                user_id=settings.auth_test_bypass_user_id,
                role=ActorRole.MEMBER,
            )

        if actor is None and _is_desktop_agent_request(request):
            # Registration and one-time owner binding are the only routes an
            # unbound desktop may call without a member session.
            return await call_next(request)

        if actor is None:
            return JSONResponse(status_code=401, content={"detail": "AUTHENTICATION_REQUIRED"})

        request.state.actor = actor
        with actor_scope(actor):
            return await call_next(request)
