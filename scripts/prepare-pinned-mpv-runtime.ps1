param(
  [string]$Destination = (Join-Path $PSScriptRoot '..\resources\bin\win')
)

$ErrorActionPreference = 'Stop'
$archiveUrl = 'https://github.com/wg5759/AgentPlay/releases/download/mpv-gpl-v0.41.0-20260719/mpv-v0.41.0-windows-x64-gpl.zip'
$archiveSha256 = '162DECE1C36816F8F72791CCCAC9052DDE596C765557996AAF3D8580AEAF9893'
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('agentplay-pinned-mpv-' + [guid]::NewGuid().ToString('N'))
$archivePath = Join-Path $tempRoot 'mpv.zip'
$extractPath = Join-Path $tempRoot 'extracted'

try {
  New-Item -ItemType Directory -Path $extractPath -Force | Out-Null
  Invoke-WebRequest -Uri $archiveUrl -OutFile $archivePath -UseBasicParsing
  $actual = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
  if ($actual -ne $archiveSha256) { throw "mpv archive SHA-256 mismatch: $actual" }
  Expand-Archive -LiteralPath $archivePath -DestinationPath $extractPath
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  foreach ($name in @('mpv.exe', 'mpv.com', 'vulkan-1.dll')) {
    $matches = @(Get-ChildItem -LiteralPath $extractPath -Recurse -File -Filter $name)
    if ($matches.Count -ne 1) { throw "Expected exactly one $name in pinned archive, found $($matches.Count)" }
    Copy-Item -LiteralPath $matches[0].FullName -Destination (Join-Path $Destination $name) -Force
  }
  [pscustomobject]@{ destination = (Resolve-Path -LiteralPath $Destination).Path; archiveSha256 = $actual } | ConvertTo-Json -Compress
} finally {
  if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
