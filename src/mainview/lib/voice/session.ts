import { MicCapture, PcmPlayer } from "./audio"
import { voiceGetToken } from "./voiceRpc"
import type { VoiceEvents } from "./types"
import type { VoiceTool, VoiceToolCall } from "./tools"

const URL = "wss://api.x.ai/v1/realtime?model=grok-voice-think-fast-2.0"
const IDLE_MS = 3 * 60_000

export class VoiceSession {
  private socket: WebSocket | null = null
  private mic = new MicCapture()
  private player = new PcmPlayer()
  private muted = false
  private stopped = false
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly events: VoiceEvents,
    private readonly tools: VoiceTool[],
    private readonly execute: (call: VoiceToolCall) => Promise<Record<string, unknown>>,
  ) {}

  async start(): Promise<void> {
    this.stopped = false; this.events.onState("connecting")
    const secret = await voiceGetToken()
    if (!secret.ok) { this.fail(secret.error); return }
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(URL, [`xai-client-secret.${secret.token}`])
      this.socket = socket
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error("Could not connect to xAI voice."))
      socket.onclose = () => { if (!this.stopped) this.events.onState("idle") }
      socket.onmessage = (event) => this.onMessage(event.data)
    }).catch((error: unknown) => this.fail(error instanceof Error ? error.message : "Could not connect to xAI voice."))
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.stopped) return
    try { await this.mic.start((audio) => { if (!this.muted) this.send({ type: "input_audio_buffer.append", audio }) }) } catch (error) { this.stop(); this.fail(error instanceof Error ? error.message : "Microphone unavailable."); return }
    this.bumpIdle()
  }

  stop(): void {
    this.stopped = true
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null; this.mic.stop(); this.player.close()
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close()
    this.socket = null; this.events.onState("idle")
  }

  setMuted(muted: boolean): void { this.muted = muted }

  private send(message: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
  }

  private bumpIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => { this.events.onError("Voice disconnected after 3 minutes of inactivity."); this.stop() }, IDLE_MS)
  }

  private onMessage(raw: unknown): void {
    let event: Record<string, unknown>
    try { event = JSON.parse(typeof raw === "string" ? raw : "") as Record<string, unknown> } catch { return }
    const type = typeof event.type === "string" ? event.type : ""
    if (type === "session.created") {
      this.send({ type: "session.update", session: {
        instructions: "You are a voice assistant that manages the Chunky coding-agent desktop app. Dispatch work to coding threads; do not write code yourself. You can read thread contents to discuss what they did or found. Be brief and conversational.",
        turn_detection: { type: "server_vad" }, tools: this.tools, tool_choice: "auto",
        audio: { input: { transcription: { model: "grok-transcribe" } } },
      } })
      this.events.onState("listening")
    } else if (type === "response.output_audio.delta") {
      if (typeof event.delta === "string") this.player.append(event.delta)
      this.events.onState("speaking")
    } else if (type === "input_audio_buffer.speech_started") {
      this.player.flush(); this.bumpIdle(); this.events.onState("listening")
    } else if (type === "response.output_audio_transcript.delta") {
      if (typeof event.delta === "string") this.events.onAssistantTranscript(event.delta, false)
    } else if (type === "response.output_audio_transcript.done") {
      const transcript = typeof event.transcript === "string" ? event.transcript : typeof event.text === "string" ? event.text : ""
      if (transcript) this.events.onAssistantTranscript(transcript, true)
      this.events.onState("listening")
    } else if (type === "conversation.item.input_audio_transcription.completed" || type === "conversation.item.input_audio_transcription.updated") {
      const transcript = typeof event.transcript === "string" ? event.transcript : typeof event.delta === "string" ? event.delta : ""
      if (transcript) this.events.onUserTranscript(transcript, type.endsWith("completed"))
      if (type.endsWith("completed")) this.bumpIdle()
    } else if (type === "response.function_call_arguments.done") {
      void this.handleTool(event)
    } else if (type === "error") {
      const detail = event.error && typeof event.error === "object" && typeof (event.error as { message?: unknown }).message === "string" ? (event.error as { message: string }).message : "xAI voice error"
      this.events.onError(detail); this.events.onState("error")
    }
  }

  private async handleTool(event: Record<string, unknown>): Promise<void> {
    const name = typeof event.name === "string" ? event.name : "unknown"
    const callId = typeof event.call_id === "string" ? event.call_id : ""
    let args: Record<string, unknown> = {}
    try { args = JSON.parse(typeof event.arguments === "string" ? event.arguments : "{}") as Record<string, unknown> } catch { args = {} }
    this.events.onState("tool"); this.events.onToolCall({ name, label: name.replaceAll("_", " ") })
    const result = await this.execute({ name, callId, args })
    this.events.onToolCall({ name, label: name.replaceAll("_", " "), ok: !result.error })
    this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(result) } })
    this.events.onState("listening")
  }

  private fail(message: string): void { this.events.onError(message); this.events.onState("error") }
}
