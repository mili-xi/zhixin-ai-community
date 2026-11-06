# Zhixin AI FastAPI Backend

This service replaces the old Next.js API Routes and local JSON store.

## Development

```powershell
cd apps/api
python -m pip install -e ".[dev]"
python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

The frontend keeps calling `/api/*`. Next.js proxies those calls to this service through `FASTAPI_BASE_URL`.

## Database

Set `DATABASE_URL` to PostgreSQL:

```env
DATABASE_URL=postgresql+psycopg://zhixin:zhixin@127.0.0.1:5432/zhixin_ai
REDIS_URL=redis://127.0.0.1:6379/0
QUEUE_LEASE_SECONDS=300
QUEUE_MAX_ATTEMPTS=3
QUEUE_POLL_INTERVAL=0.1
```

For local development, run PostgreSQL and Redis through Docker Desktop:

```powershell
npm run dev:services
```

This starts containers that match the default `apps/api/.env` values. PostgreSQL uses a pgvector-enabled image so later knowledge-base embeddings can move into the database without changing the service topology. No local PostgreSQL installation is required.

To run API, worker, web, PostgreSQL, and Redis together in Docker Desktop:

```powershell
# full rebuild + up (backend includes Scrapling + Chromium)
npm run dev:docker

# only rebuild backend after knowledge / SERP / AI changes
npm run docker:build:backend
npm run docker:restart

# smoke: health + Scrapling + seed rules/types
npm run verify:docker
```

Open `http://127.0.0.1:3001/ai-writer` after the stack is healthy.

If the default Docker ports `3001` or `8000` are already occupied by local dev servers:

```powershell
npm run dev:docker:alt-web
```

Compose builds one shared backend image for API + worker (Scrapling fetchers, Chromium for stealth URL crawl, worker `shm_size: 1gb`). The web container proxies `/api/*` to `http://api:8000` inside the Compose network. The npm scripts call a small PowerShell wrapper that disables BuildKit on Windows so Docker Desktop can build the stack reliably under this workspace path. Secrets still load from `apps/api/.env` (`DEEPSEEK_API_KEY`, `DATAFORSEO_*`, Step keys).

Tests use a temporary SQLite database only so the API contract can be verified without a local PostgreSQL server.

## Redis Queue

The API enqueues durable task records in PostgreSQL and pushes queue messages into Redis lists:

- `zhixin:queue:default`
- `zhixin:queue:publish`
- `zhixin:queue:index`
- `zhixin:queue:media`

Workers or the future desktop client can consume those Redis messages and update task records through API endpoints.

Run the local worker:

```powershell
npm run dev:worker
```

Enqueue scheduled refresh/retry jobs once:

```powershell
npm run dev:schedule
```

## AI Writing and Illustration

`POST /api/articles/generate` builds a structured writer context from:

- request `writerContext`
- selected generation rule
- selected knowledge-base items
- selected assets
- brand and competitor profiles

Queued writing keeps DeepSeek as the primary article provider. Step Image Edit 2 generates article covers and inline images from the article structure and image briefs. Configure:

```env
ARTICLE_TEXT_PROVIDER=deepseek
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-pro
DEEPSEEK_OFFLINE_MODE=false
ARTICLE_IMAGE_PROVIDER=step
STEP_API_KEY=
STEP_BASE_URL=https://api.stepfun.com
STEP_IMAGE_MODEL=step-image-edit-2
```

Gemini settings remain available as an optional compatibility provider, but they are not the default article or image path. If Step image generation fails, the DeepSeek article is retained, image generation is marked failed or partial, and the article moves to `review_required`.

Tests set offline mode so they do not call the real model.

Each worker-driven AI generation writes an `llmRequests` record that captures:

- provider and model
- selected generation rule, knowledge item IDs, asset IDs, brand profile IDs, and competitor profile IDs
- a provider-safe request summary; DeepSeek requests retain prompt messages while Gemini records never contain the API key
- a response summary with title, metadata, keywords, tags, and content preview
- task ID, article ID, status, and error message when the model call fails

Read these records with:

```http
GET /api/llm-requests
```

The API keys are only read from environment settings and are never stored in `llmRequests`, task logs, audit logs, article records, or generated assets.

Generated images are saved under `UPLOAD_DIR/assets` and added to the existing asset library with provider, model, prompt, purpose, section ID, alt text, article ID, and task ID. Articles retain `coverImage`, ordered `inlineImages`, `imageGenerationStatus`, image errors, and a quality result. Content quality and illustration improve publish readiness but do not guarantee search-engine inclusion.

## Knowledge Ingestion

The backend now supports:

- `POST /api/knowledge-base/upload` for local files.
- `POST /api/knowledge-base/fetch-url` for web URL ingestion or queued refresh.
- `GET /api/knowledge-base/{id}/chunks` for parsed chunks.

Parsed chunks and deterministic local vectors are stored as records, so the API can be swapped to pgvector or a real embedding provider later without changing the frontend flow.

## Operations

Operational records are available through:

- `GET /api/tasks`
- `GET /api/tasks/{id}`
- `GET /api/tasks/{id}/logs`
- `POST /api/tasks/{id}/retry`
- `GET /api/audit-logs`
- `GET /api/notifications`
- `GET /api/failure-center`
- `GET /api/failure-center/{taskId}`
- `POST /api/failure-center/{taskId}/retry`

Worker failures now write task logs, audit logs, and error notifications. The failure center aggregates failed or pending tasks with recent logs, linked notifications, retryability, and last-error metadata so the web UI or desktop client can present a real retry center instead of only raw task state.

SEO data collection endpoints currently create durable queued tasks for workers/providers:

- `POST /api/keywords/discover`
- `POST /api/serp-analysis/collect`
- `POST /api/geo-analysis/collect`
- `POST /api/ranking-tracker/check`

The worker executes internal tasks for knowledge refresh, inclusion checks, AI generation, auto-publish drafts, publish-and-index, and provider-backed SEO collection. Configure a real crawler, search API, or third-party SEO service with:

```env
SEO_PROVIDER_BASE_URL=https://your-seo-provider.example
SEO_PROVIDER_API_KEY=
```

The HTTP provider posts JSON payloads to:

- `POST {SEO_PROVIDER_BASE_URL}/keywords/discover`
- `POST {SEO_PROVIDER_BASE_URL}/serp/collect`
- `POST {SEO_PROVIDER_BASE_URL}/geo/collect`
- `POST {SEO_PROVIDER_BASE_URL}/ranking/check`

If `SEO_PROVIDER_API_KEY` is set, the backend sends `Authorization: Bearer <key>`.

Provider responses are stored raw in `seoProviderResults` and normalized into business records:

- keyword responses with `keywords` / `items` / `data` / `results` become `keywords`.
- SERP responses with `topResults` / `results` / `items` / `organicResults` become `serpAnalyses`.
- GEO responses with `questions` / `items` / `data` / `results` become `geoQuestions`.
- ranking responses with `rankings` / `items` / `data` / `results`, or a single `rank` / `position`, become `rankingEntries`.

When `SEO_PROVIDER_BASE_URL` is empty, SEO tasks are marked `provider_pending` and keep their request payload so a provider can be connected later. Provider exceptions fail the worker task and are recorded in task logs, audit logs, notifications, and the failure retry center.

Long-running user actions can now be queued with `async: true`:

- `POST /api/articles/generate` queues `ai-generate-article` on `zhixin:queue:ai`.
- `POST /api/auto-publish` queues `auto-publish` on `zhixin:queue:publish`.
- `POST /api/publish-and-index` queues `publish-and-index` on `zhixin:queue:publish`.
- `POST /api/media-orders/publish-and-index` queues `media-backlink-index` on `zhixin:queue:media`.
- `POST /api/inclusion-checks` queues `inclusion-check` on `zhixin:queue:index`.

The synchronous paths remain available for the current web UI, but new automation and desktop-client flows should prefer queued tasks so DeepSeek calls, media backlink generation, publishing, index submission, and inclusion checks are executed by the worker and recorded in task logs/audit logs.

Redis queue messages are reserved into a processing list and acknowledged only after database work succeeds. QUEUE_LEASE_SECONDS controls crash recovery, QUEUE_MAX_ATTEMPTS controls retry/dead-letter behavior, and QUEUE_POLL_INTERVAL controls idle polling. Do not set the lease shorter than the longest expected publish or generation task.
