<#
  Builds the Windows installer EXE for a release.

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-installer.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-installer.ps1 -Commit 6be33a3

  Produces dist\DriverRadar-<version>-Setup.exe: a single file that installs the
  app for the current user, adds Start Menu and Desktop shortcuts, registers an
  entry in Apps & features, and carries a working uninstaller.

  No new dependencies. The setup binary is C# compiled with the .NET Framework
  csc.exe that ships with Windows, and the app is embedded as a resource, so the
  build needs nothing beyond git, PowerShell and Windows itself.

  The version is read from package.json and must agree with server.js, exactly
  like scripts\publish.ps1.
#>
param(
  [string]$Version = '',
  # Any commit-ish: HEAD by default, or a tag/commit to rebuild an old release.
  [string]$Commit = 'HEAD',
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$packageJson = Join-Path $Root 'package.json'
$serverFile = Join-Path $Root 'server.js'
$sourceFile = Join-Path $PSScriptRoot '..\installer\setup.cs'

if (-not $Version) {
  if (-not (Test-Path -LiteralPath $packageJson)) { throw "Missing $packageJson" }
  $Version = [string](Get-Content -LiteralPath $packageJson -Raw | ConvertFrom-Json).version
}
if (-not $Version) { throw "Could not read a version from $packageJson" }

# The EXE shows and registers this version, so it has to be the version the app
# reports in /api/health.
$serverVersion = [regex]::Match((Get-Content -LiteralPath $serverFile -Raw), "const VERSION = '([^']+)'").Groups[1].Value
if ($serverVersion -and $serverVersion -ne $Version) {
  throw "Version mismatch: package.json says $Version, server.js says $serverVersion."
}

if (-not (Test-Path -LiteralPath $sourceFile)) { throw "Missing $sourceFile" }
if (-not $OutDir) { $OutDir = Join-Path $Root 'dist' }
if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) {
  $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path -LiteralPath $csc)) {
  throw 'csc.exe (.NET Framework 4) was not found; it ships with Windows 10 and 11.'
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("driverradar-installer-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $work | Out-Null
$outFile = Join-Path $OutDir "DriverRadar-$Version-Setup.exe"

try {
  $payload = Join-Path $work 'payload.zip'
  Push-Location $Root
  try {
    git archive --format=zip -o "$payload" $Commit
    if ($LASTEXITCODE -ne 0) { throw "git archive failed for $Commit" }
  } finally {
    Pop-Location
  }

  # Installed copies do not need the installer's own source. Windows PowerShell
  # 5.1 does not load the ZIP types until they are asked for.
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::Open($payload, 'Update')
  try {
    foreach ($entry in @($zip.Entries)) {
      if ($entry.FullName -like 'installer/*') { $entry.Delete() }
    }
  } finally {
    $zip.Dispose()
  }

  # Version constant, generated so setup.cs stays free of build placeholders.
  $info = Join-Path $work 'build-info.cs'
  [System.IO.File]::WriteAllText(
    $info,
    "namespace DriverRadarSetup { internal static class BuildInfo { public const string Version = `"$Version`"; } }",
    (New-Object System.Text.UTF8Encoding($false))
  )

  # Icon: drawn rather than shipped as a binary blob, so the repo stays text.
  $icon = Join-Path $work 'driverradar.ico'
  Add-Type -AssemblyName System.Drawing
  $size = 256
  $bitmap = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $navy = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 15, 23, 42))
    $cyan = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 56, 189, 248))
    $ring = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 56, 189, 248)), 14
    $sweep = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(200, 125, 211, 252)), 10
    $sweep.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $sweep.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

    $g.FillEllipse($navy, 4, 4, $size - 8, $size - 8)
    $g.DrawEllipse($ring, 40, 40, 176, 176)
    $g.DrawEllipse($ring, 88, 88, 80, 80)
    $g.DrawLine($sweep, 128, 128, 196, 66)
    $g.FillEllipse($cyan, 118, 118, 20, 20)
  } finally {
    $g.Dispose()
  }

  $png = Join-Path $work 'icon.png'
  $bitmap.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()

  # Single 256px PNG entry: valid since Vista and enough for Explorer, the
  # taskbar and Add/Remove Programs.
  $pngBytes = [System.IO.File]::ReadAllBytes($png)
  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)
  try {
    $bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]1)   # reserved, type=icon, count
    $bw.Write([Byte]0); $bw.Write([Byte]0)                              # 0 means 256 px
    $bw.Write([Byte]0); $bw.Write([Byte]0)                              # palette, reserved
    $bw.Write([UInt16]1); $bw.Write([UInt16]32)                         # planes, bpp
    $bw.Write([UInt32]$pngBytes.Length)
    $bw.Write([UInt32]22)                                               # offset: 6 + 16
    $bw.Write($pngBytes)
    $bw.Flush()
    [System.IO.File]::WriteAllBytes($icon, $ms.ToArray())
  } finally {
    $bw.Dispose()
    $ms.Dispose()
  }

  if (Test-Path -LiteralPath $outFile) { Remove-Item -LiteralPath $outFile -Force }

  $references = @(
    'System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll',
    'System.IO.Compression.dll', 'System.IO.Compression.FileSystem.dll', 'Microsoft.CSharp.dll'
  ) | ForEach-Object { "/reference:$_" }

  $argumentList = @(
    '/nologo', '/target:winexe', '/platform:anycpu', '/optimize+', '/langversion:5',
    "/out:$outFile",
    "/win32icon:$icon",
    "/resource:$payload,DriverRadar.payload.zip"
  ) + $references + @(
    (Join-Path $Root 'installer\setup.cs'), $info
  )

  & $csc $argumentList
  if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }
  if (-not (Test-Path -LiteralPath $outFile)) { throw "csc reported success but $outFile is missing" }

  $item = Get-Item -LiteralPath $outFile
  $hash = (Get-FileHash -LiteralPath $outFile -Algorithm SHA256).Hash.ToLowerInvariant()
  [pscustomobject]@{
    version   = $Version
    commit    = $Commit
    installer = $item.FullName
    sizeBytes = $item.Length
    sha256    = $hash
  } | Format-List
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
