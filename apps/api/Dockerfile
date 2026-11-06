# Shared backend image for API + worker.
# Includes Scrapling fetchers + Chromium for knowledge URL stealth crawl.
# Build context: monorepo root.
# BuildKit may be disabled on Windows paths with non-ASCII chars.
#
# Pin bookworm: python:3.11-slim may float to trixie and break apt mirrors mid-build.

ARG API_BASE_IMAGE=python:3.11-slim-bookworm

# ---------------------------------------------------------------------------
# deps: Python packages only (layer-cache friendly, no apt if wheels available)
# ---------------------------------------------------------------------------
FROM ${API_BASE_IMAGE} AS deps
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Install dependencies from pyproject first so app code changes reuse this layer.
# Use Tsinghua PyPI mirror + retries: host networks often break mid-download.
COPY apps/api/pyproject.toml ./pyproject.toml
RUN mkdir -p app \
    && printf '"""zhixin api package marker"""\n' > app/__init__.py \
    && pip install --upgrade pip \
        -i https://pypi.tuna.tsinghua.edu.cn/simple \
        --trusted-host pypi.tuna.tsinghua.edu.cn \
    && pip install . \
        -i https://pypi.tuna.tsinghua.edu.cn/simple \
        --trusted-host pypi.tuna.tsinghua.edu.cn \
        --retries 10 \
        --timeout 120 \
        --default-timeout 120 \
    && rm -rf app

# ---------------------------------------------------------------------------
# runtime: system libs for Chromium + Scrapling browsers + app code
# ---------------------------------------------------------------------------
FROM ${API_BASE_IMAGE} AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    KNOWLEDGE_FETCH_MODE=auto \
    KNOWLEDGE_FETCH_STEALTH=true \
    KNOWLEDGE_FETCH_TIMEOUT=30 \
    KNOWLEDGE_FETCH_STEALTH_TIMEOUT_MS=45000

WORKDIR /app

# Chromium runtime libs + CJK fonts.
# Use the Tsinghua Debian mirror — deb.debian.org often fails (Connection failed) on this host.
# Bookworm slim may only ship DEB822 debian.sources, not classic sources.list.
RUN set -eux; \
    rm -f /etc/apt/sources.list.d/debian.sources; \
    printf '%s\n' \
      'deb https://mirrors.tuna.tsinghua.edu.cn/debian bookworm main contrib non-free non-free-firmware' \
      'deb https://mirrors.tuna.tsinghua.edu.cn/debian bookworm-updates main contrib non-free non-free-firmware' \
      'deb https://mirrors.tuna.tsinghua.edu.cn/debian-security bookworm-security main contrib non-free non-free-firmware' \
      > /etc/apt/sources.list; \
    for i in 1 2 3; do \
      apt-get update && break || sleep 3; \
    done; \
    apt-get -o Acquire::Retries=5 install -y --fix-missing --no-install-recommends \
        ca-certificates \
        curl \
        ffmpeg \
        fonts-liberation \
        fonts-noto-cjk \
        fonts-unifont \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libatspi2.0-0 \
        libcairo2 \
        libcairo-gobject2 \
        libcups2 \
        libdbus-1-3 \
        libdrm2 \
        libfontconfig1 \
        libfreetype6 \
        libgbm1 \
        libgdk-pixbuf-2.0-0 \
        libglib2.0-0 \
        libgtk-3-0 \
        libnspr4 \
        libnss3 \
        libpango-1.0-0 \
        libpangocairo-1.0-0 \
        libpangoft2-1.0-0 \
        libx11-6 \
        libx11-xcb1 \
        libxcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxkbcommon0 \
        libxrandr2 \
        libxshmfence1 \
        libxss1 \
        libxtst6 \
        wget \
        xvfb \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=deps /usr/local/bin /usr/local/bin

# Install Chromium for Scrapling StealthyFetcher (HTTP Fetcher works without this).
# Use npmmirror CDN — Microsoft default is often blocked/slow in CN.
ENV PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright
RUN mkdir -p /ms-playwright \
    && (python -m playwright install chromium \
        || python -m patchright install chromium \
        || scrapling install \
        || echo "WARN: browser install skipped; knowledge stealth crawl may be limited") \
    && chmod -R a+rX /ms-playwright || true \
    && CHROME_BIN="$(find /ms-playwright -type f -name chrome -path '*/chrome-linux*/*' 2>/dev/null | head -n 1 || true)" \
    && if [ -n "$CHROME_BIN" ]; then \
         echo "Chrome binary: $CHROME_BIN"; \
         if ldd "$CHROME_BIN" 2>/dev/null | grep -E 'not found'; then \
           echo "ERROR: Chromium is missing shared libraries (stealth crawl will fail):"; \
           ldd "$CHROME_BIN" | grep -E 'not found' || true; \
           exit 1; \
         fi; \
       else \
         echo "WARN: chromium binary not found under /ms-playwright"; \
       fi

COPY apps/api/app ./app
COPY apps/api/alembic ./alembic
COPY apps/api/alembic.ini ./alembic.ini

RUN mkdir -p /app/uploads \
    && python -c "from app.scraping import scrapling_status; print(scrapling_status())"

EXPOSE 8000

CMD ["sh", "-c", "alembic upgrade head && exec python -m uvicorn app.main:app --host 0.0.0.0 --port 8000"]
