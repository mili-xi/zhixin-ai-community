"""Official MCP transport over the existing durable video publishing service."""
from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile, Form
from mcp.server.fastmcp import Context, FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from pydantic import Field
from sqlalchemy import select
from starlette.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from .auth.context import actor_scope
from .config import csv_setting, get_settings
from .database import Record, SessionLocal, get_db
from .mcp_access import READ, WRITE, ARTICLE_WRITE, ARTICLE_UPLOAD_PATH, UPLOAD_PATH, resolve_agent, authenticate_request
from .service import get_record
from . import video_publishing as video
from . import mcp_articles as articles

upload_router = APIRouter()
upload_router.include_router(articles.router)
MAX_MCP_BODY = 128 * 1024
PUBLICATION_FIELDS = ("id", "assetId", "coverAssetId", "mediaAccountId", "deviceId", "commandId", "title", "caption", "publishMode", "scheduledAt", "scheduledTimestamp", "status", "platformStatus", "stage", "itemId", "publicUrl", "message", "errorMessage", "attempt", "createdAt", "updatedAt", "submittedAt", "nextDiscoveryAt", "preparationEvidence")
ASSET_FIELDS = ("id", "kind", "filename", "sizeBytes", "sha256", "contentType", "media", "createdAt")


def project(record: dict, fields: tuple[str, ...]) -> dict:
    return {k: record[k] for k in fields if k in record}


def _result(result: dict) -> dict:
    return {"publication": project(result["publication"], PUBLICATION_FIELDS), "deduplicated": result.get("deduplicated", False)}


@upload_router.post(UPLOAD_PATH)
async def agent_upload(request: Request, file: UploadFile = File(...), kind: str = Form("video"), db=Depends(get_db)) -> dict:
    # Revalidate after multipart transfer as well: credentials may have been
    # revoked/expired while the client was uploading the body.
    identity = await run_in_threadpool(authenticate_request, request, WRITE)
    with actor_scope(identity.actor):
        return await video.upload_video_asset(file=file, kind=kind, db=db)


def _invoke_sync(ctx: Context, scope: str, action):
    request = ctx.request_context.request
    if request is None:
        return {"error": "MCP_HTTP_REQUIRED", "status": 401}
    try:
        with SessionLocal() as db:
            identity = resolve_agent(request, db, scope)
            with actor_scope(identity.actor):
                return action(db, identity)
    except HTTPException as exc:
        # Expected service failures become structured tool errors. Do not include
        # tracebacks, raw platform payloads or any authentication headers.
        return {"error": str(exc.detail), "status": exc.status_code}


async def _invoke(ctx: Context, scope: str, action):
    # The SDK executes synchronous tool functions on its event loop. Keep DB
    # sessions, row locks and actor_scope together off that shared API loop.
    return await run_in_threadpool(_invoke_sync, ctx, scope, action)


def _page(db, owner: str, kind: str, fields: tuple[str, ...], limit: int, offset: int) -> dict:
    rows = db.scalars(select(Record).where(Record.kind == kind, Record.owner_id == owner).order_by(Record.created_at.desc(), Record.id.desc()).limit(limit+1).offset(offset)).all()
    return {"items": [project(row.data, fields) for row in rows[:limit]], "nextOffset": offset+limit if len(rows)>limit else None}


