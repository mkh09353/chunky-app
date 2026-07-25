import { Plus, Trash2 } from "lucide-react"
import { useState } from "react"
import {
  deleteSeat,
  getSidekick,
  listAllModels,
  saveDefaultSeat,
  saveNamedSeat,
  validateSeatName,
} from "~/lib/configApi"
import type { ModelRow, SeatConfig, SidekickConfig } from "~/lib/configApi"
import { Button } from "../ui/button"
import { Switch } from "../ui/switch"
import {
  Badge,
  Card,
  EffortSelect,
  ErrorNote,
  InlineError,
  Loading,
  ModelSelect,
  SectionShell,
  Spinner,
  SubLabel,
  TextInput,
  useAsync,
} from "./common"

export function SidekickSection() {
  const sidekick = useAsync<SidekickConfig>(() => getSidekick(), [])
  const rows = useAsync<ModelRow[]>(() => listAllModels(), [])

  // Named seats need a provider+model before they can be persisted, so a newly
  // added seat lives locally until the user picks a model and saves it.
  const [pending, setPending] = useState<string[]>([])
  const [newName, setNewName] = useState("")
  const [nameError, setNameError] = useState<string | null>(null)

  const addPending = () => {
    const name = newName.trim().toLowerCase()
    const err = validateSeatName(name)
    const existing = sidekick.data?.seats ?? {}
    if (err) {
      setNameError(err)
      return
    }
    if (existing[name] || pending.includes(name)) {
      setNameError("A seat with that name already exists.")
      return
    }
    setPending((p) => [...p, name])
    setNewName("")
    setNameError(null)
  }

  const onSaved = (next: SidekickConfig, seatName?: string) => {
    sidekick.setData(next)
    if (seatName) setPending((p) => p.filter((n) => n !== seatName))
  }

  const namedSeats = Object.entries(sidekick.data?.seats ?? {})
  const pendingOnly = pending.filter((n) => !(sidekick.data?.seats ?? {})[n])

  return (
    <SectionShell
      title="Sidekick seats"
      description="Configure the worker agents the lead delegates to. The default seat inherits the executor when no model is set; named seats need their own model."
    >
      {sidekick.loading ? (
        <Loading rows={3} />
      ) : sidekick.error ? (
        <ErrorNote message={sidekick.error} onRetry={sidekick.reload} />
      ) : (
        <>
          <SeatCard
            title="Default seat"
            variant="default"
            config={sidekick.data?.default ?? {}}
            rows={rows.data ?? []}
            onSaved={(next) => onSaved(next)}
          />

          <div className="pt-1">
            <SubLabel>Named seats</SubLabel>
            {namedSeats.length === 0 && pendingOnly.length === 0 ? (
              <p className="pb-2 text-[12px] text-muted-foreground">
                No named seats yet. Add one below (e.g. "frontend", "backend").
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {namedSeats.map(([name, cfg]) => (
                  <SeatCard
                    key={name}
                    title={name}
                    variant="named"
                    config={cfg}
                    rows={rows.data ?? []}
                    onSaved={(next) => onSaved(next, name)}
                    onDeleted={(next) => onSaved(next, name)}
                  />
                ))}
                {pendingOnly.map((name) => (
                  <SeatCard
                    key={`pending:${name}`}
                    title={name}
                    variant="named"
                    isPending
                    config={{ enabled: true }}
                    rows={rows.data ?? []}
                    onSaved={(next) => onSaved(next, name)}
                    onDeleteLocal={() => setPending((p) => p.filter((n) => n !== name))}
                  />
                ))}
              </div>
            )}
          </div>

          <Card className="border-primary/25">
            <SubLabel>Add a named seat</SubLabel>
            <div className="flex items-center gap-2 pt-1">
              <TextInput
                value={newName}
                onChange={(v) => {
                  setNewName(v)
                  setNameError(null)
                }}
                placeholder="lowercase-slug"
                monospace
                onKeyDown={(e) => {
                  if (e.key === "Enter") addPending()
                }}
              />
              <Button size="sm" disabled={!newName.trim()} onClick={addPending}>
                <Plus className="size-3.5" />
                Add seat
              </Button>
            </div>
            {nameError && (
              <div className="pt-1.5">
                <InlineError>{nameError}</InlineError>
              </div>
            )}
          </Card>
        </>
      )}
    </SectionShell>
  )
}

