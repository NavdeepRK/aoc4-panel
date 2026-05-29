@echo off
REM ---------------------------------------------------------------------------
REM Launch wrapper for mca-filing-service.
REM
REM Used by the Task Scheduler "visible headed" path (setup-headed-autologon.ps1)
REM and handy for a manual foreground run. The NSSM service does NOT use this
REM wrapper — it invokes node.exe directly (see install-nssm-service.ps1).
REM
REM Working directory MUST be the repo root so that `import 'dotenv/config'`
REM finds .env and Playwright resolves ./node_modules.
REM ---------------------------------------------------------------------------
setlocal

REM cd to repo root (this file lives in deploy\windows\)
cd /d "%~dp0\..\.."

REM Ensure Playwright finds the shared browser install even if the machine env
REM var hasn't propagated to this session yet.
if "%PLAYWRIGHT_BROWSERS_PATH%"=="" set "PLAYWRIGHT_BROWSERS_PATH=C:\ms-playwright"

REM HEADLESS / all other config come from .env (loaded by dotenv). To force
REM headed regardless of .env, uncomment the next line:
REM set "HEADLESS=false"

echo [start-server] cwd=%CD%  PLAYWRIGHT_BROWSERS_PATH=%PLAYWRIGHT_BROWSERS_PATH%
node --import tsx src/server/index.ts

endlocal
