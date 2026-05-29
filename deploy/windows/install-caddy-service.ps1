<#
.SYNOPSIS
  Run Caddy as a Windows Service (via NSSM) fronting the worker with HTTPS.

.DESCRIPTION
  Wraps `caddy run --config <repo>\deploy\windows\Caddyfile` as an always-on
  Windows Service. Caddy auto-provisions + renews Let's Encrypt certs. Edit the
  Caddyfile first (WORKER_DOMAIN, BACKEND_IP, email).

  Prerequisites:
    - caddy.exe on PATH:   winget install CaddyServer.Caddy
    - nssm.exe on PATH:    winget install NSSM.NSSM
    - DNS A record: WORKER_DOMAIN -> this box's (Elastic) public IP
    - Firewall + EC2 Security Group: allow inbound 80 + 443
    - Worker running on 127.0.0.1:8090 (the scheduled task / NSSM service)

.NOTES
  Run from an ELEVATED PowerShell.

.PARAMETER RepoRoot     Repo root. Defaults to two levels up from this script.
.PARAMETER CaddyPath    Path to caddy.exe. Defaults to 'caddy' (expects it on PATH).
.PARAMETER NssmPath     Path to nssm.exe. Defaults to 'nssm' (expects it on PATH).
.PARAMETER ServiceName  Service name. Default 'mca-filing-caddy'.
#>
[CmdletBinding()]
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$CaddyPath = 'caddy',
  [string]$NssmPath = 'nssm',
  [string]$ServiceName = 'mca-filing-caddy'
)

$ErrorActionPreference = 'Stop'
$caddy = (Get-Command $CaddyPath -ErrorAction SilentlyContinue)
if (-not $caddy) { throw "caddy not found. Install via 'winget install CaddyServer.Caddy' or pass -CaddyPath." }
$caddy = $caddy.Source
$nssm = (Get-Command $NssmPath -ErrorAction SilentlyContinue)
if (-not $nssm) { throw "nssm not found. Install via 'winget install NSSM.NSSM' or pass -NssmPath." }
$nssm = $nssm.Source

$caddyfile = Join-Path $RepoRoot 'deploy\windows\Caddyfile'
if (-not (Test-Path $caddyfile)) { throw "Caddyfile not found: $caddyfile" }

# Refuse to start if placeholders are still present
$contents = Get-Content $caddyfile -Raw
if ($contents -match 'WORKER_DOMAIN' -or $contents -match 'BACKEND_IP') {
  throw "Edit $caddyfile first -- WORKER_DOMAIN / BACKEND_IP placeholders are still there."
}

# Validate the config
Write-Host "==> Validating Caddyfile..." -ForegroundColor Cyan
& $caddy validate --config $caddyfile
if ($LASTEXITCODE -ne 0) { throw "caddy validate failed." }

$logDir = Join-Path $RepoRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "==> Removing existing '$ServiceName' for clean reinstall." -ForegroundColor Yellow
  & $nssm stop $ServiceName confirm 2>$null | Out-Null
  & $nssm remove $ServiceName confirm | Out-Null
  Start-Sleep -Seconds 1
}

Write-Host "==> Installing Caddy service '$ServiceName'..." -ForegroundColor Cyan
& $nssm install $ServiceName $caddy
& $nssm set $ServiceName AppParameters "run --config `"$caddyfile`""
& $nssm set $ServiceName AppDirectory $RepoRoot
& $nssm set $ServiceName DisplayName 'MCA Filing Service - Caddy TLS proxy'
& $nssm set $ServiceName Start SERVICE_AUTO_START
& $nssm set $ServiceName AppStdout (Join-Path $logDir 'caddy.out.log')
& $nssm set $ServiceName AppStderr (Join-Path $logDir 'caddy.err.log')
& $nssm set $ServiceName AppRotateFiles 1
& $nssm set $ServiceName AppRotateBytes 10485760
& $nssm set $ServiceName AppExit Default Restart
& $nssm set $ServiceName AppRestartDelay 5000

& $nssm start $ServiceName
Start-Sleep -Seconds 3
$svc = Get-Service -Name $ServiceName
Write-Host ""
Write-Host "==> Caddy service '$ServiceName' status: $($svc.Status)" -ForegroundColor Green
Write-Host "    First cert issuance can take ~30s -- watch: Get-Content $logDir\caddy.err.log -Wait"
Write-Host "    Test from the backend host:  curl https://<WORKER_DOMAIN>/health"
