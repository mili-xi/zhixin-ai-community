import os
from pathlib import Path

os.environ["DATABASE_URL"] = f"sqlite:///{Path(__file__).parent / 'test.sqlite'}"
os.environ["DEEPSEEK_OFFLINE_MODE"] = "true"

import httpx

from app.seo_provider import HttpSeoProvider


def response(status_code, json):
    return httpx.Response(status_code, json=json, request=httpx.Request("POST", "https://seo-provider.test"))


def test_http_seo_provider_posts_to_task_endpoint_with_auth_header(monkeypatch):
    calls = []

    def fake_post(url, json, headers, timeout):
        calls.append({"url": url, "json": json, "headers": headers, "timeout": timeout})
        return response(200, {"provider": "seo-api", "keywords": [{"word": "AI SEO"}]})

    monkeypatch.setattr(httpx, "post", fake_post)

    result = HttpSeoProvider(base_url="https://seo-provider.test/", api_key="secret").collect("keyword-discover", {"seed": "AI SEO"})

    assert result["provider"] == "seo-api"
    assert calls == [{
        "url": "https://seo-provider.test/keywords/discover",
        "json": {"seed": "AI SEO"},
        "headers": {"Content-Type": "application/json", "Authorization": "Bearer secret"},
        "timeout": 60,
    }]


def test_http_seo_provider_wraps_list_response(monkeypatch):
    monkeypatch.setattr(httpx, "post", lambda *args, **kwargs: response(200, [{"position": 1}]))

    result = HttpSeoProvider(base_url="https://seo-provider.test").collect("serp-collect", {"keyword": "AI SEO"})

    assert result == {"items": [{"position": 1}]}


def test_http_seo_provider_returns_pending_when_unconfigured():
    result = HttpSeoProvider(base_url="", api_key="").collect("ranking-check", {"keyword": "AI SEO"})

    assert result["status"] == "provider_pending"
