from __future__ import annotations

import os
from pathlib import Path


# Configure the process before pytest imports application modules. Individual
# tests may still override these values with monkeypatch when needed.
_test_database = Path(__file__).parent / "test.sqlite"
os.environ.setdefault("DATABASE_URL", f"sqlite:///{_test_database}")
os.environ.setdefault("DEEPSEEK_OFFLINE_MODE", "true")
os.environ.setdefault("AUTH_REGISTRATION_ENABLED", "true")
os.environ.setdefault("AUTH_DEBUG_RETURN_CODE", "true")
os.environ.setdefault("AUTH_TEST_BYPASS_USER_ID", "test-owner")
os.environ.setdefault("AUTH_RATE_LIMIT_ENABLED", "false")
