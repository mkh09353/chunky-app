// The per-mode flyout hanging off the composer's Modes list: view and re-point
// every model a saved mode pins — executor, advisor, reviewer, the default
// sidekick seat, and each named seat — without leaving the composer.
//
// Editing writes the WHOLE mode back (POST /api/modes replaces the stored spec),
// so every pick goes through lib/modeSlots.specWithSlot, which starts from the
// original ModeInfo and changes exactly one key. The actual save/re-apply lives
// in App (onSave), which owns mode state and its refreshes.
import { Check, ChevronRight, Cpu, Loader2, SlidersHorizontal } from "lucide-react"
import { useMemo, useState } from "react"
import type { ModeAdvisor, ModeInfo, ModeSpec } from "@chunky/protocol"
import { providerLabel, splitModelKey } from "~/lib/api"
import { cn } from "~/lib/cn"
import type { Model } from "~/lib/mock"
import { modeEmoji } from "~/lib/modes"
import { modeSlots, slotValueLabel, specWithSlot, type ModeSlot, type ModeSlotId } from "~/lib/modeSlots"
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "./ui/dropdown-menu"

/** Same provider ordering as the composer's model picker. */
const PROVIDER_ORDER = ["zen", "grok", "codex", "anthropic"]
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const

function providerSortKey(vendor: string): string {
  const i = PROVIDER_ORDER.indexOf(vendor.toLowerCase())
  return i >= 0 ? `${i}-${vendor}` : `9-${vendor}`
}

/** The catalog row's UI id is `provider/modelId`; demo rows have no slash. */
function parseModel(m: Model): { provider: string; model: string } {
  return splitModelKey(m.id) ?? { provider: m.vendor, model: m.id }
}

type Step = "slots" | "model" | "effort"

