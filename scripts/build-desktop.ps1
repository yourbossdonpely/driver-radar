# Builds the Windows desktop app (Tauri 2) and copies the installer into dist\.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-desktop.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-desktop.ps1 -SkipStage
#
# Requires the Rust toolchain (rustup.rs) and Node 20+. WebView2 is already part
# of Windows 10 and 11; the installer bootstraps it if a machine is missing it.
#
# The same installer is built by .github/workflows/desktop-release.yml when a tag
# is pushed. DriverRadar ships for Windows only: the engine is PowerShell, the
# PnP tree and pnputil.
param(
  [switch]$SkipStage,
  [string]$Bundles = 'nsis'
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Desktop = Join-Path $Root 'desktop'
$Version = [string](Get-Content -LiteralPath (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json).version
$dist = Join-Path $Root 'dist'

function Invoke-Checked {
  param([scriptblock]$Command, [string]$What)
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$What failed (exit $LASTEXITCODE)." }
}

Set-Location $Root

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  throw 'cargo was not found. Install the Rust toolchain from https://rustup.rs and run this again.'
}

if (-not $SkipStage) {
  Invoke-Checked { node scripts/stage-desktop.js } 'Staging the desktop payload'
}

Set-Location $Desktop
if (-not (Test-Path -LiteralPath (Join-Path $Desktop 'node_modules\@tauri-apps\cli'))) {
  Invoke-Checked { npm install --no-audit --no-fund } 'npm install (desktop)'
}

Invoke-Checked { npx tauri build --bundles $Bundles } 'tauri build'

Set-Location $Root
New-Item -ItemType Directory -Force -Path $dist | Out-Null

$bundleRoot = Join-Path $Desktop 'src-tauri\target\release\bundle'
$built = @(Get-ChildItem -Path $bundleRoot -Recurse -File -Include *.exe, *.msi -ErrorAction SilentlyContinue)
if (-not $built.Count) { throw "tauri build produced no installer under $bundleRoot" }

foreach ($file in $built) {
  $kind = if ($file.Extension -eq '.msi') { 'msi' } else { 'setup' }
  $name = "DriverRadar-$Version-windows-x64-$kind$($file.Extension)"
  $destination = Join-Path $dist $name
  Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
  Write-Host "  $name"
}

Write-Host "`nWindows desktop installer(s) written to $dist"
