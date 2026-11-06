from __future__ import annotations

from typing import Any

import httpx

from .config import get_settings


class SeoProvider:
    def collect(self, task_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError


class HttpSeoProvider(SeoProvider):
    """Generic HTTP SEO provider — points at any OpenAPI-compatible SEO backend."""

    endpoint_by_task = {
        "keyword-discover": "/keywords/discover",
        "serp-collect": "/serp/collect",
        "geo-collect": "/geo/collect",
        "ranking-check": "/ranking/check",
    }

    def __init__(self, base_url: str | None = None, api_key: str | None = None) -> None:
        settings = get_settings()
        self.base_url = (base_url if base_url is not None else settings.seo_provider_base_url).rstrip("/")
        self.api_key = api_key if api_key is not None else settings.seo_provider_api_key

    def collect(self, task_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.base_url:
            return {"provider": "unconfigured", "status": "provider_pending", "message": "SEO provider base URL is not configured"}
        path = self.endpoint_by_task.get(task_type)
        if not path:
            return {"provider": "unconfigured", "status": "unsupported_task", "taskType": task_type}
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        response = httpx.post(f"{self.base_url}{path}", json=payload, headers=headers, timeout=60)
        response.raise_for_status()
        data = response.json()
        return data if isinstance(data, dict) else {"items": data}


class DataForSeoProvider(SeoProvider):
    """DataForSEO API provider — https://dataforseo.com/

    Uses the "live" (synchronous) endpoints to avoid polling tasks.
    Credentials: dataforseo_login + dataforseo_password from settings.

    Supported task types:
      keyword-discover  — Google Ads Keywords for Keywords (live)
      serp-collect      — Google SERP organic results (live/advanced)
      geo-collect       — People Also Ask questions from SERP (live)
      ranking-check     — Single-URL rank check via SERP (live)
    """

    BASE_URL = "https://api.dataforseo.com"

    # Task-type → DataForSEO endpoint mapping (live/synchronous)
    ENDPOINTS: dict[str, str] = {
        "keyword-discover": "/v3/keywords_data/google_ads/keywords_for_keywords/live",
        "serp-collect": "/v3/serp/google/organic/live/advanced",
        "geo-collect": "/v3/serp/google/organic/live/advanced",
        "ranking-check": "/v3/serp/google/organic/live/advanced",
    }

    def __init__(self, login: str | None = None, password: str | None = None) -> None:
        settings = get_settings()
        self.login = login or settings.dataforseo_login
        self.password = password or settings.dataforseo_password

    def _auth(self) -> tuple[str, str]:
        if not self.login or not self.password:
            raise ValueError("DATAFORSEO_CREDENTIALS_NOT_CONFIGURED")
        return (self.login, self.password)

    def _build_task(self, task_type: str, payload: dict[str, Any]) -> list[dict[str, Any]]:
        keyword = str(payload.get("keyword") or payload.get("seed") or payload.get("query") or "")
        language_code = str(payload.get("languageCode") or payload.get("language_code") or "zh-CN")
        location_code = int(payload.get("locationCode") or payload.get("location_code") or 2156)  # 2156 = China

        if task_type == "keyword-discover":
            return [{
                "keywords": [keyword] if keyword else [],
                "language_code": language_code,
                "location_code": location_code,
                "limit": int(payload.get("limit") or 50),
            }]

        if task_type in ("serp-collect", "geo-collect", "ranking-check"):
            return [{
                "keyword": keyword,
                "language_code": language_code,
                "location_code": location_code,
                "depth": int(payload.get("depth") or 10),
                "os": "windows",
                "device": str(payload.get("device") or "desktop"),
            }]

        return [{"keyword": keyword, "language_code": language_code, "location_code": location_code}]

    def _normalize_keyword_discover(self, data: dict[str, Any]) -> dict[str, Any]:
        tasks = data.get("tasks") or []
        keywords: list[dict[str, Any]] = []
        for task in tasks:
            for result in task.get("result") or []:
                for item in result.get("items") or []:
                    word = str(item.get("keyword") or "").strip()
                    if not word:
                        continue
                    comp_index = item.get("competition_index")
                    competition = int(comp_index) if comp_index is not None else 0
                    keywords.append({
                        "word": word,
                        "keyword": word,
                        "searchVolume": int(item.get("search_volume") or 0),
                        "difficulty": competition,
                        "trend": "stable",
                        "relatedWords": [],
                        "status": "suggested",
                    })
        return {
            "provider": "dataforseo",
            "status": "collected",
            "keywords": keywords,
        }

    def _normalize_serp_collect(self, data: dict[str, Any]) -> dict[str, Any]:
        tasks = data.get("tasks") or []
        top_results: list[dict[str, Any]] = []
        related_questions: list[str] = []
        keyword = ""
        for task in tasks:
            for result in task.get("result") or []:
                keyword = keyword or str(result.get("keyword") or "")
                for item in result.get("items") or []:
                    item_type = str(item.get("type") or "")
                    if item_type == "organic":
                        top_results.append({
                            "position": int(item.get("rank_absolute") or item.get("rank_group") or 0),
                            "title": str(item.get("title") or ""),
                            "url": str(item.get("url") or ""),
                            "domain": str(item.get("domain") or ""),
                            "snippet": str(item.get("description") or ""),
                        })
                    elif item_type == "people_also_ask":
                        for qa in item.get("items") or []:
                            q = str(qa.get("title") or qa.get("question") or "")
                            if q:
                                related_questions.append(q)
        return {
            "provider": "dataforseo",
            "status": "collected",
            "keyword": keyword,
            "searchEngine": "Google",
            "topResults": top_results[:10],
            "relatedQuestions": related_questions,
            "relatedKeywords": [],
        }

    def _normalize_geo_collect(self, data: dict[str, Any]) -> dict[str, Any]:
        tasks = data.get("tasks") or []
        questions: list[dict[str, Any]] = []
        keyword = ""
        for task in tasks:
            for result in task.get("result") or []:
                keyword = keyword or str(result.get("keyword") or "")
                for item in result.get("items") or []:
                    if str(item.get("type") or "") != "people_also_ask":
                        continue
                    for qa in item.get("items") or []:
                        question = str(qa.get("title") or qa.get("question") or "").strip()
                        if not question:
                            continue
                        questions.append({
                            "question": question,
                            "keyword": keyword,
                            "platform": "Google",
                            "sourceUrl": str(qa.get("url") or ""),
                            "sourceMedia": str(qa.get("domain") or ""),
                            "answerExcerpt": str(qa.get("description") or qa.get("expanded_element", [{}])[0].get("description") if qa.get("expanded_element") else ""),
                            "brandMention": False,
                            "competitorMention": False,
                        })
        return {
            "provider": "dataforseo",
            "status": "collected",
            "questions": questions,
        }

    def _normalize_ranking_check(self, data: dict[str, Any]) -> dict[str, Any]:
        tasks = data.get("tasks") or []
        url_filter = ""
        keyword = ""
        rankings: list[dict[str, Any]] = []
        for task in tasks:
            for result in task.get("result") or []:
                keyword = keyword or str(result.get("keyword") or "")
                for item in result.get("items") or []:
                    if str(item.get("type") or "") != "organic":
                        continue
                    item_url = str(item.get("url") or "")
                    if url_filter and url_filter not in item_url:
                        continue
                    rankings.append({
                        "keyword": keyword,
                        "url": item_url,
                        "engine": "Google",
                        "region": "China",
                        "position": int(item.get("rank_absolute") or 0),
                        "previousPosition": None,
                        "status": "indexed",
                    })
        return {
            "provider": "dataforseo",
            "status": "collected",
            "rankings": rankings,
        }

    def _normalize(self, task_type: str, data: dict[str, Any]) -> dict[str, Any]:
        if task_type == "keyword-discover":
            return self._normalize_keyword_discover(data)
        if task_type == "serp-collect":
            return self._normalize_serp_collect(data)
        if task_type == "geo-collect":
            return self._normalize_geo_collect(data)
        if task_type == "ranking-check":
            return self._normalize_ranking_check(data)
        return {"provider": "dataforseo", "status": "unsupported_task", "taskType": task_type}

    def collect(self, task_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        endpoint = self.ENDPOINTS.get(task_type)
        if not endpoint:
            return {"provider": "dataforseo", "status": "unsupported_task", "taskType": task_type}
        task_body = self._build_task(task_type, payload)
        response = httpx.post(
            f"{self.BASE_URL}{endpoint}",
            json=task_body,
            auth=self._auth(),
            headers={"Content-Type": "application/json"},
            timeout=60,
        )
        response.raise_for_status()
        data = response.json()
        if data.get("status_code") not in (None, 20000):
            raise ValueError(f"DataForSEO error {data.get('status_code')}: {data.get('status_message')}")
        return self._normalize(task_type, data)
