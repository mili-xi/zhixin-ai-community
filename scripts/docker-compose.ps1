param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ComposeArgs
)

$ErrorActionPreference = "Stop"

# Stable project name: the workspace path contains non-ASCII characters,
# so never let Compose derive the name from the directory.
if (-not $env:COMPOSE_PROJECT_NAME) {
  $env:COMPOSE_PROJECT_NAME = "zhixin-ai"
}

# Default published ports for local Docker stack.
# WEB_PORT 3001 avoids clashing with host `next dev` on 3000.
if ($ComposeArgs -contains "up" -or $ComposeArgs -contains "run") {
  if (-not $env:API_PORT) { $env:API_PORT = "8000" }
  if (-not $env:WEB_PORT) { $env:WEB_PORT = "3001" }
  if (-not $env:POSTGRES_PORT) { $env:POSTGRES_PORT = "5432" }
  if (-not $env:REDIS_PORT) { $env:REDIS_PORT = "6379" }
}

# BuildKit is flaky with this monorepo path on Windows Docker Desktop.
# Classic builder stays reliable for api/web multi-stage builds.
$env:DOCKER_BUILDKIT = "0"
$env:COMPOSE_DOCKER_CLI_BUILD = "0"
$env:BUILDKIT_PROGRESS = "plain"

function Initialize-ComposeVolumes {
  $requiredVolumes = @(
    "ai_zhixin_postgres_data",
    "ai_zhixin_redis_data",
    "ai_zhixin_uploads"
  )

  foreach ($volumeName in $requiredVolumes) {
    & docker volume inspect $volumeName *> $null
    if ($LASTEXITCODE -eq 0) {
      continue
    }

    [Console]::Error.WriteLine("[zhixin-docker] creating persistent volume: $volumeName")
    & docker volume create $volumeName *> $null
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to create Docker volume '$volumeName'."
    }
  }
}

if ($ComposeArgs -contains "up" -or $ComposeArgs -contains "run") {
  Initialize-ComposeVolumes
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
  # Banner goes to stderr so machine-readable stdout (ps --format json) stays clean.
  $banner = "[zhixin-docker] project={0} api_port={1} web_port={2} :: docker compose {3}" -f `
    $env:COMPOSE_PROJECT_NAME, `
    $(if ($env:API_PORT) { $env:API_PORT } else { "8000" }), `
    $(if ($env:WEB_PORT) { $env:WEB_PORT } else { "3001" }), `
    ($ComposeArgs -join " ")
  [Console]::Error.WriteLine($banner)
  & docker compose @ComposeArgs
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}
finally {
  Pop-Location
}
