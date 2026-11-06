from __future__ import annotations

import base64
import json
import re
from typing import Any, Callable
from urllib.parse import quote, urlsplit, urlunsplit

import httpx

from .config import Settings, get_settings


GOOGLE_INSPECTION_URL = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect"
GOOGLE_WEBMASTERS_BASE_URL = "https://www.googleapis.com/webmasters/v3"
BAIDU_PUSH_URL = "https://data.zz.baidu.com/urls"
INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow"
DATAFORSEO_BASE_URL = "https://api.dataforseo.com/v3/serp"


def canonical_url(value: str, *, include_query: bool = True) -> str:
    parsed = urlsplit(str(value or "").strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    path = parsed.path.rstrip("/") or "/"
    return urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), path, parsed.query if include_query else "", ""))


def url_belongs_to_site(url: str, site_url: str) -> bool:
    target = urlsplit(str(url or "").strip())
    site = str(site_url or "").strip()
    if not target.hostname or not site:
        return False
    if site.startswith("sc-domain:"):
        domain = site.removeprefix("sc-domain:").strip().lower().lstrip(".")
        host = target.hostname.lower()
        return host == domain or host.endswith(f".{domain}")
    prefix = canonical_url(site, include_query=False)
    candidate = canonical_url(url, include_query=False)
    if not prefix or not candidate:
        return False
    normalized_prefix = prefix.rstrip("/")
    return candidate == normalized_prefix or candidate.startswith(f"{normalized_prefix}/")


def pending_result(provider: str, operation: str, message: str, reason: str) -> dict[str, Any]:
    return {
        "provider": provider,
        "operation": operation,
        "status": "provider_pending",
        "submitted": False,
        "inclusionStatus": "unchecked",
        "verificationLevel": "unavailable",
        "verificationMethod": "provider_unavailable",
        "providerMessage": message,
        "providerResponse": {},
        "evidence": {},
        "reason": reason,
    }


def load_google_access_token(settings: Settings | None = None) -> str:
    current = settings or get_settings()
    raw_json = str(current.google_search_console_credentials_json or "").strip()
    encoded_json = str(current.google_search_console_credentials_json_b64 or "").strip()
    if not raw_json and encoded_json:
        try:
            raw_json = base64.b64decode(encoded_json, validate=True).decode("utf-8")
        except (ValueError, UnicodeDecodeError) as error:
            raise ValueError("GOOGLE_SEARCH_CONSOLE_CREDENTIALS_INVALID_BASE64") from error
    if not raw_json:
        raise ValueError("GOOGLE_SEARCH_CONSOLE_CREDENTIALS_REQUIRED")

    from google.auth.transport.requests import Request as GoogleAuthRequest
    from google.oauth2.service_account import Credentials

    credentials = Credentials.from_service_account_info(
        json.loads(raw_json),
        scopes=["https://www.googleapis.com/auth/webmasters"],
    )
    credentials.refresh(GoogleAuthRequest())
    if not credentials.token:
        raise ValueError("GOOGLE_SEARCH_CONSOLE_TOKEN_EMPTY")
    return str(credentials.token)


