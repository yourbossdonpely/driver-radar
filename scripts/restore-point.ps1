param(
  [string]$Description = 'Before driver update',
  [Parameter(Mandatory = $true)][string]$OutFile
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$payload = [ordered]@{ ok = $false; error = $null; message = $null }
try {
  Enable-ComputerRestore -Drive "$env:SystemDrive\" -ErrorAction SilentlyContinue
  Checkpoint-Computer -Description $Description -RestorePointType 'MODIFY_SETTINGS' -ErrorAction Stop
  $payload.ok = $true
  $payload.message = 'Restore point created.'
} catch {
  $payload.error = $_.Exception.Message
}

[System.IO.File]::WriteAllText($OutFile, ($payload | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
