@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title DriverRadar

rem ── 1. Find Node.js (PATH, then the usual install locations) ─────────────
set "NODE_EXE="
where node >nul 2>&1
if not errorlevel 1 set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "C:\dev\nodejs\node.exe" set "NODE_EXE=C:\dev\nodejs\node.exe"

if not defined NODE_EXE (
  echo.
  echo   Node.js 20 or newer is required to run DriverRadar.
  echo.
  where winget >nul 2>&1
  if not errorlevel 1 (
    choice /c YN /n /m "  Install Node.js LTS automatically with winget? [Y/N] "
    if errorlevel 2 goto :no_node
    echo.
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
    if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
  )
)
if not defined NODE_EXE goto :no_node

rem ── 2. Elevate before anything is served ─────────────────────────────────
rem Driver installs need an elevated process. Asking once at launch is better
rem than failing later with "administrator rights required".
net session >nul 2>&1
if errorlevel 1 (
  echo Requesting administrator rights...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

rem ── 3. Reuse a server that is already running ────────────────────────────
set "SRV_ADMIN="
for /f "delims=" %%A in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "try { (Invoke-RestMethod -TimeoutSec 2 http://127.0.0.1:7788/api/health).admin } catch { 'down' }"') do set "SRV_ADMIN=%%A"

if /i "%SRV_ADMIN%"=="True" (
  echo DriverRadar is already running with administrator rights.
  start "" http://127.0.0.1:7788
  timeout /t 2 >nul
  exit /b
)

if /i "%SRV_ADMIN%"=="False" (
  echo DriverRadar is running without administrator rights - restarting it elevated...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-RestMethod -Method Post -TimeoutSec 5 http://127.0.0.1:7788/api/elevate | Out-Null } catch {}"
  for /l %%i in (1,1,25) do (
    timeout /t 1 >nul
    set "SRV_ADMIN="
    for /f "delims=" %%A in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "try { (Invoke-RestMethod -TimeoutSec 1 http://127.0.0.1:7788/api/health).admin } catch { 'down' }"') do set "SRV_ADMIN=%%A"
    if /i "!SRV_ADMIN!"=="True" goto :restarted
  )
  echo Could not restart the running instance elevated. Run start.cmd again.
  pause
  exit /b 1
)

goto :opened

:restarted
echo DriverRadar is now running with administrator rights.
start "" http://127.0.0.1:7788
timeout /t 2 >nul
exit /b

rem ── 4. Start the supervisor (keeps the server alive, restarts on crash) ──
:opened
echo Starting DriverRadar on http://127.0.0.1:7788
"%NODE_EXE%" supervisor.js --open
pause
exit /b

:no_node
echo.
echo   Could not find Node.js.
echo   Install the LTS build from https://nodejs.org/ and run start.cmd again.
echo.
pause
exit /b 1
