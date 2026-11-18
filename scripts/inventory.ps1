param(
  [Parameter(Mandatory = $true)][string]$OutFile
)
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

# Join the live PnP device tree with the signed-driver metadata.
$signed = @{}
Get-CimInstance Win32_PnPSignedDriver | ForEach-Object {
  if ($_.DeviceID) { $signed[$_.DeviceID] = $_ }
}

$devices = foreach ($d in (Get-PnpDevice -PresentOnly)) {
  $meta = $signed[$d.InstanceId]
  $hw = @()
  if ($d.HardwareID) { $hw = @($d.HardwareID) }

  $date = $null
  if ($meta -and $meta.DriverDate) {
    $date = ([datetime]$meta.DriverDate).ToString('yyyy-MM-dd')
  }

  [ordered]@{
    id         = $d.InstanceId
    name       = if ($d.FriendlyName) { $d.FriendlyName } else { $d.Class }
    className  = [string]$d.Class
    status     = [string]$d.Status
    problem    = [int]$d.Problem
    virtual    = [bool]$d.Present  # kept for schema stability
    provider   = if ($meta) { [string]$meta.DriverProviderName } else { $null }
    version    = if ($meta) { [string]$meta.DriverVersion } else { $null }
    date       = $date
    inf        = if ($meta) { [string]$meta.InfName } else { $null }
    hardwareId = $hw
  }
}

$payload = [ordered]@{
  ok          = $true
  capturedAt  = (Get-Date).ToString('o')
  computer    = $env:COMPUTERNAME
  os          = (Get-CimInstance Win32_OperatingSystem).Caption
  osVersion   = (Get-CimInstance Win32_OperatingSystem).Version
  build       = (Get-CimInstance Win32_OperatingSystem).BuildNumber
  manufacturer= (Get-CimInstance Win32_ComputerSystem).Manufacturer
  model       = (Get-CimInstance Win32_ComputerSystem).Model
  devices     = @($devices)
}

$json = $payload | ConvertTo-Json -Depth 6 -Compress
[System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
