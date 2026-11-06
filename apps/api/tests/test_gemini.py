from __future__ import annotations

import base64

import httpx
import pytest

from app.config import Settings
from app.gemini import GeminiClient, GeminiProviderError
from app.llm import offline_article


class FakeHttp:
    def __init__(self, responses: list[httpx.Response]):
        self.responses = list(responses)
        self.calls: list[tuple[str, dict]] = []

    def post(self, url: str, **kwargs):
        self.calls.append((url, kwargs))
        return self.responses.pop(0)


def response(status_code: int, payload: dict, url: str) -> httpx.Response:
    return httpx.Response(status_code, json=payload, request=httpx.Request("POST", url))


def settings(api_key: str = "test-secret-key") -> Settings:
    return Settings(
        database_url="sqlite://",
        gemini_api_key=api_key,
        gemini_base_url="https://generativelanguage.googleapis.com",
        gemini_text_model="gemini-3.5-flash",
        gemini_image_model="gemini-3.1-flash-image",
        gemini_offline_mode=False,
    )


def test_generate_article_uses_configured_flash_model_and_parses_json():
    url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent"
    http = FakeHttp([response(200, {
        "candidates": [{"content": {"parts": [{"text": '{"title":"可读文章","contentMarkdown":"正文"}'}]}}],
    }, url)])
    client = GeminiClient(settings(), http_client=http)

    result = client.generate_article({"keyword": "AI SEO"})

    assert result["title"] == "可读文章"
    called_url, kwargs = http.calls[0]
    assert called_url == url
    assert kwargs["headers"]["x-goog-api-key"] == "test-secret-key"
    assert kwargs["json"]["generationConfig"]["responseMimeType"] == "application/json"


def test_generate_image_uses_interactions_and_decodes_image_output():
    image_bytes = b"\x89PNG\r\n\x1a\nimage"
    url = "https://generativelanguage.googleapis.com/v1beta/interactions"
    http = FakeHttp([response(200, {
        "id": "interaction-1",
        "outputs": [{
            "type": "image",
            "data": base64.b64encode(image_bytes).decode("ascii"),
            "mime_type": "image/png",
        }],
    }, url)])
    client = GeminiClient(settings(), http_client=http)

    result = client.generate_image({"prompt": "生成一张 AI SEO 封面", "aspectRatio": "16:9"})

    assert result["data"] == image_bytes
    assert result["mimeType"] == "image/png"
    assert result["interactionId"] == "interaction-1"
    called_url, kwargs = http.calls[0]
    assert called_url == url
    assert kwargs["json"]["model"] == "gemini-3.1-flash-image"
    assert kwargs["json"]["response_format"]["aspect_ratio"] == "16:9"
    assert kwargs["json"]["response_format"]["mime_type"] == "image/jpeg"


def test_generate_image_accepts_inline_data_response_shape():
    image_bytes = b"jpeg-image"
    url = "https://generativelanguage.googleapis.com/v1beta/interactions"
    http = FakeHttp([response(200, {
        "id": "interaction-inline-data",
        "candidates": [{"content": {"parts": [{
            "inlineData": {
                "mimeType": "image/jpeg",
                "data": base64.b64encode(image_bytes).decode("ascii"),
            },
        }]}}],
    }, url)])

    result = GeminiClient(settings(), http_client=http).generate_image({"prompt": "封面"})

    assert result["data"] == image_bytes
    assert result["mimeType"] == "image/jpeg"


def test_transient_rate_limit_is_retried_before_success():
    url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent"
    http = FakeHttp([
        response(429, {"error": {"message": "rate limited"}}, url),
        response(200, {"candidates": [{"content": {"parts": [{"text": '{"title":"重试成功","contentMarkdown":"正文"}'}]}}]}, url),
    ])
    delays = []
    client = GeminiClient(settings(), http_client=http, sleeper=delays.append)

    result = client.generate_article({"keyword": "重试"})

    assert result["title"] == "重试成功"
    assert len(http.calls) == 2
    assert delays == [1]


def test_provider_error_redacts_api_key():
    secret = "do-not-leak-this-key"
    url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent"
    http = FakeHttp([response(401, {"error": {"message": f"invalid key {secret}"}}, url)])
    client = GeminiClient(settings(secret), http_client=http)

    with pytest.raises(GeminiProviderError) as caught:
        client.generate_article({"keyword": "AI SEO"})

    assert secret not in str(caught.value)
    assert caught.value.code == "GEMINI_AUTH_FAILED"


def test_offline_article_is_readable_chinese_and_matches_illustrated_contract():
    article = offline_article({"keyword": "AI SEO", "rule": {"name": "专业长文"}})

    assert "增长方案" in article["title"]
    assert "创作目标" in article["contentMarkdown"]
    assert "锛" not in article["contentMarkdown"]
    assert len(article["sections"]) >= 2
    assert article["imageBriefs"][0]["purpose"] == "cover"
