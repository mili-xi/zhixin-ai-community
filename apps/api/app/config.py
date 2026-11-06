from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


def csv_setting(value: str) -> list[str]:
    values: list[str] = []
    for item in value.split(","):
        normalized = item.strip()
        if normalized and normalized not in values:
            values.append(normalized)
    return values


class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg://zhixin:zhixin@127.0.0.1:5432/zhixin_ai"
    redis_url: str = "redis://127.0.0.1:6379/0"
    queue_lease_seconds: float = 300.0
    queue_max_attempts: int = 3
    queue_poll_interval: float = 0.1
    # Without these the Redis client inherits redis-py's "block forever" defaults, so a
    # half-dead Redis turns every queue call (and the worker healthcheck) into a hang.
    redis_socket_timeout_seconds: float = 10.0
    redis_socket_connect_timeout_seconds: float = 5.0
    api_title: str = "Zhixin AI API"
    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com"
    deepseek_model: str = "deepseek-v4-pro"
    deepseek_offline_mode: bool = False
    article_text_provider: str = "deepseek"
    gemini_api_key: str = ""
    gemini_base_url: str = "https://generativelanguage.googleapis.com"
    gemini_text_model: str = "gemini-3.5-flash"
    gemini_image_model: str = "gemini-3.1-flash-image"
    gemini_offline_mode: bool = False
    article_image_provider: str = "step"
    step_api_key: str = ""
    step_base_url: str = "https://api.stepfun.com"
    step_image_model: str = "step-image-edit-2"
    upload_dir: str = "apps/api/uploads"
    auth_allowed_origins: str = "http://127.0.0.1:3000,http://localhost:3000,http://127.0.0.1:3001,http://localhost:3001"
    auth_trusted_hosts: str = "127.0.0.1,localhost,testserver,api"

    # Account registration verifies email once; later sign-in uses email and password.
    auth_registration_enabled: bool = True
    auth_email_delivery: str = "console"
    auth_smtp_host: str = ""
    auth_smtp_port: int = 587
    auth_smtp_username: str = ""
    auth_smtp_password: str = ""
    auth_smtp_from_email: str = ""
    auth_smtp_from_name: str = "智心AI"
    auth_smtp_use_ssl: bool = False
    auth_smtp_starttls: bool = True
    auth_smtp_timeout_seconds: float = 15.0
    auth_debug_return_code: bool = False
    auth_code_ttl_seconds: int = 600
    auth_code_max_attempts: int = 5
    auth_session_ttl_days: int = 30
    auth_cookie_name: str = "zhixin_session"
    auth_cookie_secure: bool = False
    auth_cookie_samesite: Literal["lax", "strict", "none"] = "lax"
    auth_test_bypass_user_id: str = ""
    auth_rate_limit_enabled: bool = True
    auth_rate_limit_window_seconds: int = 900
    auth_register_code_email_limit: int = 5
    auth_register_code_ip_limit: int = 20
    auth_login_email_limit: int = 10
    auth_login_ip_limit: int = 60

    # Generic SEO data provider (custom HTTP endpoint).
    seo_provider_base_url: str = ""
    seo_provider_api_key: str = ""

    # DataForSEO search-result observation.
    dataforseo_login: str = ""
    dataforseo_password: str = ""

    # Real search indexing and inclusion verification.
    google_search_console_credentials_json: str = ""
    google_search_console_credentials_json_b64: str = ""
    google_search_console_site_url: str = ""
    google_search_console_sitemap_url: str = ""
    baidu_search_site_url: str = ""
    baidu_search_token: str = ""
    indexnow_key: str = ""
    indexnow_key_location: str = ""
    indexnow_endpoint: str = "https://api.indexnow.org/indexnow"

    # Deprecated compatibility setting. HTTP reachability never means indexed.
    inclusion_check_method: str = "provider"

    # Soft-media publishing fallback for isolated tests only. Production workflow
    # must not invent backlinks because those links drive index and inclusion state.
    media_publish_fallback_mock: bool = False

    # Knowledge URL fetch: Scrapling (GitHub D4Vinci/Scrapling) + httpx fallback.
    # mode: auto | scrapling | scrapling-http | scrapling-stealth | httpx
    knowledge_fetch_mode: str = "auto"
    knowledge_fetch_stealth: bool = True
    knowledge_fetch_timeout: float = 30.0
    knowledge_fetch_stealth_timeout_ms: int = 45000
    # Playwright protocol calls carry no client-side timeout, so a browser node
    # that stops answering without dying hangs the fetch (and the worker) forever.
    # This is the wall-clock ceiling for one stealth fetch; 0 disables the guard.
    knowledge_fetch_stealth_hard_timeout_seconds: float = 300.0
    # Publication rechecks used to be re-created on every scheduler tick with no
    # backoff, so a permanently unreachable public page was refetched forever
    # (one order reached 6811 checks). Retries now double from the base interval up
    # to the ceiling, and stop entirely once the attempt cap is reached.
    media_recheck_backoff_base_seconds: float = 900.0
    media_recheck_backoff_max_seconds: float = 86400.0
    media_recheck_max_attempts: int = 40

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
