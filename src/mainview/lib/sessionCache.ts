import type { AgentEvent, GoalSnapshot } from "@chunky/protocol"
import { initialState, reduce, type TranscriptState } from "./transcript"

/** These are deliberately sent live-only by the server and never appear in history. */
export function isPersistedSessionEvent(event: AgentEvent): boolean {
  return event.type !== "tool.progress" &&
    event.type !== "session.rewound" &&
    event.type !== "background.changed" &&
    event.type !== "mode.applied" &&
    event.type !== "app.open_url"
}

export function rebuildTranscript(events: readonly AgentEvent[]): TranscriptState {
  return events.reduce(reduce, initialState)
}

export interface CachedSession {
  transcript: TranscriptState
  goal: GoalSnapshot | null
  repoId: string | null
  /** Persisted event prefix used to discard the server's unavoidable full replay. */
  events: AgentEvent[]
}

/** Small in-memory LRU for projections that would otherwise be rebuilt from SSE history. */
export class SessionCache {
  private readonly entries = new Map<string, CachedSession>()

  constructor(private readonly limit = 20) {}

  get(sessionId: string): CachedSession | undefined {
    const entry = this.entries.get(sessionId)
    if (!entry) return undefined
    this.entries.delete(sessionId)
    this.entries.set(sessionId, entry)
    return entry
  }

  set(sessionId: string, entry: CachedSession): void {
    this.entries.delete(sessionId)
    this.entries.set(sessionId, entry)
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!)
  }

  update(sessionId: string, update: Partial<CachedSession>): void {
    const current = this.get(sessionId)
    if (current) this.set(sessionId, { ...current, ...update })
  }

  /** Updates the projection and appends only server-persisted replay events. */
  remember(sessionId: string, transcript: TranscriptState, goal: GoalSnapshot | null, repoId: string | null, event: AgentEvent): void {
    const entry = this.get(sessionId)
    if (!entry) {
      this.set(sessionId, { transcript, goal, repoId, events: isPersistedSessionEvent(event) ? [event] : [] })
      return
    }
    entry.transcript = transcript
    entry.goal = goal
    entry.repoId = repoId
    // This cache is ref-held rather than React state. Mutating the retained
    // prefix avoids copying every prior event on every streaming delta.
    if (isPersistedSessionEvent(event)) entry.events.push(event)
  }

  delete(sessionId: string): void {
    this.entries.delete(sessionId)
  }

  /** Remove cached sessions known to belong to a repo but absent from its fresh list. */
  reconcileRepo(repoId: string | null, sessionIds: ReadonlySet<string>): void {
    for (const [id, entry] of this.entries) {
      if (entry.repoId === repoId && !sessionIds.has(id)) this.entries.delete(id)
    }
  }

  get size(): number {
    return this.entries.size
  }
}
