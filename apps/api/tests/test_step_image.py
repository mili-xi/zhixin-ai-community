from __future__ import annotations

import base64

import httpx
import pytest

from app.config import Settings
from app.step_image import StepImageClient, StepImageProviderError


class FakeHttp:
    def __init__(self, responses: list[httpx.Response]):
        self.responses = list(responses)
        self.calls = []

    def post(self, url: str, **kwargs):
        self.calls.append((url, kwargs))
        return self.responses.pop(0)


def response(status_code: int, payload: dict) -> httpx.Response:
    url = "https://api.stepfun.com/v1/images/generations"
    return httpx.Response(status_code, json=payload, request=httpx.Request("POST", url))


def settings(api_key: str = "step-test-secret") -> Settings:
    return Settings(
        database_url="sqlite://",
        step_api_key=api_key,
        step_base_url="https://api.stepfun.com",
        step_image_model="step-image-edit-2",
    )


def test_step_image_generation_uses_official_endpoint_and_decodes_b64():
    image = b"\xff\xd8\xffstep-image"
    http = FakeHttp([response(200, {"data": [{"b64_json": base64.b64encode(image).decode("ascii")}]})])
    client = StepImageClient(settings(), http_client=http, sleeper=lambda _: None)

    result = client.generate_image({"prompt": "专业 AI SEO 文章封面", "aspectRatio": "16:9"})

    assert result["data"] == image
    assert result["mimeType"] == "image/jpeg"
    assert result["provider"] == "stepfun"
    assert result["model"] == "step-image-edit-2"
    url, kwargs = http.calls[0]
    assert url == "https://api.stepfun.com/v1/images/generations"
    assert kwargs["headers"]["Authorization"] == "Bearer step-test-secret"
    assert kwargs["json"]["model"] == "step-image-edit-2"
    assert kwargs["json"]["response_format"] == "b64_json"
    assert kwargs["json"]["size"] == "768x1360"


def test_step_image_generation_maps_portrait_ratio_to_stepfun_height_width_size():
    image = b"\xff\xd8\xffportrait"
    http = FakeHttp([response(200, {"data": [{"b64_json": base64.b64encode(image).decode("ascii")}]})])
    client = StepImageClient(settings(), http_client=http, sleeper=lambda _: None)

    client.generate_image({"prompt": "Portrait article illustration", "aspectRatio": "9:16"})

    _, kwargs = http.calls[0]
    assert kwargs["json"]["size"] == "1360x768"


def test_step_image_generation_uses_alt_text_when_prompt_is_empty():
    image = b"\xff\xd8\xffalt-text-fallback"
    http = FakeHttp([response(200, {"data": [{"b64_json": base64.b64encode(image).decode("ascii")}]})])
    client = StepImageClient(settings(), http_client=http, sleeper=lambda _: None)

    client.generate_image({"prompt": "", "altText": "Editorial travel cover without text"})

    _, kwargs = http.calls[0]
    assert kwargs["json"]["prompt"] == "Editorial travel cover without text"


def test_step_provider_error_redacts_key_and_preserves_auth_code():
    secret = "step-secret-not-for-logs"
    http = FakeHttp([response(401, {"error": {"message": secret}})])
    client = StepImageClient(settings(secret), http_client=http, sleeper=lambda _: None)

    with pytest.raises(StepImageProviderError) as caught:
        client.generate_image({"prompt": "封面"})

    assert caught.value.code == "STEP_IMAGE_AUTH_FAILED"
    assert secret not in str(caught.value)
