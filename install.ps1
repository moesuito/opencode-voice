<#
.SYNOPSIS
  opencode-voice installer for Windows x64 (PowerShell 5.1+ / 7+).

.DESCRIPTION
  Installs local voice dictation for OpenCode V2 (terminal UI):
    1. downloads the Parakeet Vulkan runtime from GitHub Releases and extracts it,
    2. downloads the NVIDIA Parakeet TDT 0.6B v3 model from Hugging Face,
    3. installs the TUI plugin into the OpenCode plugins directory,
    4. writes opencode-voice.json with the resolved paths,
    5. optionally runs a smoke test (text-to-speech sample -> real transcription).

  Run from a local checkout it copies the plugin sources instead of downloading
  them (developer mode).

.PARAMETER InstallDir
  Where the runtime and models are stored. Default: %LOCALAPPDATA%\opencode-voice

.PARAMETER RuntimeDir
  Runtime directory (parakeet-server.exe). Default: <InstallDir>\runtime

.PARAMETER ModelsDir
  Models directory (*.gguf). Default: <InstallDir>\models

.PARAMETER Model
  Model quantization: f16 (default, best accuracy) or q8_0 (smaller download).

.PARAMETER Port
  Local port for parakeet-server. Default: 8797

.PARAMETER Hotkey
  TUI shortcut to start/stop recording. Default: ctrl+y

.PARAMETER SkipRuntime
  Do not download the runtime; use what is already in RuntimeDir.

.PARAMETER SkipModels
  Do not download the model; use what is already in ModelsDir.

.PARAMETER SkipPlugin
  Do not install the OpenCode plugin.

.PARAMETER Force
  Re-download files and overwrite existing ones.

.PARAMETER DryRun
  Print what would happen without changing anything.

.PARAMETER Test
  Run a smoke test after installing (starts the server, TTS sample, real transcription).

.EXAMPLE
  irm https://raw.githubusercontent.com/moesuito/opencode-voice/main/install.ps1 | iex

.EXAMPLE
  .\install.ps1 -Model q8_0 -Test

.EXAMPLE
  # reuse an existing parakeet.cpp build/models on this machine
  .\install.ps1 -RuntimeDir C:\AI\STT\bin\master -ModelsDir C:\AI\STT\models -SkipRuntime -SkipModels
