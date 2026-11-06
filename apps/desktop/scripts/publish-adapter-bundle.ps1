param(
  [string]$Version = "",
  [string]$Platforms = "penguin",
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$RemoteRoot = "/opt/zhixin-ai-downloads/adapter-bundles",
  [string]$ApiBaseUrl = "https://zhixin.example.com",
  [string]$PublicDownloadBaseUrl = "https://zhixin.example.com",
  [string]$StatePath = "$env:USERPROFILE\.zhixin-ai\desktop-agent.json",
  [string]$IdentityFile = "$env:USERPROFILE\.ssh\zhixin_deploy_ed25519",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$desktopRoot = Split-Path -Parent $PSScriptRoot

if (-not $Version) {
  $Version = Get-Date -Format "yyyyMMddHHmmss"
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )
  $previousErrorActionPreference = $ErrorActionPreference
  $exitCode = 1
  try {
    $ErrorActionPreference = "Continue"
    try {
      $null = & $FilePath @Arguments 2>&1
      $exitCode = $LASTEXITCODE
    } catch {
      $exitCode = 1
    }
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($exitCode -ne 0) {
    throw "Command failed: $FilePath"
  }
}

function Assert-PublishInputs {
  param(
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$Platforms,
    [Parameter(Mandatory = $true)][string]$RemoteRoot,
    [Parameter(Mandatory = $true)][string]$Server
  )
  if (-not ($Platforms.Trim() -cmatch "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$")) {
    throw "Invalid Platforms value."
  }
  if (-not ($Version -cmatch "^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$")) {
    throw "Invalid Version value."
  }
  if (
    -not ($RemoteRoot -cmatch "^/(?:[A-Za-z0-9._-]+/)*[A-Za-z0-9._-]+/?$") -or
    $RemoteRoot -cmatch "(^|/)\.{1,2}($|/)"
  ) {
    throw "Invalid RemoteRoot value."
  }
  if (-not ($Server -cmatch "^(?:[A-Za-z0-9][A-Za-z0-9._-]*@)?(?:[A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9])$")) {
    throw "Invalid Server value."
  }
}

function Invoke-RealPlatformGate {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$StagedManifestUrl
  )
  $previousErrorActionPreference = $ErrorActionPreference
  $exitCode = 1
  $output = $null
  try {
    $ErrorActionPreference = "Continue"
    try {
      $output = & node @Arguments 2>&1
      $exitCode = $LASTEXITCODE
    } catch {
      $output = $null
      $exitCode = 1
    }
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($exitCode -ne 0) {
    throw "Real platform gate failed. Staged bundle was not promoted."
  }
  return $output
}

function Assert-RealGateResult {
  param(
    [Parameter(Mandatory = $true)][string]$JsonText,
    [Parameter(Mandatory = $true)][string]$ExpectedVersion,
    [Parameter(Mandatory = $true)][string]$Platform
  )
  try {
    $result = $JsonText | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "Real platform gate returned invalid JSON."
  }
  if ($result.status -eq "idle") {
    throw "Real platform gate did not run: no queued desktop command was available."
  }
  if (-not $result.command) {
    throw "Real platform gate did not return a desktop command result."
  }
  if ($result.command.status -ne "succeeded") {
    throw "Real platform gate command did not succeed."
  }
  $payload = $result.command.result
  if ($payload.adapterBundleVersion -ne $ExpectedVersion) {
    throw "Real platform gate did not execute the expected staged adapter bundle."
  }
  $platformStatus = ([string]$payload.platformStatus).Trim()
  $reviewStatus = ([string]$payload.reviewStatus).Trim()
  $status = if ($platformStatus) { $platformStatus } else { $reviewStatus }
  if ($platformStatus -imatch "fallback" -or $reviewStatus -imatch "fallback") {
    throw "Real platform gate rejected a fallback publish state."
  }

  $validPublicUrlCount = 0
  foreach ($candidate in @($payload.publishedUrl, $payload.publicUrl, $payload.backlinkUrl)) {
    $candidateText = ([string]$candidate).Trim()
    if (-not $candidateText) { continue }

    $candidateUri = $null
    if (-not [Uri]::TryCreate($candidateText, [UriKind]::Absolute, [ref]$candidateUri)) {
      throw "Real platform gate returned an invalid public URL."
    }
    $uriHost = $candidateUri.DnsSafeHost.TrimEnd(".")
    $isDnsHost = [Uri]::CheckHostName($uriHost) -eq [UriHostNameType]::Dns
    $isLocalOrInvalid =
      -not $uriHost -or
      $uriHost -ieq "localhost" -or
      $uriHost -imatch "\.localhost$" -or
      $uriHost -ieq "invalid" -or
      $uriHost -imatch "\.invalid$"
    $isValidPublicUrl =
      ($candidateUri.Scheme -ieq "http" -or $candidateUri.Scheme -ieq "https") -and
      $isDnsHost -and
      -not $isLocalOrInvalid -and
      -not $candidateUri.UserInfo
    if (-not $isValidPublicUrl) {
      throw "Real platform gate returned an invalid public URL."
    }
    $validPublicUrlCount++
  }
  $reviewStatuses = @("submitted_for_review", "pending_public_visibility", "reviewing", "review_pending")
  if ($status -ieq "published") {
    if ($validPublicUrlCount -eq 0) {
      throw "Real platform gate did not reach a closed publish state."
    }
  } elseif (-not ($reviewStatuses -contains $status)) {
    throw "Real platform gate did not reach a closed publish state."
  }
  if ($Platform.Trim() -ieq "jianshu") {
    if (
      $platformStatus -cne "published" -or
      ([string]$payload.transport).Trim() -cne "api" -or
      $payload.publicVerified -isnot [bool] -or
      -not $payload.publicVerified
    ) {
      throw "Jianshu real platform gate did not return a verified API publication."
    }

    $evidence = $payload.publicationEvidence
    $publicEvidence = $evidence.public
    if (
      -not $evidence -or
      $evidence.source -cne "api" -or
      $evidence.accepted -isnot [bool] -or
      -not $evidence.accepted -or
      -not $publicEvidence -or
      $publicEvidence.titleMatched -isnot [bool] -or
      -not $publicEvidence.titleMatched -or
      $publicEvidence.bodyMatched -isnot [bool] -or
      -not $publicEvidence.bodyMatched -or
      $publicEvidence.shared -isnot [bool] -or
      -not $publicEvidence.shared
    ) {
      throw "Jianshu real platform gate did not verify the public title and body."
    }

    $noteId = ([string]$payload.externalIds.noteId).Trim()
    $slug = ([string]$payload.externalIds.slug).Trim()
    if (-not ($noteId -cmatch "^[0-9]+$") -or -not ($slug -cmatch "^[A-Za-z0-9]+$")) {
      throw "Jianshu real platform gate did not return valid note identifiers."
    }
    if (([string]$publicEvidence.noteId).Trim() -cne $noteId -or ([string]$publicEvidence.slug).Trim() -cne $slug) {
      throw "Jianshu real platform gate returned inconsistent public note identifiers."
    }

    try {
      $publishedUri = [Uri]([string]$payload.publishedUrl)
      $publicEvidenceUri = [Uri]([string]$publicEvidence.endpoint)
    } catch {
      throw "Jianshu real platform gate returned invalid publication endpoints."
    }
    if (
      $publishedUri.Scheme -cne "https" -or
      $publishedUri.DnsSafeHost -ine "www.jianshu.com" -or
      $publishedUri.Port -ne 443 -or
      $publishedUri.AbsolutePath -cne "/p/$slug" -or
      $publishedUri.UserInfo -or
      $publishedUri.Query -or
      $publishedUri.Fragment -or
      $publicEvidenceUri.Scheme -cne "https" -or
      $publicEvidenceUri.DnsSafeHost -ine "www.jianshu.com" -or
      $publicEvidenceUri.Port -ne 443 -or
      $publicEvidenceUri.AbsolutePath -cne "/shakespeare/v2/notes/$slug" -or
      $publicEvidenceUri.UserInfo -or
      $publicEvidenceUri.Query -or
      $publicEvidenceUri.Fragment
    ) {
      throw "Jianshu real platform gate evidence did not come from the expected public note endpoints."
    }

    $imageEvidence = $payload.imagePublicationEvidence
    $expectedImageCount = $imageEvidence.expectedCount
    $verifiedImageCount = $imageEvidence.public.verifiedCount
    if (
      -not $imageEvidence -or
      $imageEvidence.status -cne "verified" -or
      $expectedImageCount -isnot [int] -or
      $expectedImageCount -lt 1 -or
      -not $imageEvidence.public -or
      $imageEvidence.public.status -cne "verified" -or
      $verifiedImageCount -isnot [int] -or
      $verifiedImageCount -ne $expectedImageCount -or
      $publicEvidence.imageCount -isnot [int] -or
      $publicEvidence.imageCount -lt $expectedImageCount
    ) {
      throw "Jianshu real platform gate did not verify the public test image."
    }

    $cleanup = $payload.testCleanup
    if (
      -not $cleanup -or
      $cleanup.deleted -isnot [bool] -or
      -not $cleanup.deleted -or
      ([string]$cleanup.noteId).Trim() -cne $noteId
    ) {
      throw "Jianshu real platform gate did not delete the test article."
    }
  }
  if ($Platform.Trim() -ieq "csdn") {
    $evidence = $payload.publicationEvidence
    if (
      $platformStatus -cne "published" -or
      $payload.publiclyVisible -isnot [bool] -or
      -not $payload.publiclyVisible -or
      -not $evidence -or
      $evidence.source -cne "api" -or
      $evidence.transport -cne "csdn_signed_gateway" -or
      $evidence.accepted -isnot [bool] -or
      -not $evidence.accepted
    ) {
      throw "CSDN real platform gate did not return a verified signed-gateway publication."
    }

    $articleId = ([string]$payload.externalIds.articleId).Trim()
    $username = ([string]$payload.externalIds.username).Trim()
    if (-not ($articleId -cmatch "^[0-9]+$") -or -not ($username -cmatch "^[A-Za-z0-9_.-]+$")) {
      throw "CSDN real platform gate did not return valid article identifiers."
    }

    try {
      $publishedUri = [Uri]([string]$payload.publishedUrl)
    } catch {
      throw "CSDN real platform gate returned an invalid public article URL."
    }
    if (
      $publishedUri.Scheme -cne "https" -or
      $publishedUri.DnsSafeHost -ine "blog.csdn.net" -or
      $publishedUri.Port -ne 443 -or
      $publishedUri.AbsolutePath -cne "/$username/article/details/$articleId" -or
      $publishedUri.UserInfo -or
      $publishedUri.Query -or
      $publishedUri.Fragment
    ) {
      throw "CSDN real platform gate returned an inconsistent public article URL."
    }

    $steps = @($evidence.steps)
    $accountStep = @($steps | Where-Object { $_.stage -ceq "account" }) | Select-Object -First 1
    $draftStep = @($steps | Where-Object { $_.stage -ceq "draft" }) | Select-Object -First 1
    $publishStep = @($steps | Where-Object { $_.stage -ceq "publish" }) | Select-Object -First 1
    $readbackStep = @($steps | Where-Object { $_.stage -ceq "article_readback" }) | Select-Object -First 1
    $listStep = @($steps | Where-Object { $_.stage -ceq "article_list" }) | Select-Object -First 1
    $publicStep = @($steps | Where-Object { $_.stage -ceq "public_page" }) | Select-Object -First 1
    if (
      -not $accountStep -or ([string]$accountStep.username).Trim() -cne $username -or
      -not $draftStep -or ([string]$draftStep.articleId).Trim() -cne $articleId -or [int]$draftStep.status -ne 2 -or
      -not $publishStep -or ([string]$publishStep.articleId).Trim() -cne $articleId -or
      -not $readbackStep -or ([string]$readbackStep.articleId).Trim() -cne $articleId -or [int]$readbackStep.status -ne 1 -or
      -not $listStep -or ([string]$listStep.articleId).Trim() -cne $articleId -or [int]$listStep.status -ne 1 -or
      -not $publicStep -or ([string]$publicStep.articleId).Trim() -cne $articleId -or
      ([string]$publicStep.endpoint).Trim() -cne ([string]$payload.publishedUrl).Trim()
    ) {
      throw "CSDN real platform gate returned inconsistent API publication evidence."
    }

    $imageEvidence = $payload.imagePublicationEvidence
    $expectedImageCount = $imageEvidence.expectedCount
    if (
      -not $imageEvidence -or
      $imageEvidence.status -cne "verified" -or
      $expectedImageCount -isnot [int] -or
      $expectedImageCount -lt 1
    ) {
      throw "CSDN real platform gate did not verify a body image."
    }
    foreach ($stageName in @("upload", "draft", "public")) {
      $stage = $imageEvidence.$stageName
      if (
        -not $stage -or
        $stage.status -cne "verified" -or
        $stage.verifiedCount -isnot [int] -or
        $stage.verifiedCount -ne $expectedImageCount
      ) {
        throw "CSDN real platform gate did not verify the body image across every publication stage."
      }
    }

    $coverEvidence = $payload.coverImageEvidence
    try {
      $coverUri = [Uri]([string]$coverEvidence.platformImageUrl)
    } catch {
      throw "CSDN real platform gate returned invalid cover evidence."
    }
    if (
      -not $coverEvidence -or
      $coverEvidence.status -cne "verified" -or
      $coverUri.Scheme -cne "https" -or
      $coverUri.DnsSafeHost -inotmatch "(^|\.)csdnimg\.cn$" -or
      -not (@($coverEvidence.draftImages) -ccontains ([string]$coverEvidence.platformImageUrl)) -or
      -not (@($coverEvidence.listImages) -ccontains ([string]$coverEvidence.platformImageUrl))
    ) {
      throw "CSDN real platform gate did not verify the cover image."
    }

    $cleanup = $payload.testCleanup
    if (
      -not $cleanup -or
      $cleanup.deleted -isnot [bool] -or -not $cleanup.deleted -or
      $cleanup.softDeleted -isnot [bool] -or -not $cleanup.softDeleted -or
      $cleanup.permanentlyDeleted -isnot [bool] -or -not $cleanup.permanentlyDeleted -or
      $cleanup.listVerified -isnot [bool] -or -not $cleanup.listVerified -or
      ([string]$cleanup.articleId).Trim() -cne $articleId
    ) {
      throw "CSDN real platform gate did not permanently delete the test article."
    }
  }
  if ($Platform.Trim() -ieq "baijiahao") {
    $evidence = $payload.publicationEvidence
    $articleId = ([string]$payload.externalIds.articleId).Trim()
    $draft = $payload.draftEvidence
    $public = $payload.publicEvidence
    $cover = $payload.coverImageEvidence
    $cleanup = $payload.testCleanup
    if (
      -not $evidence -or
      $evidence.source -cne "api" -or
      $evidence.accepted -isnot [bool] -or -not $evidence.accepted -or
      -not ($articleId -cmatch "^[0-9]{8,}$")
    ) {
      throw "Baijiahao real platform gate did not return accepted API publication evidence."
    }
    $requiredStages = @("draft_create", "draft_update", "publish")
    foreach ($stageName in $requiredStages) {
      $stage = @($evidence.stages | Where-Object { $_.stage -ceq $stageName }) | Select-Object -First 1
      if (-not $stage -or $stage.httpStatus -isnot [int] -or $stage.httpStatus -lt 200 -or $stage.httpStatus -ge 300) {
        throw "Baijiahao real platform gate did not complete every API publication stage."
      }
    }
    if (
      $platformStatus -cne "published" -or
      $payload.publiclyVisible -isnot [bool] -or -not $payload.publiclyVisible -or
      $reviewStatus -cne "public" -or
      -not $draft -or
      $draft.found -isnot [bool] -or -not $draft.found -or
      ([string]$draft.articleId).Trim() -cne $articleId -or
      ([string]$draft.title).Trim() -cne ([string]$payload.title).Trim() -or
      $draft.coverImageCount -isnot [int] -or $draft.coverImageCount -lt 1
    ) {
      throw "Baijiahao real platform gate did not verify the draft title and image."
    }
    try {
      $coverUri = [Uri]([string]$cover.platformImageUrl)
    } catch {
      throw "Baijiahao real platform gate returned invalid platform cover evidence."
    }
    if (
      -not $cover -or
      $cover.status -cne "verified" -or
      $coverUri.Scheme -cne "https" -or
      $coverUri.DnsSafeHost -ine "baijiahao.baidu.com" -or
      $coverUri.AbsolutePath -cne "/bjh/picproxy"
    ) {
      throw "Baijiahao real platform gate did not upload a platform cover image."
    }
    try {
      $publishedUri = [Uri]([string]$payload.publishedUrl)
    } catch {
      throw "Baijiahao real platform gate returned an invalid public URL."
    }
    if (
      $publishedUri.Scheme -cne "https" -or
      $publishedUri.DnsSafeHost -ine "baijiahao.baidu.com" -or
      $publishedUri.Port -ne 443 -or
      $publishedUri.AbsolutePath -cne "/s" -or
      $publishedUri.UserInfo -or
      $publishedUri.Fragment -or
      $publishedUri.Query -notmatch "(^|[?&])id=[0-9]{8,}(&|$)"
    ) {
      throw "Baijiahao real platform gate returned an invalid public URL."
    }
    if (
      -not $public -or
      $public.found -isnot [bool] -or -not $public.found -or
      $public.titleMatched -isnot [bool] -or -not $public.titleMatched -or
      $public.bodyMatched -isnot [bool] -or -not $public.bodyMatched -or
      $public.publicImageFound -isnot [bool] -or -not $public.publicImageFound -or
      ([string]$public.publicUrl).Trim() -cne ([string]$payload.publishedUrl).Trim()
    ) {
      throw "Baijiahao real platform gate did not verify the anonymous public title, body, and image."
    }
    if (
      -not $cleanup -or
      $cleanup.withdrawn -isnot [bool] -or -not $cleanup.withdrawn -or
      $cleanup.removed -isnot [bool] -or -not $cleanup.removed -or
      ([string]$cleanup.articleId).Trim() -cne $articleId
    ) {
      throw "Baijiahao real platform gate did not remove the disposable test article."
    }
    $writebackOrder = $result.mediaOrder
    if (
      -not $writebackOrder -or
      ([string]$payload.mediaOrderId).Trim() -cne ([string]$writebackOrder.id).Trim() -or
      ([string]$writebackOrder.status).Trim() -cne "succeeded" -or
      ([string]$writebackOrder.platformStatus).Trim() -cne "published" -or
      ([string]$writebackOrder.reviewStatus).Trim() -cne "public" -or
      ([string]$writebackOrder.backlinkStatus).Trim() -cne "published" -or
      ([string]$writebackOrder.backlinkUrl).Trim() -cne ([string]$payload.publishedUrl).Trim()
    ) {
      throw "Baijiahao real platform gate did not write back the verified public URL."
    }
  }
  if ($Platform.Trim() -ieq "penguin") {
    $evidence = $payload.publicationEvidence
    if (-not $evidence -or $evidence.source -cne "api" -or $evidence.accepted -isnot [bool] -or -not $evidence.accepted) {
      throw "Penguin real platform gate did not return accepted direct API evidence."
    }

    try {
      $endpoint = [Uri]([string]$evidence.endpoint)
    } catch {
      throw "Penguin real platform gate returned an invalid API endpoint."
    }
    if (
      $endpoint.Scheme -cne "https" -or
      $endpoint.DnsSafeHost -ine "om.qq.com" -or
      $endpoint.Port -ne 443 -or
      $endpoint.AbsolutePath -cne "/marticlepublish/omPublish" -or
      $endpoint.UserInfo -or
      $endpoint.Query -or
      $endpoint.Fragment
    ) {
      throw "Penguin real platform gate evidence did not come from omPublish."
    }

    $responseEnvelope = $evidence.response
    $responseCodes = @()
    foreach ($codeNode in @($responseEnvelope, $responseEnvelope.response)) {
      if (-not $codeNode) { continue }
      $codeProperty = $codeNode.PSObject.Properties["code"]
      if ($codeProperty) {
        $responseCodes += $codeProperty.Value
      }
    }
    if ($responseCodes.Count -eq 0) {
      throw "Penguin real platform gate omPublish response was not accepted."
    }
    foreach ($responseCode in $responseCodes) {
      if ($responseCode -isnot [int] -or $responseCode -ne 0) {
        throw "Penguin real platform gate omPublish response was not accepted."
      }
    }

    $articleId = ([string]$payload.externalIds.articleId).Trim()
    if (-not ($articleId -cmatch "^[A-Za-z0-9_-]+$")) {
      throw "Penguin real platform gate did not return a real article ID."
    }
    $responseArticleIds = @()
    $responseDataNodes = @(
      $responseEnvelope.data,
      $responseEnvelope.response.data
    )
    foreach ($responseDataNode in $responseDataNodes) {
      if (-not $responseDataNode) { continue }
      $responseArticleIdProperty = $responseDataNode.PSObject.Properties["articleId"]
      if ($responseArticleIdProperty) {
        $responseArticleIds += ([string]$responseArticleIdProperty.Value).Trim()
      }
    }
    if ($responseArticleIds.Count -eq 0) {
      throw "Penguin real platform gate did not return a response article ID."
    }
    foreach ($responseArticleId in $responseArticleIds) {
      if ($responseArticleId -cne $articleId) {
        throw "Penguin real platform gate returned inconsistent article IDs."
      }
    }

    if (
      $platformStatus -cne "published" -or
      $payload.publiclyVisible -isnot [bool] -or
      -not $payload.publiclyVisible -or
      $payload.publicVerified -isnot [bool] -or
      -not $payload.publicVerified
    ) {
      throw "Penguin real platform gate did not verify public visibility."
    }

    try {
      $publishedUri = [Uri]([string]$payload.publishedUrl)
    } catch {
      throw "Penguin real platform gate returned an invalid public URL."
    }
    if (
      $publishedUri.Scheme -cne "https" -or
      $publishedUri.DnsSafeHost -ine "page.om.qq.com" -or
      $publishedUri.Port -ne 443 -or
      $publishedUri.UserInfo -or
      $publishedUri.Query -or
      $publishedUri.Fragment
    ) {
      throw "Penguin real platform gate returned an invalid public page URL."
    }

    $publicEvidence = $evidence.public
    if (
      -not $publicEvidence -or
      ([string]$publicEvidence.endpoint).Trim() -cne ([string]$payload.publishedUrl).Trim() -or
      $publicEvidence.titleMatched -isnot [bool] -or
      -not $publicEvidence.titleMatched -or
      $publicEvidence.bodyMatched -isnot [bool] -or
      -not $publicEvidence.bodyMatched -or
      $publicEvidence.imageCount -isnot [int] -or
      $publicEvidence.imageCount -lt 1
    ) {
      throw "Penguin real platform gate did not verify the anonymous public article."
    }

    $imageEvidence = $payload.imagePublicationEvidence
    $expectedImageCount = $imageEvidence.expectedCount
    if (
      -not $imageEvidence -or
      $imageEvidence.status -cne "verified" -or
      $expectedImageCount -isnot [int] -or
      $expectedImageCount -lt 1
    ) {
      throw "Penguin real platform gate did not verify an expected body image."
    }
    foreach ($stageName in @("upload", "draft", "public")) {
      $stage = $imageEvidence.$stageName
      if (
        -not $stage -or
        $stage.status -cne "verified" -or
        $stage.verifiedCount -isnot [int] -or
        $stage.verifiedCount -ne $expectedImageCount
      ) {
        throw "Penguin real platform gate did not verify body images across every stage."
      }
    }

    $writebackOrder = $result.mediaOrder
    $writebackImages = $writebackOrder.imagePublicationEvidence
    if (
      -not $writebackOrder -or
      ([string]$payload.mediaOrderId).Trim() -cne ([string]$writebackOrder.id).Trim() -or
      ([string]$writebackOrder.status).Trim() -cne "succeeded" -or
      ([string]$writebackOrder.platformStatus).Trim() -cne "published" -or
      ([string]$writebackOrder.reviewStatus).Trim() -cne "public" -or
      ([string]$writebackOrder.backlinkStatus).Trim() -cne "published" -or
      ([string]$writebackOrder.backlinkUrl).Trim() -cne ([string]$payload.publishedUrl).Trim() -or
      -not $writebackImages -or
      $writebackImages.status -cne "verified" -or
      $writebackImages.expectedCount -isnot [int] -or
      $writebackImages.expectedCount -ne $expectedImageCount -or
      $writebackImages.public.verifiedCount -isnot [int] -or
      $writebackImages.public.verifiedCount -ne $expectedImageCount
    ) {
      throw "Penguin real platform gate did not write back the verified public URL."
    }

    $cleanup = $payload.testCleanup
    $cleanupEvidence = $cleanup.publicationEvidence
    $cleanupResponse = $cleanupEvidence.response
    $cleanupPayload = $cleanupResponse.payload
    $cleanupCode = $cleanupPayload.response.code
    if (
      -not $cleanup -or
      $cleanup.deleted -isnot [bool] -or
      -not $cleanup.deleted -or
      ([string]$cleanup.articleId).Trim() -cne $articleId -or
      -not $cleanupEvidence -or
      -not $cleanupResponse -or
      $cleanupResponse.status -isnot [int] -or
      $cleanupResponse.status -ne 200 -or
      -not $cleanupPayload -or
      $cleanupCode -isnot [int] -or
      $cleanupCode -ne 0 -or
      $cleanupPayload.data.result -isnot [bool] -or
      -not $cleanupPayload.data.result
    ) {
      throw "Penguin real platform gate did not delete the test article."
    }
  }
}

$Platforms = $Platforms.Trim()
Assert-PublishInputs -Version $Version -Platforms $Platforms -RemoteRoot $RemoteRoot -Server $Server

if (-not $SkipBuild) {
  Invoke-Checked "node" @(
    (Join-Path $PSScriptRoot "create-adapter-bundle.mjs"),
    "--version", $Version,
    "--platforms", $Platforms
  )
}

$distRoot = Join-Path $desktopRoot "dist\adapter-bundles"
$bundlePath = Join-Path $distRoot "$Version.zip"
$manifestPath = Join-Path $distRoot "adapter-version.json"
if (-not (Test-Path -LiteralPath $bundlePath)) { throw "Bundle zip missing: $bundlePath" }
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Adapter manifest missing: $manifestPath" }

$remoteStaging = "$RemoteRoot/staging/$Version"
$sshOptions = @(
  "-i", $IdentityFile,
  "-o", "IdentitiesOnly=yes",
  "-o", "BatchMode=yes"
)
Invoke-Checked "ssh" @($sshOptions + @($Server, "mkdir -p '$remoteStaging' '$RemoteRoot/backups'"))
Invoke-Checked "scp" @($sshOptions + @($bundlePath, "$Server`:$remoteStaging/$Version.zip"))
Invoke-Checked "scp" @($sshOptions + @($manifestPath, "$Server`:$remoteStaging/adapter-version.json"))

$stagedManifestUrl = "$($PublicDownloadBaseUrl.TrimEnd('/'))/downloads/adapter-bundles/staging/$Version/adapter-version.json"
Write-Host "Staged adapter bundle: $stagedManifestUrl"

$env:ZHIXIN_ADAPTER_BUNDLE_MANIFEST_URL = $stagedManifestUrl
Write-Host "Running real platform gate..."
$firstPlatform = ($Platforms -split "," | Select-Object -First 1).Trim()
$agentArgs = @(
  (Join-Path $desktopRoot "src\agent.mjs"),
  "run-once",
  "--api", $ApiBaseUrl,
  "--state", $StatePath,
  "--platform", $firstPlatform,
  "--allow-foreground",
  "--adapter-bundle-manifest", $stagedManifestUrl
)
$gateOutput = Invoke-RealPlatformGate -Arguments $agentArgs -StagedManifestUrl $stagedManifestUrl
$gateJson = ($gateOutput | Out-String).Trim()
Assert-RealGateResult -JsonText $gateJson -ExpectedVersion $Version -Platform $firstPlatform

$backupName = Get-Date -Format "yyyyMMdd-HHmmss"
$promote = @"
set -e
mkdir -p '$RemoteRoot/backups/$backupName'
if [ -f '$RemoteRoot/adapter-version.json' ]; then cp '$RemoteRoot/adapter-version.json' '$RemoteRoot/backups/$backupName/adapter-version.json'; fi
if [ -f '$RemoteRoot/$Version.zip' ]; then cp '$RemoteRoot/$Version.zip' '$RemoteRoot/backups/$backupName/$Version.zip'; fi
cp '$remoteStaging/$Version.zip' '$RemoteRoot/$Version.zip'
cp '$remoteStaging/adapter-version.json' '$RemoteRoot/adapter-version.json'
"@
Invoke-Checked "ssh" @($sshOptions + @($Server, $promote))

Write-Host "Promoted adapter bundle version $Version"
Write-Host "$($PublicDownloadBaseUrl.TrimEnd('/'))/downloads/adapter-bundles/adapter-version.json"
