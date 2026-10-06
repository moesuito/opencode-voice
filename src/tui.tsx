/** @jsxImportSource @opentui/solid */
import type { Context } from "@opencode/plugin/tui/context"
import { configFromOptions, type VoiceConfig } from "./config.js"
import { listAudioDevices } from "./devices.js"
import { Recorder, type RecordingResult } from "./recorder.js"
import { SttServer } from "./stt.js"
import { log, logPath } from "./util/log.js"

log("voice: module imported")

/*
 * opencode-voice — ditado local para o OpenCode V2 TUI.
 *
 * Fluxo: Ctrl+Y (ou clique no ícone do rodapé) → ffmpeg grava o microfone
 * (DirectShow, 16 kHz mono) → parakeet-server transcreve com o modelo
 * Parakeet TDT 0.6B v3 (Vulkan) → o texto é enviado como prompt na sessão.
 */

const MIC_ICON = "🎤" // emoji: renderiza em qualquer fonte
const STOP_ICON = "■" // parar e enviar
const PAUSE_ICON = "⏸" // parar, transcrever e inserir sem enviar
const CANCEL_ICON = "✕" // cancelar e descartar
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
const MAX_BARS = 32

const COLORS = {
  idle: "#7a8478",
  recording: "#e06c75",
  busy: "#e5c07b",
  dim: "#5c6660",
}

type Phase = "idle" | "recording" | "transcribing"

interface VoiceSettings {
  mic: string
  hotkey: string
}