#>
param(
    [string]$InstallDir = "",
    [string]$RuntimeDir = "",
    [string]$ModelsDir = "",
    [ValidateSet("f16", "q8_0")]
    [string]$Model = "f16",
    [int]$Port = 8797,
    [string]$Hotkey = "ctrl+y",
    [switch]$SkipRuntime,
    [switch]$SkipModels,
    [switch]$SkipPlugin,
    [switch]$Force,
    [switch]$DryRun,
    [switch]$Test
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Repo = "moesuito/opencode-voice"
$RuntimeUrl = "https://github.com/$Repo/releases/latest/download/opencode-voice-win-x64-vulkan.zip"
$PluginUrl = "https://github.com/$Repo/releases/latest/download/opencode-voice-plugin.zip"
$HfBase = "https://huggingface.co/mudler/parakeet-cpp-gguf/resolve/main"

if (-not $InstallDir) {
    if ($env:LOCALAPPDATA) { $InstallDir = Join-Path $env:LOCALAPPDATA "opencode-voice" }
    else { $InstallDir = Join-Path $env:USERPROFILE "opencode-voice" }
}
if (-not $RuntimeDir) { $RuntimeDir = Join-Path $InstallDir "runtime" }
if (-not $ModelsDir) { $ModelsDir = Join-Path $InstallDir "models" }

if ($Model -eq "q8_0") { $modelFile = "tdt-0.6b-v3-q8_0.gguf" } else { $modelFile = "tdt-0.6b-v3-f16.gguf" }

if ($env:XDG_CONFIG_HOME) {
    $opencodeConfig = Join-Path $env:XDG_CONFIG_HOME "opencode"
} else {
    $opencodeConfig = Join-Path $env:USERPROFILE ".config\opencode"
}
$pluginDir = Join-Path $opencodeConfig "plugins\opencode-voice"
$configFile = Join-Path $opencodeConfig "opencode-voice.json"

function Say([string]$message) { Write-Host "[opencode-voice] $message" }
function Step([string]$message) { Write-Host ""; Write-Host "== $message" }

function Download([string]$url, [string]$destination) {
    if ((Test-Path $destination) -and (-not $Force)) { Say "cached: $destination"; return $true }
    if ($DryRun) { Say "would download: $url"; Say "            -> $destination"; return $true }
    $dir = Split-Path $destination -Parent
    New-Item -ItemType Directory -Force $dir | Out-Null
    $tmp = "$destination.part"
    try {
        $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
        if ($curl) {
            & $curl.Source -L --fail --silent --show-error --retry 3 -o $tmp $url
            if ($LASTEXITCODE -ne 0) { throw "curl failed with exit code $LASTEXITCODE" }
        } elseif ($PSVersionTable.PSVersion.Major -lt 6) {
            Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
        } else {
            Invoke-WebRequest -Uri $url -OutFile $tmp
        }
        Move-Item -Force $tmp $destination
        Say "downloaded: $destination"
        return $true
    } catch {
        Remove-Item -Force $tmp -ErrorAction SilentlyContinue
        Say "DOWNLOAD FAILED: $url"
        Say "  $($_.Exception.Message)"
        return $false
    }
}

function Extract-Zip([string]$zip, [string]$destination) {
    if ($DryRun) { Say "would extract: $zip -> $destination"; return }
    New-Item -ItemType Directory -Force $destination | Out-Null
    Expand-Archive -Path $zip -DestinationPath $destination -Force
    Say "extracted: $destination"
}

function Install-PluginFromLocal([string]$sourceRoot) {
    $files = @("index.ts", "tui.tsx", "config.ts", "devices.ts", "recorder.ts", "stt.ts", "wav.ts")
    if ($DryRun) { Say "would copy plugin sources from $sourceRoot -> $pluginDir"; return }
    New-Item -ItemType Directory -Force $pluginDir | Out-Null
    New-Item -ItemType Directory -Force (Join-Path $pluginDir "util") | Out-Null
    foreach ($file in $files) {
        Copy-Item (Join-Path $sourceRoot $file) $pluginDir -Force
    }
    Copy-Item (Join-Path $sourceRoot "util\log.ts") (Join-Path $pluginDir "util") -Force
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
    Set-Content -Path (Join-Path $pluginDir "package.json") -Value $manifest -Encoding UTF8
    Say "plugin installed (local sources): $pluginDir"
}

function Write-ConfigFile() {
    $config = [ordered]@{
        ffmpeg      = "ffmpeg"
        exe         = (Join-Path $RuntimeDir "parakeet-server.exe")
        model       = (Join-Path $ModelsDir $modelFile)
        port        = $Port
        idleMinutes = 10
        maxSeconds  = 300
        sampleRate  = 16000
        hotkey      = $Hotkey
        mic         = ""
    }
    if ($DryRun) { Say "would write config: $configFile"; return }
    New-Item -ItemType Directory -Force $opencodeConfig | Out-Null
    [System.IO.File]::WriteAllText($configFile, ($config | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
    Say "config written: $configFile"
}

function Invoke-SmokeTest() {
    Step "Smoke test"
    $exe = Join-Path $RuntimeDir "parakeet-server.exe"
    $modelPath = Join-Path $ModelsDir $modelFile
    if ((-not (Test-Path $exe)) -or (-not (Test-Path $modelPath))) { Say "SKIP: runtime or model missing"; return $false }
    if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) { Say "SKIP: curl.exe not available"; return $false }

    $process = Start-Process -FilePath $exe -ArgumentList @("--model", $modelPath, "--port", "$Port") -WindowStyle Hidden -PassThru
    try {
        $url = "http://127.0.0.1:$Port/"
        $ready = $false
        for ($i = 0; $i -lt 240; $i++) {
            $code = ""
            try { $code = & curl.exe -s -o NUL -w "%{http_code}" --max-time 2 $url 2>$null } catch { $code = "" }
            if ($code -and $code -ne "000") { $ready = $true; break }
            if ($process.HasExited) { break }
            Start-Sleep -Milliseconds 500
        }
        if (-not $ready) { Say "FAIL: server did not answer on port $Port"; return $false }
        Say "server ready"

        $wav = Join-Path $env:TEMP "opencode-voice-smoke.wav"
        Add-Type -AssemblyName System.Speech
        $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
        $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled })
        $pt = @($voices | Where-Object { $_.VoiceInfo.Culture.Name -like "pt-*" })
        if ($pt.Count -ge 1) { $synth.SelectVoice($pt[0].VoiceInfo.Name) }
        $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
            16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
            [System.Speech.AudioFormat.AudioChannel]::Mono)
        $synth.SetOutputToWaveFile($wav, $format)
        $synth.Speak("Hello! This is a smoke test for opencode voice.")
        $synth.SetOutputToNull()
        $synth.Dispose()

        $response = & curl.exe -s --max-time 90 -F "file=@$wav" -F "model=parakeet" -F "response_format=json" "http://127.0.0.1:$Port/v1/audio/transcriptions"
        if ($response -match '"text"') { Say "PASS: $response"; return $true }
        Say "FAIL: $response"
        return $false
    } finally {
        if ($process -and (-not $process.HasExited)) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    }
}

