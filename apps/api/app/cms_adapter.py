"""CMS publish adapters: Webhook and WordPress REST API."""
from __future__ import annotations

import re
from typing import Any

import httpx

from .config import get_settings


def _slug(title: str) -> str:
    """Convert title to a URL-safe slug."""
    return re.sub(r"[^a-z0-9一-鿿]+", "-", title.lower()).strip("-")[:80] or "article"


class CmsAdapter:
    """Base class for all CMS publish adapters."""

    adapter_type: str = "base"

    def publish(self, article: dict[str, Any], site: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError

    def update(self, article: dict[str, Any], site: dict[str, Any], external_id: str) -> dict[str, Any]:
        raise NotImplementedError


class WebhookCmsAdapter(CmsAdapter):
    """Sends the article as JSON to a user-configured webhook URL.

    The webhook receiver is expected to return JSON with at minimum:
      { "url": "<published page URL>", "id": "<external article ID>" }
    """

    adapter_type = "Webhook"

    def __init__(self, base_url: str = "", webhook_url: str = "", secret: str = "") -> None:
        self.base_url = base_url.rstrip("/") if base_url else ""
        self.webhook_url = webhook_url or ""
        self.secret = secret or ""

    def _endpoint(self, site: dict[str, Any]) -> str:
        url = site.get("webhookUrl") or self.webhook_url
        if not url:
            raise ValueError("WEBHOOK_URL_NOT_CONFIGURED")
        return url

    def _headers(self, site: dict[str, Any]) -> dict[str, str]:
        headers = {"Content-Type": "application/json", "User-Agent": "ZhixinAI/1.0"}
        secret = site.get("webhookSecret") or self.secret
        if secret:
            headers["X-Webhook-Secret"] = secret
        return headers

    def _article_payload(self, article: dict[str, Any], site: dict[str, Any]) -> dict[str, Any]:
        slug = _slug(article.get("title") or article.get("keyword") or article["id"])
        base = (site.get("baseUrl") or self.base_url or "https://example.com").rstrip("/")
        return {
            "id": article["id"],
            "title": article.get("title") or "",
            "seoTitle": article.get("seoTitle") or article.get("title") or "",
            "metaDescription": article.get("metaDescription") or article.get("summary") or "",
            "keyword": article.get("keyword") or "",
            "keywords": article.get("keywords") or [],
            "tags": article.get("tags") or [],
            "contentMarkdown": article.get("contentMarkdown") or "",
            "status": article.get("status") or "ready",
            "source": "zhixin-ai",
            "slug": slug,
            "defaultUrl": f"{base}/articles/{slug}",
            "category": site.get("defaultCategory") or "",
            "siteTags": site.get("defaultTags") or [],
        }

    def publish(self, article: dict[str, Any], site: dict[str, Any]) -> dict[str, Any]:
        endpoint = self._endpoint(site)
        payload = self._article_payload(article, site)
        response = httpx.post(
            endpoint,
            json=payload,
            headers=self._headers(site),
            timeout=30,
            follow_redirects=True,
        )
        response.raise_for_status()
        data = response.json() if response.content else {}
        published_url = str(data.get("url") or data.get("permalink") or "").strip()
        if not published_url:
            raise ValueError(
                f"WEBHOOK_PUBLISH_NO_URL: webhook returned HTTP {response.status_code} "
                "but the response body contained no 'url' or 'permalink' field. "
                "The receiver must return {{\"url\": \"https://...\"}}"
            )
        return {
            "publishedUrl": published_url,
            "externalId": str(data.get("id") or data.get("post_id") or ""),
            "status": "succeeded",
            "adapterType": self.adapter_type,
            "response": data,
        }

    def update(self, article: dict[str, Any], site: dict[str, Any], external_id: str) -> dict[str, Any]:
        endpoint = self._endpoint(site)
        if external_id:
            endpoint = f"{endpoint.rstrip('/')}/{external_id}"
        payload = self._article_payload(article, site)
        response = httpx.put(endpoint, json=payload, headers=self._headers(site), timeout=30, follow_redirects=True)
        response.raise_for_status()
        data = response.json() if response.content else {}
        slug = _slug(article.get("title") or article["id"])
        base = (site.get("baseUrl") or "https://example.com").rstrip("/")
        return {
            "publishedUrl": data.get("url") or data.get("permalink") or f"{base}/articles/{slug}",
            "externalId": external_id,
            "status": "succeeded",
            "adapterType": self.adapter_type,
            "response": data,
        }


class WordPressCmsAdapter(CmsAdapter):
    """Publishes articles to a WordPress site using the REST API.

    Authentication: Application Passwords (WP 5.6+).
    Configure via site fields:
      baseUrl:       https://your-site.com
      wpUsername:    your-wp-user
      wpAppPassword: xxxx xxxx xxxx xxxx xxxx xxxx
    """

    adapter_type = "WordPress"

    def __init__(self, base_url: str = "", username: str = "", app_password: str = "") -> None:
        self.base_url = base_url.rstrip("/") if base_url else ""
        self.username = username or ""
        self.app_password = app_password or ""

    def _auth(self, site: dict[str, Any]) -> tuple[str, str] | None:
        username = site.get("wpUsername") or self.username
        password = site.get("wpAppPassword") or self.app_password
        if not username or not password:
            return None
        return (username, password)

    def _api_base(self, site: dict[str, Any]) -> str:
        base = (site.get("baseUrl") or self.base_url or "").rstrip("/")
        if not base:
            raise ValueError("WORDPRESS_BASE_URL_NOT_CONFIGURED")
        return f"{base}/wp-json/wp/v2"

    def _resolve_term_ids(
        self,
        api_base: str,
        auth: tuple[str, str],
        taxonomy: str,
        names: list[str],
    ) -> list[int]:
        """Look up (or create) WordPress tag/category IDs by name.

        Attempts a search first; creates the term if not found.
        Silently skips any term that fails to resolve.
        """
        ids: list[int] = []
        for name in names:
            name = name.strip()
            if not name:
                continue
            try:
                r = httpx.get(
                    f"{api_base}/{taxonomy}",
                    params={"search": name, "per_page": 5},
                    auth=auth,
                    timeout=10,
                )
                r.raise_for_status()
                items = r.json() if isinstance(r.json(), list) else []
                match = next(
                    (item for item in items if item.get("name", "").lower() == name.lower()),
                    None,
                )
                if match:
                    ids.append(int(match["id"]))
                else:
                    rc = httpx.post(
                        f"{api_base}/{taxonomy}",
                        json={"name": name},
                        auth=auth,
                        headers={"Content-Type": "application/json"},
                        timeout=10,
                    )
                    rc.raise_for_status()
                    ids.append(int(rc.json()["id"]))
            except Exception:
                # Non-fatal: skip unresolvable terms
                pass
        return ids

    def _build_wp_body(self, article: dict[str, Any], site: dict[str, Any]) -> dict[str, Any]:
        content = article.get("contentMarkdown") or ""
        html_content = _markdown_to_simple_html(content)
        return {
            "title": article.get("title") or article.get("keyword") or "Untitled",
            "content": html_content,
            "excerpt": article.get("metaDescription") or article.get("summary") or "",
            "status": "publish",
            "slug": _slug(article.get("title") or article.get("keyword") or article["id"]),
            "meta": {
                "_yoast_wpseo_metadesc": article.get("metaDescription") or "",
                "_yoast_wpseo_title": article.get("seoTitle") or article.get("title") or "",
                "zhixin_ai_id": article.get("id") or "",
                "zhixin_ai_keyword": article.get("keyword") or "",
            },
        }

    def publish(self, article: dict[str, Any], site: dict[str, Any]) -> dict[str, Any]:
        api_base = self._api_base(site)
        auth = self._auth(site)
        if not auth:
            raise ValueError("WORDPRESS_AUTH_NOT_CONFIGURED")
        body = self._build_wp_body(article, site)

        # Resolve tag and category names to WP term IDs.
        all_tag_names = list(article.get("tags") or []) + list(site.get("defaultTags") or [])
        category_name = str(site.get("defaultCategory") or article.get("articleType") or "").strip()
        tag_ids = self._resolve_term_ids(api_base, auth, "tags", all_tag_names)
        cat_ids = self._resolve_term_ids(api_base, auth, "categories", [category_name] if category_name else [])
        body["tags"] = tag_ids
        body["categories"] = cat_ids

        response = httpx.post(
            f"{api_base}/posts",
            json=body,
            auth=auth,
            headers={"Content-Type": "application/json"},
            timeout=30,
            follow_redirects=True,
        )
        response.raise_for_status()
        data = response.json()
        published_url = str(data.get("link") or data.get("guid", {}).get("rendered") or "").strip()
        if not published_url:
            raise ValueError(
                f"WORDPRESS_PUBLISH_NO_URL: post created (id={data.get('id')}) "
                "but 'link' field is empty in the response."
            )
        return {
            "publishedUrl": published_url,
            "externalId": str(data.get("id") or ""),
            "status": "succeeded",
            "adapterType": self.adapter_type,
            "wpPostId": data.get("id"),
            "wpSlug": data.get("slug") or "",
            "response": {k: v for k, v in data.items() if k in ("id", "link", "slug", "status", "date")},
        }

    def update(self, article: dict[str, Any], site: dict[str, Any], external_id: str) -> dict[str, Any]:
        api_base = self._api_base(site)
        auth = self._auth(site)
        if not auth:
            raise ValueError("WORDPRESS_AUTH_NOT_CONFIGURED")
        body = self._build_wp_body(article, site)
        response = httpx.put(
            f"{api_base}/posts/{external_id}",
            json=body,
            auth=auth,
            headers={"Content-Type": "application/json"},
            timeout=30,
            follow_redirects=True,
        )
        response.raise_for_status()
        data = response.json()
        return {
            "publishedUrl": data.get("link") or data.get("guid", {}).get("rendered") or "",
            "externalId": external_id,
            "status": "succeeded",
            "adapterType": self.adapter_type,
            "response": {k: v for k, v in data.items() if k in ("id", "link", "slug", "status", "date")},
        }


def _markdown_to_simple_html(content: str) -> str:
    """Convert basic Markdown to HTML suitable for WordPress REST API."""
    import html as html_module

    lines = content.splitlines()
    output: list[str] = []
    in_list = False

    for line in lines:
        stripped = line.strip()

        # Headings
        if stripped.startswith("### "):
            if in_list:
                output.append("</ul>")
                in_list = False
            output.append(f"<h3>{html_module.escape(stripped[4:])}</h3>")
        elif stripped.startswith("## "):
            if in_list:
                output.append("</ul>")
                in_list = False
            output.append(f"<h2>{html_module.escape(stripped[3:])}</h2>")
        elif stripped.startswith("# "):
            if in_list:
                output.append("</ul>")
                in_list = False
            output.append(f"<h1>{html_module.escape(stripped[2:])}</h1>")
        # List items
        elif stripped.startswith("- ") or stripped.startswith("* "):
            if not in_list:
                output.append("<ul>")
                in_list = True
            output.append(f"<li>{html_module.escape(stripped[2:])}</li>")
        # Blank line
        elif not stripped:
            if in_list:
                output.append("</ul>")
                in_list = False
            output.append("")
        # Normal paragraph line
        else:
            if in_list:
                output.append("</ul>")
                in_list = False
            output.append(f"<p>{html_module.escape(stripped)}</p>")

    if in_list:
        output.append("</ul>")

    return "\n".join(output)


def get_cms_adapter(site: dict[str, Any]) -> CmsAdapter:
    """Return the appropriate CMS adapter for a site record."""
    site_type = str(site.get("type") or site.get("siteType") or "Webhook")
    if site_type == "WordPress":
        base = site.get("baseUrl") or ""
        username = site.get("wpUsername") or ""
        password = site.get("wpAppPassword") or ""
        return WordPressCmsAdapter(base_url=base, username=username, app_password=password)
    # Default: Webhook
    return WebhookCmsAdapter(
        base_url=site.get("baseUrl") or "",
        webhook_url=site.get("webhookUrl") or "",
        secret=site.get("webhookSecret") or "",
    )
