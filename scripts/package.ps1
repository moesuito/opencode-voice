# Builds the GitHub Release assets into dist/:
#   - opencode-voice-plugin.zip          (plugin sources, no dependencies needed)
#   - opencode-voice-win-x64-vulkan.zip  (parakeet.cpp Vulkan runtime for Windows x64)
#
# Usage:
#   pwsh -NoProfile -File scripts\package.ps1
#   pwsh -NoProfile -File scripts\package.ps1 -RuntimeSource "C:\AI\STT\bin\master"

param(
  [string]$RuntimeSource = "C:\AI\STT\bin\master",
  [string]$OutDir = (Join-Path (Split-Path -Parent $PSScriptRoot) "dist")
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root "src"

New-Item -ItemType Directory -Force $OutDir | Out-Null

# ---------------------------------------------------------------- plugin zip

$pluginStage = Join-Path $env:TEMP "opencode-voice-plugin-stage"
Remove-Item -Recurse -Force $pluginStage -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $pluginStage "util") | Out-Null

Copy-Item (Join-Path $src "*.ts") $pluginStage -Force
Copy-Item (Join-Path $src "tui.tsx") $pluginStage -Force
Copy-Item (Join-Path $src "util\log.ts") (Join-Path $pluginStage "util") -Force

$manifest = @'
{
  "name": "opencode-voice",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.ts",
    "./tui": "./tui.tsx"
  }
}
'@
Set-Content -Path (Join-Path $pluginStage "package.json") -Value $manifest -Encoding UTF8

$pluginZip = Join-Path $OutDir "opencode-voice-plugin.zip"
Remove-Item -Force $pluginZip -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $pluginStage "*") -DestinationPath $pluginZip -CompressionLevel Optimal
Write-Host "plugin:  $pluginZip"

# --------------------------------------------------------------- runtime zip

if (-not (Test-Path $RuntimeSource)) { throw "Runtime source not found: $RuntimeSource" }

$runtimeStage = Join-Path $env:TEMP "opencode-voice-runtime-stage"
Remove-Item -Recurse -Force $runtimeStage -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $runtimeStage | Out-Null

$keep = @("parakeet-server.exe", "parakeet-cli.exe", "diarize.exe", "ggml.dll", "ggml-base.dll", "ggml-cpu.dll", "ggml-vulkan.dll")
foreach ($name in $keep) {
  $path = Join-Path $RuntimeSource $name
  if (Test-Path $path) { Copy-Item $path $runtimeStage -Force }
}
if (-not (Test-Path (Join-Path $runtimeStage "parakeet-server.exe"))) {
  throw "parakeet-server.exe not found in $RuntimeSource"
}

$readme = @'
opencode-voice runtime (Windows x64, Vulkan)

Prebuilt parakeet.cpp binaries (parakeet-server / parakeet-cli / diarize).
Source: https://github.com/mudler/parakeet.cpp (MIT).
See NOTICE in the repository for third-party credits.
'@
Set-Content -Path (Join-Path $runtimeStage "README.txt") -Value $readme -Encoding UTF8

$runtimeZip = Join-Path $OutDir "opencode-voice-win-x64-vulkan.zip"
Remove-Item -Force $runtimeZip -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $runtimeStage "*") -DestinationPath $runtimeZip -CompressionLevel Optimal
Write-Host "runtime: $runtimeZip"
Write-Host "done."
