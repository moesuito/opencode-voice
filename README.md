# opencode-voice

[![Release](https://img.shields.io/github/v/release/moesuito/opencode-voice?style=flat-square)](https://github.com/moesuito/opencode-voice/releases)
[![License](https://img.shields.io/github/license/moesuito/opencode-voice?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20x64-blue?style=flat-square)](#requirements)

**Local voice dictation for the OpenCode V2 terminal UI.** Press `Ctrl+Y`, speak,
and the transcription is sent straight to your prompt — like dictating in your
favorite coding agent, except everything runs **offline on your machine**.

- 🎙️ **One shortcut**: `Ctrl+Y` toggles recording, live waveform + timer while you speak
- ⏸ **Insert without sending**: stop, transcribe and drop the text in the prompt to review
- ✕ **Cancel**: discard a recording with one click
- ⚡ **Fast, fully local**: NVIDIA **Parakeet TDT 0.6B v3** via [parakeet.cpp](https://github.com/mudler/parakeet.cpp)
  (ggml + **Vulkan** — works on AMD, NVIDIA and Intel GPUs)
- 🗣️ **25 languages**, auto-detected (strong Brazilian Portuguese)
- 🧠 **Zero-wait server**: starting a recording pre-warms the model in the background
  (~1.5 s cold load), so stopping a recording transcribes almost instantly; it
  unloads after 10 idle minutes
- 📤 **Sends as prompt**: raw transcription delivered to the current session
- 🔌 **Zero cloud**: no API keys, no accounts, no audio leaves your machine

## How it works

```
 Ctrl+Y / mic button
        │
        ▼
 ffmpeg (DirectShow) ──► 16 kHz WAV ──► parakeet-server (Vulkan)
        │                                    │
   live waveform                       text (~0.3 s when warm)
        │                                    │
        └──────────► sent as prompt in the current session ◄──────────┘
```

The plugin is a TUI extension: the terminal client records and renders, while a
local [`parakeet-server`](https://github.com/mudler/parakeet.cpp) (OpenAI-compatible
`/v1/audio/transcriptions`) does the speech-to-text. The server is started on
demand and stopped after an idle timeout, so the GPU memory is free when you are
not dictating.

## Requirements

- **Windows x64**
- **OpenCode V2** (`opencode --version` ≥ 2.0)
- **ffmpeg** on `PATH` (`winget install Gyan.FFmpeg`)
- A GPU with **Vulkan** support (AMD/NVIDIA/Intel; CPU fallback also possible)
- ~2 GB disk for the runtime + model, ~4 GB VRAM while the server is warm

## Quick install

Copy & paste into **PowerShell 5.1 or PowerShell 7**:

```powershell
irm https://raw.githubusercontent.com/moesuito/opencode-voice/main/install.ps1 | iex
```

The installer will:

1. download the **Vulkan runtime** (parakeet.cpp build) from the latest GitHub Release;
2. download the **Parakeet TDT 0.6B v3** GGUF model from Hugging Face;
3. copy the **OpenCode plugin** into `%USERPROFILE%\.config\opencode\plugins\opencode-voice`;
4. write `%USERPROFILE%\.config\opencode\opencode-voice.json` with the resolved paths;
5. check for `ffmpeg` and `opencode`, and optionally run a **smoke test**.

Open (or reload) OpenCode, press `Ctrl+Y`, pick your microphone on first use and speak.

### Installer options

```powershell
# smaller model (897 MB instead of 1.37 GB)
irm https://raw.githubusercontent.com/moesuito/opencode-voice/main/install.ps1 | iex -Args "-Model", "q8_0"

# run a full smoke test (starts the server, TTS sample, real transcription)
.\install.ps1 -Test

# reuse an existing parakeet.cpp build and models already on your machine
.\install.ps1 -RuntimeDir C:\AI\STT\bin\master -ModelsDir C:\AI\STT\models -SkipRuntime -SkipModels

# preview only, change nothing
.\install.ps1 -DryRun
```

## Install with your coding agent

You can let OpenCode (or any coding agent with shell access on Windows) install
it for you. Paste this prompt:

> Install **opencode-voice** on this machine:
> 1. Run `irm https://raw.githubusercontent.com/moesuito/opencode-voice/main/install.ps1 | iex`
>    (PowerShell 5.1 or 7) and show me the installer summary.
> 2. Verify `%USERPROFILE%\.config\opencode\plugins\opencode-voice` contains `index.ts` and `tui.tsx`.
> 3. Verify `%USERPROFILE%\.config\opencode\opencode-voice.json` exists and points to the
>    runtime (`parakeet-server.exe`) and the model (`*.gguf`).
> 4. Check that `ffmpeg` is on PATH (if not, install it with `winget install Gyan.FFmpeg`).
> 5. Run the smoke test and paste the result: start `parakeet-server.exe --model <model> --port 8797`,
>    wait for `GET /` to answer, then POST a short WAV to `/v1/audio/transcriptions`
>    with `-F model=parakeet -F response_format=json`, and stop the server.
> 6. Tell me to reload OpenCode and press `Ctrl+Y`.

The agent-safe checklist:

| Step | Command / check |
|---|---|
| Install | `irm <raw url>/install.ps1 \| iex` |
| Plugin present | `Test-Path "$env:USERPROFILE\.config\opencode\plugins\opencode-voice\tui.tsx"` |
| Config present | `Get-Content "$env:USERPROFILE\.config\opencode\opencode-voice.json"` |
| Runtime works | `& "$env:LOCALAPPDATA\opencode-voice\runtime\parakeet-server.exe" --help` |
| ffmpeg | `ffmpeg -version` |
| Health check | `opencode api get /api/plugin` (look for `opencode-voice`, state `active`, `features.tui: true`) |

## Usage

| Action | How |
|---|---|
| Start recording | **`Ctrl+Y`**, click the **🎤** icon, or `/voice` |
| **Stop & send** | **`Ctrl+Y`** again, or the **■** button |
| **Stop & insert (no send)** | the **⏸** button or `/voice-pause` |
| **Cancel recording** | the **✕** button or `/voice-cancel` |
| Insert last transcript | `/voice-insert` |
| Retry the last audio | `/voice-retry` |
| Pick microphone | `/voice-mic` |
| Change shortcut | `/voice-hotkey` |
| Diagnostics | `/voice-status` |

While recording you get a live waveform and a timer above the composer, plus
three controls in the prompt footer: **⏸** stops, transcribes and **inserts the
text into the prompt for review** (nothing is sent), **■** stops and **sends the
transcript as a prompt** to the current session, and **✕** cancels the recording.

## Configuration

The installer writes `%USERPROFILE%\.config\opencode\opencode-voice.json`:

| Key | Default | Description |
|---|---|---|
| `ffmpeg` | `ffmpeg` | ffmpeg executable (PATH name or absolute path) |
| `exe` | `<install>\runtime\parakeet-server.exe` | Transcription server |
| `model` | `<install>\models\tdt-0.6b-v3-f16.gguf` | GGUF model |
| `port` | `8797` | Local port for the server |
| `idleMinutes` | `10` | Minutes idle before the model is unloaded |
| `maxSeconds` | `300` | Hard cap per recording |
| `sampleRate` | `16000` | Capture sample rate (mono) |
| `hotkey` | `ctrl+y` | Default shortcut |
| `mic` | `""` | Microphone name (empty = ask on first use) |

Microphone and shortcut can also be changed from the TUI (`/voice-mic`, `/voice-hotkey`)
and are stored per user.

## Troubleshooting

- **Log**: `%TEMP%\opencode-voice.log` (override with `OPENCODE_VOICE_LOG`).
- **Mic is busy / no audio**: close apps using the microphone exclusively, then
  `/voice-mic` to re-select it. `ffmpeg -list_devices true -f dshow -i dummy` lists devices.
- **`parakeet-server` exits immediately**: run the exe manually to see the error
  (missing `ggml-vulkan.dll`? model path typo?). Update your GPU driver for Vulkan.
- **VRAM**: the model occupies ~4 GB while the server is warm and is unloaded after
  `idleMinutes` (default 10).
- **Shortcut does not work**: some terminals swallow keys; use the mic button or
  `/voice`, and remap with `/voice-hotkey` (e.g. `alt+v`).
- **Plugin not loading**: check `opencode api get /api/plugin` — `opencode-voice`
  should be `active` with `features.tui: true`. `Ctrl+P` → *plugins* shows the status in the UI.

## Development

```
src/
  tui.tsx       TUI entry: slots, keymap, commands, recording flow
  index.ts      server entry: { id, tui: true, setup } (no imports on purpose)
  recorder.ts   ffmpeg capture -> PCM -> WAV, live RMS levels
  stt.ts        parakeet-server lifecycle + transcription client
  devices.ts    DirectShow audio device discovery
  config.ts     defaults + opencode-voice.json + plugin options
  wav.ts        WAV container builder
  util/log.ts   diagnostic log (%TEMP%\opencode-voice.log)
install.ps1     end-user installer (also works from a local checkout)
scripts/
  package.ps1   builds dist/ release assets (plugin zip + runtime zip)
```

**Local install (developer loop)** — copies the sources into the OpenCode plugins
directory, no links:

```powershell
bun install
pwsh -NoProfile -File install.ps1
```

OpenCode discovers the folder and **hot-reloads** the plugin when files change —
edit here, copy with the script, keep dictating.

**Release assets**:

```powershell
pwsh -NoProfile -File scripts\package.ps1   # dist\opencode-voice-plugin.zip + runtime zip
```

## Uninstall

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\.config\opencode\plugins\opencode-voice"
Remove-Item -Force "$env:USERPROFILE\.config\opencode\opencode-voice.json"
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\opencode-voice"   # runtime + models
```

## Credits & license

- [parakeet.cpp](https://github.com/mudler/parakeet.cpp) — LocalAI team (MIT); prebuilt
  Windows Vulkan binaries are published in this repository's Releases.
- [NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) —
  speech recognition weights (CC-BY-4.0), downloaded by the installer.
- [ggml](https://github.com/ggml-org/ggml) (MIT) and [ffmpeg](https://ffmpeg.org) (LGPL/GPL).
- GGUF conversions from the [LocalAI Hugging Face repo](https://huggingface.co/mudler/parakeet-cpp-gguf).

The plugin itself is licensed under the **Apache License 2.0** — see [LICENSE](LICENSE)
and [NOTICE](NOTICE).
