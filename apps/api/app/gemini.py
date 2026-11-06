from __future__ import annotations

import base64
import json
import time
from typing import Any

import httpx

from .config import Settings, get_settings


class GeminiProviderError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _article_prompt(context: dict[str, Any]) -> str:
    return (
        "你是一名专业的中文 SEO/GEO 内容编辑。请依据给定的生成规则、知识依据、品牌信息和素材，"
        "生成事实清晰、可直接排版发布的完整文章。输出严格 JSON：title、summary、"
        "metaDescription、contentMarkdown、keywords、tags、sections、imageBriefs。"
        "sections 每项 id、title、content；content 必须是完整正文（每节≥180字），禁止只有标题的空壳。"
        "contentMarkdown 必须含完整段落，不能只有标题。"
        "图文排版：封面1张 + 每个正文 section 1张 inline 插图（一段正文配一张图）；"
        "inline.sectionId 必须等于 sections[].id；prompt 描述章节语义且图片不要文字。"
        "不要编造未提供的数字、案例或来源。\n\n结构化上下文：\n"
        + json.dumps(context, ensure_ascii=False, separators=(",", ":"), default=str)
    )


def _json_text(payload: dict[str, Any]) -> dict[str, Any]:
    candidates = payload.get("candidates") or []
    parts = ((candidates[0].get("content") or {}).get("parts") or []) if candidates else []
    text = next((str(part.get("text") or "") for part in parts if part.get("text")), "")
    if not text:
        raise GeminiProviderError("GEMINI_EMPTY_RESPONSE", "Gemini 未返回文章内容")
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as error:
        raise GeminiProviderError("GEMINI_INVALID_JSON", "Gemini 返回的文章不是有效 JSON") from error
    if not isinstance(parsed, dict):
        raise GeminiProviderError("GEMINI_INVALID_JSON", "Gemini 返回的文章结构无效")
    return parsed


def _image_output(payload: dict[str, Any]) -> tuple[bytes, str]:
    outputs = payload.get("outputs") or []
    convenience = payload.get("output_image")
    if isinstance(convenience, dict):
        outputs = [*outputs, convenience]
    for candidate in payload.get("candidates") or []:
        for part in ((candidate.get("content") or {}).get("parts") or []):
            inline_data = part.get("inlineData") or part.get("inline_data")
            if isinstance(inline_data, dict):
                outputs.append(inline_data)
    for output in reversed(outputs):
        if not isinstance(output, dict) or not output.get("data"):
            continue
        mime_type = str(output.get("mime_type") or output.get("mimeType") or "image/png")
        try:
            return base64.b64decode(str(output["data"]), validate=True), mime_type
        except (ValueError, TypeError) as error:
            raise GeminiProviderError("GEMINI_INVALID_IMAGE", "Gemini 返回的图片数据无效") from error
    raise GeminiProviderError("GEMINI_EMPTY_IMAGE", "Gemini 未返回图片")


class GeminiClient:
    def __init__(self, settings: Settings | None = None, http_client: Any | None = None, sleeper: Any = time.sleep):
        self.settings = settings or get_settings()
        self.http = http_client or httpx.Client(timeout=120)
        self.sleeper = sleeper

    def _post(self, url: str, payload: dict[str, Any]) -> dict[str, Any]:
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                response = self.http.post(
                    url,
                    headers={"x-goog-api-key": self.settings.gemini_api_key, "Content-Type": "application/json"},
                    json=payload,
                    timeout=120,
                )
                if (response.status_code == 429 or response.status_code >= 500) and attempt < 2:
                    self.sleeper(2**attempt)
                    continue
                response.raise_for_status()
                result = response.json()
                if not isinstance(result, dict):
                    raise GeminiProviderError("GEMINI_INVALID_RESPONSE", "Gemini 返回了无效响应")
                return result
            except GeminiProviderError:
                raise
            except httpx.HTTPStatusError as error:
                status = error.response.status_code
                code = "GEMINI_AUTH_FAILED" if status in {401, 403} else "GEMINI_RATE_LIMITED" if status == 429 else "GEMINI_REQUEST_FAILED"
                raise GeminiProviderError(code, f"Gemini 请求失败（HTTP {status}）") from error
            except httpx.HTTPError as error:
                last_error = error
                if attempt < 2:
                    self.sleeper(2**attempt)
                    continue
        raise GeminiProviderError("GEMINI_UNAVAILABLE", "Gemini 服务暂时不可用") from last_error

    def generate_article(self, context: dict[str, Any]) -> dict[str, Any]:
        model = self.settings.gemini_text_model
        url = f"{self.settings.gemini_base_url.rstrip('/')}/v1beta/models/{model}:generateContent"
        payload = {
            "contents": [{"role": "user", "parts": [{"text": _article_prompt(context)}]}],
            "generationConfig": {
                "temperature": 0.7,
                "responseMimeType": "application/json",
            },
        }
        return _json_text(self._post(url, payload))

    def generate_image(self, brief: dict[str, Any]) -> dict[str, Any]:
        url = f"{self.settings.gemini_base_url.rstrip('/')}/v1beta/interactions"
        aspect_ratio = str(brief.get("aspectRatio") or "16:9")
        payload = {
            "model": self.settings.gemini_image_model,
            "input": [{"type": "text", "text": str(brief.get("prompt") or "")}],
            "response_format": {"type": "image", "mime_type": "image/jpeg", "aspect_ratio": aspect_ratio},
        }
        result = self._post(url, payload)
        data, mime_type = _image_output(result)
        return {
            "data": data,
            "mimeType": mime_type,
            "interactionId": str(result.get("id") or ""),
            "model": self.settings.gemini_image_model,
        }
