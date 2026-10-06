import { spawn, type ChildProcess } from "node:child_process"
import { log } from "./util/log.js"
import { buildWav } from "./wav.js"

export interface RecordingResult {
  wav: Buffer
  durationMs: number
  /** Loudest absolute sample (0..1) — used to detect silence. */
  peak: number
}

export interface RecorderCallbacks {
  /** Raw level (0..1) for one PCM chunk, ~every 50 ms. */
  onLevel(level: number): void
  /** Fired when the configured maximum duration is reached. */
  onAutoStop(): void
  onError(message: string): void
}

export interface RecorderStartOptions {
  ffmpeg: string
  device: string
  sampleRate: number
  maxSeconds: number
  callbacks: RecorderCallbacks
}

/**
 * Captures microphone audio through ffmpeg's DirectShow input as raw 16-bit
 * mono PCM on stdout. Levels are emitted while recording; `stop()` returns the
 * buffered audio as a WAV.
 */
export class Recorder {
  private child?: ChildProcess
  private opts?: RecorderStartOptions
  private chunks: Buffer[] = []
  private byteCount = 0
  private peak = 0
  private startedAt = 0
  private autoStopTimer?: ReturnType<typeof setTimeout>
  private stopPromise?: Promise<RecordingResult | undefined>
  private resolveStop?: (result: RecordingResult | undefined) => void
  private discarded = false
  private stderrTail: string[] = []

  get isRecording(): boolean {
    return this.child !== undefined
  }

  start(options: RecorderStartOptions): void {
    if (this.child) throw new Error("já existe uma gravação em andamento")
    this.opts = options
    this.chunks = []
    this.byteCount = 0
    this.peak = 0
    this.discarded = false
    this.stopPromise = undefined
    this.resolveStop = undefined
    this.stderrTail = []
    this.startedAt = Date.now()

    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "dshow",
      "-audio_buffer_size",
      "50",
      "-i",
      `audio=${options.device}`,
      "-ac",
      "1",
      "-ar",
      String(options.sampleRate),
      "-f",
      "s16le",
      "-",
    ]

    log("recorder: spawning ffmpeg:", args.join(" "))
    const child = spawn(options.ffmpeg, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
    this.child = child

    child.stdout?.on("data", (data: Buffer) => this.collect(data))
    child.stderr?.on("data", (data: Buffer) => {
      this.stderrTail.push(data.toString())
      if (this.stderrTail.length > 20) this.stderrTail.shift()
    })
    child.on("error", (error) => {
      log("recorder: process error:", error.message)
      this.finalize(undefined)
      options.callbacks.onError(error.message)
    })
    child.on("exit", (code) => {
      if (this.child === child) {
        const tail = this.stderrTail.join("").trim()
        log("recorder: ffmpeg exited:", code, tail ? `| ${tail.slice(0, 400)}` : "")
        this.finalize(this.takeResult())
      }
    })

    this.autoStopTimer = setTimeout(() => {
      log("recorder: maximum duration reached")
      options.callbacks.onAutoStop()
    }, Math.max(1, options.maxSeconds) * 1000)
  }

  /** Stops gracefully (ffmpeg quits on `q`) and resolves with the recording. */
  stop(): Promise<RecordingResult | undefined> {
    const child = this.child
    if (!child) return Promise.resolve(undefined)
    if (this.stopPromise) return this.stopPromise

    this.stopPromise = new Promise<RecordingResult | undefined>((resolve) => {
      this.resolveStop = resolve
      try {
        child.stdin?.write("q")
      } catch {
        // stdin may already be closed; the kill below is the backstop
      }
      setTimeout(() => {
        if (this.child === child) {
          try {
            child.kill()
          } catch {
            // ignore
          }
        }
      }, 1500)
    })
    return this.stopPromise
  }

  /** Stops and discards the current recording. */
  cancel(): void {
    const child = this.child
    this.discarded = true
    if (this.autoStopTimer) clearTimeout(this.autoStopTimer)
    this.autoStopTimer = undefined
    if (!child) return
    try {
      child.stdin?.write("q")
    } catch {
      // ignore
    }
    setTimeout(() => {
      if (this.child === child) {
        try {
          child.kill()
        } catch {
          // ignore
        }
      }
    }, 700)
  }

  private collect(data: Buffer): void {
    if (this.discarded || data.length === 0) return
    // Int16 samples: drop a dangling byte if ffmpeg ever emits an odd chunk.
    const usable = data.length % 2 === 0 ? data : data.subarray(0, data.length - 1)
    this.chunks.push(Buffer.from(usable))
    this.byteCount += usable.length

    let sumSquares = 0
    let localPeak = 0
    for (let index = 0; index + 1 < usable.length; index += 2) {
      const value = usable.readInt16LE(index) / 32768
      sumSquares += value * value
      const magnitude = Math.abs(value)
      if (magnitude > localPeak) localPeak = magnitude
    }
    const samples = Math.max(1, usable.length / 2)
    const rms = Math.sqrt(sumSquares / samples)
    if (localPeak > this.peak) this.peak = localPeak
    this.opts?.callbacks.onLevel(Math.max(0, Math.min(1, rms * 6)))
  }

  private takeResult(): RecordingResult | undefined {
    if (this.discarded || !this.opts || this.byteCount === 0) return undefined
    return {
      wav: buildWav(Buffer.concat(this.chunks, this.byteCount), this.opts.sampleRate),
      durationMs: Date.now() - this.startedAt,
      peak: this.peak,
    }
  }

  private finalize(result: RecordingResult | undefined): void {
    if (this.autoStopTimer) clearTimeout(this.autoStopTimer)
    this.autoStopTimer = undefined
    this.child = undefined
    const resolve = this.resolveStop
    this.resolveStop = undefined
    resolve?.(result)
  }
}
