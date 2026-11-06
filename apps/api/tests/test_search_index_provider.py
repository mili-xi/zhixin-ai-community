import os
from pathlib import Path

os.environ["DATABASE_URL"] = f"sqlite:///{Path(__file__).parent / 'test.sqlite'}"

import httpx

from app.search_index_provider import (
    BaiduIndexProvider,
    DataForSeoIndexObserver,
    GoogleSearchConsoleProvider,
    IndexNowProvider,
    SearchIndexService,
)
from app.config import Settings


def response(status_code: int, payload: dict | None = None, method: str = "POST", url: str = "https://provider.test") -> httpx.Response:
    return httpx.Response(status_code, json=payload or {}, request=httpx.Request(method, url))


class FakeHttp:
    def __init__(self, *, post_response: httpx.Response | None = None, put_response: httpx.Response | None = None):
        self.post_response = post_response
        self.put_response = put_response
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append(("POST", url, kwargs))
        assert self.post_response is not None
        return self.post_response

    def put(self, url, **kwargs):
        self.calls.append(("PUT", url, kwargs))
        assert self.put_response is not None
        return self.put_response


def test_google_url_inspection_maps_official_pass_verdict_to_indexed():
    http = FakeHttp(post_response=response(200, {
        "inspectionResult": {
            "inspectionResultLink": "https://search.google.com/search-console/inspect/example",
            "indexStatusResult": {
                "verdict": "PASS",
                "coverageState": "Submitted and indexed",
                "indexingState": "INDEXING_ALLOWED",
                "pageFetchState": "SUCCESSFUL",
                "lastCrawlTime": "2026-07-11T02:30:00Z",
                "googleCanonical": "https://example.com/articles/ai-seo",
            },
        }
    }))
    provider = GoogleSearchConsoleProvider(
        site_url="https://example.com/",
        sitemap_url="https://example.com/sitemap.xml",
        token_loader=lambda: "google-token",
        http_client=http,
    )

    result = provider.inspect("https://example.com/articles/ai-seo", "AI SEO")

    assert result["inclusionStatus"] == "indexed"
    assert result["verificationLevel"] == "official"
    assert result["verificationMethod"] == "google_url_inspection"
    assert result["evidence"]["verdict"] == "PASS"
    method, url, kwargs = http.calls[0]
    assert method == "POST"
    assert url == "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect"
    assert kwargs["headers"]["Authorization"] == "Bearer google-token"
    assert kwargs["json"] == {
        "inspectionUrl": "https://example.com/articles/ai-seo",
        "siteUrl": "https://example.com/",
        "languageCode": "zh-CN",
    }


def test_google_generic_url_submission_uses_verified_sitemap_instead_of_indexing_api():
    http = FakeHttp(put_response=response(204, {}, method="PUT"))
    provider = GoogleSearchConsoleProvider(
        site_url="https://example.com/",
        sitemap_url="https://example.com/sitemap.xml",
        token_loader=lambda: "google-token",
        http_client=http,
    )

    result = provider.submit("https://example.com/articles/new")

    assert result["status"] == "accepted"
    assert result["submitted"] is True
    assert result["submissionMethod"] == "google_sitemap"
    assert "indexing API" not in result["providerMessage"].lower()
    assert http.calls[0][0] == "PUT"
    assert "/webmasters/v3/sites/https%3A%2F%2Fexample.com%2F/sitemaps/https%3A%2F%2Fexample.com%2Fsitemap.xml" in http.calls[0][1]


def test_baidu_push_persists_real_acceptance_receipt_and_rejects_foreign_hosts():
    http = FakeHttp(post_response=response(200, {"remain": 99, "success": 1, "not_same_site": [], "not_valid": []}))
    provider = BaiduIndexProvider(site_url="https://example.cn", token="baidu-token", http_client=http)

    accepted = provider.submit("https://example.cn/articles/seo")
    foreign = provider.submit("https://zhuanlan.zhihu.com/p/123")

    assert accepted["status"] == "accepted"
    assert accepted["submitted"] is True
    assert accepted["providerResponse"]["success"] == 1
    assert foreign["status"] == "rejected"
    assert foreign["submitted"] is False
    assert foreign["reason"] == "URL_OUTSIDE_VERIFIED_SITE"
    assert len(http.calls) == 1


def test_indexnow_202_is_accepted_receipt_not_inclusion_confirmation():
    http = FakeHttp(post_response=response(202, {}))
    provider = IndexNowProvider(
        key="abcd1234",
        key_location="https://example.com/abcd1234.txt",
        http_client=http,
    )

    result = provider.submit("https://example.com/articles/new")

    assert result["status"] == "accepted"
    assert result["submitted"] is True
    assert result["providerResponse"]["httpStatus"] == 202
    assert result["inclusionStatus"] == "unchecked"
    assert result["verificationLevel"] == "unavailable"


