import { Link2 } from "lucide-react"
import { useState } from "react"
import type { SkillCatalogEntry, SkillModelBinding, SkillRepoStatus } from "@chunky/protocol"
import {
  getSkillRepos,
  getSkills,
  listAllModels,
  manageSkillRepos,
} from "~/lib/configApi"
import type { ModelRow } from "~/lib/configApi"
import { getPrReviewsConfig, updatePrReviewsConfig } from "~/lib/prApi"
import type { PrReviewsConfig } from "@chunky/protocol"
import {
  findSkillBinding,
  findSkillRepoId,
  formatBinding,
  setCatalogBindingIn,
  setSkillBindingIn,
} from "~/lib/skills"
import { Button } from "../ui/button"
import { BindingEditor } from "./BindingEditor"
import {
  Badge,
  Card,
  EmptyNote,
  ErrorNote,
  InlineError,
  Loading,
  SectionShell,
  Select,
  SubLabel,
  Spinner,
  TextInput,
  useAsync,
} from "./common"

const DEFAULT_READY_LABEL = "ready-to-review"

/**
 * The four reviewers "Review PR" fans out to. The first three are skills and
 * can be pinned to a model; the last shells out to an external CLI that keeps
 * its own configuration, so it is shown for completeness and nothing else.
 */
const LENSES: {
  label: string
  skill: string
  /** What runs when no binding is set. */
  fallback: string
}[] = [
  { label: "Runtime bug hunter", skill: "runtime-bug-hunter", fallback: "premium model · high" },
  {
    label: "Quality (thermo-nuclear)",
    skill: "thermo-nuclear-code-quality-review",
    fallback: "session model",
  },
  { label: "Independent review", skill: "chunky-code-review", fallback: "codex · high" },
]

interface ConfigView {
  supported: boolean
  config: PrReviewsConfig | null
}

interface LensData {
  repos: SkillRepoStatus[]
  catalog: SkillCatalogEntry[]
}

export function PrReviewsSection() {
  return (
    <SectionShell
      title="PR Reviews"
      description="Which GitHub organization the board watches, and what each review lens runs on."
    >
      <GitHubCard />
      <LensCard />
    </SectionShell>
  )
}

// ---- Card 1: GitHub -------------------------------------------------------

function GitHubCard() {
  const state = useAsync<ConfigView>(async () => {
    const result = await getPrReviewsConfig()
    // An older server has no PR routes at all; that is an explanation, not an
    // error the user can retry their way out of.
    if (!result.ok) {
      if (result.unsupported) return { supported: false, config: null }
      throw new Error(result.error)
    }
    return { supported: true, config: result.config }
  }, [])

  if (state.loading) return <Card><Loading rows={3} /></Card>
  if (state.error) return <Card><ErrorNote message={state.error} onRetry={state.reload} /></Card>
  if (state.data && !state.data.supported) {
    return (
      <Card>
        <SubLabel>GitHub</SubLabel>
        <EmptyNote>This server does not support PR reviews.</EmptyNote>
      </Card>
    )
  }

  return (
    <GitHubForm
      config={state.data?.config ?? null}
      onSaved={(config) => state.setData({ supported: true, config })}
    />
  )
}

