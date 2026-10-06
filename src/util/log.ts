import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"

const MAX_LOG_BYTES = 1_000_000

let resolvedPath: string | undefined

/**
 * Diagnostic log shared by every module. Lives next to the other OpenCode
 * temp files (`%TEMP%\opencode-voice.log`) and can be overridden with
 * `OPENCODE_VOICE_LOG` for debugging.
 */
export function logPath(): string {
  if (!resolvedPath) {
    resolvedPath = process.env.OPENCODE_VOICE_LOG?.trim() || join(tmpdir(), "opencode-voice.log")
  }
  return resolvedPath
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value
  if (value instanceof Error) return value.stack || value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Fire-and-forget logging; never throws into the plugin flow. */
export function log(...parts: unknown[]): void {
  try {
    const file = logPath()
    mkdirSync(dirname(file), { recursive: true })
    try {
      if (statSync(file).size > MAX_LOG_BYTES) writeFileSync(file, "")
    } catch {
      // file does not exist yet
    }
    appendFileSync(file, `[${new Date().toISOString()}] ${parts.map(stringify).join(" ")}\n`, "utf8")
  } catch {
    // logging must never break the plugin
  }
}
