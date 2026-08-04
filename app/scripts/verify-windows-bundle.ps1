[CmdletBinding()]
param(
  [string]$TauriRoot = (Join-Path $PSScriptRoot "../src-tauri")
)

$ErrorActionPreference = "Stop"
$resolvedTauriRoot = [System.IO.Path]::GetFullPath($TauriRoot)
$runtimePath = Join-Path $resolvedTauriRoot "resources/vc_redist.x64.exe"
$releaseDirectory = Join-Path $resolvedTauriRoot "target/release"
$nsisDirectory = Join-Path $releaseDirectory "bundle/nsis"

if (-not (Test-Path $runtimePath -PathType Leaf)) {
  throw "The prepared Visual C++ redistributable is missing: $runtimePath"
}

$signature = Get-AuthenticodeSignature -FilePath $runtimePath
if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
    $signature.SignerCertificate.Subject -notmatch "Microsoft Corporation") {
  throw "The bundled Visual C++ redistributable does not have a valid Microsoft Authenticode signature."
}

$installer = Get-ChildItem -Path $nsisDirectory -Filter "*-setup.exe" -File |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1
if (-not $installer) {
  throw "No NSIS setup executable was produced under $nsisDirectory."
}

$sevenZip = Get-Command 7z -ErrorAction SilentlyContinue
if ($sevenZip) {
  $sevenZipPath = $sevenZip.Source
}
else {
  $sevenZipPath = Join-Path $env:ProgramFiles "7-Zip/7z.exe"
  if (-not (Test-Path $sevenZipPath -PathType Leaf)) {
    throw "7-Zip is unavailable; cannot inspect the finished NSIS installer."
  }
}
$archiveListing = & $sevenZipPath l $installer.FullName
if ($LASTEXITCODE -ne 0) {
  throw "7-Zip could not inspect the NSIS installer (exit code $LASTEXITCODE)."
}
if (($archiveListing -join "`n") -notmatch "vc_redist\.x64\.exe") {
  throw "The finished NSIS installer does not contain vc_redist.x64.exe."
}

$application = Get-ChildItem -Path $releaseDirectory -Filter "*.exe" -File |
  Where-Object { $_.Name -notlike "*-setup.exe" } |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1
if (-not $application) {
  throw "No Windows application executable was produced under $releaseDirectory."
}

$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio/Installer/vswhere.exe"
if (-not (Test-Path $vswhere -PathType Leaf)) {
  throw "vswhere.exe is unavailable; cannot inspect Windows PE dependencies."
}
$visualStudioPath = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
if (-not $visualStudioPath) {
  throw "Visual C++ build tools are unavailable; cannot inspect Windows PE dependencies."
}
$toolsVersionFile = Join-Path $visualStudioPath "VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt"
$toolsVersion = (Get-Content $toolsVersionFile -Raw).Trim()
$dumpbin = Join-Path $visualStudioPath "VC/Tools/MSVC/$toolsVersion/bin/Hostx64/x64/dumpbin.exe"
if (-not (Test-Path $dumpbin -PathType Leaf)) {
  throw "dumpbin.exe is unavailable at the expected path: $dumpbin"
}

$dependencies = & $dumpbin /DEPENDENTS $application.FullName
if ($LASTEXITCODE -ne 0) {
  throw "dumpbin could not inspect the application executable (exit code $LASTEXITCODE)."
}

Write-Host "Verified Windows installer: $($installer.FullName)"
Write-Host "Verified bundled Microsoft runtime: $runtimePath"
Write-Host "PE dependencies for $($application.Name):"
$dependencies | Write-Host
