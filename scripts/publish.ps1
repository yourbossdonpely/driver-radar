# Publishes a DriverRadar release to GitHub.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\publish.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\publish.ps1 -DryRun
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\publish.ps1 -Version 1.3.3
#
# The version comes from package.json, so the tag, the asset and the version the
# app reports in /api/health can never drift apart. Build the assets first:
#   git archive --format=zip -o dist\DriverRadar-<version>.zip --prefix=DriverRadar-<version>/ HEAD
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-installer.ps1
#
# Release notes are read from data\release-notes-<version>.md (git-ignored, like
# the rest of data\). Paths are resolved from the repository root, so the script
# runs from any working directory.
param(
  [string]$Version = '',
  [string]$Repo = 'yourbossdonpely/driver-radar',
  [string]$Notes = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# gh and git write expected misses ("release not found", "no remote") to stderr,
# and under $ErrorActionPreference = 'Stop' a native command's stderr becomes a
# terminating error — which used to abort the run after the push. Probes run
# with Continue and are decided by $LASTEXITCODE alone.
function Test-Quiet {
  param([scriptblock]$Probe)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Probe 2>$null | Out-Null
    return $LASTEXITCODE -eq 0
  } finally {
    $ErrorActionPreference = $previous
  }
}

# The script lives in scripts\, so the repository root is its parent.
$Root = Split-Path -Parent $PSScriptRoot
$packageJson = Join-Path $Root 'package.json'
$serverFile = Join-Path $Root 'server.js'

if (-not $Version) {
  if (-not (Test-Path -LiteralPath $packageJson)) { throw "Missing $packageJson" }
  $Version = [string](Get-Content -LiteralPath $packageJson -Raw | ConvertFrom-Json).version
}
if (-not $Version) { throw "Could not read a version from $packageJson" }

# server.js is the version /api/health reports, so a mismatch would ship a UI
# that disagrees with its own tag.
$serverVersion = [regex]::Match((Get-Content -LiteralPath $serverFile -Raw), "const VERSION = '([^']+)'").Groups[1].Value
if ($serverVersion -and $serverVersion -ne $Version) {
  throw "Version mismatch: package.json says $Version, server.js says $serverVersion."
}

$tag = "v$Version"
$zip = Join-Path $Root "dist\DriverRadar-$Version.zip"
$exe = Join-Path $Root "dist\DriverRadar-$Version-Setup.exe"
if (-not $Notes) { $Notes = Join-Path $Root "data\release-notes-$Version.md" }
else { $Notes = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Notes) }

Set-Location $Root

$assets = @($zip)
if (Test-Path -LiteralPath $exe) {
  $assets += $exe
}

if ($DryRun) {
  [pscustomobject]@{
    version        = $Version
    tag            = $tag
    zip            = $zip
    zipBuilt       = (Test-Path -LiteralPath $zip)
    exe            = $exe
    exeBuilt       = (Test-Path -LiteralPath $exe)
    notes          = $Notes
    notesAvailable = (Test-Path -LiteralPath $Notes)
  } | Format-List
  return
}

if (-not (Test-Path -LiteralPath $zip)) { throw "Missing release asset: $zip" }
if (-not (Test-Path -LiteralPath $Notes)) { throw "Missing release notes: $Notes" }

gh auth status
if ($LASTEXITCODE -ne 0) { throw 'gh is not authenticated. Run: gh auth login' }

if (-not (Test-Quiet { gh repo view $Repo --json name })) {
  gh repo create $Repo --public -d 'Windows driver scanner and updater' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'repo create failed' }
  if (-not (Test-Quiet { git remote get-url origin })) {
    git remote add origin "https://github.com/$Repo.git"
  }
}

git push -u origin main
if ($LASTEXITCODE -ne 0) { throw 'git push failed' }

if (Test-Quiet { gh release view $tag --repo $Repo }) {
  # Re-running for the same version replaces the assets instead of failing.
  foreach ($asset in $assets) {
    gh release upload $tag $asset --repo $Repo --clobber
    if ($LASTEXITCODE -ne 0) { throw "release upload failed for $asset" }
  }
} else {
  $createArgs = @('release', 'create', $tag) + $assets + @('--repo', $Repo, '--title', "DriverRadar $Version", '--notes-file', $Notes)
  & gh $createArgs
  if ($LASTEXITCODE -ne 0) { throw 'release create failed' }
}

gh repo view $Repo --json url,visibility,defaultBranchRef
gh release view $tag --repo $Repo --json url,assets
