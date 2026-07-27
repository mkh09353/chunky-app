import { Check, Play, Save, Trash2 } from "lucide-react"
import { useState } from "react"
import {
  applyMode,
  deleteMode,
  getModes,
  prettyModel,
  providerLabel,
  saveMode,
} from "~/lib/configApi"
import type { ModeAdvisor, ModeInfo, ModeSpec, ModesResponse } from "~/lib/configApi"
import { Button } from "../ui/button"
import {
  Badge,
  Card,
  EmptyNote,
  ErrorNote,
  InlineError,
  Loading,
  SectionShell,
  Spinner,
  SubLabel,
  TextInput,
  useAsync,
} from "./common"

/** "Sol (high)" — one agent slot of a mode. */
function agentLabel(agent: ModeAdvisor): string {
  return `${prettyModel(agent.model)}${agent.effort ? ` (${agent.effort})` : ""}`
}

/** The full trio: executor · sidekick (+ named seats) · advisor · reviewer.
 *  Mirrors the TUI's `/mode` summary — absent keys inherit, null means off. */
function specLabel(spec: ModeSpec): string {
  if (!spec.provider || !spec.model) return "—"
  const bits = [`${providerLabel(spec.provider)} · ${prettyModel(spec.model)}`]
  if (spec.effort) bits.push(`effort ${spec.effort}`)
  if (spec.speed) bits.push(spec.speed)
  if (spec.sidekick !== undefined) {
    bits.push(`sidekick ${spec.sidekick ? agentLabel(spec.sidekick) : "inherit"}`)
  }
  if (spec.sidekickSeats !== undefined) {
    const seats = spec.sidekickSeats
      ? Object.entries(spec.sidekickSeats).sort(([a], [b]) => a.localeCompare(b))
      : []
    if (seats.length > 0) {
      bits.push(`seats ${seats.map(([name, seat]) => `${name}=${agentLabel(seat)}`).join(", ")}`)
    } else if (spec.sidekickSeats === null) {
      bits.push("seats cleared")
    }
  }
  if (spec.advisor !== undefined) {
    bits.push(`advisor ${spec.advisor ? agentLabel(spec.advisor) : "off"}`)
  }
  if (spec.review !== undefined) {
    bits.push(`reviewer ${spec.review ? agentLabel(spec.review) : "off"}`)
  }
  return bits.join(" · ")
}

function sameAsCurrent(mode: ModeInfo, current: ModeSpec): boolean {
  return (
    mode.provider === current.provider &&
    mode.model === current.model &&
    (mode.effort ?? null) === (current.effort ?? null)
  )
}

export function ModesSection({ onApplied }: { onApplied?: () => void } = {}) {
  const modes = useAsync<ModesResponse>(() => getModes(), [])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [savingNew, setSavingNew] = useState(false)

  const apply = async (mode: string) => {
    setBusy(mode)
    setError(null)
    try {
      await applyMode(mode)
      modes.reload()
      // Applying swaps executor + advisor + sidekick server-side: let the app
      // re-read the model selection so the composer isn't stale.
      onApplied?.()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const remove = async (mode: string) => {
    if (!window.confirm(`Delete the "${mode}" mode? This can't be undone.`)) return
    setBusy(mode)
    setError(null)
    try {
      const next = await deleteMode(mode)
      modes.setData(next)
      onApplied?.()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const saveCurrent = async () => {
    const n = name.trim()
    if (!n) return
    setSavingNew(true)
    setError(null)
    try {
      const next = await saveMode({ name: n })
      modes.setData(next)
      setName("")
      onApplied?.()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSavingNew(false)
    }
  }

  return (
    <SectionShell
      title="Modes"
      description="Named executor + advisor + sidekick pairings you can switch between in one click."
    >
      {error && <ErrorNote message={error} />}

      {modes.loading ? (
        <Loading rows={3} />
      ) : modes.error ? (
        <ErrorNote message={modes.error} onRetry={modes.reload} />
      ) : (
        <>
          <Card>
            <SubLabel>Current pairing</SubLabel>
            <p className="pt-0.5 text-[13px]">{modes.data ? specLabel(modes.data.current) : "—"}</p>
          </Card>

          <div>
            <SubLabel>Saved modes</SubLabel>
            {!modes.data || modes.data.modes.length === 0 ? (
              <EmptyNote>No saved modes yet. Save the current pairing below.</EmptyNote>
            ) : (
              <div className="flex flex-col gap-2">
                {modes.data.modes.map((mode) => {
                  const active = sameAsCurrent(mode, modes.data!.current)
                  return (
                    <Card key={mode.name}>
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-medium text-[13.5px]">{mode.name}</span>
                            {active && (
                              <Badge tone="primary">
                                <Check className="size-2.5" />
                                Active
                              </Badge>
                            )}
                          </div>
                          <span className="truncate text-[12px] text-muted-foreground">
                            {specLabel(mode)}
                          </span>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Button
                            variant={active ? "outline" : "secondary"}
                            size="sm"
                            disabled={busy === mode.name || active}
                            onClick={() => void apply(mode.name)}
                          >
                            {busy === mode.name ? <Spinner /> : <Play className="size-3.5" />}
                            {active ? "Applied" : "Apply"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title="Delete mode"
                            disabled={busy === mode.name}
                            onClick={() => void remove(mode.name)}
                            className="text-destructive hover:bg-destructive/10"
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      </div>
                    </Card>
                  )
                })}
              </div>
            )}
          </div>

          <Card className="border-primary/25">
            <SubLabel>Save current pairing as a mode</SubLabel>
            <div className="flex items-center gap-2 pt-1">
              <TextInput
                value={name}
                onChange={setName}
                placeholder="mode name"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveCurrent()
                }}
              />
              <Button size="sm" disabled={savingNew || !name.trim()} onClick={() => void saveCurrent()}>
                {savingNew ? <Spinner /> : <Save className="size-3.5" />}
                Save
              </Button>
            </div>
            {error && (
              <div className="pt-1.5">
                <InlineError>{error}</InlineError>
              </div>
            )}
          </Card>
        </>
      )}
    </SectionShell>
  )
}
