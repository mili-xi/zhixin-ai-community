param(
  [string]$ApiUrl,
  [string]$WebUrl
)

$ErrorActionPreference = "Stop"
try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
  $OutputEncoding = [System.Text.UTF8Encoding]::new()
} catch {
  # ignore encoding setup failures on older hosts
}

function Write-Step {
  param([string]$Message)
  Write-Host "==> $Message"
}

function Initialize-ComposeEnv {
  if (-not $env:COMPOSE_PROJECT_NAME) {
    $env:COMPOSE_PROJECT_NAME = "zhixin-ai"
  }
  $env:DOCKER_BUILDKIT = "0"
  $env:COMPOSE_DOCKER_CLI_BUILD = "0"
  if (-not $env:API_PORT) { $env:API_PORT = "8000" }
  if (-not $env:WEB_PORT) { $env:WEB_PORT = "3001" }
}

function Invoke-Compose {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$ComposeArgs)
  Initialize-ComposeEnv
  & docker compose @ComposeArgs
  if ($LASTEXITCODE -ne 0) {
    throw "docker compose command failed: $($ComposeArgs -join ' ')"
  }
}

function Invoke-Json {
  param(
    [string]$Method = "GET",
    [string]$Uri,
    [object]$Body = $null
  )

  if ($null -eq $script:JsonHttpClient) {
    Add-Type -AssemblyName System.Net.Http
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $handler.UseCookies = $true
    $handler.CookieContainer = [System.Net.CookieContainer]::new()
    $script:JsonHttpClient = [System.Net.Http.HttpClient]::new($handler)
  }
  $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($Method), $Uri)
  try {
    if ($null -ne $Body) {
      $json = $Body | ConvertTo-Json -Depth 20
      $request.Content = [System.Net.Http.StringContent]::new(
        $json,
        [System.Text.Encoding]::UTF8,
        "application/json"
      )
    }

    $response = $script:JsonHttpClient.SendAsync($request).GetAwaiter().GetResult()
    $bytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
    $content = [System.Text.Encoding]::UTF8.GetString($bytes)
    if (-not $response.IsSuccessStatusCode) {
      throw "HTTP $([int]$response.StatusCode) from $Uri`: $content"
    }
    if (-not $content) {
      return $null
    }
    return $content | ConvertFrom-Json
  }
  finally {
    $request.Dispose()
  }
}

function Invoke-HttpProbe {
  param([string]$Uri)

  Add-Type -AssemblyName System.Net.Http
  $handler = [System.Net.Http.HttpClientHandler]::new()
  $handler.AllowAutoRedirect = $false
  $client = [System.Net.Http.HttpClient]::new($handler)
  try {
    $response = $client.GetAsync($Uri).GetAwaiter().GetResult()
    try {
      return [pscustomobject]@{
        StatusCode = [int]$response.StatusCode
        Location = if ($null -ne $response.Headers.Location) { $response.Headers.Location.ToString() } else { "" }
      }
    }
    finally {
      $response.Dispose()
    }
  }
  finally {
    $client.Dispose()
  }
}

