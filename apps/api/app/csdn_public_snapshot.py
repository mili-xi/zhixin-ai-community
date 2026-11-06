from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin, urlsplit

import httpx
from bs4 import BeautifulSoup


_CSDN_ARTICLE_PATH = re.compile(
    r"^/(?P<username>[A-Za-z0-9_-]+)/article/details/(?P<article_id>[0-9]+)/?$"
)
_REDIRECT_STATUSES = {301, 302, 303, 307, 308}
_DEFAULT_HEADERS = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.6",
    "cache-control": "no-cache",
    "pragma": "no-cache",
    "user-agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126 Safari/537.36"
    ),
}


class CsdnPublicSnapshotError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class CsdnPublicArticleUrl:
    url: str
    username: str
    article_id: str

    @property
    def identity(self) -> tuple[str, str]:
        return self.username, self.article_id


def validate_csdn_public_url(value: str) -> CsdnPublicArticleUrl:
    raw_url = str(value or "").strip()
    try:
        parsed = urlsplit(raw_url)
        explicit_port = parsed.port
    except ValueError as error:
        raise CsdnPublicSnapshotError("CSDN_PUBLIC_URL_INVALID") from error

    match = _CSDN_ARTICLE_PATH.fullmatch(parsed.path)
    if (
        parsed.scheme != "https"
        or parsed.hostname != "blog.csdn.net"
        or parsed.username is not None
        or parsed.password is not None
        or explicit_port is not None
        or parsed.query
        or parsed.fragment
        or not match
    ):
        raise CsdnPublicSnapshotError("CSDN_PUBLIC_URL_INVALID")

    return CsdnPublicArticleUrl(
        url=raw_url,
        username=match.group("username"),
        article_id=match.group("article_id"),
    )


def _decode_html(content: bytes, encoding: str | None) -> str:
    return content.decode(encoding or "utf-8", errors="replace")


def _read_response_body(response: httpx.Response, max_response_bytes: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    for chunk in response.iter_bytes():
        total += len(chunk)
        if total > max_response_bytes:
            raise CsdnPublicSnapshotError("CSDN_PUBLIC_RESPONSE_TOO_LARGE")
        chunks.append(chunk)
    return b"".join(chunks)


def _image_urls(content: Any, page_url: str) -> list[str]:
    urls: list[str] = []
    for image in content.select("img"):
        candidates = [
            image.get("src"),
            image.get("data-src"),
            image.get("data-original"),
        ]
        srcset = str(image.get("srcset") or "")
        candidates.extend(item.strip().split()[0] for item in srcset.split(",") if item.strip())
        for candidate in candidates:
            if not candidate:
                continue
            absolute = urljoin(page_url, str(candidate).strip())
            parsed = urlsplit(absolute)
            if parsed.scheme not in {"http", "https"} or not parsed.hostname:
                continue
            normalized = parsed._replace(fragment="").geturl()
            if normalized not in urls:
                urls.append(normalized)
    return urls


def _snapshot_from_html(html: str, final_url: str, status: int) -> dict[str, Any]:
    soup = BeautifulSoup(html, "html.parser")
    content = soup.select_one("#content_views")
    if content is None:
        raise CsdnPublicSnapshotError("CSDN_PUBLIC_CONTENT_MISSING")

    content_text = content.get_text(" ", strip=True)
    if not content_text:
        raise CsdnPublicSnapshotError("CSDN_PUBLIC_CONTENT_MISSING")

    title = soup.title.get_text(" ", strip=True) if soup.title else ""
    return {
        "status": status,
        "url": final_url,
        "title": title,
        "text": content_text,
        "contentText": content_text,
        "imageUrls": _image_urls(content, final_url),
    }


def fetch_csdn_public_snapshot(
    value: str,
    *,
    transport: httpx.BaseTransport | None = None,
    timeout: float = 20.0,
    max_redirects: int = 3,
    max_response_bytes: int = 2_000_000,
) -> dict[str, Any]:
    target = validate_csdn_public_url(value)
    current_url = target.url

    try:
        with httpx.Client(
            transport=transport,
            timeout=timeout,
            follow_redirects=False,
            headers=_DEFAULT_HEADERS,
        ) as client:
            for redirect_count in range(max_redirects + 1):
                with client.stream("GET", current_url) as response:
                    if response.status_code in _REDIRECT_STATUSES:
                        location = response.headers.get("location", "")
                        if not location or redirect_count >= max_redirects:
                            raise CsdnPublicSnapshotError("CSDN_PUBLIC_REDIRECT_INVALID")
                        try:
                            redirected = validate_csdn_public_url(urljoin(current_url, location))
                        except CsdnPublicSnapshotError as error:
                            raise CsdnPublicSnapshotError("CSDN_PUBLIC_REDIRECT_INVALID") from error
                        if redirected.identity != target.identity:
                            raise CsdnPublicSnapshotError("CSDN_PUBLIC_REDIRECT_INVALID")
                        current_url = redirected.url
                        continue

                    if response.status_code < 200 or response.status_code >= 300:
                        raise CsdnPublicSnapshotError(
                            f"CSDN_PUBLIC_UPSTREAM_STATUS:{response.status_code}"
                        )
                    content = _read_response_body(response, max_response_bytes)
                    html = _decode_html(content, response.encoding)
                    return _snapshot_from_html(html, current_url, response.status_code)
    except CsdnPublicSnapshotError:
        raise
    except httpx.HTTPError as error:
        raise CsdnPublicSnapshotError("CSDN_PUBLIC_FETCH_FAILED") from error

    raise CsdnPublicSnapshotError("CSDN_PUBLIC_REDIRECT_INVALID")
