<#
.SYNOPSIS
  One-time installer for mca-filing-service on a Windows automation server.

.DESCRIPTION
  - Verifies Node.js >= 20 is on PATH.
  - Pins PLAYWRIGHT_BROWSERS_PATH to a machine-wide folder so the browser binaries
    are found regardless of which account the Windows Service runs as.
  - Installs production npm deps (npm ci).
  - Downloads the Playwright Chromium build for Windows into that shared folder.
  - Seeds .env from .env.example if one doesn't exist yet.

.NOTES
  Run from an ELEVATED PowerShell (Run as Administrator) so the machine-level
  environment variable can be written. Example:

      Set-ExecutionPolicy -Scope Process Bypass -Force
      .\deploy\windows\install.ps1

.PARAMETER RepoRoot
  Path to the repo root. Defaults to two levels up from this script.

.PARAMETER BrowsersPath
  Where Playwright stores its Chromium build. Defaults to C:\ms-playwright.
#>
[CmdletBinding()]
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$BrowsersPath = 'C:\ms-playwright'
)

$ErrorActionPreference = 'Stop'
Write-Host "==> mca-filing-service Windows installer" -ForegroundColor Cyan
Write-Host "    RepoRoot     = $RepoRoot"
Write-Host "    BrowsersPath = $BrowsersPath"

# --- 1. Node check -----------------------------------------------------------
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) {
  throw "Node.js not found on PATH. Install the LTS (v20 or v22) from https://nodejs.org and re-open PowerShell."
}
$nodeVersion = (& node -v)  # e.g. v22.17.0
$major = [int]($nodeVersion.TrimStart('v').Split('.')[0])
if ($major -lt 20) {
  throw "Node.js $nodeVersion is too old. Install v20 LTS or newer."
}
Write-Host "==> Node $nodeVersion OK ($($node.Source))" -ForegroundColor Green

# --- 2. Pin Playwright browser path (machine-wide) ---------------------------
# Set it for BOTH the machine (so a service account inherits it) and the current
# process (so the npm/playwright steps below use it immediately).
[Environment]::SetEnvironmentVariable('PLAYWRIGHT_BROWSERS_PATH', $BrowsersPath, 'Machine')
$env:PLAYWRIGHT_BROWSERS_PATH = $BrowsersPath
New-Item -ItemType Directory -Force -Path $BrowsersPath | Out-Null
Write-Host "==> PLAYWRIGHT_BROWSERS_PATH set (machine + process) = $BrowsersPath" -ForegroundColor Green

# --- 3. Install npm deps -----------------------------------------------------
Push-Location $RepoRoot
try {
  # Skip the implicit browser download during npm ci; we do it explicitly in step 4
  # so it lands in the pinned shared folder.
  $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
  Write-Host "==> npm ci (production deps)..." -ForegroundColor Cyan
  & npm ci
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE)" }

  # --- 4. Install Chromium for Windows --------------------------------------
  Remove-Item Env:\PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD -ErrorAction SilentlyContinue
  Write-Host "==> Downloading Playwright Chromium into $BrowsersPath ..." -ForegroundColor Cyan
  & npx playwright install chromium
  if ($LASTEXITCODE -ne 0) { throw "playwright install chromium failed (exit $LASTEXITCODE)" }

  # --- 5. Seed .env ----------------------------------------------------------
  $envFile = Join-Path $RepoRoot '.env'
  $envExample = Join-Path $RepoRoot '.env.example'
  if (-not (Test-Path $envFile)) {
    Copy-Item $envExample $envFile
    Write-Host "==> Created .env from .env.example — EDIT IT before starting the service." -ForegroundColor Yellow
  } else {
    Write-Host "==> .env already exists — leaving it untouched." -ForegroundColor Green
  }

  # --- 6. Smoke test ---------------------------------------------------------
  Write-Host "==> Typecheck (npm run typecheck)..." -ForegroundColor Cyan
  & npm run typecheck
  if ($LASTEXITCODE -ne 0) { Write-Host "    typecheck reported issues (non-fatal for runtime)." -ForegroundColor Yellow }
}
finally {
  Pop-Location
}

Write-Host ""
Write-Host "==> Install complete." -ForegroundColor Green
Write-Host "    Next:"
Write-Host "      1. Edit .env  (ADMIN_TOKEN, MAX_CONCURRENT_JOBS, captcha keys, PORTAL_BACKEND_URL/SYSTEM_AUTH_TOKEN, HEADLESS)"
Write-Host "      2a. Headless service:  .\deploy\windows\install-nssm-service.ps1"
Write-Host "      2b. Visible headed:    .\deploy\windows\setup-headed-autologon.ps1"
