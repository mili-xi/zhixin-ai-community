from __future__ import annotations

import signal
import threading
import time

import pytest

from app.scraping import (
    StealthFetchTimeout,
    clean_text,
    fetch_url_text,
    hard_timeout,
    html_to_text,
    is_hard_wall_host,
    looks_like_login_wall,
    scrapling_status,
    text_is_usable,
)


def test_is_hard_wall_host_matches_zhihu_and_wechat():
    assert is_hard_wall_host("zhuanlan.zhihu.com")
    assert is_hard_wall_host("mp.weixin.qq.com")
    assert not is_hard_wall_host("example.com")


def test_html_to_text_prefers_article_container():
    html = """
    <html><body>
      <nav>菜单登录</nav>
      <article><p>这是正文第一段，内容足够长用于知识库学习。</p><p>第二段继续说明产品能力与案例。</p></article>
    </body></html>
    """
    text = html_to_text(html)
    assert "正文第一段" in text
    assert "菜单" not in text or "正文" in text


def test_login_wall_detection():
    assert looks_like_login_wall("请先登录后查看全文")
    assert not looks_like_login_wall("A" * 900 + "请先登录")


def test_text_is_usable_requires_length():
    assert not text_is_usable("太短")
    long_text = "这是一段足够长的正文内容，用来验证知识库抓取是否可用。" * 3
    assert len(long_text) >= 80
    assert text_is_usable(long_text)


def test_fetch_url_text_httpx_mode_example_com():
    text, meta = fetch_url_text("https://example.com", mode="httpx", enable_stealth=False)
    assert "Example Domain" in text or "example" in text.lower()
    assert meta["engine"] == "httpx"
    assert text_is_usable(text)


def test_scrapling_status_shape():
    status = scrapling_status()
    assert "available" in status
    assert "hint" in status
    assert "project" in status


def test_clean_text_collapses_blank_lines():
    assert clean_text("a\n\n\n\nb") == "a\n\nb"


def test_hard_timeout_passes_through_fast_work():
    with hard_timeout(5.0, label="fast"):
        assert 1 + 1 == 2


def test_hard_timeout_disabled_when_budget_not_positive():
    # A non-positive budget must never install a timer.
    started = time.monotonic()
    with hard_timeout(0.0, label="disabled"):
        time.sleep(0.05)
    assert time.monotonic() - started < 1.0


def test_hard_timeout_noop_off_main_thread():
    outcome = {}

    def worker():
        try:
            with hard_timeout(0.2, label="thread"):
                time.sleep(0.6)
            outcome["completed"] = True
        except BaseException as error:  # pragma: no cover - would be a bug
            outcome["error"] = error

    thread = threading.Thread(target=worker)
    thread.start()
    thread.join(timeout=5)
    assert not thread.is_alive()
    assert outcome.get("completed") is True


@pytest.mark.skipif(
    not hasattr(signal, "setitimer"), reason="SIGALRM guard needs POSIX setitimer"
)
def test_hard_timeout_fires_and_restores_previous_handler():
    previous = signal.getsignal(signal.SIGALRM)
    try:
        with pytest.raises(StealthFetchTimeout) as excinfo:
            with hard_timeout(0.2, label="slow fetch", cleanup_seconds=30.0):
                time.sleep(5.0)
        assert "slow fetch" in str(excinfo.value)
        # The guard disarms itself, so a later sleep is not interrupted.
        time.sleep(0.1)
        assert signal.getsignal(signal.SIGALRM) is previous
    finally:
        signal.signal(signal.SIGALRM, previous)
        signal.setitimer(signal.ITIMER_REAL, 0.0)


@pytest.mark.skipif(
    not hasattr(signal, "setitimer"), reason="SIGALRM guard needs POSIX setitimer"
)
def test_hard_timeout_failure_is_catchable_by_caller():
    # Scrapling wraps teardown in suppress(Exception); the timeout must be an
    # ordinary exception so page.close() failures cannot escape it.
    assert issubclass(StealthFetchTimeout, Exception)
    try:
        with hard_timeout(0.2, label="bounded teardown"):
            time.sleep(5.0)
    except Exception as error:
        assert isinstance(error, StealthFetchTimeout)
    else:  # pragma: no cover - would mean the guard never fired
        raise AssertionError("hard_timeout did not fire")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0.0)


def test_fetch_with_scrapling_stealth_accepts_hard_timeout_argument():
    import inspect

    from app.scraping import fetch_with_scrapling_stealth

    params = inspect.signature(fetch_with_scrapling_stealth).parameters
    assert params["hard_timeout_seconds"].default == 300.0
    assert "stealth_hard_timeout_seconds" in inspect.signature(fetch_url_text).parameters
