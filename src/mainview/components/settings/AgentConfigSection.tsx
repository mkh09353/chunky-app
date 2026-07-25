// Shared UI for the Advisor and Reviewer settings — both are an enable toggle
// plus a provider/model/effort picker over the same wire shape.
import { useState } from "react"
import {
  getAdvisor,
  getReviewer,
  listAllModels,
  setAdvisor,
  setReviewer,
} from "~/lib/configApi"
import type { AgentModelConfig, ModelRow } from "~/lib/configApi"
import { Button } from "../ui/button"
import { Switch } from "../ui/switch"
import {
  Card,
  EffortSelect,
  ErrorNote,
  FieldRow,
  InlineError,
  Loading,
  ModelSelect,
  SectionShell,
  Spinner,
  useAsync,
} from "./common"

function AgentConfigSection({
  title,
  description,
  noun,
  load,
  save,
}: {
  title: string
  description: string
  noun: string
  load: () => Promise<AgentModelConfig>
  save: (cfg: AgentModelConfig) => Promise<AgentModelConfig>
}) {
  const cfg = useAsync<AgentModelConfig>(load, [])
  const rows = useAsync<ModelRow[]>(() => listAllModels(), [])

  const [draft, setDraft] = useState<AgentModelConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const current = draft ?? cfg.data ?? { enabled: false }
  const dirty = draft !== null

  const patch = (p: Partial<AgentModelConfig>) => {
    setDraft({ ...current, ...p })
  }

  const modelKey = current.provider && current.model ? `${current.provider}/${current.model}` : ""

  const commit = async () => {
    setSaving(true)
    setError(null)
    try {
      const next = await save(current)
      cfg.setData(next)
      setDraft(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <SectionShell title={title} description={description}>
      {cfg.loading ? (
        <Loading rows={2} />
      ) : cfg.error ? (
        <ErrorNote message={cfg.error} onRetry={cfg.reload} />
      ) : (
        <Card>
          <FieldRow title={`Enable ${noun}`} description={`Turn the ${noun} on or off.`}>
            <Switch checked={current.enabled} onCheckedChange={(v) => patch({ enabled: v })} />
          </FieldRow>

          <div className="border-border/60 border-t pt-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="font-medium text-[13px]">Model</span>
              <div className="flex flex-wrap items-center gap-2">
                <ModelSelect
                  rows={rows.data ?? []}
                  value={modelKey}
                  allowInherit
                  inheritLabel="Inherit executor"
                  disabled={!current.enabled}
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
                  disabled={!current.enabled}
                  onChange={(v) => patch({ effort: v || null })}
                />
              </div>
            </div>
            {rows.error && (
              <div className="pt-2">
                <InlineError>Couldn't load model catalog: {rows.error}</InlineError>
              </div>
            )}
          </div>

          {error && (
            <div className="pt-2">
              <InlineError>{error}</InlineError>
            </div>
          )}

          <div className="flex justify-end pt-3">
            <Button size="sm" disabled={!dirty || saving} onClick={() => void commit()}>
              {saving ? <Spinner /> : "Save"}
            </Button>
          </div>
        </Card>
      )}
    </SectionShell>
  )
}

export function AdvisorSection() {
  return (
    <AgentConfigSection
      title="Advisor"
      description="A second model the lead can consult for a second opinion during a session."
      noun="advisor"
      load={getAdvisor}
      save={setAdvisor}
    />
  )
}

export function ReviewerSection() {
  return (
    <AgentConfigSection
      title="Reviewer"
      description="The default asynchronous reviewer that inspects substantial changes near completion."
      noun="reviewer"
      load={getReviewer}
      save={setReviewer}
    />
  )
}
