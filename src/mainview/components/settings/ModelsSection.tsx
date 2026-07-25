import { Check, Plus } from "lucide-react"
import { useCallback, useMemo, useState } from "react"
import {
  getActiveModel,
  getModelAvailability,
  listAllModels,
  listProviders,
  manageCatalog,
  prettyModel,
  providerLabel,
  selectModel,
  setModelAvailability,
  splitModelKey,
} from "~/lib/configApi"
import type {
  CatalogModel,
  ModelAvailability,
  ModelRow,
  ModelSelection,
  ProviderInfo,
} from "~/lib/configApi"
import { cn } from "~/lib/cn"
import { Button } from "../ui/button"
import {
  Badge,
  Card,
  EffortSelect,
  EmptyNote,
  ErrorNote,
  InlineError,
  Loading,
  ModelSelect,
  SectionShell,
  Select,
  Spinner,
  SpeedSelect,
  SubLabel,
  TextInput,
  asEffort,
  asSpeed,
  useAsync,
} from "./common"

export function ModelsSection() {
  const rows = useAsync<ModelRow[]>(() => listAllModels(), [])
  const active = useAsync<ModelSelection | null>(() => getActiveModel(), [])
  const providers = useAsync<ProviderInfo[]>(() => listProviders(), [])

  return (
    <SectionShell
      title="Models"
      description="Pick the active model, tune effort and speed, and manage each provider's catalog."
    >
      <ActiveModelCard rows={rows.data ?? []} active={active} />

      <div className="pt-1">
        <SubLabel>Catalog & availability</SubLabel>
        {providers.loading ? (
          <Loading rows={2} />
        ) : providers.error ? (
          <ErrorNote message={providers.error} onRetry={providers.reload} />
        ) : (
          <CatalogManager providers={providers.data ?? []} onCatalogChange={rows.reload} />
        )}
      </div>
    </SectionShell>
  )
}

function ActiveModelCard({
  rows,
  active,
}: {
  rows: ModelRow[]
  active: ReturnType<typeof useAsync<ModelSelection | null>>
}) {
  const [effort, setEffort] = useState("")
  const [speed, setSpeed] = useState("")
  const [model, setModel] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)

  const serverModel = active.data?.model ? `${active.data.provider}/${active.data.model}` : ""
  const serverEffort = active.data?.effort ?? ""
  const serverSpeed = active.data?.speed ?? ""

  const currentModel = dirty ? model : serverModel
  const currentEffort = dirty ? effort : serverEffort
  const currentSpeed = dirty ? speed : serverSpeed

  const touch = () => {
    if (!dirty) {
      setModel(serverModel)
      setEffort(serverEffort)
      setSpeed(serverSpeed)
      setDirty(true)
    }
  }

  const apply = async () => {
    const parts = splitModelKey(currentModel)
    if (!parts) {
      setError("Choose a model first.")
      return
    }
    setSaving(true)
    setError(null)
    try {
      const next = await selectModel({
        provider: parts.provider,
        model: parts.model,
        effort: asEffort(currentEffort),
        speed: asSpeed(currentSpeed),
      })
      active.setData(next)
      setDirty(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <SubLabel>Active model</SubLabel>
      {active.loading ? (
        <Loading rows={1} />
      ) : active.error ? (
        <ErrorNote message={active.error} onRetry={active.reload} />
      ) : (
        <div className="flex flex-col gap-3 pt-1">
          <div className="flex flex-wrap items-center gap-2">
            <ModelSelect
              rows={rows}
              value={currentModel}
              onChange={(v) => {
                touch()
                setModel(v)
              }}
            />
            <EffortSelect
              value={currentEffort}
              allowInherit
              onChange={(v) => {
                touch()
                setEffort(v)
              }}
            />
            <SpeedSelect
              value={currentSpeed}
              allowInherit
              onChange={(v) => {
                touch()
                setSpeed(v)
              }}
            />
            <Button size="sm" disabled={saving || !dirty} onClick={() => void apply()}>
              {saving ? <Spinner /> : "Apply"}
            </Button>
          </div>
          {error && <InlineError>{error}</InlineError>}
        </div>
      )}
    </Card>
  )
}

function CatalogManager({
  providers,
  onCatalogChange,
}: {
  providers: ProviderInfo[]
  onCatalogChange: () => void
}) {
  const [providerId, setProviderId] = useState(providers[0]?.id ?? "")

  if (providers.length === 0) return <EmptyNote>No providers available.</EmptyNote>

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-[12px] text-muted-foreground">Provider</span>
        <Select value={providerId} onChange={setProviderId} className="max-w-[14rem]">
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </Select>
      </div>
      {providerId && (
        <ProviderCatalog key={providerId} providerId={providerId} onCatalogChange={onCatalogChange} />
      )}
    </div>
  )
}

