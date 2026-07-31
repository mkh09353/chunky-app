import type { SessionSummary } from "@chunky/protocol"
import { useCallback, useEffect, useRef, useState } from "react"
import { VoiceAgent, voiceHasApiKey, voiceSetApiKey, type VoiceEvents, type VoiceState, type VoiceToolContext } from "~/lib/voice"

/** One rolling transcript line. `final` drives interim vs settled styling. */
export interface VoiceLine {
  text: string
  final: boolean
}

/** A tool-call chip in the HUD. `ok === undefined` means still running. */
export interface VoiceToolChip {
  id: number
  name: string
  label: string
  ok?: boolean
  /** Set shortly before removal so the chip can transition out. */
  fading?: boolean
}

/** App-side capabilities the voice tools need; kept live through a ref. */
export interface UseVoiceAgentOptions {
  /** Null while demo/offline — starting voice is disabled without a server. */
  baseUrl: string | null
  getRepos: () => Promise<{ id: string; name: string; path: string }[]>
  getSessions: (repoId?: string | null) => Promise<SessionSummary[]>
  dispatchAppAction: VoiceToolContext["dispatchAppAction"]
  refresh: () => void
}

export interface VoiceAgentController {
  state: VoiceState
  /** A session was requested and has not been stopped yet. */
  active: boolean
  muted: boolean
  error: string | null
  userLine: VoiceLine | null
  assistantLine: VoiceLine | null
  tools: VoiceToolChip[]
  /** The HUD renders while a session is live or a failure needs reporting. */
  visible: boolean
  apiKeyPromptOpen: boolean
  start: () => void
  stop: () => void
  toggle: () => void
  setMuted: (muted: boolean) => void
  setApiKeyPromptOpen: (open: boolean) => void
  submitApiKey: (key: string) => Promise<{ ok: boolean; error?: string }>
  dismissError: () => void
}

const CHIP_LIMIT = 3
const CHIP_FADE_MS = 3600
const CHIP_REMOVE_MS = 4100

/** True for the "no xAI key yet" failure, whether thrown or reported. */
function isMissingKey(message: string): boolean {
  return /api key/i.test(message)
}

/**
 * The engine emits assistant text as deltas and user text as either deltas or
 * whole-transcript updates, so interim text is merged rather than replaced: a
 * cumulative update supersedes the buffer, a fragment appends to it.
 */
function mergeInterim(prev: VoiceLine | null, text: string): string {
  if (!prev || prev.final || !prev.text) return text
  if (text.startsWith(prev.text)) return text
  if (prev.text.endsWith(text)) return prev.text
  return prev.text + text
}

