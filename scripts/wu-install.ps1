param(
  [Parameter(Mandatory = $true)][string]$UpdateId,
  [Parameter(Mandatory = $true)][string]$OutFile
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Get-Prop($object, $name) {
  try {
    $value = $object.$name
    if ($null -ne $value) { return $value }
  } catch { }
  return $null
}

$payload = [ordered]@{
  ok      = $false
  error   = $null
  message = $null
  reboot  = $false
}

try {
  $session = New-Object -ComObject Microsoft.Update.Session
  $session.ClientApplicationID = 'DriverUpdater/1.0'

  $searcher = $session.CreateUpdateSearcher()
  $searcher.ServerSelection = 3
  $searcher.ServiceID = '7971f918-a847-4430-9279-4a52d1efe18d'
  $searcher.Online = $true

  $results = $searcher.Search("IsInstalled=0 and Type='Driver'")
  $update = $null
  foreach ($u in $results.Updates) {
    $identity = Get-Prop $u 'Identity'
    if ($identity -and ([string]$identity.UpdateID) -eq $UpdateId) { $update = $u; break }
  }

  if (-not $update) {
    throw "The update is no longer offered by Windows Update. Rescan and try again."
  }

  if (-not (Get-Prop $update 'EulaAccepted')) {
    $update.AcceptEula()
  }

  $collection = New-Object -ComObject Microsoft.Update.UpdateColl
  [void]$collection.Add($update)

  $downloader = $session.CreateUpdateDownloader()
  $downloader.Updates = $collection
  $downloadResult = $downloader.Download()
  if ($downloadResult.ResultCode -ne 2) {
    throw "Download failed with result code $($downloadResult.ResultCode)."
  }

  $installer = $session.CreateUpdateInstaller()
  $installer.Updates = $collection
  $installResult = $installer.Install()

  $payload.ok = ($installResult.ResultCode -eq 2)
  $payload.reboot = [bool]$installResult.RebootRequired
  $payload.message = "Result code $($installResult.ResultCode)"
  if (-not $payload.ok) { $payload.error = "Install returned result code $($installResult.ResultCode)." }
} catch {
  $payload.error = $_.Exception.Message
}

[System.IO.File]::WriteAllText($OutFile, ($payload | ConvertTo-Json -Depth 4 -Compress), (New-Object System.Text.UTF8Encoding($false)))