class GoogleSearchConsoleProvider:
    def __init__(
        self,
        *,
        site_url: str,
        sitemap_url: str = "",
        token_loader: Callable[[], str] | None = None,
        http_client: Any = httpx,
    ) -> None:
        self.site_url = str(site_url or "").strip()
        self.sitemap_url = str(sitemap_url or "").strip()
        self.token_loader = token_loader or load_google_access_token
        self.http = http_client

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token_loader()}",
            "Content-Type": "application/json",
        }

    def submit(self, url: str) -> dict[str, Any]:
        if not self.site_url:
            return pending_result("Google", "submit", "缺少 Google Search Console 站点属性。", "GOOGLE_SITE_URL_REQUIRED")
        if not url_belongs_to_site(url, self.site_url):
            return {
                **pending_result("Google", "submit", "URL 不属于已验证的 Google Search Console 站点。", "URL_OUTSIDE_VERIFIED_SITE"),
                "status": "rejected",
            }
        if not self.sitemap_url:
            return pending_result(
                "Google",
                "submit",
                "Google 不为普通文章提供单 URL 推送，请配置站点 Sitemap 并通过 Search Console 提交。",
                "GOOGLE_SITEMAP_REQUIRED",
            )
        try:
            headers = self._headers()
        except (ValueError, json.JSONDecodeError) as error:
            return pending_result("Google", "submit", str(error), "GOOGLE_CREDENTIALS_REQUIRED")
        endpoint = (
            f"{GOOGLE_WEBMASTERS_BASE_URL}/sites/{quote(self.site_url, safe='')}"
            f"/sitemaps/{quote(self.sitemap_url, safe='')}"
        )
        response = self.http.put(endpoint, headers=headers, timeout=30)
        response.raise_for_status()
        return {
            "provider": "Google",
            "operation": "submit",
            "status": "accepted",
            "submitted": True,
            "submissionMethod": "google_sitemap",
            "inclusionStatus": "unchecked",
            "verificationLevel": "unavailable",
            "verificationMethod": "google_sitemap_submission",
            "providerMessage": "Google Search Console 已接收 Sitemap，这不代表当前 URL 已被收录。",
            "providerResponse": {"httpStatus": response.status_code, "sitemapUrl": self.sitemap_url},
            "evidence": {},
        }

    def inspect(self, url: str, title: str = "") -> dict[str, Any]:
        del title
        if not self.site_url:
            return pending_result("Google", "inspect", "缺少 Google Search Console 站点属性。", "GOOGLE_SITE_URL_REQUIRED")
        if not url_belongs_to_site(url, self.site_url):
            return pending_result(
                "Google",
                "inspect",
                "该 URL 不属于当前 Search Console 站点，无法执行官方检查。",
                "URL_OUTSIDE_VERIFIED_SITE",
            )
        try:
            headers = self._headers()
        except (ValueError, json.JSONDecodeError) as error:
            return pending_result("Google", "inspect", str(error), "GOOGLE_CREDENTIALS_REQUIRED")
        response = self.http.post(
            GOOGLE_INSPECTION_URL,
            headers=headers,
            json={"inspectionUrl": url, "siteUrl": self.site_url, "languageCode": "zh-CN"},
            timeout=30,
        )
        response.raise_for_status()
        payload = response.json() if response.content else {}
        inspection = payload.get("inspectionResult") if isinstance(payload, dict) else {}
        inspection = inspection if isinstance(inspection, dict) else {}
        index_status = inspection.get("indexStatusResult")
        index_status = index_status if isinstance(index_status, dict) else {}
        verdict = str(index_status.get("verdict") or "").upper()
        if verdict == "PASS":
            inclusion_status = "indexed"
        elif verdict in {"FAIL", "NEUTRAL"}:
            inclusion_status = "not_indexed"
        else:
            inclusion_status = "unchecked"
        coverage = str(index_status.get("coverageState") or "")
        return {
            "provider": "Google",
            "operation": "inspect",
            "status": "verified",
            "submitted": False,
            "inclusionStatus": inclusion_status,
            "verificationLevel": "official",
            "verificationMethod": "google_url_inspection",
            "providerMessage": coverage or f"Google verdict: {verdict or 'UNKNOWN'}",
            "providerResponse": {"httpStatus": response.status_code},
            "evidence": {
                "verdict": verdict,
                "coverageState": coverage,
                "indexingState": index_status.get("indexingState") or "",
                "pageFetchState": index_status.get("pageFetchState") or "",
                "lastCrawlTime": index_status.get("lastCrawlTime") or "",
                "googleCanonical": index_status.get("googleCanonical") or "",
                "userCanonical": index_status.get("userCanonical") or "",
                "inspectionResultLink": inspection.get("inspectionResultLink") or "",
            },
        }


