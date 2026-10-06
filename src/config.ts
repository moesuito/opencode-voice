import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export interface VoiceConfig {
  /** ffmpeg executable (PATH name or absolute path). */
  ffmpeg: string
  /** parakeet-server executable. */
  exe: string
  /** GGUF model served by parakeet-server. */
  model: string
  /** Local HTTP port used by parakeet-server. */
  port: number
  /** Minutes of inactivity before the plugin unloads the model. */
  idleMinutes: number
  /** Hard cap for a single recording. */
  maxSeconds: number
  /** Capture sample rate (mono, 16-bit). */
  sampleRate: number
  /** Default keyboard shortcut (TUI keybinding syntax). */
  hotkey: string
  /** Microphone device name ("" = ask on first use). */
  mic: string
}

/** Portable install root used by the release installer. */
function defaultInstallDir(): string {
  const local = process.env.LOCALAPPDATA ?? process.env.USERPROFILE ?? ""
  return join(local, "opencode-voice")
}

export const DEFAULT_CONFIG: VoiceConfig = {
  ffmpeg: "ffmpeg",
  exe: join(defaultInstallDir(), "runtime", "parakeet-server.exe"),
  model: join(defaultInstallDir(), "models", "tdt-0.6b-v3-f16.gguf"),
  port: 8797,
  idleMinutes: 10,
  maxSeconds: 300,
  sampleRate: 16000,
  hotkey: "ctrl+y",
  mic: "",
}

/**
 * Config file written by the installer, next to the OpenCode configuration.
 * `OPENCODE_VOICE_CONFIG` overrides the path (mainly for tests).
 */
export function configFilePath(): string {
  const override = process.env.OPENCODE_VOICE_CONFIG?.trim()
  if (override) return override
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ""
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  const base = xdg && xdg.length > 0 ? xdg : join(home, ".config")
  return join(base, "opencode", "opencode-voice.json")
}

/** Reads the installer-written config file; unknown/malformed values are ignored. */
export function readConfigFile(): Partial<VoiceConfig> {
  try {
    const path = configFilePath()
    if (!existsSync(path)) return {}
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    const value: Partial<VoiceConfig> = {}
    if (typeof raw.ffmpeg === "string" && raw.ffmpeg.trim()) value.ffmpeg = raw.ffmpeg.trim()
    if (typeof raw.exe === "string" && raw.exe.trim()) value.exe = raw.exe.trim()
    if (typeof raw.model === "string" && raw.model.trim()) value.model = raw.model.trim()
    if (raw.port !== undefined) value.port = readNumber(raw.port, DEFAULT_CONFIG.port)
    if (raw.idleMinutes !== undefined) value.idleMinutes = readNumber(raw.idleMinutes, DEFAULT_CONFIG.idleMinutes)
    if (raw.maxSeconds !== undefined) value.maxSeconds = readNumber(raw.maxSeconds, DEFAULT_CONFIG.maxSeconds)
    if (raw.sampleRate !== undefined) value.sampleRate = readNumber(raw.sampleRate, DEFAULT_CONFIG.sampleRate)
    if (typeof raw.hotkey === "string" && raw.hotkey.trim()) value.hotkey = raw.hotkey.trim()
    if (typeof raw.mic === "string") value.mic = raw.mic.trim()
    return value
  } catch {
    return {}
  }
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback
}

function readNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * Resolution order (lowest to highest): built-in defaults → installer config
 * file (`opencode-voice.json`) → plugin options from the OpenCode config.
 */
export function configFromOptions(options: Readonly<Record<string, unknown>> | undefined): VoiceConfig {
  const merged: Record<string, unknown> = { ...readConfigFile(), ...(options ?? {}) }
  return {
    ffmpeg: readString(merged.ffmpeg, DEFAULT_CONFIG.ffmpeg),
    exe: readString(merged.exe, DEFAULT_CONFIG.exe),
    model: readString(merged.model, DEFAULT_CONFIG.model),
    port: readNumber(merged.port, DEFAULT_CONFIG.port),
    idleMinutes: readNumber(merged.idleMinutes, DEFAULT_CONFIG.idleMinutes),
    maxSeconds: readNumber(merged.maxSeconds, DEFAULT_CONFIG.maxSeconds),
    sampleRate: readNumber(merged.sampleRate, DEFAULT_CONFIG.sampleRate),
    hotkey: readString(merged.hotkey, DEFAULT_CONFIG.hotkey),
    mic: readString(merged.mic, DEFAULT_CONFIG.mic),
  }
}
