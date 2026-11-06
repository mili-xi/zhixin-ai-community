param(
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$desktopRoot = Split-Path -Parent $PSScriptRoot

if (-not $SkipBuild) {
  & npm.cmd --prefix $desktopRoot run tauri:build
  if ($LASTEXITCODE -ne 0) { throw "Desktop release build failed." }
}

$isccCandidates = @(
  (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"),
  (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe"),
  (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe")
)
$iscc = $isccCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $iscc) {
  throw "Inno Setup 6 is required. Install JRSoftware.InnoSetup with winget first."
}

$outputDir = Join-Path $desktopRoot "dist"
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

& $iscc "/Qp" (Join-Path $desktopRoot "installer\windows\zhixin-ai.iss")
if ($LASTEXITCODE -ne 0) { throw "Windows installer compilation failed." }

$installer = Join-Path $outputDir "zhixin-ai-windows.exe"
if (-not (Test-Path -LiteralPath $installer)) { throw "Installer output was not created: $installer" }
Get-Item -LiteralPath $installer | Select-Object FullName, Length, LastWriteTime
