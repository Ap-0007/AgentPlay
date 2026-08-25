[CmdletBinding()]
param(
  [ValidateSet('stable', 'preview', 'beta')]
  [string]$Channel = 'stable',
  [string]$Version = 'latest',
  [ValidateSet('installer', 'portable')]
  [string]$Package = 'installer',
  [string]$Destination,
  [switch]$AllowUnsigned
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repository = 'wg5759/AgentPlay'
$headers = @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'AgentPlay-safe-installer' }

function Get-Release {
  if ($Channel -ne 'stable' -and $Version -eq 'latest') {
    throw 'Preview/Beta 安装必须明确指定版本，避免自动选择错误的预发布。'
  }
  if ($Version -eq 'latest') {
    return Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$repository/releases/latest"
  }
  $tag = if ($Version.StartsWith('v')) { $Version } else { "v$Version" }
  return Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$repository/releases/tags/$tag"
}

function Get-Asset([object]$Release, [string]$Name) {
  $asset = @($Release.assets | Where-Object { $_.name -eq $Name })
  if ($asset.Count -ne 1) { throw "Release 缺少唯一资产：$Name" }
  return $asset[0]
}

function Save-Asset([object]$Asset, [string]$Path) {
  Invoke-WebRequest -Headers $headers -Uri $Asset.browser_download_url -OutFile $Path
}

function Get-ExpectedHash([string]$ChecksumPath, [string]$Name) {
  foreach ($line in Get-Content -LiteralPath $ChecksumPath) {
    if ($line -match '^([A-Fa-f0-9]{64})  (.+)$' -and $Matches[2] -eq $Name) { return $Matches[1].ToUpperInvariant() }
  }
  throw "SHA256SUMS 中找不到资产：$Name"
}

function Assert-Hash([string]$Path, [string]$Expected) {
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToUpperInvariant()
  if ($actual -ne $Expected) { throw "SHA-256 校验失败：$([IO.Path]::GetFileName($Path))" }
}

function Assert-Signature([string]$Path, [bool]$ManifestSigned) {
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($ManifestSigned -and $signature.Status -ne 'Valid') {
    throw "发布清单声明已签名，但 Authenticode 无效：$($signature.Status)"
  }
  if (-not $ManifestSigned -and -not $AllowUnsigned) {
    throw '该版本未签名。确认来自官方 Release 且哈希一致后，如仍要继续，请显式添加 -AllowUnsigned。'
  }
  if (-not $ManifestSigned) {
    Write-Warning '正在使用未签名的 Preview/Beta；不会关闭或绕过 Windows SmartScreen。'
  }
}

$release = Get-Release
$resolvedVersion = [string]$release.tag_name
if ($resolvedVersion.StartsWith('v')) { $resolvedVersion = $resolvedVersion.Substring(1) }
$manifestName = "AgentPlay-$resolvedVersion-release-manifest.json"
$checksumsName = "AgentPlay-$resolvedVersion-SHA256SUMS.txt"
$packageName = if ($Package -eq 'installer') {
  "AgentPlay-$resolvedVersion-Windows-x64-Standard.exe"
} else {
  "AgentPlay-$resolvedVersion-Windows-x64-Portable.zip"
}

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempRoot = Join-Path $tempBase ("AgentPlay-install-" + [Guid]::NewGuid().ToString('N'))
$portableDestinationCreated = $null
New-Item -ItemType Directory -Path $tempRoot | Out-Null

try {
  $manifestPath = Join-Path $tempRoot $manifestName
  $checksumsPath = Join-Path $tempRoot $checksumsName
  Save-Asset (Get-Asset $release $checksumsName) $checksumsPath
  Save-Asset (Get-Asset $release $manifestName) $manifestPath
  Assert-Hash $manifestPath (Get-ExpectedHash $checksumsPath $manifestName)

  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  if ([string]$manifest.channel -ne $Channel) { throw "发布通道不一致：$($manifest.channel) != $Channel" }
  if ($Channel -eq 'stable' -and [bool]$release.prerelease) { throw 'Stable 通道不能指向 GitHub prerelease。' }
  if ($Channel -ne 'stable' -and -not [bool]$release.prerelease) { throw 'Preview/Beta 通道必须指向 GitHub prerelease。' }
  $manifestSigned = [bool]$manifest.signed
  if (-not $manifestSigned -and -not $AllowUnsigned) {
    throw '该版本未签名。确认来自官方 Release 且哈希一致后，如仍要继续，请显式添加 -AllowUnsigned。'
  }

  $packagePath = Join-Path $tempRoot $packageName
  Save-Asset (Get-Asset $release $packageName) $packagePath
  Assert-Hash $packagePath (Get-ExpectedHash $checksumsPath $packageName)
  if ($Package -eq 'installer') {
    Assert-Signature $packagePath $manifestSigned
    $process = Start-Process -FilePath $packagePath -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "安装程序退出码：$($process.ExitCode)" }
    Write-Output "AgentPlay $resolvedVersion 安装程序已完成。"
  } else {
    if (-not $Destination) {
      $Destination = Join-Path $env:LOCALAPPDATA "Programs\AgentPlay-Portable\$resolvedVersion"
    }
    $resolvedDestination = [IO.Path]::GetFullPath($Destination)
    if (Test-Path -LiteralPath $resolvedDestination) { throw "便携版目标目录已存在，不会覆盖：$resolvedDestination" }
    $portableDestinationCreated = $resolvedDestination
    Expand-Archive -LiteralPath $packagePath -DestinationPath $resolvedDestination
    $applicationPath = Join-Path $resolvedDestination 'AgentPlay.exe'
    if (-not (Test-Path -LiteralPath $applicationPath)) { throw '便携包解压后缺少 AgentPlay.exe' }
    Assert-Signature $applicationPath $manifestSigned
    $portableDestinationCreated = $null
    Write-Output "AgentPlay $resolvedVersion 便携版已解压到：$resolvedDestination"
  }
} catch {
  if ($portableDestinationCreated -and (Test-Path -LiteralPath $portableDestinationCreated)) {
    Remove-Item -LiteralPath $portableDestinationCreated -Recurse -Force
  }
  throw
} finally {
  $resolvedTemp = [IO.Path]::GetFullPath($tempRoot)
  if ($resolvedTemp.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedTemp)) {
    Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
  }
}
