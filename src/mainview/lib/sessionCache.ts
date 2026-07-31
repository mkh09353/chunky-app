import type { AgentEvent, GoalSnapshot } from "@chunky/protocol"
import type { TranscriptState } from "./transcript"

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
