import { ChevronDown, Plus, RefreshCw, Trash2 } from "lucide-react"
import { useState } from "react"
import {
  getSkillRepos,
  getSkills,
  manageSkillRepos,
  setSkillEnabled,
} from "~/lib/configApi"
import type { SkillCatalogEntry, SkillRepoStatus } from "~/lib/configApi"
import { cn } from "~/lib/cn"
import { confirm } from "~/lib/confirm"
import {
  formatLastSync,
  isUnsupportedSkillRepos,
  setSkillEnabledIn,
  summarizeSkills,
} from "~/lib/skills"
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

/** Repo rows plus whether this server has the route at all. */
interface SkillReposView {
  supported: boolean
  repos: SkillRepoStatus[]
}

export function SkillsSection() {
  const skills = useAsync<SkillCatalogEntry[]>(() => getSkills(), [])
  // Wraps the existing client rather than moving it: an older server answers
  // 404 here, which is a calm empty state and not an error to retry.
  const repos = useAsync<SkillReposView>(async () => {
    try {
      return { supported: true, repos: await getSkillRepos() }
    } catch (err) {
      if (isUnsupportedSkillRepos(err)) return { supported: false, repos: [] }
      throw err
    }
  }, [])

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
        ) : repos.data && !repos.data.supported ? (
          <EmptyNote>This server does not support managed skill repos.</EmptyNote>
        ) : (
          <RepoManager
            repos={repos.data?.repos ?? []}
            onReload={() => {
              repos.reload()
              skills.reload()
            }}
            onOptimistic={(update) =>
              repos.setData((prev) =>
                prev ? { ...prev, repos: update(prev.repos) } : prev,
              )
            }
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

function RepoManager({
  repos,
  onReload,
  onOptimistic,
}: {
  repos: SkillRepoStatus[]
  onReload: () => void
  /** Apply a local edit to the loaded rows (optimistic toggle + its revert). */
  onOptimistic: (update: (repos: SkillRepoStatus[]) => SkillRepoStatus[]) => void
}) {
  const [url, setUrl] = useState("")
  const [branch, setBranch] = useState("")
  const [subdir, setSubdir] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Skills stay folded away until asked for: a repo can ship a dozen, and the
  // header's summary line already answers "is anything on in here?".
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const add = async () => {
    const u = url.trim()
    if (!u) return
    setBusy("add")
    setError(null)
    try {
      await manageSkillRepos({
        action: "add",
        url: u,
        branch: branch.trim() || undefined,
        subdir: subdir.trim() || undefined,
      })
      setUrl("")
      setBranch("")
      setSubdir("")
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
    const ok = await confirm({
      title: `Remove skill repo "${repo.url}"?`,
      body: "This deletes the local clone.",
      confirmLabel: "Remove",
      destructive: true,
    })
    if (!ok) return
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

  // Optimistic, like the Available-skills list above: the switch moves at once
  // and flips back with the reason shown if the server refuses.
  const toggleSkill = async (id: string, skill: string, enabled: boolean) => {
    setBusy(`${id}:${skill}`)
    setError(null)
    onOptimistic((list) => setSkillEnabledIn(list, id, skill, enabled))
    try {
      await manageSkillRepos({ action: enabled ? "enable" : "disable", id, skill })
    } catch (err) {
      setError((err as Error).message)
      onOptimistic((list) => setSkillEnabledIn(list, id, skill, !enabled))
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
        repos.map((repo) => {
          const open = expanded.has(repo.id)
          const summary = summarizeSkills(repo)
          return (
          <Card key={repo.id}>
            <div className="flex items-start justify-between gap-3">
              <button
                type="button"
                onClick={() => toggleExpanded(repo.id)}
                aria-expanded={open}
                className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <ChevronDown
                  className={cn(
                    "mt-0.5 size-3.5 shrink-0 text-muted-foreground/60 transition-transform",
                    !open && "-rotate-90",
                  )}
                />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate font-medium text-[13px]">{repo.url}</span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {repo.branch && <Badge tone="muted">{repo.branch}</Badge>}
                    {repo.subdir && <Badge tone="muted">{repo.subdir}</Badge>}
                    <Badge tone={repo.present ? "success" : "warning"}>
                      {repo.present ? "cloned" : "missing"}
                    </Badge>
                    {repo.lastError && <Badge tone="destructive">error</Badge>}
                  </div>
                  <span className="text-[11px] text-muted-foreground">
                    {summary.label} · {formatLastSync(repo.lastSync)}
                  </span>
                </div>
              </button>
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

            {repo.lastError && <InlineError>{repo.lastError}</InlineError>}

            {open && repo.skills.length > 0 && (
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

            {open && repo.skills.length === 0 && (
              <p className="mt-2.5 text-[11.5px] text-muted-foreground/70">
                {repo.present
                  ? "This repository ships no SKILL.md packages."
                  : "Not cloned yet — update it to discover its skills."}
              </p>
            )}
          </Card>
          )
        })
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
            <TextInput value={subdir} onChange={setSubdir} placeholder="subdir (optional)" monospace />
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
