# Ensures the code-signing certificate for DriverRadar exists on disk.
param(
  [string]$PfxPath = '',
  [string]$Password = 'DriverRadar2026!'
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
if (-not $PfxPath) {
  $PfxPath = Join-Path $Root 'driverradar.pfx'
}

if (Test-Path -LiteralPath $PfxPath) {
  Write-Output "Code-signing certificate already exists at: $PfxPath"
  return
}

# Look for an existing certificate for yourbossdonpely
$cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -like '*yourbossdonpely*' } | Select-Object -First 1

if (-not $cert) {
  Write-Output "Creating new code-signing certificate for yourbossdonpely..."
  $cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject "CN=yourbossdonpely, O=DriverRadar" `
    -KeyUsage DigitalSignature `
    -FriendlyName "DriverRadar Code Signing" `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -NotAfter (Get-Date).AddYears(10)
}

# Also export as .cer
$cerPath = Join-Path $Root 'driverradar.cer'
Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null

# Import into TrustedPublisher
try {
  & certutil.exe -user -addstore -f "TrustedPublisher" $cerPath | Out-Null
  & certutil.exe -user -addstore -f "Root" $cerPath | Out-Null
} catch {
  Write-Warning "certutil addstore warning: $_"
}

# Export PFX
$securePwd = ConvertTo-SecureString $Password -AsPlainText -Force
Export-PfxCertificate -Cert $cert -FilePath $PfxPath -Password $securePwd | Out-Null

Write-Output "PFX exported to: $PfxPath (Thumbprint: $($cert.Thumbprint))"