def test_dataforseo_observer_records_search_result_evidence_for_external_media_url():
    target = "https://zhuanlan.zhihu.com/p/123456"
    http = FakeHttp(post_response=response(200, {
        "status_code": 20000,
        "tasks": [{"result": [{"items": [{"type": "organic", "url": target, "title": "AI SEO"}]}]}],
    }))
    observer = DataForSeoIndexObserver(login="login", password="password", http_client=http)

    result = observer.inspect("google", target, "AI SEO")

    assert result["inclusionStatus"] == "indexed"
    assert result["verificationLevel"] == "observed"
    assert result["verificationMethod"] == "dataforseo_google_serp"
    assert result["evidence"]["matchedUrl"] == target
    assert http.calls[0][2]["json"][0]["language_code"] == "zh-CN"


def test_dataforseo_no_match_is_unconfirmed_not_proof_of_non_inclusion():
    http = FakeHttp(post_response=response(200, {
        "status_code": 20000,
        "tasks": [{"result": [{"items": [{"type": "organic", "url": "https://example.com/another-page"}]}]}],
    }))
    observer = DataForSeoIndexObserver(login="login", password="password", http_client=http)

    result = observer.inspect("baidu", "https://example.com/articles/target")

    assert result["inclusionStatus"] == "unchecked"
    assert result["verificationLevel"] == "observed"
    assert result["evidence"]["matchedUrl"] == ""


def test_dataforseo_no_search_results_is_unchecked_not_task_failure():
    http = FakeHttp(post_response=response(200, {
        "status_code": 20000,
        "tasks": [{"status_code": 40102, "status_message": "No Search Results.", "result": []}],
    }))
    observer = DataForSeoIndexObserver(login="login", password="password", http_client=http)

    result = observer.inspect("bing", "https://zhuanlan.zhihu.com/p/no-result")

    assert result["inclusionStatus"] == "unchecked"
    assert result["verificationLevel"] == "observed"
    assert result["verificationMethod"] == "dataforseo_bing_serp"
    assert result["evidence"]["observedUrls"] == []


def test_dataforseo_account_verification_required_is_provider_pending():
    http = FakeHttp(post_response=response(403, {
        "status_code": 40104,
        "status_message": "Please verify your account before using the API.",
    }))
    observer = DataForSeoIndexObserver(login="login", password="password", http_client=http)

    result = observer.inspect("google", "https://example.com/articles/target")

    assert result["status"] == "provider_pending"
    assert result["inclusionStatus"] == "unchecked"
    assert result["reason"] == "DATAFORSEO_ACCOUNT_VERIFICATION_REQUIRED"


def test_dataforseo_requires_exact_query_string_match_for_index_evidence():
    http = FakeHttp(post_response=response(200, {
        "status_code": 20000,
        "tasks": [{"result": [{"items": [{"type": "organic", "url": "https://example.com/article?id=other"}]}]}],
    }))
    observer = DataForSeoIndexObserver(login="login", password="password", http_client=http)

    result = observer.inspect("google", "https://example.com/article?id=target")

    assert result["inclusionStatus"] == "unchecked"
    assert result["evidence"]["matchedUrl"] == ""


def test_search_index_service_treats_dataforseo_submit_as_observation_only():
    service = SearchIndexService(settings=Settings(
        _env_file=None,
        dataforseo_login="login",
        dataforseo_password="password",
    ))

    result = service.submit({
        "provider": "DataForSEO",
        "url": "https://zhuanlan.zhihu.com/p/123456789",
    })

    assert result["provider"] == "DataForSEO"
    assert result["status"] == "provider_pending"
    assert result["submitted"] is False
    assert result["reason"] == "DATAFORSEO_OBSERVATION_ONLY"


def test_search_index_service_inspects_dataforseo_observation_provider():
    target_url = "https://zhuanlan.zhihu.com/p/123456789"
    http = FakeHttp(post_response=response(200, {
        "status_code": 20000,
        "tasks": [{"result": [{"items": [{"type": "organic", "url": target_url}]}]}],
    }))
    service = SearchIndexService(
        settings=Settings(_env_file=None, dataforseo_login="login", dataforseo_password="password"),
        http_client=http,
    )

    result = service.inspect({"provider": "DataForSEO", "url": target_url})

    assert result["inclusionStatus"] == "indexed"
    assert result["verificationMethod"] == "dataforseo_google_serp"
    assert http.calls[0][1].endswith("/google/organic/live/advanced")


def test_runtime_status_rejects_invalid_google_service_account_payload():
    settings = Settings(
        _env_file=None,
        google_search_console_credentials_json_b64="not-valid-base64",
        google_search_console_site_url="https://example.com/",
        google_search_console_sitemap_url="https://example.com/sitemap.xml",
    )

    google = next(item for item in SearchIndexService(settings=settings).statuses() if item["provider"] == "Google")

    assert google["configured"] is False
    assert "GOOGLE_SEARCH_CONSOLE_CREDENTIALS_INVALID" in google["configurationErrors"]


def test_runtime_status_rejects_malformed_indexnow_configuration():
    settings = Settings(
        _env_file=None,
        indexnow_key="short",
        indexnow_key_location="not-a-public-url",
    )

    indexnow = next(item for item in SearchIndexService(settings=settings).statuses() if item["provider"] == "IndexNow")

    assert indexnow["configured"] is False
    assert "INDEXNOW_KEY_INVALID" in indexnow["configurationErrors"]
    assert "INDEXNOW_KEY_LOCATION_INVALID" in indexnow["configurationErrors"]
