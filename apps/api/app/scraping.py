"""Knowledge URL fetch powered by Scrapling with httpx fallback.

Strategy (auto mode):
1. Scrapling Fetcher — HTTP + Chrome TLS fingerprint (fast)
2. Scrapling StealthyFetcher — headless stealth browser for hard hosts / short HTML
3. httpx — last resort if Scrapling is not installed or both fail

See: https://github.com/D4Vinci/Scrapling
"""

from __future__ import annotations

import re
import signal
import threading
from contextlib import contextmanager
from typing import Any, Callable
from urllib.parse import urlparse

import httpx


try:
    from bs4 import BeautifulSoup
except Exception:  # pragma: no cover
    BeautifulSoup = None

try:
    from scrapling.fetchers import Fetcher, StealthyFetcher

    SCRAPLING_AVAILABLE = True
except Exception:  # pragma: no cover
    Fetcher = None  # type: ignore[assignment,misc]
    StealthyFetcher = None  # type: ignore[assignment,misc]
    SCRAPLING_AVAILABLE = False


DEFAULT_FETCH_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/126.0.0.0 Safari/537.36 ZhixinAI-KnowledgeFetcher/1.0"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}


class StealthFetchTimeout(RuntimeError):
    """Raised when a stealth fetch blows through its hard wall-clock budget."""


def hard_timeout_supported() -> bool:
    """SIGALRM guards only work on the main thread of a POSIX process."""
    return (
        hasattr(signal, "SIGALRM")
        and hasattr(signal, "setitimer")
        and threading.current_thread() is threading.main_thread()
    )


@contextmanager
def hard_timeout(seconds: float, *, label: str, cleanup_seconds: float = 30.0):
    """Bound a blocking call whose own library offers no timeout at all.

    Scrapling talks to the browser through Playwright's protocol, and
    patchright's ``Channel.send`` only awaits the reply future: when the browser
    node stops answering without crashing or closing, nothing on the client side
    ever gives up. That is exactly how the worker wedged on 2026-10-07 and stopped
    consuming every queue.

    A SIGALRM timer is the only lever that can break that wait, because
    Scrapling's sync API runs the event loop in the calling thread via greenlets.
    The first firing raises; afterwards a short leash stays armed so tearing the
    wedged page down is bounded too. Degrades to a no-op off the main thread or
    on platforms without ``setitimer``.
    """
    budget = float(seconds or 0.0)
    if budget <= 0 or not hard_timeout_supported():
        yield
        return

    def _fire(_signum, _frame):
        try:
            signal.setitimer(signal.ITIMER_REAL, max(float(cleanup_seconds), 1.0))
        except Exception:  # pragma: no cover - defensive
            pass
        raise StealthFetchTimeout(f"{label} exceeded hard timeout of {budget:.0f}s")

    previous = signal.signal(signal.SIGALRM, _fire)
    signal.setitimer(signal.ITIMER_REAL, budget)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0.0)
        signal.signal(signal.SIGALRM, previous)

LOGIN_WALL_HINTS = (
    "登录",
    "登陆",
    "请先登录",
    "sign in",
    "log in",
    "验证码",
    "captcha",
    "access denied",
    "403 forbidden",
    "人机验证",
    "安全验证",
)

# Hosts that usually need stealth browser, not bare HTTP.
HARD_WALL_HOSTS = (
    "zhihu.com",
    "zhuanlan.zhihu.com",
    "weixin.qq.com",
    "mp.weixin.qq.com",
    "xiaohongshu.com",
    "www.xiaohongshu.com",
)

# Prefer main content selectors when present (Scrapling CSS, then BS4).
CONTENT_SELECTORS = (
    "article",
    "main",
    "#js_content",  # WeChat official accounts
    ".Post-RichText",  # Zhihu
    ".RichText",
    ".Post-Main",
    ".article-content",
    ".entry-content",
    ".post-content",
    ".markdown-body",
    "#content",
    ".content",
)


