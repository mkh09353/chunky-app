import { VoiceSession } from "./session"
import { executeVoiceTool, voiceTools } from "./tools"
import type { VoiceEvents, VoiceState } from "./types"
import type { VoiceToolContext } from "./tools"

export type { VoiceEvents, VoiceState } from "./types"
export type { VoiceToolContext } from "./tools"
export { voiceHasApiKey, voiceSetApiKey } from "./voiceRpc"
export { fuzzyMatch, voiceTools } from "./tools"

/** React-free facade for a future UI hook/component. */
export class VoiceAgent {
  private session: VoiceSession
  private currentState: VoiceState = "idle"

  constructor(ctx: VoiceToolContext, events: VoiceEvents) {
    const wrapped: VoiceEvents = {
      ...events,
      onState: (state) => { this.currentState = state; events.onState(state) },
    }
    this.session = new VoiceSession(wrapped, voiceTools, (call) => executeVoiceTool(ctx, call))
  }

  get state(): VoiceState { return this.currentState }
  start(): Promise<void> { return this.session.start() }
  stop(): void { this.session.stop() }
  setMuted(muted: boolean): void { this.session.setMuted(muted) }
}