class BaiduIndexProvider:
    def __init__(self, *, site_url: str, token: str, endpoint: str = BAIDU_PUSH_URL, http_client: Any = httpx) -> None:
        self.site_url = str(site_url or "").strip().rstrip("/")
        self.token = str(token or "").strip()
        self.endpoint = endpoint
        self.http = http_client

    def submit(self, url: str) -> dict[str, Any]:
        if not self.site_url or not self.token:
            return pending_result("Baidu", "submit", "缺少百度搜索资源平台站点或推送 Token。", "BAIDU_CREDENTIALS_REQUIRED")
        if not url_belongs_to_site(url, self.site_url):
            return {
                **pending_result("Baidu", "submit", "URL 不属于百度 Token 绑定站点。", "URL_OUTSIDE_VERIFIED_SITE"),
                "status": "rejected",
            }
        response = self.http.post(
            self.endpoint,
            params={"site": self.site_url, "token": self.token},
            content=f"{url}\n".encode("utf-8"),
            headers={"Content-Type": "text/plain"},
            timeout=30,
        )
        response.raise_for_status()
        payload = response.json() if response.content else {}
        success = int(payload.get("success") or 0) if isinstance(payload, dict) else 0
        accepted = success > 0
        provider_error = str(payload.get("message") or payload.get("error") or "") if isinstance(payload, dict) else ""
        return {
            "provider": "Baidu",
            "operation": "submit",
            "status": "accepted" if accepted else "rejected",
            "submitted": accepted,
            "submissionMethod": "baidu_normal_push",
            "inclusionStatus": "unchecked",
            "verificationLevel": "unavailable",
            "verificationMethod": "baidu_push_receipt",
            "providerMessage": (
                "百度已接收 URL；普通收录 API 只加快发现，不保证收录。"
                if accepted
                else provider_error or "百度未接收 URL，请检查站点归属与 URL 格式。"
            ),
            "providerResponse": {
                "httpStatus": response.status_code,
                "success": success,
                "remain": payload.get("remain") if isinstance(payload, dict) else None,
                "notSameSite": payload.get("not_same_site") if isinstance(payload, dict) else [],
                "notValid": payload.get("not_valid") if isinstance(payload, dict) else [],
            },
            "evidence": {},
        }


class IndexNowProvider:
    def __init__(
        self,
        *,
        key: str,
        key_location: str,
        endpoint: str = INDEXNOW_ENDPOINT,
        http_client: Any = httpx,
    ) -> None:
        self.key = str(key or "").strip()
        self.key_location = str(key_location or "").strip()
        self.endpoint = endpoint
        self.http = http_client

    def submit(self, url: str) -> dict[str, Any]:
        target = urlsplit(str(url or "").strip())
        key_location = urlsplit(self.key_location)
        if not re.fullmatch(r"[A-Za-z0-9-]{8,128}", self.key) or not key_location.hostname:
            return pending_result("IndexNow", "submit", "缺少有效的 IndexNow Key 或 Key 文件地址。", "INDEXNOW_CREDENTIALS_REQUIRED")
        if not target.hostname or target.hostname.lower() != key_location.hostname.lower():
            return {
                **pending_result("IndexNow", "submit", "URL 与 IndexNow Key 文件不属于同一主机。", "URL_OUTSIDE_VERIFIED_SITE"),
                "status": "rejected",
            }
        key_scope = key_location.path.rsplit("/", 1)[0].rstrip("/")
        if key_scope and not (target.path == key_scope or target.path.startswith(f"{key_scope}/")):
            return {
                **pending_result("IndexNow", "submit", "URL 不在 IndexNow Key 文件允许的路径范围内。", "URL_OUTSIDE_KEY_SCOPE"),
                "status": "rejected",
            }
        response = self.http.post(
            self.endpoint,
            json={"host": target.hostname, "key": self.key, "keyLocation": self.key_location, "urlList": [url]},
            headers={"Content-Type": "application/json; charset=utf-8"},
            timeout=30,
        )
        if response.status_code not in {200, 202}:
            response.raise_for_status()
        return {
            "provider": "IndexNow",
            "operation": "submit",
            "status": "accepted",
            "submitted": True,
            "submissionMethod": "indexnow",
            "inclusionStatus": "unchecked",
            "verificationLevel": "unavailable",
            "verificationMethod": "indexnow_receipt",
            "providerMessage": "IndexNow 已接收 URL；回执不代表搜索引擎已收录。",
            "providerResponse": {"httpStatus": response.status_code},
            "evidence": {},
        }