export function useVoiceAgent(options: UseVoiceAgentOptions): VoiceAgentController {
  const optionsRef = useRef(options)
  optionsRef.current = options

  const [state, setState] = useState<VoiceState>("idle")
  const [active, setActive] = useState(false)
  const [muted, setMutedState] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [userLine, setUserLine] = useState<VoiceLine | null>(null)
  const [assistantLine, setAssistantLine] = useState<VoiceLine | null>(null)
  const [tools, setTools] = useState<VoiceToolChip[]>([])
  const [apiKeyPromptOpen, setApiKeyPromptOpen] = useState(false)

  const agentRef = useRef<VoiceAgent | null>(null)
  const activeRef = useRef(false)
  const chipSeq = useRef(0)
  const chipTimers = useRef(new Map<number, ReturnType<typeof setTimeout>[]>())

  const clearChipTimers = useCallback(() => {
    for (const timers of chipTimers.current.values()) for (const timer of timers) clearTimeout(timer)
    chipTimers.current.clear()
  }, [])

  /** Resolved chips fade out on their own; pending ones stay until they settle. */
  const scheduleChipRemoval = useCallback((id: number) => {
    const existing = chipTimers.current.get(id)
    if (existing) for (const timer of existing) clearTimeout(timer)
    chipTimers.current.set(id, [
      setTimeout(() => setTools((prev) => prev.map((chip) => (chip.id === id ? { ...chip, fading: true } : chip))), CHIP_FADE_MS),
      setTimeout(() => {
        chipTimers.current.delete(id)
        setTools((prev) => prev.filter((chip) => chip.id !== id))
      }, CHIP_REMOVE_MS),
    ])
  }, [])

  const teardown = useCallback(() => {
    activeRef.current = false
    setActive(false)
    setMutedState(false)
    setUserLine(null)
    setAssistantLine(null)
    setTools([])
    clearChipTimers()
  }, [clearChipTimers])

  const ensureAgent = useCallback((): VoiceAgent => {
    if (agentRef.current) return agentRef.current
    const ctx: VoiceToolContext = {
      // Getter: the agent instance outlives any single render's baseUrl.
      get baseUrl() {
        return optionsRef.current.baseUrl ?? ""
      },
      getRepos: () => optionsRef.current.getRepos(),
      getSessions: (repoId) => optionsRef.current.getSessions(repoId),
      dispatchAppAction: (action) => optionsRef.current.dispatchAppAction(action),
      refresh: () => optionsRef.current.refresh(),
    }
    const events: VoiceEvents = {
      onState: (next) => {
        setState(next)
        if (next === "idle") teardown()
      },
      onUserTranscript: (text, final) => {
        setUserLine((prev) => ({ text: final ? text : mergeInterim(prev, text), final }))
      },
      onAssistantTranscript: (text, final) => {
        setAssistantLine((prev) => ({ text: final ? text : mergeInterim(prev, text), final }))
      },
      onToolCall: (info) => {
        setTools((prev) => {
          // A call reports twice: once on dispatch, once with its result.
          const pending = info.ok !== undefined ? [...prev].reverse().find((chip) => chip.name === info.name && chip.ok === undefined) : undefined
          if (pending) {
            scheduleChipRemoval(pending.id)
            return prev.map((chip) => (chip.id === pending.id ? { ...chip, ok: info.ok, label: info.label } : chip))
          }
          const chip: VoiceToolChip = { id: ++chipSeq.current, name: info.name, label: info.label, ok: info.ok }
          if (info.ok !== undefined) scheduleChipRemoval(chip.id)
          return [...prev, chip].slice(-CHIP_LIMIT)
        })
      },
      onError: (message) => {
        if (isMissingKey(message)) {
          agentRef.current?.stop()
          teardown()
          setState("idle")
          setError(null)
          setApiKeyPromptOpen(true)
          return
        }
        setError(message)
      },
    }
    agentRef.current = new VoiceAgent(ctx, events)
    return agentRef.current
  }, [scheduleChipRemoval, teardown])

  const start = useCallback(() => {
    if (activeRef.current) return
    activeRef.current = true
    setActive(true)
    setError(null)
    setState("connecting")
    const agent = ensureAgent()
    void (async () => {
      // Ask first so a missing key opens the prompt instead of failing loudly.
      if (!(await voiceHasApiKey())) {
        activeRef.current = false
        teardown()
        setState("idle")
        setApiKeyPromptOpen(true)
        return
      }
      try {
        await agent.start()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        activeRef.current = false
        if (isMissingKey(message)) {
          teardown()
          setState("idle")
          setApiKeyPromptOpen(true)
          return
        }
        setError(message)
        setState("error")
      }
    })()
  }, [ensureAgent, teardown])

  const stop = useCallback(() => {
    agentRef.current?.stop()
    teardown()
    setState("idle")
    setError(null)
  }, [teardown])

  const toggle = useCallback(() => {
    if (activeRef.current || error) stop()
    else start()
  }, [error, start, stop])

  const setMuted = useCallback((next: boolean) => {
    setMutedState(next)
    agentRef.current?.setMuted(next)
  }, [])

  const submitApiKey = useCallback(
    async (key: string): Promise<{ ok: boolean; error?: string }> => {
      const result = await voiceSetApiKey(key)
      if (!result.ok) return { ok: false, error: result.error || "Could not save the xAI API key." }
      setApiKeyPromptOpen(false)
      start()
      return { ok: true }
    },
    [start],
  )

  const dismissError = useCallback(() => {
    setError(null)
    if (!activeRef.current) setState("idle")
  }, [])

  useEffect(
    () => () => {
      agentRef.current?.stop()
      clearChipTimers()
    },
    [clearChipTimers],
  )

  return {
    state,
    active,
    muted,
    error,
    userLine,
    assistantLine,
    tools,
    visible: active || state === "error" || error !== null,
    apiKeyPromptOpen,
    start,
    stop,
    toggle,
    setMuted,
    setApiKeyPromptOpen,
    submitApiKey,
    dismissError,
  }
}