function ProviderCatalog({
  providerId,
  onCatalogChange,
}: {
  providerId: string
  onCatalogChange: () => void
}) {
  // One call returns BOTH the full known catalog and the checked (visible) ids.
  const availability = useAsync<ModelAvailability>(() => getModelAvailability(providerId), [providerId])
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newId, setNewId] = useState("")
  const [adding, setAdding] = useState(false)

  const models: CatalogModel[] = availability.data?.models ?? []
  const availableSet = useMemo(
    () => new Set(availability.data?.available ?? []),
    [availability.data],
  )

  const toggle = useCallback(
    async (id: string, on: boolean) => {
      setError(null)
      setPending(id)
      const current = availability.data?.available ?? []
      const next = on ? [...new Set([...current, id])] : current.filter((x) => x !== id)
      availability.setData((prev) => (prev ? { ...prev, available: next } : prev))
      try {
        await setModelAvailability(providerId, next)
        onCatalogChange()
      } catch (err) {
        setError((err as Error).message)
        availability.reload()
      } finally {
        setPending(null)
      }
    },
    [availability, onCatalogChange, providerId],
  )

  const addModel = async () => {
    const id = newId.trim()
    if (!id) return
    setAdding(true)
    setError(null)
    try {
      await manageCatalog(providerId, { action: "add", model: id })
      setNewId("")
      availability.reload()
      onCatalogChange()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setAdding(false)
    }
  }

  if (availability.loading) return <Loading rows={3} />
  if (availability.error) return <ErrorNote message={availability.error} onRetry={availability.reload} />

  return (
    <div className="flex flex-col gap-2">
      {error && <InlineError>{error}</InlineError>}
      {models.length === 0 ? (
        <EmptyNote>No models in this provider's catalog yet.</EmptyNote>
      ) : (
        <div className="flex max-h-72 flex-col divide-y divide-border/60 overflow-y-auto rounded-xl border border-border">
          {models.map((m) => {
            const available = availableSet.has(m.id)
            return (
              <label
                key={m.id}
                className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-accent/30"
              >
                <Checkbox
                  checked={available}
                  disabled={pending === m.id}
                  onChange={(v) => void toggle(m.id, v)}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium text-[13px]">
                    {m.name || prettyModel(m.id)}
                  </span>
                  <span className="truncate font-mono text-[10.5px] text-muted-foreground">
                    {m.id}
                  </span>
                </span>
                <div className="flex shrink-0 items-center gap-1.5">
                  {m.reasoning && <Badge tone="muted">reasoning</Badge>}
                  {m.contextLimit ? (
                    <Badge tone="muted">{Math.round(m.contextLimit / 1000)}k</Badge>
                  ) : null}
                  {m.custom && <Badge tone="primary">custom</Badge>}
                  {pending === m.id && <Spinner />}
                </div>
              </label>
            )
          })}
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">
        Checked models appear in the picker; unchecking hides them from {providerLabel(providerId)}.
      </p>

      <div className="flex items-center gap-2 pt-1">
        <TextInput
          value={newId}
          onChange={setNewId}
          placeholder={`Add model id to ${providerLabel(providerId)} catalog…`}
          monospace
          onKeyDown={(e) => {
            if (e.key === "Enter") void addModel()
          }}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={adding || !newId.trim()}
          onClick={() => void addModel()}
        >
          {adding ? <Spinner /> : <Plus className="size-3.5" />}
          Add
        </Button>
      </div>
    </div>
  )
}

function Checkbox({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
        checked ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background",
        disabled && "opacity-50",
      )}
    >
      {checked && <Check className="size-3" />}
    </button>
  )
}
