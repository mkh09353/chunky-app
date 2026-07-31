export type VoiceState = "idle" | "connecting" | "listening" | "speaking" | "tool" | "error"

export interface VoiceEvents {
  onState(s: VoiceState): void
  onUserTranscript(text: string, final: boolean): void
  onAssistantTranscript(text: string, final: boolean): void
  onToolCall(info: { name: string; label: string; ok?: boolean }): void
  onError(message: string): void
}