function SeatCard({
  title,
  variant,
  config,
  rows,
  isPending = false,
  onSaved,
  onDeleted,
  onDeleteLocal,
}: {
  title: string
  variant: "default" | "named"
  config: SeatConfig
  rows: ModelRow[]
  isPending?: boolean
  onSaved: (cfg: SidekickConfig) => void
  onDeleted?: (cfg: SidekickConfig) => void
  onDeleteLocal?: () => void
}) {
  const [draft, setDraft] = useState<SeatConfig | null>(isPending ? { enabled: true } : null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const current = draft ?? config
  const dirty = draft !== null
  const patch = (p: Partial<SeatConfig>) => setDraft({ ...current, ...p })

  const modelKey = current.provider && current.model ? `${current.provider}/${current.model}` : ""

  const commit = async () => {
    if (variant === "named" && !modelKey) {
      setError("A named seat needs a provider + model.")
      return
    }
    setSaving(true)
    setError(null)
    try {
      const next =
        variant === "default"
          ? await saveDefaultSeat(current)
          : await saveNamedSeat(title, current)
      onSaved(next)
      setDraft(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (isPending) {
      onDeleteLocal?.()
      return
    }
    if (!window.confirm(`Delete the "${title}" seat? This can't be undone.`)) return
    setDeleting(true)
    setError(null)
    try {
      const next = await deleteSeat(title)
      onDeleted?.(next)
    } catch (err) {
      setError((err as Error).message)
      setDeleting(false)
    }
  }

  return (
    <Card>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-medium text-[13.5px]">{title}</span>
          {variant === "named" && <Badge tone={isPending ? "warning" : "muted"}>{isPending ? "unsaved" : "seat"}</Badge>}
        </div>
        {variant === "default" && (
          <div className="flex items-center gap-2">
            <span className="text-[11.5px] text-muted-foreground">Enabled</span>
            <Switch checked={current.enabled ?? false} onCheckedChange={(v) => patch({ enabled: v })} />
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 pt-3">
        <span className="text-[12px] text-muted-foreground">Model & effort</span>
        <div className="flex flex-wrap items-center gap-2">
          <ModelSelect
            rows={rows}
            value={modelKey}
            allowInherit={variant === "default"}
            inheritLabel="Inherit executor"
            disabled={variant === "default" && !current.enabled}
            onChange={(v) => {
              if (!v) {
                patch({ provider: null, model: null })
                return
              }
              const slash = v.indexOf("/")
              patch({ provider: v.slice(0, slash), model: v.slice(slash + 1) })
            }}
          />
          <EffortSelect
            value={current.effort ?? ""}
            allowInherit
            disabled={variant === "default" && !current.enabled}
            onChange={(v) => patch({ effort: v || null })}
          />
        </div>
      </div>

      {error && (
        <div className="pt-2">
          <InlineError>{error}</InlineError>
        </div>
      )}

      <div className="flex items-center justify-end gap-1.5 pt-3">
        {variant === "named" && (
          <Button
            variant="ghost"
            size="sm"
            disabled={deleting}
            onClick={() => void remove()}
            className="text-destructive hover:bg-destructive/10"
          >
            {deleting ? <Spinner /> : <Trash2 className="size-3.5" />}
            {isPending ? "Discard" : "Delete"}
          </Button>
        )}
        <Button size="sm" disabled={(!dirty && !isPending) || saving} onClick={() => void commit()}>
          {saving ? <Spinner /> : "Save"}
        </Button>
      </div>
    </Card>
  )
}