class DataForSeoIndexObserver:
    def __init__(self, *, login: str, password: str, http_client: Any = httpx) -> None:
        self.login = str(login or "").strip()
        self.password = str(password or "").strip()
        self.http = http_client

    def inspect(self, engine: str, url: str, title: str = "") -> dict[str, Any]:
        del title
        normalized_engine = str(engine or "").lower()
        if normalized_engine not in {"google", "baidu", "bing"}:
            return pending_result(engine, "inspect", "当前搜索结果观测引擎不受支持。", "OBSERVATION_ENGINE_UNSUPPORTED")
        if not self.login or not self.password:
            return pending_result(engine, "inspect", "缺少 DataForSEO 凭据，无法观测第三方媒体 URL。", "DATAFORSEO_CREDENTIALS_REQUIRED")
        endpoint = f"{DATAFORSEO_BASE_URL}/{normalized_engine}/organic/live/advanced"
        query = f"site:{url}"
        response = self.http.post(
            endpoint,
            json=[{
                "keyword": query,
                "language_code": "zh-CN",
                "location_code": 2156,
                "depth": 20,
                "device": "desktop",
                "os": "windows",
            }],
            auth=(self.login, self.password),
            headers={"Content-Type": "application/json"},
            timeout=60,
        )
        payload = response.json() if response.content else {}
        if response.status_code == 403 and isinstance(payload, dict) and payload.get("status_code") == 40104:
            return pending_result(
                normalized_engine.title(),
                "inspect",
                "DataForSEO 账号尚未完成后台验证，无法执行搜索结果观测。",
                "DATAFORSEO_ACCOUNT_VERIFICATION_REQUIRED",
            )
        response.raise_for_status()
        if isinstance(payload, dict) and payload.get("status_code") not in {None, 20000}:
            raise ValueError(f"DATAFORSEO_ERROR_{payload.get('status_code')}: {payload.get('status_message')}")
        target = canonical_url(url)
        matched_url = ""
        observed_urls: list[str] = []
        for task in payload.get("tasks") or []:
            if task.get("status_code") == 40102:
                continue
            if task.get("status_code") not in {None, 20000}:
                raise ValueError(f"DATAFORSEO_TASK_ERROR_{task.get('status_code')}: {task.get('status_message')}")
            for result in task.get("result") or []:
                for item in result.get("items") or []:
                    if str(item.get("type") or "") != "organic":
                        continue
                    item_url = str(item.get("url") or "")
                    if item_url:
                        observed_urls.append(item_url)
                    if canonical_url(item_url) == target:
                        matched_url = item_url
        return {
            "provider": normalized_engine.title(),
            "operation": "inspect",
            "status": "verified",
            "submitted": False,
            "inclusionStatus": "indexed" if matched_url else "unchecked",
            "verificationLevel": "observed",
            "verificationMethod": f"dataforseo_{normalized_engine}_serp",
            "providerMessage": (
                "搜索结果中发现该 URL。"
                if matched_url
                else "本次搜索结果观测未发现该 URL，不能据此断定未收录。"
            ),
            "providerResponse": {"httpStatus": response.status_code},
            "evidence": {
                "query": query,
                "matchedUrl": matched_url,
                "observedUrls": observed_urls[:10],
            },
        }


