import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import type { VoiceConfig } from "./config.js"
import { log } from "./util/log.js"

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Manages the local parakeet-server (parakeet.cpp / Vulkan):
 *
 * - starts it on demand when a transcription is requested,
 * - keeps the model resident while in use,
 * - unloads it after `idleMinutes` without transcriptions,
 * - never kills a server it did not start itself.
 */
export class SttServer {
  private child?: ChildProcess
  private owned = false
  private idleTimer?: ReturnType<typeof setTimeout>
  private starting?: Promise<void>

  constructor(private readonly cfg: VoiceConfig) {}

  baseURL(): string {
    return `http://127.0.0.1:${this.cfg.port}`
  }

  /** True when this plugin instance started the currently running server. */
  get isOwned(): boolean {
    return this.owned
  }

  /** Any HTTP answer means the server is up; connection refusal means down. */
  async ping(): Promise<boolean> {
    try {
      await fetch(`${this.baseURL()}/`, { signal: AbortSignal.timeout(1500) })
      return true
    } catch {
      return false
    }
  }

  async ensure(onStatus?: (message: string) => void): Promise<void> {
    if (this.starting) return this.starting
    if (await this.ping()) return
    this.starting = this.startServer(onStatus).finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  async transcribe(wav: Buffer): Promise<string> {
    const form = new FormData()
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "voice.wav")
    form.append("model", "parakeet")
    form.append("response_format", "json")

    const response = await fetch(`${this.baseURL()}/v1/audio/transcriptions`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(180_000),
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`transcrição falhou (${response.status}): ${body.slice(0, 200)}`)

    const parsed = JSON.parse(body) as { text?: string }
    this.scheduleIdleUnload()
    return (parsed.text ?? "").trim()
  }

  async dispose(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    if (this.owned && this.child) {
      log("stt: disposing owned server")
      try {
        this.child.kill()
      } catch {
        // ignore
      }
    }
  }

  private async startServer(onStatus?: (message: string) => void): Promise<void> {
    if (!existsSync(this.cfg.exe)) throw new Error(`parakeet-server não encontrado: ${this.cfg.exe}`)
    if (!existsSync(this.cfg.model)) throw new Error(`modelo não encontrado: ${this.cfg.model}`)

    onStatus?.("carregando modelo… (primeira vez demora alguns segundos)")
    log("stt: spawning", this.cfg.exe, "--model", this.cfg.model, "--port", String(this.cfg.port))
    const child = spawn(this.cfg.exe, ["--model", this.cfg.model, "--port", String(this.cfg.port)], {
      windowsHide: true,
      stdio: "ignore",
    })
    this.child = child
    this.owned = true

    let exited = false
    child.on("exit", (code) => {
      exited = true
      log("stt: server exited:", code)
      if (this.child === child) {
        this.child = undefined
        this.owned = false
      }
    })

    const deadline = Date.now() + 240_000
    while (Date.now() < deadline) {
      if (exited) throw new Error("parakeet-server encerrou ao iniciar — veja o log de diagnóstico")
      if (await this.ping()) {
        log("stt: server ready")
        return
      }
      await sleep(500)
    }
    throw new Error("timeout esperando o parakeet-server subir")
  }

  private scheduleIdleUnload(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.owned && this.child) {
        log("stt: idle unload (modelo liberado após", this.cfg.idleMinutes, "min)")
        try {
          this.child.kill()
        } catch {
          // ignore
        }
      }
    }, Math.max(1, this.cfg.idleMinutes) * 60_000)
    this.idleTimer.unref?.()
  }
}
