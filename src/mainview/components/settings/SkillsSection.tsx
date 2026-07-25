import { Plus, RefreshCw, Trash2 } from "lucide-react"
import { useState } from "react"
import {
  getSkillRepos,
  getSkills,
  manageSkillRepos,
  setSkillEnabled,
} from "~/lib/configApi"
import type { SkillCatalogEntry, SkillRepoStatus } from "~/lib/configApi"
import { Button } from "../ui/button"
import { Switch } from "../ui/switch"
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

export function SkillsSection() {
  const skills = useAsync<SkillCatalogEntry[]>(() => getSkills(), [])
  const repos = useAsync<SkillRepoStatus[]>(() => getSkillRepos(), [])

  return (
    <SectionShell
      title="Skills"
      description="Enable Agent Skills and manage the git repositories they come from."
    >
      <div>
        <SubLabel>Available skills</SubLabel>
        {skills.loading ? (
          <Loading rows={3} />
        ) : skills.error ? (
          <ErrorNote message={skills.error} onRetry={skills.reload} />
        ) : (
          <SkillList skills={skills.data ?? []} onChanged={skills.setData} />
        )}
      </div>

      <div className="pt-1">
        <SubLabel>Managed skill repositories</SubLabel>
        {repos.loading ? (
          <Loading rows={2} />
        ) : repos.error ? (
          <ErrorNote message={repos.error} onRetry={repos.reload} />
        ) : (
          <RepoManager
            repos={repos.data ?? []}
            onReload={() => {
              repos.reload()
              skills.reload()
            }}
          />
        )}
      </div>
    </SectionShell>
  )
}

const SOURCE_LABEL: Record<string, string> = {
  user: "User",
  project: "Project",
  repo: "Repos",
}

function SkillList({
  skills,
  onChanged,
}: {
  skills: SkillCatalogEntry[]
  onChanged: (updater: (prev: SkillCatalogEntry[] | null) => SkillCatalogEntry[] | null) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (skills.length === 0) return <EmptyNote>No skills discovered.</EmptyNote>

  const groups = new Map<string, SkillCatalogEntry[]>()
  for (const s of skills) {
    const list = groups.get(s.source) ?? []
    list.push(s)
    groups.set(s.source, list)
  }

  const toggle = async (skill: SkillCatalogEntry, enabled: boolean) => {
    setBusy(skill.path)
    setError(null)
    onChanged((prev) =>
      (prev ?? []).map((s) => (s.path === skill.path ? { ...s, enabled } : s)),
    )
    try {
      await setSkillEnabled(skill, enabled)
    } catch (err) {
      setError((err as Error).message)
      onChanged((prev) =>
        (prev ?? []).map((s) => (s.path === skill.path ? { ...s, enabled: !enabled } : s)),
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {error && <InlineError>{error}</InlineError>}
      {[...groups.entries()].map(([source, list]) => (
        <div key={source}>
          <div className="flex items-center gap-2 pb-1.5">
            <Badge tone="muted">{list[0]?.sourceLabel || SOURCE_LABEL[source] || source}</Badge>
          </div>
          <div className="flex flex-col divide-y divide-border/60 rounded-xl border border-border">
            {list.map((s) => (
              <div key={s.path} className="flex items-center gap-3 px-3 py-2.5">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium text-[13px]">{s.name}</span>
                  {s.description && (
                    <span className="truncate text-[11.5px] text-muted-foreground">
                      {s.description}
                    </span>
                  )}
                </div>
                <Switch
                  checked={s.enabled}
                  disabled={busy === s.path}
                  onCheckedChange={(v) => void toggle(s, v)}
                />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function RepoManager({ repos, onReload }: { repos: SkillRepoStatus[]; onReload: () => void }) {
  const [url, setUrl] = useState("")
  const [branch, setBranch] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const add = async () => {
    const u = url.trim()
    if (!u) return
    setBusy("add")
    setError(null)
    try {
      await manageSkillRepos({ action: "add", url: u, branch: branch.trim() || undefined })
      setUrl("")
      setBranch("")
      onReload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const update = async (id: string) => {
    setBusy(id)
    setError(null)
    try {
      await manageSkillRepos({ action: "update", id })
      onReload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const remove = async (repo: SkillRepoStatus) => {
    if (!window.confirm(`Remove skill repo "${repo.url}"?\n\nThis deletes the local clone.`)) return
    setBusy(repo.id)
    setError(null)
    try {
      await manageSkillRepos({ action: "remove", id: repo.id })
      onReload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const toggleSkill = async (id: string, skill: string, enabled: boolean) => {
    setBusy(`${id}:${skill}`)
    setError(null)
    try {
      await manageSkillRepos({ action: enabled ? "enable" : "disable", id, skill })
      onReload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {error && <InlineError>{error}</InlineError>}

      {repos.length === 0 ? (
        <EmptyNote>No managed skill repos. Add one below.</EmptyNote>
      ) : (
        repos.map((repo) => (
          <Card key={repo.id}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate font-medium text-[13px]">{repo.url}</span>
                <div className="flex flex-wrap items-center gap-1.5">
                  {repo.branch && <Badge tone="muted">{repo.branch}</Badge>}
                  <Badge tone={repo.present ? "success" : "warning"}>
                    {repo.present ? "cloned" : "missing"}
                  </Badge>
                  {repo.lastError && <Badge tone="destructive">error</Badge>}
                </div>
                {repo.lastError && <InlineError>{repo.lastError}</InlineError>}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title="Update (git pull)"
                  disabled={busy === repo.id}
                  onClick={() => void update(repo.id)}
                >
                  {busy === repo.id ? <Spinner /> : <RefreshCw className="size-3.5" />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title="Remove repo"
                  disabled={busy === repo.id}
                  onClick={() => void remove(repo)}
                  className="text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>

            {repo.skills.length > 0 && (
              <div className="mt-2.5 flex flex-col divide-y divide-border/50 rounded-lg border border-border/70">
                {repo.skills.map((sk) => (
                  <div key={sk.name} className="flex items-center gap-3 px-2.5 py-1.5">
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[12.5px] font-medium">{sk.name}</span>
                      {sk.description && (
                        <span className="truncate text-[11px] text-muted-foreground">
                          {sk.description}
                        </span>
                      )}
                    </div>
                    <Switch
                      checked={sk.enabled}
                      disabled={busy === `${repo.id}:${sk.name}`}
                      onCheckedChange={(v) => void toggleSkill(repo.id, sk.name, v)}
                    />
                  </div>
                ))}
              </div>
            )}
          </Card>
        ))
      )}

      <Card className="border-primary/25">
        <SubLabel>Add a skill repository</SubLabel>
        <div className="flex flex-col gap-2 pt-1">
          <TextInput
            value={url}
            onChange={setUrl}
            placeholder="https://github.com/owner/skills-repo"
            monospace
          />
          <div className="flex items-center gap-2">
            <TextInput value={branch} onChange={setBranch} placeholder="branch (optional)" monospace />
            <Button size="sm" disabled={busy === "add" || !url.trim()} onClick={() => void add()}>
              {busy === "add" ? <Spinner /> : <Plus className="size-3.5" />}
              Add
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}