function GitHubForm({
  config,
  onSaved,
}: {
  config: PrReviewsConfig | null
  onSaved: (config: PrReviewsConfig) => void
}) {
  const [org, setOrg] = useState(config?.org ?? "")
  const [token, setToken] = useState("")
  const [readyLabel, setReadyLabel] = useState(config?.readyLabel ?? DEFAULT_READY_LABEL)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const orgs = config?.orgs ?? []

  const save = async () => {
    if (!org.trim()) {
      setError("Pick an organization first.")
      return
    }
    setBusy(true)
    setError(null)
    setSaved(false)
    const result = await updatePrReviewsConfig({
      org: org.trim(),
      // Omitted rather than blank: an empty string would clear a stored token.
      ...(token.trim() ? { token: token.trim() } : {}),
      readyLabel: readyLabel.trim() || DEFAULT_READY_LABEL,
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    // The token is write-only: it goes up and is never read back or displayed.
    setToken("")
    setSaved(true)
    onSaved(result.config)
  }

  return (
    <Card>
      <SubLabel>GitHub</SubLabel>
      <div className="flex flex-col gap-3 pt-1">
        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-muted-foreground">Organization</span>
          {orgs.length > 0 ? (
            <Select value={org} onChange={setOrg} disabled={busy} className="max-w-[18rem]">
              <option value="">Select an organization…</option>
              {orgs.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          ) : (
            <TextInput
              value={org}
              onChange={setOrg}
              placeholder="acme"
              disabled={busy}
              monospace
              className="max-w-[18rem]"
            />
          )}
        </label>

        <label className="flex flex-col gap-1">
          <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            Personal access token
            {config?.hasToken && <Badge tone="success">stored</Badge>}
          </span>
          <TextInput
            value={token}
            onChange={setToken}
            type="password"
            placeholder="uses gh auth token if empty"
            disabled={busy}
            className="max-w-[18rem]"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-muted-foreground">Ready-for-review label</span>
          <TextInput
            value={readyLabel}
            onChange={setReadyLabel}
            placeholder={DEFAULT_READY_LABEL}
            disabled={busy}
            monospace
            className="max-w-[18rem]"
          />
        </label>

        {error && <InlineError>{error}</InlineError>}

        <div className="flex items-center gap-2">
          <Button size="sm" disabled={busy} onClick={() => void save()}>
            {busy ? <Spinner /> : null}
            Save
          </Button>
          {saved && !busy && <span className="text-[11.5px] text-success">Saved.</span>}
        </div>
      </div>
    </Card>
  )
}

// ---- Card 2: review lens models -------------------------------------------

function LensCard() {
  const models = useAsync<ModelRow[]>(() => listAllModels(), [])
  // Bindings live on managed repo rows and/or the flat catalog; read both and
  // let findSkillBinding decide. Either source failing is survivable.
  const lenses = useAsync<LensData>(async () => {
    const [repos, catalog] = await Promise.all([
      getSkillRepos().catch(() => [] as SkillRepoStatus[]),
      getSkills().catch(() => [] as SkillCatalogEntry[]),
    ])
    return { repos, catalog }
  }, [])

  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  /** Bind (or, with null, unbind) one lens skill. Optimistic, with revert. */
  const save = async (
    skill: string,
    previous: SkillModelBinding | undefined,
    binding: SkillModelBinding | null,
  ) => {
    const data = lenses.data
    if (!data) return
    const repoId = findSkillRepoId(data.repos, skill)
    setBusy(skill)
    setError(null)
    const apply = (next: SkillModelBinding | null) =>
      lenses.setData((prev) =>
        prev
          ? {
              repos: repoId ? setSkillBindingIn(prev.repos, repoId, skill, next) : prev.repos,
              catalog: setCatalogBindingIn(prev.catalog, skill, next),
            }
          : prev,
      )
    apply(binding)
    try {
      await manageSkillRepos(
        binding
          ? { action: "bind", skill, binding, ...(repoId ? { id: repoId } : {}) }
          : { action: "unbind", skill, ...(repoId ? { id: repoId } : {}) },
      )
      setEditing(null)
    } catch (err) {
      setError((err as Error).message)
      apply(previous ?? null)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <SubLabel>Review panel models</SubLabel>
      <p className="pb-2 text-[12px] text-muted-foreground">
        “Review PR” runs four reviewers in parallel. Each can be pinned to a model; without a
        pin, the default below is used.
      </p>

      {lenses.loading ? (
        <Loading rows={4} />
      ) : lenses.error ? (
        <ErrorNote message={lenses.error} onRetry={lenses.reload} />
      ) : (
        <div className="flex flex-col divide-y divide-border/60 rounded-xl border border-border">
          {error && (
            <div className="px-3 py-2">
              <InlineError>{error}</InlineError>
            </div>
          )}

          {LENSES.map((lens) => {
            const binding = findSkillBinding(
              lenses.data?.repos ?? [],
              lenses.data?.catalog ?? [],
              lens.skill,
            )
            const label = formatBinding(binding)
            const open = editing === lens.skill
            return (
              <div key={lens.skill} className="flex flex-col gap-1.5 px-3 py-2.5">
                <div className="flex items-center gap-2.5">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium text-[13px]">{lens.label}</span>
                    <span className="truncate font-mono text-[11px] text-muted-foreground">
                      {lens.skill}
                    </span>
                  </div>
                  {!open &&
                    (label ? (
                      <Badge tone="primary">
                        <span className="font-mono">{label}</span>
                      </Badge>
                    ) : (
                      <span className="shrink-0 text-[11px] text-muted-foreground/70">
                        {lens.fallback}
                      </span>
                    ))}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title={binding ? "Edit model binding" : "Pin to a model"}
                    aria-label={binding ? "Edit model binding" : "Pin to a model"}
                    disabled={busy === lens.skill}
                    onClick={() => setEditing(open ? null : lens.skill)}
                    className={binding ? "text-primary" : undefined}
                  >
                    <Link2 className="size-3.5" />
                  </Button>
                </div>
                {open && (
                  <BindingEditor
                    rows={models.data ?? []}
                    binding={binding}
                    busy={busy === lens.skill}
                    // Every lens binding is advisory: the panel treats any
                    // binding as authoritative, so the strength is not a choice.
                    showLock={false}
                    onCancel={() => setEditing(null)}
                    onSave={(next) => void save(lens.skill, binding, next)}
                    onRemove={() => void save(lens.skill, binding, null)}
                  />
                )}
              </div>
            )
          })}

          <div className="flex items-center gap-2.5 px-3 py-2.5">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium text-[13px] text-muted-foreground">
                OpenCodeReview
              </span>
              <span className="truncate font-mono text-[11px] text-muted-foreground/70">
                external ocr CLI
              </span>
            </div>
            <span className="shrink-0 text-[11px] text-muted-foreground/70">
              configured via ~/.opencodereview
            </span>
          </div>
        </div>
      )}
    </Card>
  )
}