export function ModeSlotsMenu({
  mode,
  models,
  disabled,
  onSave,
  onDone,
}: {
  /** The FULL saved spec — the edit is built by spreading this object. */
  mode: ModeInfo
  /** The composer's catalog rows (id = `provider/modelId`). */
  models: Model[]
  disabled?: boolean
  /** Persist the edited spec. Rejecting shows the reason inline. */
  onSave: (name: string, spec: ModeSpec) => Promise<void>
  /** Called after a successful save so the caller can close the whole menu. */
  onDone?: () => void
}) {
  const [step, setStep] = useState<Step>("slots")
  const [slotId, setSlotId] = useState<ModeSlotId | null>(null)
  const [pending, setPending] = useState<{ provider: string; model: string; name: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const slots = useMemo(() => modeSlots(mode), [mode])
  const slot = slots.find((s) => s.id === slotId) ?? null

  // Only models whose provider is logged in can be pinned into a mode — the
  // server would resolve the rest to nothing on apply.
  const groups = useMemo(() => {
    const map = new Map<string, Model[]>()
    for (const m of models) {
      if (m.ready === false) continue
      const key = m.vendor || "other"
      const list = map.get(key) ?? []
      list.push(m)
      map.set(key, list)
    }
    return [...map.entries()].sort(([a], [b]) => providerSortKey(a).localeCompare(providerSortKey(b)))
  }, [models])

  const reset = () => {
    setStep("slots")
    setSlotId(null)
    setPending(null)
    setError(null)
  }

  const commit = async (value: ModeAdvisor | null | undefined) => {
    if (!slotId || saving) return
    setSaving(true)
    setError(null)
    try {
      await onSave(mode.name, specWithSlot(mode, slotId, value))
      reset()
      onDone?.()
    } catch (err) {
      setError((err as Error).message || "Couldn't save the mode")
      setStep("slots")
    } finally {
      setSaving(false)
    }
  }

  const openSlot = (s: ModeSlot) => {
    setSlotId(s.id)
    setPending(null)
    setError(null)
    setStep("model")
  }

  const chooseModel = (m: Model) => {
    const { provider, model } = parseModel(m)
    if (m.reasoning) {
      setPending({ provider, model, name: m.name })
      setStep("effort")
      return
    }
    void commit({ provider, model })
  }

  const currentKey = slot?.value ? `${slot.value.provider}/${slot.value.model}` : ""
  // "Inherit" is the live state when the slot holds no pairing AND the mode
  // spells inheritance the way that slot spells it: absent for the reviewer,
  // an explicit null for the sidekick seat.
  const inheritSelected =
    slot != null &&
    !slot.value &&
    (slot.id === "review" ? mode.review !== null : slot.id === "sidekick" ? mode.sidekick === null : false)

  const heading =
    step === "slots"
      ? "Models in this mode"
      : step === "model"
        ? `${slot?.label ?? "Slot"} · pick a model`
        : `${pending?.name ?? "Model"} · effort`

  return (
    <DropdownMenuSub
      onOpenChange={(open) => {
        if (!open) reset()
      }}
    >
      <DropdownMenuSubTrigger
        disabled={disabled}
        aria-label={`Edit the models in the ${mode.name} mode`}
        className="shrink-0 gap-1 px-1.5 text-muted-foreground"
      >
        <SlidersHorizontal className="size-3.5" />
      </DropdownMenuSubTrigger>

      <DropdownMenuSubContent className="flex max-h-80 min-w-64 flex-col overflow-hidden p-0">
        <div className="flex items-center justify-between gap-2 border-border/70 border-b px-2.5 py-1.5">
          <DropdownMenuLabel className="min-w-0 truncate p-0">
            <span className="pr-1 text-[12px] leading-none">{modeEmoji(mode.name)}</span>
            {mode.name} · {heading}
          </DropdownMenuLabel>
          {saving && <Loader2 className="size-3 shrink-0 animate-spin text-primary" />}
        </div>

        <div className="overflow-y-auto p-1">
          {step === "slots" ? (
            slots.map((s, i) => (
              <div key={s.id}>
                {/* Named seats get their own header, once. */}
                {s.seat && !slots[i - 1]?.seat && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>Named seats</DropdownMenuLabel>
                  </>
                )}
                <DropdownMenuItem
                  disabled={saving}
                  closeOnClick={false}
                  onClick={() => openSlot(s)}
                  className="min-w-0"
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className={cn("truncate font-medium text-[13px] text-foreground", s.seat && "font-mono text-[12.5px]")}>
                      {s.label}
                    </span>
                    <span className="truncate text-[11px] text-muted-foreground">{slotValueLabel(s)}</span>
                  </div>
                  <ChevronRight className="size-3.5 shrink-0 opacity-50" />
                </DropdownMenuItem>
              </div>
            ))
          ) : step === "model" ? (
            <>
              <DropdownMenuItem disabled={saving} closeOnClick={false} onClick={() => setStep("slots")}>
                <ChevronRight className="size-3.5 rotate-180" />
                Back
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {slot?.offersInherit && (
                <DropdownMenuItem
                  disabled={saving}
                  closeOnClick={false}
                  // The reviewer inherits by being ABSENT; the sidekick seat
                  // inherits by being an explicit null (see the wire contract).
                  onClick={() => void commit(slot.id === "review" ? undefined : null)}
                  className={cn(inheritSelected && "bg-accent/60")}
                >
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {inheritSelected && <Check className="size-3.5 text-primary" />}
                  </span>
                  <span className="text-[13px]">
                    {slot.id === "review" ? "Inherit the global reviewer" : "Inherit the executor"}
                  </span>
                </DropdownMenuItem>
              )}
              {slot?.offersOff && (
                <DropdownMenuItem
                  disabled={saving}
                  closeOnClick={false}
                  onClick={() => void commit(null)}
                  className={cn(slot.value === null && "bg-accent/60")}
                >
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {slot.value === null && <Check className="size-3.5 text-primary" />}
                  </span>
                  <span className="text-[13px]">Off</span>
                </DropdownMenuItem>
              )}
              {(slot?.offersInherit || slot?.offersOff) && <DropdownMenuSeparator />}
              {groups.length === 0 ? (
                <DropdownMenuItem disabled>No models available</DropdownMenuItem>
              ) : (
                groups.map(([vendor, rows], gi) => (
                  <div key={vendor}>
                    {gi > 0 && <DropdownMenuSeparator />}
                    <DropdownMenuLabel>{providerLabel(vendor)}</DropdownMenuLabel>
                    {rows.map((m) => {
                      const { provider, model } = parseModel(m)
                      const selected = `${provider}/${model}` === currentKey
                      return (
                        <DropdownMenuItem
                          key={m.id}
                          disabled={saving}
                          closeOnClick={false}
                          onClick={() => chooseModel(m)}
                          className={cn("min-w-0", selected && "bg-accent/60")}
                        >
                          <span className="flex size-4 shrink-0 items-center justify-center">
                            {selected ? <Check className="size-3.5 text-primary" /> : <Cpu className="size-3.5 opacity-50" />}
                          </span>
                          <div className="flex min-w-0 flex-col">
                            <span className="truncate font-medium text-[13px] text-foreground">{m.name}</span>
                            <span className="truncate text-[11px] text-muted-foreground">
                              {providerLabel(provider)}
                              {m.reasoning ? " · reasoning" : ""}
                            </span>
                          </div>
                        </DropdownMenuItem>
                      )
                    })}
                  </div>
                ))
              )}
            </>
          ) : (
            <>
              <DropdownMenuItem disabled={saving} closeOnClick={false} onClick={() => setStep("model")}>
                <ChevronRight className="size-3.5 rotate-180" />
                Back
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={saving}
                closeOnClick={false}
                onClick={() => pending && void commit({ provider: pending.provider, model: pending.model })}
              >
                <span className="flex size-4 shrink-0 items-center justify-center" />
                <span className="text-[13px]">Default effort</span>
              </DropdownMenuItem>
              {EFFORTS.map((effort) => {
                const selected =
                  slot?.value?.effort === effort &&
                  slot.value.provider === pending?.provider &&
                  slot.value.model === pending?.model
                return (
                  <DropdownMenuItem
                    key={effort}
                    disabled={saving}
                    closeOnClick={false}
                    onClick={() =>
                      pending && void commit({ provider: pending.provider, model: pending.model, effort })
                    }
                    className={cn(selected && "bg-accent/60")}
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center">
                      {selected && <Check className="size-3.5 text-primary" />}
                    </span>
                    <span className="font-medium text-[13px] capitalize text-foreground">{effort}</span>
                  </DropdownMenuItem>
                )
              })}
            </>
          )}
        </div>

        {error && (
          <div className="border-destructive/25 border-t bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
            {error}
          </div>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