interface UiState {
  phase: Phase
  levels: number[]
  elapsed: number
  spin: number
  detail: string
}

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, "0")}`
}

function waveform(levels: readonly number[]): string {
  const bars = levels.map(
    (level) => BARS[Math.max(0, Math.min(BARS.length - 1, Math.floor(level * BARS.length)))],
  )
  return bars.join("").padStart(MAX_BARS, "▁")
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const plugin = {
  id: "opencode-voice",
  async setup(context: Context) {
    log("voice: setup start | pid", process.pid)
    context.ui.toast.show({ title: "Voz", message: "Plugin carregado", variant: "success", duration: 4000 })
    const cfg: VoiceConfig = configFromOptions(context.options)
    const [settings, updateSettings] = context.storage.store<VoiceSettings>("opencode-voice", {
      initial: { mic: "", hotkey: "" },
    })
    const [ui, updateUi] = context.storage.memory<UiState>("opencode-voice.ui", {
      initial: { phase: "idle", levels: [], elapsed: 0, spin: 0, detail: "" },
    })

    const recorder = new Recorder()
    const stt = new SttServer(cfg)

    const hotkey = () => (settings.hotkey || "").trim() || cfg.hotkey
    const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") =>
      context.ui.toast.show({ title: "Voz", message, variant })

    let startedAt = 0
    let tickTimer: ReturnType<typeof setInterval> | undefined
    let spinTimer: ReturnType<typeof setInterval> | undefined
    let lastSessionID: string | undefined
    let lastResult: RecordingResult | undefined
    let lastText = ""

    function setPhase(phase: Phase, detail = "") {
      updateUi((draft) => {
        draft.phase = phase
        draft.detail = detail
        if (phase === "idle") {
          draft.levels = []
          draft.elapsed = 0
        }
      })
    }

    function stopTimers() {
      if (tickTimer) clearInterval(tickTimer)
      if (spinTimer) clearInterval(spinTimer)
      tickTimer = undefined
      spinTimer = undefined
    }

    function startElapsedTimer() {
      if (tickTimer) clearInterval(tickTimer)
      tickTimer = setInterval(() => {
        updateUi((draft) => {
          if (draft.phase === "recording") draft.elapsed = Math.floor((Date.now() - startedAt) / 1000)
        })
      }, 250)
    }

    function startSpin() {
      if (spinTimer) return
      spinTimer = setInterval(() => {
        updateUi((draft) => {
          draft.spin = (draft.spin + 1) % SPINNER.length
        })
      }, 100)
    }

    function currentSessionID(): string | undefined {
      const route = context.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }

    async function ensureMic(): Promise<string | undefined> {
      const configured = (settings.mic || "").trim() || cfg.mic
      if (configured) return configured

      const devices = await listAudioDevices(cfg.ffmpeg)
      if (devices.length === 0) {
        toast("Nenhum microfone encontrado (verifique o ffmpeg).", "error")
        return undefined
      }
      const chosen = await context.ui.dialog.select<string>({
        title: "Escolha o microfone",
        placeholder: "Filtrar…",
        options: devices.map((device) => ({ title: device.name, value: device.name, description: device.alt })),
      })
      if (!chosen) return undefined
      await updateSettings((draft) => {
        draft.mic = chosen
      })
      toast(`Microfone: ${chosen}`, "success")
      return chosen
    }

    async function pickMic() {
      const devices = await listAudioDevices(cfg.ffmpeg)
      if (devices.length === 0) {
        toast("Nenhum microfone encontrado.", "error")
        return
      }
      const current = (settings.mic || "").trim()
      const chosen = await context.ui.dialog.select<string>({
        title: "Microfone",
        placeholder: "Filtrar…",
        current: current || undefined,
        options: devices.map((device) => ({ title: device.name, value: device.name, description: device.alt })),
      })
      if (chosen === undefined) return
      await updateSettings((draft) => {
        draft.mic = chosen
      })
      toast(`Microfone: ${chosen}`, "success")
    }

    async function setHotkey() {
      const value = await context.ui.dialog.prompt({
        title: "Atalho do microfone",
        description: "Exemplos: ctrl+y, alt+v, ctrl+alt+v",
        placeholder: cfg.hotkey,
        value: hotkey(),
      })
      if (value === undefined) return
      const next = value.trim()
      await updateSettings((draft) => {
        draft.hotkey = next
      })
      toast(`Atalho: ${next || cfg.hotkey}`, "success")
    }

    async function showStatus() {
      const running = await stt.ping()
      const mic = (settings.mic || "").trim() || "(não escolhido)"
      const message = [
        `Atalho: ${hotkey()}`,
        `Microfone: ${mic}`,
        `ffmpeg: ${cfg.ffmpeg}`,
        `parakeet-server: ${running ? "no ar" : "parado"}${stt.isOwned ? " (gerenciado pelo plugin)" : ""}`,
        `Porta: ${cfg.port}`,
        `Modelo: ${cfg.model}`,
        `Descarga ociosa: ${cfg.idleMinutes} min • máx. gravação: ${cfg.maxSeconds}s`,
        `Log: ${logPath()}`,
      ].join("\n")
      await context.ui.dialog.alert({ title: "Voz — diagnóstico", message })
    }

    async function startRecording() {
      const sessionID = currentSessionID() ?? lastSessionID
      if (!sessionID) {
        toast("Abra uma sessão para ditar.", "warning")
        return
      }
      lastSessionID = sessionID

      let device: string | undefined
      try {
        device = await ensureMic()
      } catch (error) {
        toast(`Microfone indisponível: ${errorMessage(error)}`, "error")
        return
      }
      if (!device) return

      try {
        recorder.start({
          ffmpeg: cfg.ffmpeg,
          device,
          sampleRate: cfg.sampleRate,
          maxSeconds: cfg.maxSeconds,
          callbacks: {
            onLevel: (level) =>
              updateUi((draft) => {
                draft.levels = [...draft.levels.slice(-(MAX_BARS - 1)), level]
              }),
            onAutoStop: () => {
              void stopRecording("send")
            },
            onError: (message) => {
              stopTimers()
              setPhase("idle")
              toast(`Falha na gravação: ${message}`, "error")
            },
          },
        })
      } catch (error) {
        toast(`Falha ao iniciar o microfone: ${errorMessage(error)}`, "error")
        return
      }

      startedAt = Date.now()
      setPhase("recording")
      startElapsedTimer()
      log("voice: recording started |", device)
    }

    async function stopRecording(mode: "send" | "insert") {
      if (ui.phase !== "recording") return
      if (tickTimer) {
        clearInterval(tickTimer)
        tickTimer = undefined
      }

      const result = await recorder.stop()
      lastResult = result
      if (!result || result.durationMs < 400 || result.peak < 0.008) {
        log("voice: recording discarded | dur", result?.durationMs, "peak", result?.peak)
        setPhase("idle")
        toast("Nada foi captado.", "warning")
        return
      }
      await transcribeAndSend(result, mode)
    }

    async function transcribeAndSend(result: RecordingResult, mode: "send" | "insert") {
      setPhase("transcribing", "preparando motor…")
      startSpin()
      try {
        await stt.ensure((message) =>
          updateUi((draft) => {
            draft.detail = message
          }),
        )
        updateUi((draft) => {
          draft.detail = "transcrevendo…"
        })
        const text = await stt.transcribe(result.wav)
        if (!text) {
          log("voice: transcription empty")
          setPhase("idle")
          toast("Nenhuma fala detectada.", "warning")
          return
        }
        lastText = text
        if (mode === "insert") {
          const inserted = insertIntoComposer(text)
          setPhase("idle")
          if (inserted) {
            toast("Transcrição inserida no prompt — revise e envie.", "success")
          } else {
            toast("Sem campo de texto focado — use /voice-insert.", "warning")
          }
          log("voice: transcribed (insert) |", `${text.length} chars`, inserted ? "| inserted" : "| no editor")
          return
        }
        await sendPrompt(text)
      } catch (error) {
        log("voice: transcription failed:", errorMessage(error))
        setPhase("idle")
        toast(`Transcrição falhou: ${errorMessage(error)}`, "error")
      } finally {
        stopTimers()
      }
    }

    async function sendPrompt(text: string) {
      const sessionID = currentSessionID() ?? lastSessionID
      if (!sessionID) {
        toast("Sem sessão ativa — use /voice-retry quando abrir uma.", "warning")
        return
      }
      await context.client.session.prompt({ sessionID, text })
      setPhase("idle")
      toast(text.length > 90 ? `${text.slice(0, 90)}…` : text, "success")
      log("voice: prompt sent |", sessionID, `| ${text.length} chars`)
    }

    async function retry() {
      if (ui.phase !== "idle") return
      if (!lastResult) {
        toast("Nada para reenviar.", "warning")
        return
      }
      await transcribeAndSend(lastResult, "send")
    }

    /** Insere texto no composer focado (sem enviar). */
    function insertIntoComposer(text: string): boolean {
      try {
        const editor = context.renderer.currentFocusedEditor
        if (!editor) return false
        editor.insertText(text.endsWith(" ") ? text : `${text} `)
        return true
      } catch (error) {
        log("voice: insert into composer failed:", errorMessage(error))
        return false
      }
    }

    /** Para a gravação, transcreve e insere no prompt — sem enviar. */
    async function pauseAndInsert() {
      if (ui.phase === "recording") {
        await stopRecording("insert")
        return
      }
      if (ui.phase === "transcribing") {
        toast("Ainda processando o áudio anterior…", "warning")
        return
      }
      toast("Nada gravando no momento.", "warning")
    }

    function insertLastText() {
      if (!lastText) {
        toast("Nada transcrito ainda.", "warning")
        return
      }
      if (insertIntoComposer(lastText)) toast("Texto inserido no prompt.", "success")
      else toast("Sem campo de texto focado.", "warning")
    }

    function cancel() {
      if (ui.phase !== "recording") return
      recorder.cancel()
      stopTimers()
      setPhase("idle")
      toast("Gravação cancelada.", "info")
    }

    async function toggle() {
      if (ui.phase === "recording") {
        await stopRecording("send")
        return
      }
      if (ui.phase === "transcribing") {
        toast("Ainda processando o áudio anterior…", "warning")
        return
      }
      await startRecording()
    }

    context.keymap.layer(() => ({
      mode: "global",
      priority: 20,
      commands: [
        {
          id: "opencode-voice.record",
          title: "Voz: gravar / parar",
          group: "Voz",
          bind: hotkey(),
          palette: true,
          slash: { name: "voice", aliases: ["voice-record"] },
          suggested: true,
          run: () => {
            void toggle()
          },
        },
        {
          id: "opencode-voice.cancel",
          title: "Voz: cancelar gravação",
          group: "Voz",
          palette: true,
          slash: { name: "voice-cancel" },
          run: () => {
            cancel()
          },
        },
        {
          id: "opencode-voice.retry",
          title: "Voz: reenviar último áudio",
          group: "Voz",
          palette: true,
          slash: { name: "voice-retry" },
          run: () => {
            void retry()
          },
        },
        {
          id: "opencode-voice.pause",
          title: "Voz: transcrever sem enviar",
          group: "Voz",
          palette: true,
          slash: { name: "voice-pause" },
          run: () => {
            void pauseAndInsert()
          },
        },
        {
          id: "opencode-voice.insert",
          title: "Voz: inserir última transcrição",
          group: "Voz",
          palette: true,
          slash: { name: "voice-insert" },
          run: () => {
            insertLastText()
          },
        },
        {
          id: "opencode-voice.mic",
          title: "Voz: escolher microfone",
          group: "Voz",
          palette: true,
          slash: { name: "voice-mic" },
          run: () => {
            void pickMic()
          },
        },
        {
          id: "opencode-voice.hotkey",
          title: "Voz: definir atalho",
          group: "Voz",
          palette: true,
          slash: { name: "voice-hotkey" },
          run: () => {
            void setHotkey()
          },
        },
        {
          id: "opencode-voice.status",
          title: "Voz: diagnóstico",
          group: "Voz",
          palette: true,
          slash: { name: "voice-status" },
          run: () => {
            void showStatus()
          },
        },
      ],
      bindings: ["opencode-voice.record"],
    }))
    log("voice: keymap layer registered")

    // Controles do microfone no rodapé do prompt (some fora de sessão).
    // Gravando: ⏸ transcreve e insere sem enviar · ■ para e envia · ✕ cancela.
    const disposeFooter = context.ui.slot({
      append: "prompt.footer",
      render: (input) => {
        if (input.sessionID) lastSessionID = input.sessionID
        if (!input.sessionID) return <box height={0} />
        if (ui.phase === "recording") {
          return (
            <box height={1} flexShrink={0} marginLeft={1} flexDirection="row" alignItems="center">
              <box
                paddingLeft={1}
                paddingRight={1}
                onMouseUp={() => {
                  void stopRecording("insert")
                }}
              >
                <text fg={COLORS.busy}>{PAUSE_ICON}</text>
              </box>
              <box
                paddingLeft={1}
                paddingRight={1}
                onMouseUp={() => {
                  void stopRecording("send")
                }}
              >
                <text fg={COLORS.recording}>{STOP_ICON}</text>
              </box>
              <box
                paddingLeft={1}
                paddingRight={1}
                onMouseUp={() => {
                  cancel()
                }}
              >
                <text fg={COLORS.dim}>{CANCEL_ICON}</text>
              </box>
            </box>
          )
        }
        if (ui.phase === "idle") {
          return (
            <box
              height={1}
              flexShrink={0}
              marginLeft={1}
              paddingLeft={1}
              paddingRight={1}
              justifyContent="center"
              alignItems="center"
              onMouseUp={() => {
                void toggle()
              }}
            >
              <text fg={COLORS.idle}>{MIC_ICON}</text>
            </box>
          )
        }
        return (
          <box
            height={1}
            flexShrink={0}
            marginLeft={1}
            paddingLeft={1}
            paddingRight={1}
            justifyContent="center"
            alignItems="center"
          >
            <text fg={COLORS.busy}>{SPINNER[ui.spin % SPINNER.length]}</text>
          </box>
        )
      },
    })

    // Painel de gravação logo acima do composer: onda sonora + timer.
    const disposeComposerTop = context.ui.slot({
      append: "session.composer.top",
      render: (input) => {
        lastSessionID = input.sessionID
        if (ui.phase === "idle") return <box height={0} />
        return (
          <box height={1} flexDirection="row" paddingLeft={1}>
            {ui.phase === "recording" ? (
              <>
                <text fg={COLORS.recording}>{`● REC ${formatElapsed(ui.elapsed)}`}</text>
                <text fg={COLORS.recording}>{`  ${waveform(ui.levels)}`}</text>
                <text fg={COLORS.dim}>{`   ${hotkey()} envia · ⏸ insere · ✕ cancela`}</text>
              </>
            ) : (
              <text fg={COLORS.busy}>
                {`${SPINNER[ui.spin % SPINNER.length]} ${ui.detail || "transcrevendo…"}`}
              </text>
            )}
          </box>
        )
      },
    })

    log("voice: plugin loaded | pid", process.pid, "| exe:", cfg.exe, "| model:", cfg.model, "| hotkey:", cfg.hotkey)

    return () => {
      stopTimers()
      recorder.cancel()
      void stt.dispose()
      disposeFooter()
      disposeComposerTop()
    }
  },
}

export default plugin