function Get-ComposePublishedPort {
  param(
    [string]$Service,
    [int]$ContainerPort
  )

  Initialize-ComposeEnv
  $mapping = & docker compose port $Service $ContainerPort 2>$null
  if ($LASTEXITCODE -ne 0) {
    return $null
  }

  $text = ($mapping | Out-String).Trim()
  if (-not $text) {
    return $null
  }

  if ($text -match ":(\d+)$") {
    return [int]$Matches[1]
  }

  if ($text -match "^(\d+)$") {
    return [int]$Matches[1]
  }

  return $null
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
  Initialize-ComposeEnv

  Write-Step "Checking Docker Compose services"
  # Avoid JSON parse: Chinese workspace paths corrupt nested PowerShell JSON capture.
  $runningServices = @(& docker compose ps --status running --format "{{.Service}}" 2>$null | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to list compose services. Run npm run dev:docker first."
  }

  $requiredServices = @("postgres", "redis", "api", "worker", "web")
  foreach ($serviceName in $requiredServices) {
    if ($runningServices -notcontains $serviceName) {
      throw "Docker service '$serviceName' is not running. Running: $($runningServices -join ', '). Run npm run dev:docker first."
    }
  }

  if (-not $ApiUrl) {
    $apiPort = Get-ComposePublishedPort -Service "api" -ContainerPort 8000
    if ($null -eq $apiPort) { $apiPort = 8000 }
    $ApiUrl = "http://127.0.0.1:$apiPort"
  }

  if (-not $WebUrl) {
    $webPort = Get-ComposePublishedPort -Service "web" -ContainerPort 3000
    if ($null -eq $webPort) { $webPort = 3001 }
    $WebUrl = "http://127.0.0.1:$webPort"
  }

  Write-Step "Checking FastAPI health at $ApiUrl"
  $health = Invoke-Json -Uri "$ApiUrl/health"
  if ($health.status -ne "ok") {
    throw "FastAPI health check failed: $($health | ConvertTo-Json -Compress)"
  }

  $smokeToken = [Guid]::NewGuid().ToString("N")
  $smokeUserId = "smoke-user-$smokeToken"
  $smokeEmail = "smoke-$smokeToken@example.com"
  $smokePassword = "SmokePassword$smokeToken"
  $smokeUserCreated = $false

  Write-Step "Creating temporary authenticated smoke member"
  $passwordHashOutput = @(& docker compose exec -T api python -c "from app.auth.security import hash_password; print(hash_password('$smokePassword'))")
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to generate a temporary password hash inside the API container."
  }
  $passwordHash = ($passwordHashOutput | Where-Object { $_ } | Select-Object -Last 1).Trim()
  if (-not $passwordHash.StartsWith('$argon2')) {
    throw "Temporary password hash was not generated in the expected Argon2 format."
  }

  $insertUserSql = "insert into users (id, email, display_name, role, status, password_hash, password_changed_at, created_at, updated_at) values ('$smokeUserId', '$smokeEmail', 'Docker smoke member', 'member', 'active', '$passwordHash', now(), now(), now());"
  & docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U zhixin -d zhixin_ai -c $insertUserSql | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to create the temporary smoke member in PostgreSQL."
  }
  $smokeUserCreated = $true

  Write-Step "Logging in temporary smoke member"
  $login = Invoke-Json -Method "POST" -Uri "$ApiUrl/api/auth/login" -Body @{
    email = $smokeEmail
    password = $smokePassword
  }
  if (-not $login.authenticated -or $login.user.id -ne $smokeUserId) {
    throw "Temporary smoke member login did not establish the expected session."
  }

  $me = Invoke-Json -Uri "$ApiUrl/api/auth/me"
  if (-not $me.authenticated -or $me.user.id -ne $smokeUserId) {
    throw "Authenticated session cookie was not retained across API requests."
  }

  Write-Step "Checking Redis queue connectivity"
  $queueHealth = Invoke-Json -Uri "$ApiUrl/api/queues/health"
  if (-not $queueHealth.configured -or -not $queueHealth.connected) {
    throw "Redis queue health check failed: $($queueHealth | ConvertTo-Json -Compress)"
  }

  Write-Step "Checking AI / SERP / Scrapling provider status"
  $providers = Invoke-Json -Uri "$ApiUrl/api/ai/providers/status"
  if (-not $providers.text) {
    throw "AI provider status missing text block: $($providers | ConvertTo-Json -Compress -Depth 6)"
  }
  Write-Host ("  text: {0} configured={1} mode={2}" -f $providers.text.provider, $providers.text.configured, $providers.text.mode)
  if ($providers.serp) {
    Write-Host ("  serp: {0} configured={1} :: {2}" -f $providers.serp.provider, $providers.serp.configured, $providers.serp.hint)
  }
  if ($providers.knowledgeFetch) {
    Write-Host ("  knowledgeFetch: available={0} mode={1} :: {2}" -f $providers.knowledgeFetch.available, $providers.knowledgeFetch.mode, $providers.knowledgeFetch.hint)
    if (-not $providers.knowledgeFetch.available) {
      throw "Scrapling is not available inside the API/worker image. Rebuild backend: npm run docker:build:backend"
    }
  } else {
    throw "knowledgeFetch status missing from /api/ai/providers/status — rebuild backend image."
  }

  Write-Step "Checking member defaults (article types / generation rules)"
  $articleTypes = Invoke-Json -Uri "$ApiUrl/api/article-types"
  $rules = Invoke-Json -Uri "$ApiUrl/api/generation-rules"
  if (-not $articleTypes -or $articleTypes.Count -lt 1) {
    throw "Article types empty for a newly authenticated member. Expected system presets."
  }
  if (-not $rules -or $rules.Count -lt 1) {
    throw "Generation rules empty for a newly authenticated member. Expected system defaults."
  }
  Write-Host ("  articleTypes={0} generationRules={1}" -f $articleTypes.Count, $rules.Count)

  Write-Step "Checking public login page and protected dashboard redirect"
  $loginPage = Invoke-HttpProbe -Uri "$WebUrl/login"
  if ($loginPage.StatusCode -ne 200) {
    throw "Web login page returned HTTP $($loginPage.StatusCode)"
  }
  $dashboard = Invoke-HttpProbe -Uri "$WebUrl/dashboard"
  if ($dashboard.StatusCode -notin @(301, 302, 303, 307, 308) -or $dashboard.Location -notmatch '^/login(?:\?|$)') {
    throw "Unauthenticated dashboard did not redirect to login. HTTP $($dashboard.StatusCode), Location '$($dashboard.Location)'"
  }

  Write-Step "Creating temporary authenticated API smoke article"
  $smokeTitle = "Docker smoke article $(Get-Date -Format 'yyyyMMddHHmmss')"
  $created = Invoke-Json -Method "POST" -Uri "$ApiUrl/api/articles" -Body @{
    title           = $smokeTitle
    keyword         = "docker-smoke"
    contentMarkdown = "# $smokeTitle"
    status          = "draft"
    tags            = @("smoke-test")
  }

  if (-not $created.id) {
    throw "Smoke article creation did not return an id."
  }

  $recordId = $created.id
  try {
    Write-Step "Verifying smoke article owner and content in PostgreSQL"
    $dbRow = & docker compose exec -T postgres psql -U zhixin -d zhixin_ai -t -A -F '|' -c "select owner_id, data->>'title' from records where id = '$recordId' and kind = 'articles';"
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to query PostgreSQL for smoke article."
    }
    $dbRow = ($dbRow | Out-String).Trim()
    if ($dbRow -ne "$smokeUserId|$smokeTitle") {
      throw "PostgreSQL smoke read failed. Expected owner/title '$smokeUserId|$smokeTitle', got '$dbRow'."
    }
  }
  finally {
    Write-Step "Cleaning temporary smoke records"
    & docker compose exec -T postgres psql -U zhixin -d zhixin_ai -c "delete from records where id = '$recordId';" | Out-Null
  }

  Write-Step "Docker deployment verified"
  Write-Host "API: $ApiUrl"
  Write-Host "Web: $WebUrl/ai-writer  (lazy one-click create)"
  Write-Host "Project: $($env:COMPOSE_PROJECT_NAME)"
  Write-Host "Network: zhixin-ai-net"
  Write-Host "Database: PostgreSQL container zhixin-ai-postgres"
  Write-Host "Queue: Redis container zhixin-ai-redis + worker zhixin-ai-worker"
  Write-Host "Images: zhixin-ai-backend:local (Scrapling), zhixin-ai-web:local"
  Write-Host "Try: open $WebUrl/ai-writer  |  knowledge URL  |  SERP with DataForSEO"
}
finally {
  if ($smokeUserCreated) {
    Write-Step "Cleaning temporary smoke member and sessions"
    & docker compose exec -T postgres psql -U zhixin -d zhixin_ai -c "delete from records where owner_id = '$smokeUserId'; delete from web_sessions where user_id = '$smokeUserId'; delete from users where id = '$smokeUserId';" | Out-Null
  }
  if ($null -ne $script:JsonHttpClient) {
    $script:JsonHttpClient.Dispose()
    $script:JsonHttpClient = $null
  }
  Pop-Location
}
