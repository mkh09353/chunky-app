// Editing ONE slot of a saved mode.
//
// A mode is stored (and saved) as a whole object: POST /api/modes replaces the
// stored spec wholesale (../chunky settings.ts saveMode -> `{ ...modes, [name]:
// spec }`). So an editor must never build a spec from scratch — the server also
// stores fields the protocol's ModeSpec doesn't declare (notably `incognito`,
// see lib/incognitoModes.ts), and anything left out is silently dropped.
// Everything here therefore starts from the ORIGINAL ModeInfo and changes one
// key, preserving the wire contract's three-way distinction:
//
//   absent (undefined) = "leave this alone"   null = off / inherit   value = set
import type { ModeAdvisor, ModeInfo, ModeSpec } from "@chunky/protocol"
import { prettyModel } from "./api"

/** Which slot of a mode is being edited. Named seats carry their own key. */
export type ModeSlotId = "executor" | "advisor" | "review" | "sidekick" | `seat:${string}`

export interface ModeSlot {
  id: ModeSlotId
  /** Row label: "Executor", "Advisor", or the seat's own name. */
  label: string
  /** The pairing this slot currently holds. */
  value: ModeAdvisor | null | undefined
  /** What the row reads when `value` is null/undefined. */
  emptyLabel: string
  /** Whether the picker offers "Inherit" (null) / "Off" (null) for this slot. */
  offersInherit: boolean
  offersOff: boolean
  /** Named seats are shown in their own group under the fixed trio. */
  seat: boolean
}

/** "Sol (high)" — one agent slot, worded exactly like Settings → Modes. */
export function agentLabel(agent: ModeAdvisor): string {
  return `${prettyModel(agent.model)}${agent.effort ? ` (${agent.effort})` : ""}`
}

/** The label for a slot's current state (its model, or why it has none). */
export function slotValueLabel(slot: ModeSlot): string {
  return slot.value ? agentLabel(slot.value) : slot.emptyLabel
}

/**
 * Every editable slot of a mode, in menu order: the executor, the fixed trio,
 * then the named seats sorted by name.
 *
 * The empty labels spell out what the wire contract actually does on apply:
 * an absent advisor still applies as "off", an absent reviewer inherits the
 * global one, and an absent sidekick leaves the live seat untouched.
 */
export function modeSlots(mode: ModeInfo): ModeSlot[] {
  const slots: ModeSlot[] = [
    {
      id: "executor",
      label: "Executor",
      // The executor lives on the spec root, not in a nested object.
      value: mode.model ? { provider: mode.provider, model: mode.model, ...(mode.effort ? { effort: mode.effort } : {}) } : null,
      emptyLabel: "not set",
      offersInherit: false,
      offersOff: false,
      seat: false,
    },
    {
      id: "advisor",
      label: "Advisor",
      value: mode.advisor,
      emptyLabel: mode.advisor === null ? "off" : "not set (off)",
      offersInherit: false,
      offersOff: true,
      seat: false,
    },
    {
      id: "review",
      label: "Reviewer",
      value: mode.review,
      emptyLabel: mode.review === null ? "off" : "inherits the global reviewer",
      offersInherit: true,
      offersOff: true,
      seat: false,
    },
    {
      id: "sidekick",
      label: "Sidekick",
      value: mode.sidekick,
      emptyLabel: mode.sidekick === null ? "inherits the executor" : "not set (seat left alone)",
      offersInherit: true,
      offersOff: false,
      seat: false,
    },
  ]
  const seats = mode.sidekickSeats ?? {}
  for (const [name, seat] of Object.entries(seats).sort(([a], [b]) => a.localeCompare(b))) {
    slots.push({
      id: `seat:${name}`,
      label: name,
      value: seat,
      emptyLabel: "not set",
      offersInherit: false,
      offersOff: false,
      seat: true,
    })
  }
  return slots
}

/** The seat name behind a `seat:<name>` slot id, or null for the fixed slots. */
export function seatNameOf(id: ModeSlotId): string | null {
  return id.startsWith("seat:") ? id.slice("seat:".length) : null
}

/**
 * The mode's spec with ONE slot replaced — the whole original object minus its
 * `name`, so `incognito` and any field this app doesn't model round-trip
 * untouched.
 *
 * `undefined` removes the key (back to "leave this alone"), `null` writes an
 * explicit off/inherit, and a pairing sets it. The executor is the exception:
 * it can't be cleared, so a null/undefined value is a no-op there. Executor
 * `speed` is deliberately left as-is — seats have no speed on the wire, and
 * this editor only moves models + effort.
 */
export function specWithSlot(
  mode: ModeInfo,
  slot: ModeSlotId,
  value: ModeAdvisor | null | undefined,
): ModeSpec {
  const { name: _name, ...rest } = mode
  const next: ModeSpec = { ...rest }

  if (slot === "executor") {
    if (!value) return next
    next.provider = value.provider
    next.model = value.model
    if (value.effort) next.effort = value.effort
    else delete next.effort
    return next
  }

  if (slot === "advisor" || slot === "review" || slot === "sidekick") {
    if (value === undefined) delete next[slot]
    else next[slot] = value
    return next
  }

  const seat = seatNameOf(slot)
  if (seat === null) return next
  const seats: Record<string, ModeAdvisor> = { ...(mode.sidekickSeats ?? {}) }
  if (value) seats[seat] = value
  else delete seats[seat]
  next.sidekickSeats = seats
  return next
}
