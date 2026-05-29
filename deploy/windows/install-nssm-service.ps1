<#
.SYNOPSIS
  Register mca-filing-service as an always-on Windows Service via NSSM.

.DESCRIPTION
  NSSM (the Non-Sucking Service Manager) wraps node.exe as a Windows Service with
  auto-restart and log redirection. The service invokes:

      node.exe --import tsx src\server\index.ts

  ...with the working directory set to the repo root (so dotenv finds .env and
  Playwright resolves node_modules). A single node.exe child = clean stop/restart.

  IMPORTANT -- Session 0 isolation:
    A Windows Service runs in Session 0, which has no interactive desktop on
    Windows 10/11 and Server 2016+. If HEADLESS=false, Chromium will still LAUNCH
    but will be INVISIBLE to anyone logged in over RDP/console. Use this NSSM path
    for HEADLESS=true. For a watchable headed browser, use
    setup-headed-autologon.ps1 instead.

.NOTES
  Run from an ELEVATED PowerShell. Requires nssm.exe -- download from
  https://nssm.cc/download (unzip win64\nssm.exe) and pass its path, or drop it on
  PATH. Or install via:  winget install NSSM.NSSM   /   choco install nssm

.PARAMETER RepoRoot     Repo root. Defaults to two levels up from this script.
.PARAMETER NssmPath     Path to nssm.exe. Defaults to 'nssm' (expects it on PATH).
.PARAMETER ServiceName  Windows service name. Default 'mca-filing-service'.
.PARAMETER LogDir       Where stdout/stderr are written. Default <RepoRoot>\logs.
.PARAMETER ServiceUser  Optional 'DOMAIN\user' or '.\user' to run as. Default = LocalSystem.
.PARAMETER ServicePassword  Password for ServiceUser (required if ServiceUser set).
#>
[CmdletBinding()]
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$NssmPath = 'nssm',
  [string]$ServiceName = 'mca-filing-service',
  [string]$LogDir = $null,
  [string]$ServiceUser = $null,
  [string]$ServicePassword = $null
)

$ErrorActionPreference = 'Stop'
if (-not $LogDir) { $LogDir = Join-Path $RepoRoot 'logs' }

# --- resolve tools -----------------------------------------------------------
$nssm = (Get-Command $NssmPath -ErrorAction SilentlyContinue)
if (-not $nssm) { throw "nssm not found at '$NssmPath'. Install via 'winget install NSSM.NSSM' or pass -NssmPath C:\path\to\nssm.exe" }
$nssm = $nssm.Source

$node = (Get-Command node -ErrorAction Stop).Source
$entry = Join-Path $RepoRoot 'src\server\index.ts'
if (-not (Test-Path $entry)) { throw "Entry not found: $entry -- is -RepoRoot correct?" }

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$browsersPath = [Environment]::GetEnvironmentVariable('PLAYWRIGHT_BROWSERS_PATH', 'Machine')
if (-not $browsersPath) { $browsersPath = 'C:\ms-playwright' }

Write-Host "==> Installing service '$ServiceName'" -ForegroundColor Cyan
Write-Host "    node    = $node"
Write-Host "    repo    = $RepoRoot"
Write-Host "    logs    = $LogDir"
Write-Host "    browsers= $browsersPath"

# --- remove any prior definition (idempotent) --------------------------------
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "==> Existing service found -- stopping + removing for clean reinstall." -ForegroundColor Yellow
  & $nssm stop $ServiceName confirm 2>$null | Out-Null
  & $nssm remove $ServiceName confirm | Out-Null
  Start-Sleep -Seconds 1
}

# --- install -----------------------------------------------------------------
& $nssm install $ServiceName $node
& $nssm set $ServiceName AppParameters '--import tsx src\server\index.ts'
& $nssm set $ServiceName AppDirectory $RepoRoot
& $nssm set $ServiceName DisplayName 'MCA Filing Service (AOC-4)'
& $nssm set $ServiceName Description 'Playwright automation worker for MCA V3 portal filings'
& $nssm set $ServiceName Start SERVICE_AUTO_START

# Environment: dotenv loads .env, but PLAYWRIGHT_BROWSERS_PATH must be present
# in the service environment so Chromium is found.
& $nssm set $ServiceName AppEnvironmentExtra "PLAYWRIGHT_BROWSERS_PATH=$browsersPath" "NODE_ENV=production"

# Logging -- rotate at 10 MB
& $nssm set $ServiceName AppStdout (Join-Path $LogDir 'service.out.log')
& $nssm set $ServiceName AppStderr (Join-Path $LogDir 'service.err.log')
& $nssm set $ServiceName AppRotateFiles 1
& $nssm set $ServiceName AppRotateOnline 1
& $nssm set $ServiceName AppRotateBytes 10485760

# Restart policy: on crash, throttle then restart
& $nssm set $ServiceName AppExit Default Restart
& $nssm set $ServiceName AppRestartDelay 5000
& $nssm set $ServiceName AppThrottle 5000

# Graceful stop -- give in-flight Playwright browsers time to close (index.ts traps SIGTERM/SIGINT)
& $nssm set $ServiceName AppStopMethodConsole 15000
& $nssm set $ServiceName AppStopMethodWindow 5000

# Optional dedicated service account
if ($ServiceUser) {
  if (-not $ServicePassword) { throw "-ServicePassword is required when -ServiceUser is set." }
  & $nssm set $ServiceName ObjectName $ServiceUser $ServicePassword
  Write-Host "==> Service will run as $ServiceUser" -ForegroundColor Green
  Write-Host "    NOTE: ensure Chromium at $browsersPath is readable by that account." -ForegroundColor Yellow
}

# --- start -------------------------------------------------------------------
& $nssm start $ServiceName
Start-Sleep -Seconds 3
$svc = Get-Service -Name $ServiceName
Write-Host ""
Write-Host "==> Service '$ServiceName' status: $($svc.Status)" -ForegroundColor Green
Write-Host "    Logs:    $LogDir\service.out.log  /  service.err.log"
Write-Host "    Manage:  nssm restart $ServiceName   |   nssm stop $ServiceName   |   nssm edit $ServiceName"
Write-Host "    Health:  curl http://localhost:8090/health"
