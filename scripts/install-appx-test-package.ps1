param(
  [string]$PackagePath = "",
  [string]$TrustedStore = "Cert:\LocalMachine\TrustedPeople",
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

function Resolve-LatestAppxPackage {
  $dist = Join-Path (Split-Path -Parent $PSScriptRoot) "dist"
  if (-not (Test-Path -LiteralPath $dist)) {
    throw "Dist folder not found: $dist"
  }

  $candidate = Get-ChildItem -LiteralPath $dist -File |
    Where-Object { @(".appx", ".msix", ".appxbundle", ".msixbundle") -contains $_.Extension.ToLowerInvariant() } |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1

  if (-not $candidate) {
    throw "No .appx/.msix package found in $dist"
  }

  return $candidate.FullName
}

if ([string]::IsNullOrWhiteSpace($PackagePath)) {
  $PackagePath = Resolve-LatestAppxPackage
} else {
  $PackagePath = (Resolve-Path -LiteralPath $PackagePath).Path
}

$signature = Get-AuthenticodeSignature -FilePath $PackagePath
if (-not $signature.SignerCertificate) {
  throw @"
No signing certificate was found in $PackagePath.

This usually means the AppX/MSIX package is unsigned. That is expected for Microsoft Store-targeted packages built without a local Windows signing certificate.

To test locally on Windows, either:
1. Sign the package with a test certificate whose subject exactly matches the package publisher:
   CN=8DBD4E24-DD06-4AEF-88B7-7F0C2E30B4D9
2. Rebuild with WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD (or CSC_LINK / CSC_KEY_PASSWORD) set to a .pfx certificate.

After the package is signed, rerun this script to trust the certificate and install the package.
"@
}

$packageName = [System.IO.Path]::GetFileNameWithoutExtension($PackagePath)
$certPath = Join-Path $env:TEMP "$packageName.cer"

Export-Certificate -Cert $signature.SignerCertificate -FilePath $certPath -Force | Out-Null
Import-Certificate -FilePath $certPath -CertStoreLocation $TrustedStore | Out-Null

Write-Host "Imported signing certificate for $packageName into $TrustedStore"
Write-Host "Certificate subject: $($signature.SignerCertificate.Subject)"
if ($TrustedStore -like "Cert:\LocalMachine\*") {
  Write-Host "Machine-store import requires an elevated PowerShell session."
}

if (-not $SkipInstall) {
  Add-AppxPackage -Path $PackagePath
  Write-Host "Installed package: $PackagePath"
}
