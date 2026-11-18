param(
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$OutFile
)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$results = New-Object System.Collections.ArrayList

$infPattern = Join-Path $Root '*.inf'
$packages = @(Get-ChildItem -Path $Root -Filter '*.inf' -Recurse -File -ErrorAction SilentlyContinue)

if ($packages.Count -eq 0) {
  $payload = [ordered]@{
    ok      = $false
    error   = 'No .inf files were found in the extracted package.'
    results = @()
    reboot  = $false
  }
  [System.IO.File]::WriteAllText($OutFile, ($payload | ConvertTo-Json -Depth 5 -Compress), (New-Object System.Text.UTF8Encoding($false)))
  exit 0
}

$allOutput = New-Object System.Collections.ArrayList
$reboot = $false

foreach ($inf in $packages) {
  $output = $null
  $code = 0
  try {
    $output = & pnputil.exe /add-driver $inf.FullName /install 2>&1 | Out-String
    $code = $LASTEXITCODE
  } catch {
    $output = $_.Exception.Message
    $code = 1
  }

  if ($output -match '(?i)reboot' -or $code -eq 3010) { $reboot = $true }
  [void]$allOutput.Add("### $($inf.Name)`r`n$output")

  [void]$results.Add([ordered]@{
    inf     = $inf.FullName
    name    = $inf.Name
    code    = $code
    output  = ($output.Trim())
    success = ($code -eq 0 -or $code -eq 3010)
  })
}

$payload = [ordered]@{
  ok        = ($results | Where-Object { -not $_.success }).Count -eq 0
  reboot    = $reboot
  count     = $results.Count
  results   = @($results)
  log       = ($allOutput -join "`r`n`r`n")
}

$json = $payload | ConvertTo-Json -Depth 5 -Compress
[System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