def host_of(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").lower()
    except Exception:
        return ""


def is_hard_wall_host(host: str) -> bool:
    if not host:
        return False
    return any(host == item or host.endswith("." + item) or host.endswith(item) for item in HARD_WALL_HOSTS)


def clean_text(text: str) -> str:
    return re.sub(r"\n{3,}", "\n\n", (text or "").strip())


def html_to_text(html_text: str) -> str:
    if not html_text:
        return ""
    if BeautifulSoup is None:
        return clean_text(re.sub(r"<[^>]+>", " ", html_text))
    soup = BeautifulSoup(html_text, "html.parser")
    for node in soup(["script", "style", "noscript", "svg", "iframe"]):
        node.decompose()
    # Prefer main content containers when present.
    for selector in CONTENT_SELECTORS:
        try:
            node = soup.select_one(selector)
        except Exception:
            node = None
        if node:
            candidate = clean_text(node.get_text("\n", strip=True))
            if len(candidate) >= 80:
                return candidate
    return clean_text(soup.get_text("\n", strip=True))


def response_to_text(page: Any) -> str:
    """Extract readable text from a Scrapling Response / Selector.

    Prefer long structured content. Never return a tiny selector snippet when the
    full HTML body has more usable text (that used to surface as body too short).
    """
    candidates: list[str] = []

    # Prefer structured content selectors via Scrapling CSS.
    for selector in CONTENT_SELECTORS:
        try:
            nodes = page.css(selector)
            if not nodes:
                continue
            parts: list[str] = []
            for node in nodes[:5]:
                getter = getattr(node, "get_all_text", None)
                if callable(getter):
                    parts.append(str(getter(strip=True) or ""))
                else:
                    parts.append(str(node.get() or ""))
            candidate = clean_text("\n\n".join(p for p in parts if p))
            if candidate:
                candidates.append(candidate)
                if len(candidate) >= 80:
                    return candidate
        except Exception:
            continue

    getter = getattr(page, "get_all_text", None)
    if callable(getter):
        try:
            text = clean_text(str(getter(strip=True) or ""))
            if text:
                candidates.append(text)
        except Exception:
            pass

    body_text = ""
    body = getattr(page, "body", None)
    if isinstance(body, bytes):
        encoding = str(getattr(page, "encoding", None) or "utf-8")
        body_text = html_to_text(body.decode(encoding, errors="ignore"))
    elif isinstance(body, str):
        body_text = html_to_text(body)

    if not body_text:
        html_content = getattr(page, "html_content", None)
        if html_content:
            body_text = html_to_text(str(html_content))
    if body_text:
        candidates.append(body_text)

    if not candidates:
        return ""
    # Longest non-empty extraction wins (avoids 25-char false positives).
    return max(candidates, key=lambda item: len(item))


def looks_like_login_wall(text: str) -> bool:
    cleaned = clean_text(text)
    if len(cleaned) >= 800:
        return False
    lowered = cleaned.lower()
    return any(hint in cleaned or hint in lowered for hint in LOGIN_WALL_HINTS)


def text_is_usable(text: str, *, min_chars: int = 80) -> bool:
    cleaned = clean_text(text)
    if len(cleaned) < min_chars:
        return False
    if looks_like_login_wall(cleaned):
        return False
    return True


def fetch_with_scrapling_http(url: str) -> tuple[str, dict[str, Any]]:
    if not SCRAPLING_AVAILABLE or Fetcher is None:
        raise RuntimeError("SCRAPLING_NOT_AVAILABLE")
    page = Fetcher.get(url, stealthy_headers=True, impersonate="chrome")
    status = int(getattr(page, "status", 0) or 0)
    text = response_to_text(page)
    meta = {"engine": "scrapling-fetcher", "status": status, "impersonate": "chrome"}
    if status in {401, 403}:
        raise ValueError("HTTP_FORBIDDEN")
    if status >= 400:
        raise ValueError(f"HTTP_{status}")
    return text, meta


def fetch_with_scrapling_stealth(
    url: str,
    *,
    headless: bool = True,
    timeout_ms: int = 45000,
    hard_timeout_seconds: float = 300.0,
) -> tuple[str, dict[str, Any]]:
    if not SCRAPLING_AVAILABLE or StealthyFetcher is None:
        raise RuntimeError("SCRAPLING_STEALTH_NOT_AVAILABLE")
    # StealthyFetcher opens a headless browser; heavier but better vs anti-bot.
    # The guard has to wrap the whole call: Scrapling retries internally and
    # builds its Response by calling page.content(), which is another unbounded
    # protocol round trip.
    with hard_timeout(
        hard_timeout_seconds,
        label=f"stealth fetch {url}",
        cleanup_seconds=max(hard_timeout_seconds / 10.0, 15.0),
    ):
        page = StealthyFetcher.fetch(
            url,
            headless=headless,
            network_idle=True,
            timeout=timeout_ms,
        )
        status = int(getattr(page, "status", 0) or 0)
        text = response_to_text(page)
    meta = {"engine": "scrapling-stealthy", "status": status, "headless": headless}
    if status in {401, 403} and not text_is_usable(text):
        raise ValueError("HTTP_FORBIDDEN")
    return text, meta


def fetch_with_httpx(url: str, *, timeout: float = 30.0) -> tuple[str, dict[str, Any]]:
    try:
        response = httpx.get(url, timeout=timeout, follow_redirects=True, headers=DEFAULT_FETCH_HEADERS)
    except httpx.TimeoutException as error:
        raise ValueError("网页抓取超时，请稍后重试，或改为粘贴正文 / 上传文件。") from error
    except httpx.RequestError as error:
        raise ValueError(f"无法访问该网页：{error}") from error

    if response.status_code in {401, 403}:
        raise ValueError(
            "目标站点拒绝抓取（可能需要登录或有反爬）。请粘贴正文内容，或上传 PDF/Word/TXT 文件。"
        )
    if response.status_code >= 400:
        raise ValueError(f"网页返回 HTTP {response.status_code}，无法学习。请换公开页面或粘贴正文。")

    text = html_to_text(response.text or "")
    return text, {"engine": "httpx", "status": response.status_code}


def fetch_url_text(
    url: str,
    *,
    mode: str = "auto",
    enable_stealth: bool = True,
    http_timeout: float = 30.0,
    stealth_timeout_ms: int = 45000,
    stealth_hard_timeout_seconds: float = 300.0,
) -> tuple[str, dict[str, Any]]:
    """Fetch page text. Returns (text, meta). Raises ValueError with Chinese messages."""
    url = (url or "").strip()
    if not url:
        raise ValueError("URL_REQUIRED")
    host = host_of(url)
    hard = is_hard_wall_host(host)
    mode = (mode or "auto").lower()
    errors: list[str] = []

    def try_http_stack() -> tuple[str, dict[str, Any]] | None:
        if mode in {"auto", "scrapling", "scrapling-http"} and SCRAPLING_AVAILABLE:
            try:
                text, meta = fetch_with_scrapling_http(url)
                if text_is_usable(text):
                    return text, meta
                errors.append(f"scrapling-fetcher: body too short ({len(clean_text(text))})")
            except Exception as error:
                errors.append(f"scrapling-fetcher: {error}")
        if mode in {"auto", "httpx"} or not SCRAPLING_AVAILABLE:
            try:
                text, meta = fetch_with_httpx(url, timeout=http_timeout)
                if text_is_usable(text):
                    return text, meta
                errors.append(f"httpx: body too short ({len(clean_text(text))})")
            except Exception as error:
                errors.append(f"httpx: {error}")
        return None

    def try_stealth() -> tuple[str, dict[str, Any]] | None:
        if not enable_stealth or mode in {"httpx", "scrapling-http"}:
            return None
        if mode not in {"auto", "scrapling", "scrapling-stealth", "stealth"}:
            return None
        if not SCRAPLING_AVAILABLE:
            return None
        try:
            text, meta = fetch_with_scrapling_stealth(
                url,
                headless=True,
                timeout_ms=stealth_timeout_ms,
                hard_timeout_seconds=stealth_hard_timeout_seconds,
            )
            if text_is_usable(text, min_chars=60):
                return text, meta
            errors.append(f"scrapling-stealthy: body too short ({len(clean_text(text))})")
        except Exception as error:
            errors.append(f"scrapling-stealthy: {error}")
        return None

    # Hard hosts: try stealth earlier.
    if hard and enable_stealth and mode in {"auto", "scrapling", "stealth", "scrapling-stealth"}:
        result = try_stealth()
        if result:
            return result
        result = try_http_stack()
        if result:
            return result
    else:
        result = try_http_stack()
        if result:
            return result
        if enable_stealth:
            result = try_stealth()
            if result:
                return result

    detail = "；".join(errors[-3:]) if errors else "未知错误"
    if hard:
        raise ValueError(
            f"抓取「{host}」失败（已尝试 Scrapling 增强抓取）：{detail}。"
            " 若仍失败，请直接粘贴正文或上传文件。"
        )
    if looks_like_login_wall(detail) or "FORBIDDEN" in detail.upper() or "403" in detail:
        raise ValueError(
            "目标站点拒绝抓取或需要登录验证。已尝试 Scrapling 伪装请求/隐身浏览器。"
            "请粘贴正文，或上传 PDF/Word/TXT。"
        )
    raise ValueError(
        f"网页抓取失败：{detail}。可换公开页面，或粘贴正文 / 上传文件。"
    )


def chromium_shared_library_issues() -> list[str]:
    """Return missing shared libs for Playwright Chromium, if binary exists."""
    import os
    from pathlib import Path

    root = Path(os.environ.get("PLAYWRIGHT_BROWSERS_PATH") or "/ms-playwright")
    if not root.exists():
        return ["PLAYWRIGHT_BROWSERS_PATH missing"]
    chrome_bins = list(root.glob("**/chrome-linux*/chrome"))
    if not chrome_bins:
        return ["chromium binary not found"]
    chrome = str(chrome_bins[0])
    try:
        import subprocess

        result = subprocess.run(
            ["ldd", chrome],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        missing = [
            line.strip()
            for line in (result.stdout or "").splitlines()
            if "not found" in line
        ]
        return missing
    except Exception as error:  # pragma: no cover
        return [f"ldd failed: {error}"]


def scrapling_status() -> dict[str, Any]:
    missing_libs = chromium_shared_library_issues() if SCRAPLING_AVAILABLE else []
    stealth_ready = bool(StealthyFetcher) and not missing_libs
    if not SCRAPLING_AVAILABLE:
        hint = '未安装 Scrapling。Worker 环境执行: pip install "scrapling[fetchers]" && scrapling install'
    elif missing_libs:
        hint = (
            "Scrapling 已装，但 Chromium 系统库缺失，隐身浏览器不可用："
            + "; ".join(missing_libs[:5])
            + "。请重建 backend 镜像并安装 libcairo2 等依赖。"
        )
    else:
        hint = "Scrapling 已启用：HTTP 伪装 + 反爬浏览器分层抓取"
    return {
        "available": SCRAPLING_AVAILABLE,
        "fetcher": bool(Fetcher),
        "stealthyFetcher": bool(StealthyFetcher),
        "stealthReady": stealth_ready,
        "chromiumMissingLibraries": missing_libs,
        "project": "https://github.com/D4Vinci/Scrapling",
        "hint": hint,
    }
