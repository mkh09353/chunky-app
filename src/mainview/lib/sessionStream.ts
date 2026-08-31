// The cursor-aware (v2) session event stream state machine.
//
// WHY: the old protocol had no replay cursor, so every attach — including the
// reconnect after the app had merely been backgrounded — replayed the whole
// history from event zero, and the client had to *recognise its own past*
// (see replayReconciler.ts) to avoid duplicating it. The v2 stream fixes that
// at the source: every durable event carries a `seq` and a cursor, so a
// reconnect asks for the suffix it is missing.
//
// TWO PROJECTIONS, ALWAYS
//
//   visible — what is rendered. Durable state PLUS the live overlay (raw
//             `message.delta` tokens, tool.progress, ports.changed …) that the
//             server sends for responsiveness but has not persisted yet.
//   durable — a shadow reduced ONLY from `event` frames. It is the exact state
//             at `cursor`, which is what makes the cursor resumable: a
//             reconnect from `cursor` receives exactly the events that are NOT
//             in `durable`.
//
// THE INVARIANT: a reconnect attempt must never make the screen older.
//
// Replay is therefore reduced into a WORKING copy of the durable shadow and
// committed atomically at `replay-end`; if the stream dies first the working
// copy is thrown away and the previously committed durable/cursor (and the
// transcript on screen) survive untouched. At `replay-end` — and only there —
// `visible` becomes `durable`, which is safe precisely because durable now
// covers everything the visible overlay had (an un-persisted token overlay from
// before the disconnect is superseded by the coalesced persisted delta).
//
// DEDUP: in the live phase raw `message.delta` tokens arrive first as `live`
// frames, and the coalesced persisted delta (the same text, merged) arrives
// LATER as an `event` frame. Those `event` frames therefore update ONLY the
// durable shadow — the visible already rendered the tokens. Every other `event`
// frame updates both.
//
// Pure and server-free: drive it with synthetic frames.
// Run with: bun test src/mainview/lib/sessionStream.test.ts
import {
  encodeSessionEventCursor,
  type AgentEvent,
  type SessionEventStreamFrame,
} from "@chunky/protocol"
import { initialState, reduce, type TranscriptState } from "./transcript"

/** A frame off the wire: v2 frames, or a legacy AgentEvent from an old server. */
export type SessionStreamFrame = SessionEventStreamFrame | { kind: "legacy"; event: AgentEvent }

export type StreamPhase = "replay" | "live"

export type StreamStep =
  /**
   * The event belongs on screen. The machine has NOT reduced it yet: the caller
   * decides (some live-only events are *claimed* by the app — app.open_url,
   * app.request_api_key, mode.applied — and must never become transcript
   * items) and calls `reduceVisible` for the ones it keeps.
   */
  | { kind: "visible"; event: AgentEvent; phase: StreamPhase }
  /** Durable shadow only: replay history, or the coalesced delta the visible
   *  projection already rendered as raw tokens. Never touches the screen. */
  | { kind: "durable"; event: AgentEvent; phase: StreamPhase }
  /** Replay finished. Everything here is committed: swap the screen to it. */
  | { kind: "commit"; visible: TranscriptState; durable: TranscriptState; cursor: string }
  /** The server threw our cursor away; a full replay from zero follows. The
   *  screen keeps showing the old projection until the next `commit`. */
  | { kind: "reset"; reason: "history-rewritten" | "cursor-ahead" }
  /** An old server ignored `?stream=v2`: route this attempt through the legacy
   *  full-replay reconciler instead. */
  | { kind: "legacy"; event: AgentEvent }

export interface SessionStreamMachineInit {
  /** The projection already on screen; kept visible throughout replay. */
  visible?: TranscriptState
  /** Committed durable shadow, i.e. the exact state at `cursor`. */
  durable?: TranscriptState | null
  /** Committed cursor, encoded. Sent to the server to resume. */
  cursor?: string | null
}

/**
 * One connection attempt's worth of v2 stream state.
 *
 * Construct it from the COMMITTED state (cached durable + cursor) before each
 * connection; if the attempt dies before `replay-end`, throw the machine away
 * and build the next one from the same committed state. That discard is the
 * whole no-regression story.
 */
