import { RotateCcw, Save } from "lucide-react"
import { useMemo, useState } from "react"
import {
  deleteWorkflowTarget,
  getWorkflowTargets,
  prettyModel,
  providerLabel,
  putWorkflowTarget,
} from "~/lib/configApi"
import type { BadgeTone } from "./common"
import type { WorkflowBilling, WorkflowTarget } from "~/lib/configApi"
import { Button } from "../ui/button"
import { Switch } from "../ui/switch"
import {
  Badge,
  Card,
  EffortSelect,
  EmptyNote,
  ErrorNote,
  InlineError,
  Loading,
  SectionShell,
  Spinner,
  SubLabel,
  TextInput,
  asEffort,
  useAsync,
} from "./common"

const BILLING_TONE: Record<WorkflowBilling, BadgeTone> = {
  free: "success",
  subscription: "primary",
  metered: "warning",
  unknown: "muted",
}

export function WorkflowSection() {
  const targets = useAsync<WorkflowTarget[]>(() => getWorkflowTargets(), [])

  const groups = useMemo(() => {
    const map = new Map<string, WorkflowTarget[]>()
    for (const t of targets.data ?? []) {
      const list = map.get(t.provider) ?? []
      list.push(t)
      map.set(t.provider, list)
    }
    return [...map.entries()]
  }, [targets.data])

  return (
    <SectionShell
      title="Workflow routing"
      description="Which provider/model each parallel workflow sub-agent uses. Toggle a model into automatic routing, tag it (frontend, research…), and override its effort."
    >
      {targets.loading ? (
        <Loading rows={4} />
      ) : targets.error ? (
        <ErrorNote message={targets.error} onRetry={targets.reload} />
      ) : groups.length === 0 ? (
        <EmptyNote>
          No workflow targets. Log in to a provider so its models become routable.
        </EmptyNote>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map(([provider, list]) => (
            <div key={provider}>
              <SubLabel>{providerLabel(provider)}</SubLabel>
              <div className="flex flex-col gap-2">
                {list.map((t) => (
                  <TargetRow key={`${t.provider}/${t.model}`} target={t} onChanged={targets.reload} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionShell>
  )
}

function TargetRow({ target, onChanged }: { target: WorkflowTarget; onChanged: () => void }) {
  const [automatic, setAutomatic] = useState(target.automatic)
  const [tags, setTags] = useState(target.tags.join(", "))
  const [effort, setEffort] = useState(target.effort)
  const [busy, setBusy] = useState<"save" | "reset" | null>(null)
  const [error, setError] = useState<string | null>(null)

  const dirty =
    automatic !== target.automatic ||
    tags !== target.tags.join(", ") ||
    effort !== target.effort

  const save = async () => {
    setBusy("save")
    setError(null)
    try {
      const parsedTags = tags
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
      await putWorkflowTarget({
        provider: target.provider,
        model: target.model,
        tags: parsedTags,
        automatic,
        ...(asEffort(effort) ? { effort: asEffort(effort) } : {}),
      })
      onChanged()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const reset = async () => {
    setBusy("reset")
    setError(null)
    try {
      await deleteWorkflowTarget(target.provider, target.model)
      onChanged()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-[13px]">
              {target.name || prettyModel(target.model)}
            </span>
            <Badge tone={BILLING_TONE[target.billing]}>{target.billing}</Badge>
          </div>
          <span className="truncate font-mono text-[10.5px] text-muted-foreground">{target.model}</span>
        </div>
        <label className="flex items-center gap-2">
          <span className="text-[11.5px] text-muted-foreground">Automatic</span>
          <Switch checked={automatic} onCheckedChange={setAutomatic} />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-3">
        <TextInput
          value={tags}
          onChange={setTags}
          placeholder="tags, comma separated"
          className="max-w-[16rem]"
        />
        <EffortSelect value={effort} onChange={setEffort} />
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            title="Clear override"
            disabled={busy !== null}
            onClick={() => void reset()}
          >
            {busy === "reset" ? <Spinner /> : <RotateCcw className="size-3.5" />}
            Reset
          </Button>
          <Button size="sm" disabled={!dirty || busy !== null} onClick={() => void save()}>
            {busy === "save" ? <Spinner /> : <Save className="size-3.5" />}
            Save
          </Button>
        </div>
      </div>

      {error && (
        <div className="pt-2">
          <InlineError>{error}</InlineError>
        </div>
      )}
    </Card>
  )
}
