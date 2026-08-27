import type { AgentEvent, GoalSnapshot } from "@chunky/protocol"
import { initialState, PORTS_CHANGED, reduce, type TranscriptState } from "./transcript"

/** These are deliberately sent live-only by the server and never appear in history. */
export function isPersistedSessionEvent(event: AgentEvent): boolean {
  return event.type !== "tool.progress" &&
    event.type !== "session.rewound" &&
    event.type !== PORTS_CHANGED &&
    event.type !== "background.changed" &&
    event.type !== "mode.applied" &&
    event.type !== "app.open_url" &&
    event.type !== "app.request_api_key"
}

export function rebuildTranscript(events: readonly AgentEvent[]): TranscriptState {
  return events.reduce(reduce, initialState)
}

export interface CachedSession {
  transcript: TranscriptState
  goal: GoalSnapshot | null
  repoId: string | null
  /** LEGACY servers only: persisted event prefix used to discard the server's
   *  unavoidable full replay (see replayReconciler.ts). The v2 cursor stream
   *  replaces it with `durable` + `cursor`. */
  events: AgentEvent[]
  /** v2: the durable shadow projection — exact state at `cursor`. */
  durable?: TranscriptState | null
  /** v2: encoded replay cursor this session's durable shadow sits at. */
  cursor?: string | null
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

  /** v2: commit the durable shadow and the cursor it sits at, atomically with
   *  the projection that is now on screen. The legacy `events` prefix is
   *  dropped: a cursor makes recognising our own past unnecessary. */
  commitCursor(
    sessionId: string,
    entry: { transcript: TranscriptState; durable: TranscriptState; cursor: string; goal: GoalSnapshot | null; repoId: string | null },
  ): void {
    this.set(sessionId, {
      transcript: entry.transcript,
      goal: entry.goal,
      repoId: entry.repoId,
      events: [],
      durable: entry.durable,
      cursor: entry.cursor,
    })
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