def build_server() -> FastMCP:
    settings = get_settings()
    hosts = csv_setting(settings.auth_trusted_hosts)
    # TrustedHostMiddleware handles host validation, including its wildcard
    # syntax. SDK Origin validation is kept as an additional explicit guard.
    security = TransportSecuritySettings(enable_dns_rebinding_protection="*" not in hosts, allowed_hosts=[h for host in hosts for h in (host, host+":*")], allowed_origins=csv_setting(settings.auth_allowed_origins))
    server = FastMCP("zhixin-ai", instructions="Publish finished articles to supported media platforms and finished Douyin videos through your own Zhixin AI account. Article writes require article:write; video writes require publish:write. Call get_upload_instructions for files. publish_article and publish_video queue real public posts and require explicit confirmation. Poll by publication ID; submitted_for_review and submission_unknown are not published. Never blindly resubmit an unknown outcome. Desktop executor must be online.", stateless_http=True, json_response=True, streamable_http_path="/mcp", transport_security=security)
    read = ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False)
    write = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=True)

    # Return CallToolResult for service errors, rather than a success-shaped dict.
    from mcp.types import CallToolResult, TextContent
    import json

    def answer(data):
        if "error" in data:
            return CallToolResult(isError=True, content=[TextContent(type="text", text=json.dumps(data, ensure_ascii=False))], structuredContent=data)
        return data

    @server.tool(annotations=read)
    async def get_publish_capabilities(ctx: Context) -> dict:
        """List your Douyin accounts, device readiness and video limits. No credentials are returned."""
        def action(db, identity):
            result = video.video_capabilities(db)
            names = {r.id: r.data.get("name", "") for r in db.scalars(select(Record).where(Record.kind == "mediaAccounts", Record.owner_id == identity.actor.owner_id)).all()}
            return {**result, "accounts": [{**a, "name": names.get(a["mediaAccountId"], "")} for a in result["accounts"]]}
        return answer(await _invoke(ctx, READ, action))

    @server.tool(annotations=read)
    async def get_upload_instructions(ctx: Context) -> dict:
        """Get the authenticated multipart upload path. Upload locally held files with HTTP, never put video bytes in MCP JSON or pass local paths to the remote server."""
        return answer(await _invoke(ctx, READ, lambda db, identity: {"uploadPath": UPLOAD_PATH, "method": "POST", "authorization": "Bearer <same MCP token; publish:write required>", "contentType": "multipart/form-data", "fields": {"file": "binary MP4 video or PNG/JPEG cover", "kind": "video (default) or cover"}, "maxVideoBytes": video.MAX_VIDEO_BYTES, "maxCoverBytes": video.MAX_COVER_BYTES, "result": "Use the returned id as assetId or coverAssetId in publish_video. The remote server cannot read files on your computer.", "articleImages": {"uploadPath": ARTICLE_UPLOAD_PATH, "method": "POST", "scope": ARTICLE_WRITE, "fields": {"file": "binary PNG/JPEG"}, "maxBytes": articles.MAX_IMAGE_BYTES, "access": "Article images use the existing publicly accessible /uploads/assets URLs, not private video storage. Do not upload confidential images.", "use": "Use returned id in ![alt](asset:<id>) or coverAssetId for import_article."}}))

    @server.tool(annotations=read)
    async def list_video_assets(ctx: Context, limit: Annotated[int, Field(ge=1, le=100)] = 20, offset: Annotated[int, Field(ge=0, le=100000)] = 0) -> dict:
        """List only your private uploaded assets, newest first, with bounded pagination."""
        return answer(await _invoke(ctx, READ, lambda db, identity: _page(db, identity.actor.owner_id, "videoAssets", ASSET_FIELDS, limit, offset)))

    @server.tool(annotations=write)
    async def publish_video(ctx: Context, assetId: Annotated[str, Field(min_length=1, max_length=120)], mediaAccountId: Annotated[str, Field(min_length=1, max_length=120)], caption: Annotated[str, Field(min_length=1, max_length=1000)], idempotencyKey: Annotated[str, Field(min_length=1, max_length=128)], confirmPublish: Annotated[bool, Field(strict=True)], coverAssetId: Annotated[str, Field(max_length=120)] = "", title: Annotated[str, Field(max_length=30)] = "", publishMode: Literal["immediate", "scheduled"] = "immediate", scheduledAt: Annotated[str, Field(max_length=40)] = "") -> dict:
        """Queue a REAL Douyin video publication after user authorization. title (max 30 chars) and caption (max 1000 chars) fill separate fields. publishMode defaults to immediate; scheduled requires scheduledAt as ISO 8601 with timezone and minute precision, 2 hours to 14 days ahead, and an account whose supportsScheduled is true. confirmPublish must be true. Reuse idempotencyKey on network retries; do not regenerate it. Returns a durable publication ID; it does not mean the post is public. Omit coverAssetId for native AI cover."""
        def action(db, identity):
            if confirmPublish is not True:
                raise HTTPException(400, "PUBLISH_CONFIRMATION_REQUIRED")
            return _result(video.create_video_publication_payload({"assetId": assetId, "mediaAccountId": mediaAccountId, "caption": caption, "idempotencyKey": idempotencyKey, "coverAssetId": coverAssetId, "title": title, "publishMode": publishMode, "scheduledAt": scheduledAt}, db))
        return answer(await _invoke(ctx, WRITE, action))

    @server.tool(annotations=read)
    async def get_video_publication(ctx: Context, publicationId: Annotated[str, Field(min_length=1, max_length=120)]) -> dict:
        """Read your durable task's status. Only status=published is verified public; review and unknown submission are not failures safe to republish."""
        return answer(await _invoke(ctx, READ, lambda db, identity: project(get_record(db, "videoPublications", publicationId), PUBLICATION_FIELDS)))

    @server.tool(annotations=read)
    async def list_video_publications(ctx: Context, limit: Annotated[int, Field(ge=1, le=100)] = 20, offset: Annotated[int, Field(ge=0, le=100000)] = 0) -> dict:
        """List your video publication queue and outcomes, newest first."""
        return answer(await _invoke(ctx, READ, lambda db, identity: _page(db, identity.actor.owner_id, "videoPublications", PUBLICATION_FIELDS, limit, offset)))

    @server.tool(annotations=write)
    async def recheck_video_publication(ctx: Context, publicationId: Annotated[str, Field(min_length=1, max_length=120)]) -> dict:
        """Queue a status lookup for an existing platform item ID. Never submits a new video. Active lookups are deduplicated; public tasks return immediately. Unknown outcomes without an item ID require manual reconciliation."""
        return answer(await _invoke(ctx, WRITE, lambda db, identity: _result(video.queue_video_discovery(db, get_record(db, "videoPublications", publicationId)))))

    @server.tool(annotations=read)
    async def get_article_publish_capabilities(ctx: Context) -> dict:
        """Discover supported article platforms and your own account authorization/device readiness. WeChat is unsupported; Douyin uses the existing video tools."""
        return answer(await _invoke(ctx, READ, lambda db, identity: articles.capabilities(db)))

    @server.tool(annotations=read)
    async def list_article_assets(ctx: Context, limit: Annotated[int, Field(ge=1, le=100)]=20, offset: Annotated[int, Field(ge=0, le=100000)]=0) -> dict:
        """List only your article image metadata. Article image URLs use the existing public asset library."""
        return answer(await _invoke(ctx, READ, lambda db, identity: articles.page(db,'assets',articles.ASSET_FIELDS,limit,offset)))

    @server.tool(annotations=write)
    async def import_article(ctx: Context, title: Annotated[str, Field(min_length=1,max_length=200)], contentMarkdown: Annotated[str, Field(min_length=1,max_length=20000)], idempotencyKey: Annotated[str, Field(min_length=1,max_length=128)], summary: Annotated[str, Field(max_length=2000)]='', tags: Annotated[list[Annotated[str, Field(max_length=80)]], Field(max_length=20)] | None=None, coverAssetId: Annotated[str, Field(max_length=120)]='') -> dict:
        """Import a FINISHED article; requires article:write. Does not generate or publish content. Inline images use ![alt](asset:<your uploaded article image ID>), at most 5; no external images or local paths. Retry the same content with the same idempotencyKey."""
        return answer(await _invoke(ctx, ARTICLE_WRITE, lambda db, identity: articles.import_article(db,title=title,contentMarkdown=contentMarkdown,idempotencyKey=idempotencyKey,summary=summary,tags=tags,coverAssetId=coverAssetId)))

    @server.tool(annotations=read)
    async def list_articles(ctx: Context, limit: Annotated[int, Field(ge=1, le=100)]=20, offset: Annotated[int, Field(ge=0, le=100000)]=0) -> dict:
        """List your article drafts, including imported content. Bounded pagination."""
        return answer(await _invoke(ctx, READ, lambda db, identity: articles.page(db,'articles',articles.ARTICLE_FIELDS,limit,offset)))

    @server.tool(annotations=read)
    async def get_article(ctx: Context, articleId: Annotated[str, Field(min_length=1,max_length=120)]) -> dict:
        """Read your finished article content, without internal filesystem or generation context."""
        return answer(await _invoke(ctx, READ, lambda db, identity: articles.public_article(get_record(db,'articles',articleId))))

    @server.tool(annotations=write)
    async def publish_article(ctx: Context, articleId: Annotated[str, Field(min_length=1,max_length=120)], mediaAccountId: Annotated[str, Field(min_length=1,max_length=120)], idempotencyKey: Annotated[str, Field(min_length=1,max_length=128)], confirmPublish: Annotated[bool, Field(strict=True)]) -> dict:
        """Queue a REAL article post to one of your authorized accounts; requires article:write and explicit confirmPublish=true. Loop over chosen accounts for multiple platforms. Return a durable publication ID, never a claim of public success. Reuse keys on retries; unknown/interrupted outcomes must be queried, not resubmitted."""
        return answer(await _invoke(ctx, ARTICLE_WRITE, lambda db, identity: articles.publish_article(db,articleId=articleId,mediaAccountId=mediaAccountId,idempotencyKey=idempotencyKey,confirmPublish=confirmPublish)))

    @server.tool(annotations=read)
    async def get_article_publication(ctx: Context, publicationId: Annotated[str, Field(min_length=1,max_length=120)]) -> dict:
        """Query your MCP publication ID or existing media order ID. Only verified public evidence produces status=published. Review/unknown are not safe to repost."""
        return answer(await _invoke(ctx, READ, lambda db, identity: articles.get_publication(db,publicationId)))

    @server.tool(annotations=read)
    async def list_article_publications(ctx: Context, limit: Annotated[int, Field(ge=1, le=100)]=20, offset: Annotated[int, Field(ge=0, le=100000)]=0) -> dict:
        """List your article queue and existing article publication records, with pagination."""
        return answer(await _invoke(ctx, READ, lambda db, identity: articles.list_publications(db,limit,offset)))

    @server.tool(annotations=write)
    async def recheck_article_publication(ctx: Context, publicationId: Annotated[str, Field(min_length=1,max_length=120)]) -> dict:
        """Request status verification of your existing article publication; requires article:write. Does not create a new post or accept arbitrary lookup URLs."""
        return answer(await _invoke(ctx, ARTICLE_WRITE, lambda db, identity: articles.recheck_publication(db,publicationId)))

    return server


