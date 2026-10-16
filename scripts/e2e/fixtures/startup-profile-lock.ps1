# Controlled Windows OS boundary: keep a real FileStream open without FileShare.Delete.
# This process is a sibling of the smoke CLI, outside its application-owned Job.
param(
  [Parameter(Mandatory=$true)][string]$Evidence,
  [Parameter(Mandatory=$true)][ValidateSet('transient', 'persistent')][string]$Mode
)
$ErrorActionPreference = 'Stop'
$deadline = [DateTime]::UtcNow.AddSeconds(60)
$handle = $null
try {
  $record = $null
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath "$Evidence.stop-locker") { exit 0 }
    if (Test-Path -LiteralPath $Evidence) {
      try { $record = Get-Content -Raw -LiteralPath $Evidence | ConvertFrom-Json } catch { $record = $null }
      if ($record) {
        $lockedProfile = Join-Path $record.root $record.identifier
        if (Test-Path -LiteralPath $lockedProfile) { break }
      }
    }
    Start-Sleep -Milliseconds 10
  }
  if (-not $record -or -not (Test-Path -LiteralPath $lockedProfile)) { throw 'Fixture profile never appeared' }
  $database = Join-Path $lockedProfile 'WebView-profile.db'
  $handle = [System.IO.FileStream]::new($database, [System.IO.FileMode]::OpenOrCreate,
    [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::ReadWrite)
  @{ pid = $PID; profile = $lockedProfile } | ConvertTo-Json -Compress | Set-Content -LiteralPath "$Evidence.acquired" -Encoding utf8NoBOM
  $reaped = Join-Path $record.root 'windows-launch.json.reaped'
  while (-not (Test-Path -LiteralPath $reaped)) {
    if (Test-Path -LiteralPath "$Evidence.stop-locker") { exit 0 }
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Smoke application Job never confirmed reaping' }
    Start-Sleep -Milliseconds 10
  }
  if ($Mode -eq 'transient') {
    $held = [System.Diagnostics.Stopwatch]::StartNew()
    Start-Sleep -Milliseconds 750
    $handle.Dispose(); $handle = $null
    @{ reaped = $true; held_after_reap_ms = $held.ElapsedMilliseconds } | ConvertTo-Json -Compress | Set-Content -LiteralPath "$Evidence.released" -Encoding utf8NoBOM
  } else {
    while (-not (Test-Path -LiteralPath "$Evidence.stop-locker")) {
      if ([DateTime]::UtcNow -ge $deadline) { throw 'Persistent locker exceeded its owned test deadline' }
      Start-Sleep -Milliseconds 20
    }
  }
} finally {
  if ($null -ne $handle) { $handle.Dispose() }
}
