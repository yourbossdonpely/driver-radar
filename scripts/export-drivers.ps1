param(
  [Parameter(Mandatory = $true)][string]$OutDir,
  [Parameter(Mandatory = $true)][string]$OutFile
)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

# Back up every third-party driver package before an update. Windows' inbox
# drivers are never touched by pnputil, so `*` is exactly the set worth keeping.
$payload = [ordered]@{
  ok    = $false
  path  = $OutDir
  count = 0
  log   = $null
  error = $null
}

try {
  if (-not (Test-Path -LiteralPath $OutDir)) {
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  }

  $output = & pnputil.exe /export-driver '*' $OutDir 2>&1 | Out-String
  $code = $LASTEXITCODE
  $payload.log = $output.Trim()

  $files = @(Get-ChildItem -LiteralPath $OutDir -Recurse -Filter '*.inf' -File -ErrorAction SilentlyContinue)
  $payload.count = $files.Count

  if ($code -eq 0 -or $files.Count -gt 0) {
    # pnputil can return non-zero when it skips one package but still exports the
    # rest; having files on disk is the outcome that matters.
    $payload.ok = $true
  } else {
    $payload.error = if ($output.Trim()) { $output.Trim() } else { "pnputil returned $code." }
  }
} catch {
  $payload.error = $_.Exception.Message
}

$json = $payload | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
