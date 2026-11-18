param(
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
  ok        = $true
  error     = $null
  serviceId = '7971f918-a847-4430-9279-4a52d1efe18d'
  updates   = @()
}

try {
  $session = New-Object -ComObject Microsoft.Update.Session
  $session.ClientApplicationID = 'DriverUpdater/1.0'

  $searcher = $session.CreateUpdateSearcher()
  $searcher.ServerSelection = 3
  $searcher.ServiceID = '7971f918-a847-4430-9279-4a52d1efe18d'
  $searcher.Online = $true

  $results = $searcher.Search("IsInstalled=0 and Type='Driver' and IsHidden=0")

  $updates = New-Object System.Collections.ArrayList
  foreach ($u in $results.Updates) {
    $date = $null
    $rawDate = Get-Prop $u 'DriverVerDate'
    if ($rawDate) {
      try { $date = ([datetime]$rawDate).ToString('yyyy-MM-dd') } catch { $date = [string]$rawDate }
    }

    $hw = @()
    $rawHw = Get-Prop $u 'DriverHardwareID'
    if ($rawHw) { $hw = @($rawHw) }

    $identity = Get-Prop $u 'Identity'

    [void]$updates.Add([ordered]@{
      updateId     = if ($identity) { [string]$identity.UpdateID } else { $null }
      title        = [string](Get-Prop $u 'Title')
      driverClass  = [string](Get-Prop $u 'DriverClass')
      provider     = [string](Get-Prop $u 'DriverProvider')
      version      = [string](Get-Prop $u 'DriverVerVersion')
      date         = $date
      sizeBytes    = [int64](Get-Prop $u 'MaxDownloadSize')
      eulaAccepted = [bool](Get-Prop $u 'EulaAccepted')
      reboot       = [bool](Get-Prop $u 'RebootRequired')
      hardwareId   = $hw
      categories   = @($u.Categories | ForEach-Object { [string]$_.Name })
    })
  }

  $payload.updates = @($updates)
} catch {
  $payload.ok = $false
  $payload.error = $_.Exception.Message
}

$json = $payload | ConvertTo-Json -Depth 6 -Compress
[System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