class MCPTransport:
    """Manage SDK lifespan in FastAPI, including repeatable test lifespans."""
    def __init__(self):
        self.http_app = None

    @asynccontextmanager
    async def lifespan(self):
        server = build_server()
        self.http_app = server.streamable_http_app()
        try:
            async with server.session_manager.run():
                yield
        finally:
            self.http_app = None

    async def __call__(self, scope, receive, send):
        request = Request(scope)
        try:
            await run_in_threadpool(authenticate_request, request, READ)
        except HTTPException as exc:
            return await JSONResponse({"detail": exc.detail}, status_code=exc.status_code, headers=exc.headers)(scope, receive, send)
        if self.http_app is None:
            return await JSONResponse({"detail": "MCP_NOT_STARTED"}, status_code=503)(scope, receive, send)
        # Buffer only small protocol messages, never media. Bound chunked bodies
        # as well as Content-Length before the SDK JSON parser allocates memory.
        chunks, count = [], 0
        if request.method == "POST":
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                count += len(message.get("body", b""))
                if count > MAX_MCP_BODY:
                    return await JSONResponse({"detail": "MCP_REQUEST_TOO_LARGE"}, status_code=413)(scope, receive, send)
                chunks.append(message)
                if not message.get("more_body"):
                    break
        async def replay():
            if chunks:
                return chunks.pop(0)
            return await receive()
        # Both /mcp spellings work without a credential-bearing redirect.
        scope = {**scope, "path": "/mcp", "raw_path": b"/mcp"}
        await self.http_app(scope, replay, send)


mcp_transport = MCPTransport()
