import { spawn } from "node:child_process"

export interface AudioDevice {
  /** Device name as accepted by ffmpeg's dshow input (`audio=<name>`). */
  name: string
  /** Windows PnP alternative name (`@device_cm_...`), used as a fallback. */
  alt?: string
}

const NAME_RE = /"([^"]+)"\s*\((audio|video)\)/
const ALT_RE = /Alternative name "([^"]+)"/

/** Parses ffmpeg's `-list_devices` output (stderr) into audio devices. */
export function parseAudioDevices(output: string): AudioDevice[] {
  const devices: AudioDevice[] = []
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(/^\[[^\]]*\]\s*/, "")
    const named = NAME_RE.exec(line)
    if (named) {
      if (named[2] === "audio") devices.push({ name: named[1] })
      continue
    }
    const alternative = ALT_RE.exec(line)
    if (alternative && devices.length > 0) {
      const last = devices[devices.length - 1]
      if (!last.alt) last.alt = alternative[1]
    }
  }
  return devices
}

/**
 * Lists DirectShow audio capture devices. ffmpeg exits non-zero for
 * `-list_devices` (there is no real input), so the list comes from stderr and
 * the exit code is ignored.
 */
export function listAudioDevices(ffmpeg: string, timeoutMs = 15_000): Promise<AudioDevice[]> {
  return new Promise((resolve) => {
    let output = ""
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve(parseAudioDevices(output))
    }
    const child = spawn(ffmpeg, ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], {
      windowsHide: true,
    })
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // ignore
      }
      finish()
    }, timeoutMs)
    child.stdout?.on("data", (data: Buffer) => {
      output += data.toString()
    })
    child.stderr?.on("data", (data: Buffer) => {
      output += data.toString()
    })
    child.on("error", () => {
      clearTimeout(timer)
      finish()
    })
    child.on("exit", () => {
      clearTimeout(timer)
      finish()
    })
  })
}
