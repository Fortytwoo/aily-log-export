param(
  [string]$OutputDir = "dist"
)

$ErrorActionPreference = "Stop"

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$outputRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDir))
$stageDir = Join-Path $outputRoot "webstore-package"

function Assert-UnderRepo {
  param([string]$Path)
  $full = [System.IO.Path]::GetFullPath($Path)
  if (-not $full.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to operate outside repository: $full"
  }
}

Push-Location $repoRoot
try {
  node .\scripts\validate-extension.mjs

  $manifest = Get-Content -Path (Join-Path $repoRoot "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  $version = $manifest.version
  $zipName = "aily-runtime-log-exporter-v$version-webstore.zip"
  $zipPath = Join-Path $outputRoot $zipName

  Assert-UnderRepo $outputRoot
  Assert-UnderRepo $stageDir
  Assert-UnderRepo $zipPath

  if (Test-Path -LiteralPath $stageDir) {
    Remove-Item -LiteralPath $stageDir -Recurse -Force
  }
  New-Item -ItemType Directory -Path $stageDir | Out-Null

  Copy-Item -LiteralPath (Join-Path $repoRoot "manifest.json") -Destination $stageDir
  Copy-Item -LiteralPath (Join-Path $repoRoot "src") -Destination $stageDir -Recurse
  Copy-Item -LiteralPath (Join-Path $repoRoot "icons") -Destination $stageDir -Recurse

  if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
  }

  Compress-Archive -Path (Join-Path $stageDir "*") -DestinationPath $zipPath -CompressionLevel Optimal
  Write-Host "Chrome Web Store upload ZIP: $zipPath"
} finally {
  Pop-Location
}

