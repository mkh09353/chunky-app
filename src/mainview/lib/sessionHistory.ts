import {
  decodeSessionEventCursor,
  encodeSessionEventCursor,
  type SessionHistoryResponse,
} from "@chunky/protocol"
import type { SessionSnapshot } from "./sessionSnapshots"
import { initialState, type TranscriptState } from "./transcript"
import { SessionStreamMachine } from "./sessionStream"

export type SessionHistoryRow = SessionHistoryResponse["events"][number]

/** Project HTTP history through the exact v2 replay machine used by SSE. */
export function projectSessionHistory(
  rows: readonly SessionHistoryRow[],
  cursor: SessionHistoryResponse["cursor"],
): { transcript: TranscriptState; cursor: string } {
  const machine = new SessionStreamMachine({ visible: initialState })
  for (const row of rows) {
    machine.handle({
      kind: "event",
      seq: row.seq,
      cursor: { generation: cursor.generation, nextSeq: row.seq + 1 },
      event: row.event,
    })
  }
  const commit = machine.handle({ kind: "replay-end", cursor })
  if (commit.kind !== "commit") throw new Error("history projection did not commit")
  return { transcript: commit.visible, cursor: encodeSessionEventCursor(cursor) }
}

/** Merge disjoint/overlapping pages by sequence without reordering events. */
export function mergeSessionHistoryRows(
  older: readonly SessionHistoryRow[],
  newer: readonly SessionHistoryRow[],
): SessionHistoryRow[] {
  const rows = new Map<number, SessionHistoryRow>()
  for (const row of older) rows.set(row.seq, row)
  for (const row of newer) rows.set(row.seq, row)
  return [...rows.values()].sort((a, b) => a.seq - b.seq)
}

/** Append one monotonically increasing stream row in O(1). */
export function appendMonotonicHistoryRow(
  rows: SessionHistoryRow[],
  row: SessionHistoryRow,
  lastSeq: number,
): number {
  if (row.seq <= lastSeq) return lastSeq
  rows.push(row)
  return row.seq
}

/** Build an on-disk snapshot only from a committed durable projection/cursor. */
export function committedSessionSnapshot(
  transcript: TranscriptState | null,
  encodedCursor: string | null,
  olderPage: SessionSnapshot["olderPage"],
  savedAt = Date.now(),
): SessionSnapshot | null {
  if (!transcript || !encodedCursor) return null
  const cursor = decodeSessionEventCursor(encodedCursor)
  if (!cursor) return null
  return { version: 1, transcript, cursor, olderPage, savedAt }
}

/** Mutable cold-bootstrap coordinator kept outside React so attach generation
 * guards and one-at-a-time older paging are straightforward to test. */
export class SessionHistoryPager {
  private loading = false

  constructor(
    private rows: SessionHistoryRow[],
    private olderPage: Pick<SessionHistoryResponse, "before" | "hasMore">,
  ) {}

  async load(
    fetchPage: (before: string) => Promise<SessionHistoryResponse>,
    current: () => boolean,
    commit: (
      rows: SessionHistoryRow[],
      projection: TranscriptState,
      olderPage: Pick<SessionHistoryResponse, "before" | "hasMore">,
    ) => void,
  ): Promise<void> {
    if (this.loading || !this.olderPage.hasMore || !this.olderPage.before) return
    this.loading = true
    try {
      const page = await fetchPage(this.olderPage.before)
      if (!current()) return
      const rows = mergeSessionHistoryRows(page.events, this.rows)
      const projection = projectSessionHistory(rows, page.cursor).transcript
      const olderPage = { before: page.before, hasMore: page.hasMore }
      this.rows = rows
      this.olderPage = olderPage
      commit(rows, projection, olderPage)
    } finally {
      this.loading = false
    }
  }
}
