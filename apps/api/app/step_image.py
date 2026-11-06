from __future__ import annotations

import base64
import time
from typing import Any

import httpx

from .config import Settings, get_settings


class StepImageProviderError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _size_for_aspect_ratio(value: str) -> str:
    # StepFun interprets this field as height x width, despite the OpenAI-style name.
    return {
        "1:1": "1024x1024",
        "3:4": "1184x896",   # returns 896x1184 portrait
        "4:3": "896x1184",   # returns 1184x896 landscape
        "9:16": "1360x768",  # returns 768x1360 portrait
        "16:9": "768x1360",  # returns 1360x768 landscape
    }.get(value, "768x1360")


def _mime_type(data: bytes) -> str:
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith((b"RIFF",)) and data[8:12] == b"WEBP":
        return "image/webp"
    return "application/octet-stream"


class StepImageClient:
    def __init__(self, settings: Settings | None = None, http_client: Any | None = None, sleeper: Any = time.sleep):
        self.settings = settings or get_settings()
        self.http = http_client or httpx.Client(timeout=120)
        self.sleeper = sleeper

    def generate_image(self, brief: dict[str, Any]) -> dict[str, Any]:
        url = f"{self.settings.step_base_url.rstrip('/')}/v1/images/generations"
        payload = {
            "model": self.settings.step_image_model,
            "prompt": str(brief.get("prompt") or brief.get("altText") or "").strip()[:512],
            "response_format": "b64_json",
            "size": _size_for_aspect_ratio(str(brief.get("aspectRatio") or "16:9")),
            "cfg_scale": 1.0,
            "steps": 8,
            "text_mode": False,
        }
        response = None
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                response = self.http.post(
                    url,
                    headers={
                        "Authorization": f"Bearer {self.settings.step_api_key}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                    timeout=120,
                )
                if (response.status_code == 429 or response.status_code >= 500) and attempt < 2:
                    self.sleeper(2**attempt)
                    continue
                response.raise_for_status()
                body = response.json()
                encoded = ((body.get("data") or [{}])[0] or {}).get("b64_json")
                if not encoded:
                    raise StepImageProviderError("STEP_IMAGE_EMPTY_RESPONSE", "Step Image Edit 2 未返回图片")
                try:
                    data = base64.b64decode(str(encoded), validate=True)
                except (TypeError, ValueError) as error:
                    raise StepImageProviderError("STEP_IMAGE_INVALID_RESPONSE", "Step Image Edit 2 返回的图片数据无效") from error
                return {
                    "data": data,
                    "mimeType": _mime_type(data),
                    "provider": "stepfun",
                    "model": self.settings.step_image_model,
                }
            except StepImageProviderError:
                raise
            except httpx.HTTPStatusError as error:
                status = error.response.status_code
                code = "STEP_IMAGE_AUTH_FAILED" if status in {401, 403} else "STEP_IMAGE_RATE_LIMITED" if status == 429 else "STEP_IMAGE_REQUEST_FAILED"
                raise StepImageProviderError(code, f"Step Image Edit 2 请求失败（HTTP {status}）") from error
            except httpx.HTTPError as error:
                last_error = error
                if attempt < 2:
                    self.sleeper(2**attempt)
                    continue
        raise StepImageProviderError("STEP_IMAGE_UNAVAILABLE", "Step Image Edit 2 服务暂时不可用") from last_error
