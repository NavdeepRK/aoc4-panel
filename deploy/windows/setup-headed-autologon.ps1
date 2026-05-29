<#
.SYNOPSIS
  Configure a *visible, watchable* headed Chromium run that survives reboots.

.DESCRIPTION
  WHY NOT A SERVICE?  A Windows Service runs in Session 0, which has no desktop on
  modern Windows. Headed Chrome launched from a service is invisible to an operator.
  To let a human watch/intervene in the browser, the process must run in an
  INTERACTIVE session. The reliable pattern:

    1. Autologon  — on boot the box logs into an interactive desktop (Session 1)
                    as a dedicated user, with no human at the keyboard.
    2. Keep-awake — disable screensaver / lock / sleep so the desktop stays live.
    3. Scheduled task (At log on, "run only when user is logged on") — starts the
       server in that interactive session, so Chromium windows are visible over RDP
       (use /admin console session or "Show session" RDP) and auto-restarts on crash.

  This script does (2) + (3). It does NOT set the autologon password into the
  registry for you (storing a plaintext password is a security risk) — instead it
  prints the recommended Sysinternals Autologon step for (1), which stores the
  secret encrypted in the LSA.

.NOTES
  Run from an ELEVATED PowerShell, signed in AS the dedicated automation user
  (the scheduled task is created for the current user). Ensure HEADLESS=false in .env.

.PARAMETER RepoRoot   Repo root. Defaults to two levels up from this script.
.PARAMETER TaskName   Scheduled task name. Default 'mca-filing-service'.
#>
[CmdletBinding()]
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$TaskName = 'mca-filing-service'
)

$ErrorActionPreference = 'Stop'
$startCmd = Join-Path $RepoRoot 'deploy\windows\start-server.cmd'
if (-not (Test-Path $startCmd)) { throw "start wrapper not found: $startCmd" }

$me = "$env:USERDOMAIN\$env:USERNAME"
Write-Host "==> Visible-headed setup for user: $me" -ForegroundColor Cyan

# --- sanity: warn if .env still headless ------------------------------------
$envFile = Join-Path $RepoRoot '.env'
if (Test-Path $envFile) {
  $headless = Select-String -Path $envFile -Pattern '^\s*HEADLESS\s*=\s*(.+)$' | Select-Object -Last 1
  if ($headless -and $headless.Matches[0].Groups[1].Value.Trim() -match '^(true|1)$') {
    Write-Host "    WARNING: .env has HEADLESS=true — set HEADLESS=false for a visible browser." -ForegroundColor Yellow
  }
}

# --- (2) keep the interactive desktop awake & unlocked ----------------------
Write-Host "==> Disabling sleep / screensaver lock for this machine..." -ForegroundColor Cyan
& powercfg /change standby-timeout-ac 0
& powercfg /change monitor-timeout-ac 0
& powercfg /change hibernate-timeout-ac 0
# Disable the lock-screen screensaver for the current user
New-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name 'ScreenSaveActive' -Value '0' -PropertyType String -Force | Out-Null
New-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name 'ScreenSaverIsSecure' -Value '0' -PropertyType String -Force | Out-Null
Write-Host "    done (AC power: no standby/monitor/hibernate timeout; screensaver off)." -ForegroundColor Green

# --- (3) scheduled task: start at logon, in this interactive session --------
Write-Host "==> Registering scheduled task '$TaskName' (At log on, interactive)..." -ForegroundColor Cyan
$action = New-ScheduledTaskAction -Execute $startCmd -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $me
# Interactive (run only when logged on) + highest privileges
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0)   # 0 = no time limit

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Description 'MCA filing service (headed, interactive session)' | Out-Null
Write-Host "    task registered." -ForegroundColor Green

Write-Host ""
Write-Host "==> REMAINING MANUAL STEP — enable autologon (so the box reaches an interactive" -ForegroundColor Yellow
Write-Host "    desktop after reboot with no human at the keyboard). Use Sysinternals Autologon"
Write-Host "    (stores the password encrypted in LSA, far safer than the registry):"
Write-Host ""
Write-Host "      1. Download https://download.sysinternals.com/files/Autologon.zip" -ForegroundColor Gray
Write-Host "      2. Run Autologon.exe, enter: user=$env:USERNAME, domain=$env:USERDOMAIN, password=****" -ForegroundColor Gray
Write-Host "      3. Click Enable. Reboot to verify it logs in + the server starts visibly." -ForegroundColor Gray
Write-Host ""
Write-Host "    To start it now without rebooting:  Start-ScheduledTask -TaskName $TaskName"
Write-Host "    Health:  curl http://localhost:8090/health"
