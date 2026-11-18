<#
  DriverRadar first-run bootstrap.

  A brand new Windows PC has no Node.js, and start.cmd cannot run anything until a
  runtime exists. This file is the only part of the project that runs without Node:
  it looks for a suitable runtime, installs the official LTS build when there is
  none, and hands the absolute path back to start.cmd through data\node-path.txt.

  Resolution order:
    1. A runtime already on the machine (PATH, Program Files, per-user install).
    2. winget -> OpenJS.NodeJS.LTS, silent.
    3. The official nodejs.org MSI for this CPU, silent.

  Exit codes: 0 = runtime ready, 1 = could not prepare one.
#>
param(
  [int]$MinMajor = 20,
  [string]$OutFile = (Join-Path (Split-Path -Parent $PSScriptRoot) 'data\node-path.txt'),
  # Diagnose only: report what would be used, never install anything.
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = Split-Path -Parent $PSScriptRoot
$LogFile = Join-Path $Root 'data\bootstrap.log'

# A brand new machine has no data\ yet, and both the log redirect and the MSI
# fallback need somewhere to write. Create it before anything else can fail.
$DataDir = Join-Path $Root 'data'
if (-not (Test-Path -LiteralPath $DataDir)) {
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
}

function Write-Note([string]$Text) { Write-Host "  $Text" -ForegroundColor Cyan }
function Write-Problem([string]$Text) { Write-Host "  $Text" -ForegroundColor Yellow }

function Get-NodeVersion([string]$Path) {
  if (-not $Path) { return $null }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try {
    $raw = & $Path --version 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
    $text = ([string]($raw | Select-Object -First 1)).Trim()
    if ($text -notmatch '^v(\d+)\.') { return $null }
    return [pscustomobject]@{
      Path    = (Resolve-Path -LiteralPath $Path).ProviderPath
      Version = $text
      Major   = [int]$Matches[1]
    }
  } catch {
    return $null
  }
}

function Find-Node {
  $candidates = New-Object System.Collections.Generic.List[string]

  $onPath = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($onPath) { $candidates.Add($onPath.Source) }

  $known = @()
  if ($env:ProgramFiles) { $known += (Join-Path $env:ProgramFiles 'nodejs\node.exe') }
  if (${env:ProgramFiles(x86)}) { $known += (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe') }
  if ($env:LOCALAPPDATA) { $known += (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe') }
  $known += 'C:\dev\nodejs\node.exe'
  foreach ($path in $known) { $candidates.Add($path) }

  foreach ($path in $candidates) {
    $info = Get-NodeVersion $path
    if ($info -and $info.Major -ge $MinMajor) { return $info }
  }
  return $null
}

function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @($machine, $user) | Where-Object { $_ }
  $env:Path = ($parts -join ';')
}

function Save-NodePath([string]$Path) {
  $dir = Split-Path -Parent $OutFile
  if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }
  [System.IO.File]::WriteAllText(
    $OutFile,
    $Path + [Environment]::NewLine,
    (New-Object System.Text.UTF8Encoding($false))
  )
}

function Install-WithWinget {
  $winget = (Get-Command winget.exe -ErrorAction SilentlyContinue).Source
  if (-not $winget -and $env:LOCALAPPDATA) {
    $alias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe'
    if (Test-Path -LiteralPath $alias) { $winget = $alias }
  }
  if (-not $winget) { return $false }

  Write-Note 'Installing Node.js LTS with winget (this is the slow part)...'
  $wingetArgs = @(
    'install', '--id', 'OpenJS.NodeJS.LTS', '-e', '--source', 'winget', '--silent',
    '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity'
  )
  try {
    $proc = Start-Process -FilePath $winget -ArgumentList $wingetArgs -Wait -PassThru `
      -NoNewWindow -RedirectStandardOutput $LogFile -RedirectStandardError "$LogFile.err"
    # 0 = installed, -1978335189 / 0x8A15002B = already installed. Anything else may
    # still have worked, so verify by looking for the binary rather than the code.
    if ($proc.ExitCode -eq 0) { return $true }
  } catch {
    Add-Content -Path "$LogFile.err" -Value $_.Exception.Message
  }
  Update-SessionPath
  return [bool](Find-Node)
}

function Install-FromOfficialMsi {
  $arch = 'x64'
  if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $arch = 'arm64' }
  elseif ($env:PROCESSOR_ARCHITECTURE -eq 'x86') { $arch = 'x86' }

  Write-Note 'Looking up the current Node.js LTS release...'
  $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing -TimeoutSec 60
  $lts = @($index | Where-Object { $_.lts }) | Select-Object -First 1
  if (-not $lts) { throw 'nodejs.org did not report an LTS release.' }

  $version = [string]$lts.version
  $fileName = "node-$version-$arch.msi"
  $url = "https://nodejs.org/dist/$version/$fileName"
  $msi = Join-Path $env:TEMP $fileName

  Write-Note "Downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $msi -UseBasicParsing -TimeoutSec 600

  Write-Note 'Installing it silently...'
  $proc = Start-Process -FilePath 'msiexec.exe' `
    -ArgumentList @('/i', "`"$msi`"", '/qn', '/norestart') -Wait -PassThru
  Remove-Item -LiteralPath $msi -ErrorAction SilentlyContinue

  # 3010 = installed, reboot pending. Treat it as success and check the binary.
  if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) {
    throw "msiexec returned $($proc.ExitCode)."
  }
  Update-SessionPath
}

function Check-Windows {
  if ($env:OS -ne 'Windows_NT') {
    throw 'DriverRadar only runs on Windows.'
  }
  if ($PSVersionTable.PSVersion.Major -lt 5) {
    Write-Problem "PowerShell $($PSVersionTable.PSVersion) is old; 5.1 or newer is recommended."
  }
}

# ── main ──────────────────────────────────────────────────────────────────
try {
  Check-Windows
} catch {
  Write-Problem $_.Exception.Message
  exit 1
}

$node = Find-Node

if (-not $node) {
  if ($CheckOnly) {
    Write-Problem "No Node.js $MinMajor or newer found."
    exit 1
  }

  Write-Host ''
  Write-Host '  DriverRadar needs Node.js 20 or newer and will install it now.' -ForegroundColor White
  Write-Host '  This happens once. It needs an internet connection.' -ForegroundColor Gray
  Write-Host ''

  $installed = $false
  try {
    $installed = Install-WithWinget
  } catch {
    Add-Content -Path "$LogFile.err" -Value $_.Exception.Message -ErrorAction SilentlyContinue
  }
  if ($installed) { $node = Find-Node }

  if (-not $node) {
    try {
      Install-FromOfficialMsi
      $node = Find-Node
    } catch {
      Write-Problem "Could not install Node.js: $($_.Exception.Message)"
      Write-Problem "Details: $LogFile"
      exit 1
    }
  }
}

if (-not $node) {
  Write-Problem "Node.js $MinMajor or newer is still not available."
  exit 1
}

Save-NodePath $node.Path
Write-Note "Node.js $($node.Version) -> $($node.Path)"
exit 0