class SearchIndexService:
    def __init__(self, settings: Settings | None = None, http_client: Any = httpx) -> None:
        self.settings = settings or get_settings()
        google_loader = lambda: load_google_access_token(self.settings)
        self.google = GoogleSearchConsoleProvider(
            site_url=self.settings.google_search_console_site_url,
            sitemap_url=self.settings.google_search_console_sitemap_url,
            token_loader=google_loader,
            http_client=http_client,
        )
        self.baidu = BaiduIndexProvider(
            site_url=self.settings.baidu_search_site_url,
            token=self.settings.baidu_search_token,
            http_client=http_client,
        )
        self.indexnow = IndexNowProvider(
            key=self.settings.indexnow_key,
            key_location=self.settings.indexnow_key_location,
            endpoint=self.settings.indexnow_endpoint,
            http_client=http_client,
        )
        self.observer = DataForSeoIndexObserver(
            login=self.settings.dataforseo_login,
            password=self.settings.dataforseo_password,
            http_client=http_client,
        )
        self.http = http_client

    def submit(self, submission: dict[str, Any]) -> dict[str, Any]:
        provider = str(submission.get("provider") or "IndexNow")
        url = str(submission.get("url") or "")
        if provider == "Google":
            return self.google.submit(url)
        if provider == "Baidu":
            return self.baidu.submit(url)
        if provider == "IndexNow":
            return self.indexnow.submit(url)
        if provider == "Sitemap":
            return {**self.google.submit(url), "provider": "Sitemap"}
        if provider == "DataForSEO":
            return pending_result(
                "DataForSEO",
                "submit",
                "DataForSEO 是搜索结果观测服务，不会向搜索引擎提交第三方媒体 URL；已保留记录用于收录观察。",
                "DATAFORSEO_OBSERVATION_ONLY",
            )
        return pending_result(provider, "submit", "未知索引 Provider。", "PROVIDER_UNSUPPORTED")

    def inspect(self, submission: dict[str, Any]) -> dict[str, Any]:
        provider = str(submission.get("provider") or "IndexNow")
        url = str(submission.get("url") or "")
        title = str(submission.get("articleTitle") or "")
        observer_configured = bool(self.settings.dataforseo_login and self.settings.dataforseo_password)
        if provider in {"Google", "Sitemap"}:
            official = self.google.inspect(url, title)
            if official.get("verificationLevel") == "official" or not observer_configured:
                return official
            return self.observer.inspect("google", url, title)
        if provider == "Baidu":
            if observer_configured:
                return self.observer.inspect("baidu", url, title)
            return pending_result(
                "Baidu",
                "inspect",
                "百度普通收录 API 不提供单 URL 官方收录检查；可配置 DataForSEO 做搜索结果观测。",
                "BAIDU_INSPECTION_UNAVAILABLE",
            )
        if provider == "IndexNow":
            if observer_configured:
                return self.observer.inspect("bing", url, title)
            return pending_result(
                "IndexNow",
                "inspect",
                "IndexNow 只有提交回执；可配置 DataForSEO 观测 Bing 搜索结果。",
                "INDEXNOW_INSPECTION_UNAVAILABLE",
            )
        if provider == "DataForSEO":
            if observer_configured:
                return {**self.observer.inspect("google", url, title), "provider": "DataForSEO"}
            return pending_result(
                "DataForSEO",
                "inspect",
                "缺少 DataForSEO 凭据，无法观测第三方媒体 URL。",
                "DATAFORSEO_CREDENTIALS_REQUIRED",
            )
        return pending_result(provider, "inspect", "未知索引 Provider。", "PROVIDER_UNSUPPORTED")

    def check_availability(self, url: str) -> dict[str, Any]:
        if not canonical_url(url):
            return {"availabilityStatus": "unknown", "availabilityHttpStatus": None}
        headers = {"User-Agent": "ZhixinAI-AvailabilityChecker/1.0"}
        try:
            response = self.http.head(url, follow_redirects=True, timeout=10, headers=headers)
            if response.status_code in {405, 501}:
                response = self.http.get(url, follow_redirects=True, timeout=10, headers=headers)
            if 200 <= response.status_code < 400:
                status = "reachable"
            elif response.status_code in {404, 410, 451}:
                status = "unreachable"
            else:
                status = "unknown"
            return {"availabilityStatus": status, "availabilityHttpStatus": response.status_code}
        except Exception as error:
            return {
                "availabilityStatus": "unknown",
                "availabilityHttpStatus": None,
                "availabilityError": str(error),
            }

    def statuses(self) -> list[dict[str, Any]]:
        google_raw = str(self.settings.google_search_console_credentials_json or "").strip()
        google_b64 = str(self.settings.google_search_console_credentials_json_b64 or "").strip()
        google_configuration_errors: list[str] = []
        google_credentials = bool(google_raw or google_b64)
        if google_credentials:
            try:
                decoded = google_raw or base64.b64decode(google_b64, validate=True).decode("utf-8")
                credential_data = json.loads(decoded)
                required_keys = {"client_email", "private_key", "token_uri"}
                if credential_data.get("type") != "service_account" or not required_keys.issubset(credential_data):
                    raise ValueError("service account fields missing")
            except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
                google_credentials = False
                google_configuration_errors.append("GOOGLE_SEARCH_CONSOLE_CREDENTIALS_INVALID")
        observer = bool(self.settings.dataforseo_login and self.settings.dataforseo_password)
        google_inspection_missing = []
        if not google_credentials:
            google_inspection_missing.append("GOOGLE_SEARCH_CONSOLE_CREDENTIALS_JSON_B64")
        if not self.settings.google_search_console_site_url:
            google_inspection_missing.append("GOOGLE_SEARCH_CONSOLE_SITE_URL")
        google_submission_missing = [*google_inspection_missing]
        if not self.settings.google_search_console_sitemap_url:
            google_submission_missing.append("GOOGLE_SEARCH_CONSOLE_SITEMAP_URL")
        baidu_missing = []
        if not self.settings.baidu_search_site_url:
            baidu_missing.append("BAIDU_SEARCH_SITE_URL")
        if not self.settings.baidu_search_token:
            baidu_missing.append("BAIDU_SEARCH_TOKEN")
        indexnow_missing = []
        indexnow_configuration_errors: list[str] = []
        if not self.settings.indexnow_key:
            indexnow_missing.append("INDEXNOW_KEY")
        elif not re.fullmatch(r"[A-Za-z0-9-]{8,128}", self.settings.indexnow_key):
            indexnow_configuration_errors.append("INDEXNOW_KEY_INVALID")
        if not self.settings.indexnow_key_location:
            indexnow_missing.append("INDEXNOW_KEY_LOCATION")
        else:
            key_location = urlsplit(self.settings.indexnow_key_location)
            if key_location.scheme not in {"http", "https"} or not key_location.hostname:
                indexnow_configuration_errors.append("INDEXNOW_KEY_LOCATION_INVALID")

        def runtime_status(
            provider: str,
            missing: list[str],
            configuration_errors: list[str] | None = None,
            **extra: Any,
        ) -> dict[str, Any]:
            errors = configuration_errors or []
            return {
                "provider": provider,
                "configured": not missing and not errors,
                "status": "active" if not missing and not errors else "provider_pending",
                "missingFields": missing,
                "configurationErrors": errors,
                "observationConfigured": observer,
                "missingObservationFields": [] if observer else ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"],
                **extra,
            }

        return [
            runtime_status(
                "Google",
                google_submission_missing,
                google_configuration_errors,
                submissionMethod="google_sitemap",
                submissionCapability="owned_site_only",
                inspectionCapability="official_owned_site" if not google_inspection_missing and not google_configuration_errors else "unavailable",
                inspectionConfigured=not google_inspection_missing and not google_configuration_errors,
                setupHint="服务账号必须加入对应 Search Console 站点；普通文章通过 Sitemap 提交，URL Inspection 负责官方收录检查。",
            ),
            runtime_status(
                "Baidu",
                baidu_missing,
                submissionMethod="baidu_normal_push",
                submissionCapability="owned_site_only",
                inspectionCapability="observed" if observer else "unavailable",
                inspectionConfigured=observer,
                setupHint="百度 Token 只能推送绑定站点；普通收录 API 不保证收录，也不提供单 URL 官方检查。",
            ),
            runtime_status(
                "IndexNow",
                indexnow_missing,
                indexnow_configuration_errors,
                submissionMethod="indexnow",
                submissionCapability="owned_host_only",
                inspectionCapability="observed" if observer else "unavailable",
                inspectionConfigured=observer,
                setupHint="Key 文件必须部署在 URL 所属主机；200/202 只表示收到 URL。",
            ),
            runtime_status(
                "Sitemap",
                google_submission_missing,
                google_configuration_errors,
                submissionMethod="google_sitemap",
                submissionCapability="owned_site_only",
                inspectionCapability="official_owned_site" if not google_inspection_missing and not google_configuration_errors else "unavailable",
                inspectionConfigured=not google_inspection_missing and not google_configuration_errors,
                setupHint="复用 Google Search Console 站点和 Sitemap 配置。",
            ),
        ]