export class SessionStreamMachine {
  private visibleState: TranscriptState
  private durableState: TranscriptState
  private cursorValue: string | null
  private readonly requested: string | null
  private working: TranscriptState
  private workingCursor: string | null = null
  private streamPhase: StreamPhase = "replay"

  constructor(init: SessionStreamMachineInit = {}) {
    this.visibleState = init.visible ?? initialState
    // A cursor is only usable together with the durable state it describes.
    const resumable = init.cursor && init.durable ? init.cursor : null
    this.durableState = (resumable ? init.durable : null) ?? initialState
    this.cursorValue = resumable ?? null
    this.requested = resumable ?? null
    // Without a cursor the server replays from zero, so the working copy must
    // start from zero too.
    this.working = this.durableState
  }

  /** What is on screen right now. */
  get visible(): TranscriptState { return this.visibleState }

  /** The committed shadow — exact state at `cursor`. */
  get durable(): TranscriptState { return this.durableState }

  /** The committed cursor, or null when nothing is committed yet. */
  get cursor(): string | null { return this.cursorValue }

  /** The cursor this attempt asked the server to resume from. */
  get requestCursor(): string | null { return this.requested }

  get phase(): StreamPhase { return this.streamPhase }

  /** True once `replay-end` has been seen on this connection. */
  get replayComplete(): boolean { return this.streamPhase === "live" }

  /** Reduce a visible event into the rendered projection. */
  reduceVisible(event: AgentEvent): TranscriptState {
    this.visibleState = reduce(this.visibleState, event)
    return this.visibleState
  }

  /** Adopt an externally-produced visible projection (e.g. a coalescer's). */
  setVisible(state: TranscriptState): void {
    this.visibleState = state
  }

  /** Rebase the committed projection after older HTTP history is prepended.
   * The stream cursor is unchanged: the added rows precede it. */
  rebaseCommitted(state: TranscriptState): void {
    this.visibleState = state
    this.durableState = state
    this.working = state
  }

  handle(frame: SessionStreamFrame): StreamStep {
    if (frame.kind === "legacy") return { kind: "legacy", event: frame.event }
    if (frame.kind === "replay-reset") {
      // Discard shadow state: a full replay from zero follows. The COMMITTED
      // durable/cursor stay put — if this attempt dies mid-rebuild the next one
      // still resumes from them (and gets reset again).
      this.working = initialState
      this.workingCursor = null
      this.streamPhase = "replay"
      return { kind: "reset", reason: frame.reason }
    }
    if (frame.kind === "replay-end") {
      this.durableState = this.working
      this.cursorValue = encodeSessionEventCursor(frame.cursor)
      // Durable now covers everything the visible overlay had.
      this.visibleState = this.durableState
      this.streamPhase = "live"
      return { kind: "commit", visible: this.visibleState, durable: this.durableState, cursor: this.cursorValue }
    }
    if (frame.kind === "live") {
      return { kind: "visible", event: frame.event, phase: this.streamPhase }
    }
    // kind === "event": a durable, persisted event.
    if (this.streamPhase === "replay") {
      this.working = reduce(this.working, frame.event)
      this.workingCursor = encodeSessionEventCursor(frame.cursor)
      return { kind: "durable", event: frame.event, phase: "replay" }
    }
    this.durableState = reduce(this.durableState, frame.event)
    this.cursorValue = encodeSessionEventCursor(frame.cursor)
    // The visible projection already rendered these tokens as `live` frames.
    if (frame.event.type === "message.delta") {
      return { kind: "durable", event: frame.event, phase: "live" }
    }
    return { kind: "visible", event: frame.event, phase: "live" }
  }

  /** The uncommitted replay position, for diagnostics/tests. */
  get workingCursorValue(): string | null { return this.workingCursor }
}

/**
 * True when a reconnect cache is v2-shaped (cursor and/or durable shadow).
 * That cache has no persisted event prefix for ReplayReconciler, so a from-zero
 * legacy replay must drop the resume point and rebuild rather than append onto
 * the already-visible transcript (which would duplicate every item).
 */
export function v2CacheNeedsLegacyRebuild(
  cache: { cursor?: string | null; durable?: TranscriptState | null } | null | undefined,
): boolean {
  return cache != null && !!(cache.cursor || cache.durable)
}
