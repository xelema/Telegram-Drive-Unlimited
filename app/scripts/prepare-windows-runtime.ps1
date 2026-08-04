[CmdletBinding()]
param(
  [string]$OutputPath = (Join-Path $PSScriptRoot "../src-tauri/resources/vc_redist.x64.exe")
)

$ErrorActionPreference = "Stop"
$downloadUrl = "https://aka.ms/vc14/vc_redist.x64.exe"
$resolvedOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $resolvedOutputPath
$temporaryFile = Join-Path ([System.IO.Path]::GetTempPath()) ("telegram-drive-vc-redist-{0}.exe" -f [guid]::NewGuid())

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

try {
  Write-Host "Downloading the Microsoft Visual C++ v14 x64 Redistributable..."
  Invoke-WebRequest -Uri $downloadUrl -OutFile $temporaryFile -UseBasicParsing

  $file = Get-Item $temporaryFile
  if ($file.Length -lt 1MB) {
    throw "Downloaded redistributable is unexpectedly small ($($file.Length) bytes)."
  }

  $signature = Get-AuthenticodeSignature -FilePath $temporaryFile
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Redistributable Authenticode signature is not valid: $($signature.Status)."
  }
  if ($signature.SignerCertificate.Subject -notmatch "Microsoft Corporation") {
    throw "Redistributable is not signed by Microsoft Corporation."
  }

  Move-Item -Path $temporaryFile -Destination $resolvedOutputPath -Force
  $hash = Get-FileHash -Path $resolvedOutputPath -Algorithm SHA256
  Write-Host "Verified Microsoft-signed runtime: $resolvedOutputPath"
  Write-Host "SHA256: $($hash.Hash)"
}
finally {
  if (Test-Path $temporaryFile) {
    Remove-Item $temporaryFile -Force
  }
}