# ------------------------------------------------------------------ main

Write-Host ""
Write-Host "opencode-voice installer"
Say "install dir:  $InstallDir"
Say "runtime dir:  $RuntimeDir"
Say "models dir:   $ModelsDir"
Say "model:        $modelFile"
Say "plugin dir:   $pluginDir"
if ($DryRun) { Say "DRY RUN - nothing will be changed" }

$everythingOk = $true

Step "Runtime (parakeet.cpp, Vulkan, Windows x64)"
if ($SkipRuntime) {
    Say "skipped (-SkipRuntime); expecting parakeet-server.exe in: $RuntimeDir"
} else {
    $zip = Join-Path $env:TEMP "opencode-voice-runtime.zip"
    if (Download $RuntimeUrl $zip) {
        Extract-Zip $zip $RuntimeDir
    } else {
        $everythingOk = $false
    }
}

Step "Model (Hugging Face)"
if ($SkipModels) {
    Say "skipped (-SkipModels); expecting $modelFile in: $ModelsDir"
} else {
    if (-not (Download "$HfBase/$modelFile" (Join-Path $ModelsDir $modelFile))) { $everythingOk = $false }
}

Step "OpenCode plugin"
$localSource = ""
if ($PSScriptRoot) {
    $candidate = Join-Path $PSScriptRoot "src"
    if (Test-Path (Join-Path $candidate "tui.tsx")) { $localSource = $candidate }
}
if ($SkipPlugin) {
    Say "skipped (-SkipPlugin)"
} elseif ($localSource) {
    Say "local checkout detected: $localSource"
    Install-PluginFromLocal $localSource
} else {
    $zip = Join-Path $env:TEMP "opencode-voice-plugin.zip"
    if (Download $PluginUrl $zip) {
        Extract-Zip $zip $pluginDir
    } else {
        $everythingOk = $false
    }
}

Step "Configuration"
Write-ConfigFile

Step "Environment checks"
$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if ($ffmpeg) { Say "ffmpeg:     $($ffmpeg.Source)" } else { Say "ffmpeg:     NOT FOUND (install it, e.g. winget install Gyan.FFmpeg)" }
$opencode = Get-Command opencode -ErrorAction SilentlyContinue
if ($opencode) { Say "opencode:   $($opencode.Source)" } else { Say "opencode:   NOT FOUND (OpenCode V2 is required)" }

$testOk = $true
if ($Test -and (-not $DryRun)) { $testOk = Invoke-SmokeTest }

Write-Host ""
Write-Host "== Summary"
Say "runtime:  $RuntimeDir"
Say "models:   $ModelsDir"
Say "plugin:   $pluginDir"
Say "config:   $configFile"
if ((-not $everythingOk)) { Say "WARNING: some downloads failed - re-run the installer" }
if ($Test -and (-not $DryRun)) {
    if ($testOk) { Say "smoke test: PASS" } else { Say "smoke test: FAIL" }
}
Say "next steps:"
Say "  1. open (or reload) OpenCode"
Say "  2. press $Hotkey and pick your microphone on first use"
Say "  3. speak, press $Hotkey again - the transcription is sent as a prompt"
Say "docs: https://github.com/$Repo"
Write-Host ""
