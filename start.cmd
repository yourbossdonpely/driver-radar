@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title DriverRadar

echo.
echo   DriverRadar
echo   -----------
echo.

rem ── 1. Administrator rights before anything else ─────────────────────────
rem Driver installs need elevation, and so does the one-time Node.js install,
rem so the prompt happens once at launch instead of halfway through an update.
net session >nul 2>&1
if errorlevel 1 (
  echo   Requesting administrator rights...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

rem ── 2. Dependencies: install Node.js on first run, silently ──────────────
rem bootstrap.ps1 finds an existing runtime, or installs the official LTS build
rem (winget, then the nodejs.org MSI) and records the path in data\node-path.txt.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\bootstrap.ps1"
if errorlevel 1 goto :no_node

rem bootstrap.ps1 rewrites this file on every run, so a stale path cannot linger.
set "NODE_EXE="
if exist "data\node-path.txt" for /f "usebackq delims=" %%A in ("data\node-path.txt") do if not defined NODE_EXE set "NODE_EXE=%%A"
if not defined NODE_EXE goto :no_node
if not exist "%NODE_EXE%" goto :no_node

rem ── 3. Reuse a server that is already running ────────────────────────────
set "SRV_ADMIN="
for /f "delims=" %%A in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "try { (Invoke-RestMethod -TimeoutSec 2 http://127.0.0.1:7788/api/health).admin } catch { 'down' }"') do set "SRV_ADMIN=%%A"

if /i "%SRV_ADMIN%"=="True" (
  echo   Already running with administrator rights.
  start "" http://127.0.0.1:7788
  timeout /t 2 >nul
  exit /b
)

if /i "%SRV_ADMIN%"=="False" (
  echo   Running without administrator rights - restarting it elevated...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-RestMethod -Method Post -TimeoutSec 5 http://127.0.0.1:7788/api/elevate | Out-Null } catch {}"
  for /l %%i in (1,1,25) do (
    timeout /t 1 >nul
    set "SRV_ADMIN="
    for /f "delims=" %%A in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "try { (Invoke-RestMethod -TimeoutSec 1 http://127.0.0.1:7788/api/health).admin } catch { 'down' }"') do set "SRV_ADMIN=%%A"
    if /i "!SRV_ADMIN!"=="True" goto :restarted
  )
  echo   Could not restart the running instance elevated. Run start.cmd again.
  pause
  exit /b 1
)

goto :opened

:restarted
echo   Now running with administrator rights.
start "" http://127.0.0.1:7788
timeout /t 2 >nul
exit /b

rem ── 4. Start the supervisor (keeps the server alive, restarts on crash) ──
:opened
echo   Starting the local server on http://127.0.0.1:7788
echo.
"%NODE_EXE%" supervisor.js --open
pause
exit /b

:no_node
echo.
echo   DriverRadar could not prepare Node.js 20 or newer.
echo.
echo   Usual causes:
echo     - this PC has no internet connection right now
echo     - winget or Windows Installer is blocked by group policy
echo.
echo   Manual install: https://nodejs.org/ - take the LTS MSI for this PC,
echo   then run start.cmd again.
echo.
pause
exit /b 1
