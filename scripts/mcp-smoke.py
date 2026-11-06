"""Read-only real-HTTP MCP smoke. Requires the API's mcp dependency.

ZHIXIN_MCP_URL=https://<host>/mcp ZHIXIN_MCP_TOKEN=<secret> python scripts/mcp-smoke.py
Never prints the token or invokes a publishing tool.
"""
import asyncio
import json
import os
from urllib.parse import urlparse

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


async def verify(url: str, token: str) -> dict:
    parsed = urlparse(url)
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}):
        raise ValueError("Use HTTPS for remote MCP; HTTP is allowed only on loopback")
    if not token:
        raise ValueError("ZHIXIN_MCP_TOKEN is required")
    async with httpx.AsyncClient(headers={"Authorization": f"Bearer {token}"}, timeout=30, follow_redirects=False) as http:
        async with streamable_http_client(url, http_client=http) as (read, write, _):
            async with ClientSession(read, write) as session:
                initialized = await session.initialize()
                tools = await session.list_tools()
                names = sorted(tool.name for tool in tools.tools)
                expected = {"get_publish_capabilities", "get_upload_instructions", "list_video_assets", "publish_video", "get_video_publication", "list_video_publications", "recheck_video_publication"}
                expected.update({"get_article_publish_capabilities", "list_article_assets", "import_article", "list_articles", "get_article", "publish_article", "get_article_publication", "list_article_publications", "recheck_article_publication"})
                if not expected.issubset(names):
                    raise RuntimeError("Missing publishing tools")
                readiness = await session.call_tool("get_publish_capabilities", {})
                if readiness.isError:
                    raise RuntimeError("Capability read failed")
                article_readiness = await session.call_tool("get_article_publish_capabilities", {})
                if article_readiness.isError:
                    raise RuntimeError("Article capability read failed")
                upload = await session.call_tool("get_upload_instructions", {})
                if upload.isError:
                    raise RuntimeError("Upload discovery failed")
                return {"server": initialized.serverInfo.name, "protocol": initialized.protocolVersion, "tools": names, "readOnlyChecks": "passed"}


if __name__ == "__main__":
    result = asyncio.run(verify(os.environ["ZHIXIN_MCP_URL"], os.environ["ZHIXIN_MCP_TOKEN"]))
    print(json.dumps(result, ensure_ascii=False))
