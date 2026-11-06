from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from app.csdn_public_snapshot import (
    CsdnPublicSnapshotError,
    fetch_csdn_public_snapshot,
    validate_csdn_public_url,
)
from app.config import get_settings
from app.main import app


PUBLIC_URL = "https://blog.csdn.net/zhixin_ai/article/details/163452814"


def test_fetches_canonical_csdn_article_and_extracts_only_article_content() -> None:
    html = """
    <html>
      <head><title>Gate 5 article - CSDN</title></head>
      <body>
        <img src="https://i-blog.csdnimg.cn/navigation.png">
        <article>
          <div id="content_views">
            <h2>Public body marker</h2>
            <p>The public article is visible.</p>
            <img src="https://i-blog.csdnimg.cn/body.png">
          </div>
        </article>
        <img src="https://i-blog.csdnimg.cn/recommendation.png">
      </body>
    </html>
    """

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == PUBLIC_URL
        return httpx.Response(200, text=html, request=request)

    snapshot = fetch_csdn_public_snapshot(
        PUBLIC_URL,
        transport=httpx.MockTransport(handler),
    )

    assert snapshot == {
        "status": 200,
        "url": PUBLIC_URL,
        "title": "Gate 5 article - CSDN",
        "text": "Public body marker The public article is visible.",
        "contentText": "Public body marker The public article is visible.",
        "imageUrls": ["https://i-blog.csdnimg.cn/body.png"],
    }


@pytest.mark.parametrize(
    "url",
    [
        "http://blog.csdn.net/zhixin_ai/article/details/163452814",
        "https://csdn.net/zhixin_ai/article/details/163452814",
        "https://evil.blog.csdn.net/zhixin_ai/article/details/163452814",
        "https://blog.csdn.net.evil.example/zhixin_ai/article/details/163452814",
        "https://user@blog.csdn.net/zhixin_ai/article/details/163452814",
        "https://blog.csdn.net:443/zhixin_ai/article/details/163452814",
        "https://blog.csdn.net/zhixin_ai/article/details/not-a-number",
        "https://blog.csdn.net/zhixin_ai/profile",
        "https://blog.csdn.net/zhixin_ai/article/details/163452814?spm=1001",
        "https://blog.csdn.net/zhixin_ai/article/details/163452814#section",
    ],
)
def test_rejects_any_url_outside_the_exact_csdn_article_shape(url: str) -> None:
    with pytest.raises(CsdnPublicSnapshotError, match="CSDN_PUBLIC_URL_INVALID"):
        validate_csdn_public_url(url)


@pytest.mark.parametrize(
    "location",
    [
        "https://example.com/internal",
        "https://blog.csdn.net/other_user/article/details/163452814",
        "https://blog.csdn.net/zhixin_ai/article/details/999999999",
    ],
)
def test_rejects_redirects_outside_the_original_article(location: str) -> None:
    requested_urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested_urls.append(str(request.url))
        return httpx.Response(302, headers={"location": location}, request=request)

    with pytest.raises(CsdnPublicSnapshotError, match="CSDN_PUBLIC_REDIRECT_INVALID"):
        fetch_csdn_public_snapshot(
            PUBLIC_URL,
            transport=httpx.MockTransport(handler),
        )

    assert requested_urls == [PUBLIC_URL]


def test_follows_a_bounded_redirect_that_keeps_the_original_article_identity() -> None:
    redirected_url = f"{PUBLIC_URL}/"
    requested_urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested_urls.append(str(request.url))
        if str(request.url) == PUBLIC_URL:
            return httpx.Response(302, headers={"location": redirected_url}, request=request)
        return httpx.Response(
            200,
            text='<html><title>Article</title><div id="content_views">Body</div></html>',
            request=request,
        )

    snapshot = fetch_csdn_public_snapshot(
        PUBLIC_URL,
        transport=httpx.MockTransport(handler),
    )

    assert requested_urls == [PUBLIC_URL, redirected_url]
    assert snapshot["url"] == redirected_url
    assert snapshot["contentText"] == "Body"


def test_rejects_a_page_without_the_csdn_article_body() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            text="<html><title>Soft unavailable</title><body>Not an article.</body></html>",
            request=request,
        )

    with pytest.raises(CsdnPublicSnapshotError, match="CSDN_PUBLIC_CONTENT_MISSING"):
        fetch_csdn_public_snapshot(
            PUBLIC_URL,
            transport=httpx.MockTransport(handler),
        )


def test_public_snapshot_route_is_public_but_neighboring_paths_are_not(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    expected = {
        "status": 200,
        "url": PUBLIC_URL,
        "title": "Gate 5 article",
        "text": "Public body marker",
        "contentText": "Public body marker",
        "imageUrls": ["https://i-blog.csdnimg.cn/body.png"],
    }
    monkeypatch.setenv("AUTH_TEST_BYPASS_USER_ID", "")
    get_settings.cache_clear()
    monkeypatch.setattr(
        "app.routes.public_snapshot.fetch_csdn_public_snapshot",
        lambda url: expected if url == PUBLIC_URL else None,
    )

    try:
        with TestClient(app) as client:
            response = client.post("/api/public-snapshots/csdn", json={"url": PUBLIC_URL})
            neighboring = client.post(
                "/api/public-snapshots/csdn/anything",
                json={"url": PUBLIC_URL},
            )
    finally:
        get_settings.cache_clear()

    assert response.status_code == 200
    assert response.json() == expected
    assert neighboring.status_code == 401
    assert neighboring.json()["detail"] == "AUTHENTICATION_REQUIRED"


def test_public_snapshot_route_maps_invalid_input_to_400(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AUTH_TEST_BYPASS_USER_ID", "")
    get_settings.cache_clear()
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/public-snapshots/csdn",
                json={"url": "https://example.com/internal"},
            )
    finally:
        get_settings.cache_clear()

    assert response.status_code == 400
    assert response.json()["detail"] == "CSDN_PUBLIC_URL_INVALID"


def test_public_snapshot_route_maps_upstream_failure_to_502(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail(_url: str) -> dict:
        raise CsdnPublicSnapshotError("CSDN_PUBLIC_FETCH_FAILED")

    monkeypatch.setenv("AUTH_TEST_BYPASS_USER_ID", "")
    get_settings.cache_clear()
    monkeypatch.setattr("app.routes.public_snapshot.fetch_csdn_public_snapshot", fail)
    try:
        with TestClient(app) as client:
            response = client.post("/api/public-snapshots/csdn", json={"url": PUBLIC_URL})
    finally:
        get_settings.cache_clear()

    assert response.status_code == 502
    assert response.json()["detail"] == "CSDN_PUBLIC_FETCH_FAILED"
