// Branch toolbar + git/source-control panel for the active session's workspace.
// Everything here degrades to "hidden" when the native Git bridge is missing
// (plain browser dev): gitStatus() then reports isRepo:false and the toolbar
// renders nothing.
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Check,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  Upload,
} from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { cn } from "~/lib/cn"
import {
  gitBranches,
  gitCommit,
  gitPull,
  gitPush,
  gitStage,
  gitStatus,
  gitSwitch,
  gitUnstage,
  scmCheckoutPr,
  scmCreatePr,
  scmInfo,
  scmListPrs,
  scmPublish,
  type CommandResult,
  type GitBranches,
  type GitStatus,
  type ScmInfo,
  type ScmPr,
} from "~/lib/git"
import { Button } from "./ui/button"
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog"
import { Input } from "./ui/input"
import { Switch } from "./ui/switch"
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip"

/** Background refresh cadence for the collapsed toolbar (panel refreshes eagerly). */
const TOOLBAR_POLL_MS = 20_000

type PanelTab = "changes" | "branches" | "prs"

/** Only absolute workspace paths can be handed to the native git bridge. */
export function isAbsolutePath(path: string | undefined | null): path is string {
  if (!path) return false
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path)
}

function openExternal(url: string) {
  try {
    window.open(url, "_blank", "noopener,noreferrer")
  } catch {
    /* popup blocked — the URL stays visible in the panel */
  }
}

function cliHint(info: ScmInfo): string {
  const name = info.cliName || (info.provider === "gitlab" ? "glab" : "gh")
  return `Install ${name} to enable pull requests.`
}

function providerLabel(provider: ScmInfo["provider"]): string {
  switch (provider) {
    case "github":
      return "GitHub"
    case "gitlab":
      return "GitLab"
    case "bitbucket":
      return "Bitbucket"
    case "azure":
      return "Azure DevOps"
    default:
      return "unknown"
  }
}

/* ── toolbar ────────────────────────────────────────────────────────────── */

/** Compact branch pill in the chat header; opens the git panel on click. */
export function GitToolbar({ cwd }: { cwd?: string }) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<GitStatus | null>(null)
  const gen = useRef(0)
  const enabled = isAbsolutePath(cwd)

  const refreshStatus = useCallback(async (): Promise<GitStatus | null> => {
    if (!isAbsolutePath(cwd)) {
      setStatus(null)
      return null
    }
    const generation = ++gen.current
    const next = await gitStatus({ cwd }).catch(() => null)
    if (generation !== gen.current) return next
    setStatus(next ?? null)
    return next ?? null
  }, [cwd])

  useEffect(() => {
    setStatus(null)
    void refreshStatus()
  }, [refreshStatus])

  useEffect(() => {
    if (!enabled) return
    const timer = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return
      void refreshStatus()
    }, TOOLBAR_POLL_MS)
    return () => window.clearInterval(timer)
  }, [enabled, refreshStatus])

  if (!enabled || !status?.isRepo) return null

  const dirty =
    status.staged.length + status.unstaged.length + status.untracked.length > 0

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              className="no-drag max-w-[13rem] gap-1.5"
              onClick={() => setOpen(true)}
              aria-label="Open git panel"
            />
          }
        >
          <GitBranch className="size-3.5" />
          <span className="truncate font-mono text-[11px]">{status.branch || "detached"}</span>
          {dirty && <span className="size-1.5 shrink-0 rounded-full bg-primary" />}
          {status.ahead > 0 && (
            <span className="flex shrink-0 items-center text-[10.5px] tabular-nums">
              <ArrowUp className="size-3" />
              {status.ahead}
            </span>
          )}
          {status.behind > 0 && (
            <span className="flex shrink-0 items-center text-[10.5px] tabular-nums">
              <ArrowDown className="size-3" />
              {status.behind}
            </span>
          )}
        </TooltipTrigger>
        <TooltipPopup>Git · {status.branch || "detached HEAD"}</TooltipPopup>
      </Tooltip>
      {isAbsolutePath(cwd) && (
        <GitPanel
          open={open}
          onOpenChange={setOpen}
          cwd={cwd}
          status={status}
          onRefreshStatus={refreshStatus}
        />
      )}
    </>
  )
}

/* ── panel ──────────────────────────────────────────────────────────────── */

function StatusBadge({ code }: { code: string }) {
  const letter = (code || "?").trim().slice(0, 2) || "?"
  const tone =
    letter.startsWith("A") || letter.startsWith("?")
      ? "text-success"
      : letter.startsWith("D")
        ? "text-destructive"
        : "text-amber-600 dark:text-amber-400"
  return (
    <span className={cn("w-6 shrink-0 text-center font-mono text-[10.5px] uppercase", tone)}>
      {letter}
    </span>
  )
}

function FileRow({
  path,
  code,
  action,
  actionLabel,
  onAction,
  disabled,
}: {
  path: string
  code: string
  action: "stage" | "unstage"
  actionLabel: string
  onAction: () => void
  disabled?: boolean
}) {
  return (
    <div className="group flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-accent/50">
      <StatusBadge code={code} />
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground/85" title={path}>
        {path}
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={disabled}
              onClick={onAction}
              aria-label={`${actionLabel} ${path}`}
              className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
            />
          }
        >
          {action === "stage" ? <Plus /> : <Minus />}
        </TooltipTrigger>
        <TooltipPopup>{actionLabel}</TooltipPopup>
      </Tooltip>
    </div>
  )
}

function SectionHeading({
  label,
  count,
  action,
}: {
  label: string
  count: number
  action?: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-2 pt-3 pb-1">
      <span className="font-medium text-[10.5px] text-muted-foreground/70 uppercase tracking-[0.08em]">
        {label}
      </span>
      <span className="text-[10.5px] text-muted-foreground/50 tabular-nums">{count}</span>
      <span className="h-px flex-1 bg-border/60" />
      {action}
    </div>
  )
}

export function GitPanel({
  open,
  onOpenChange,
  cwd,
  status,
  onRefreshStatus,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  cwd: string
  status: GitStatus | null
  onRefreshStatus: () => Promise<GitStatus | null>
}) {
  const [tab, setTab] = useState<PanelTab>("changes")
  const [branches, setBranches] = useState<GitBranches | null>(null)
  const [scm, setScm] = useState<ScmInfo | null>(null)
  const [scmLoading, setScmLoading] = useState(false)
  const [prs, setPrs] = useState<ScmPr[] | null>(null)
  const [prsLoading, setPrsLoading] = useState(false)
  const [prsError, setPrsError] = useState<string | null>(null)
  const [prTick, setPrTick] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  const [message, setMessage] = useState("")
  const [stageAll, setStageAll] = useState(true)
  const [newBranch, setNewBranch] = useState("")

  const [prFormOpen, setPrFormOpen] = useState(false)
  const [prTitle, setPrTitle] = useState("")
  const [prBody, setPrBody] = useState("")
  const [prBase, setPrBase] = useState("")
  const [prDraft, setPrDraft] = useState(false)
  const [createdPrUrl, setCreatedPrUrl] = useState<string | null>(null)

  const [publishOpen, setPublishOpen] = useState(false)
  const [publishName, setPublishName] = useState("")
  const [publishPrivate, setPublishPrivate] = useState(true)
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null)

  const loadBranches = useCallback(async () => {
    const next = await gitBranches({ cwd }).catch(() => null)
    setBranches(next ?? null)
    return next ?? null
  }, [cwd])

  const loadScm = useCallback(async () => {
    setScmLoading(true)
    const info = await scmInfo({ cwd }).catch(() => null)
    setScm(info ?? null)
    setScmLoading(false)
    return info ?? null
  }, [cwd])

  /** Status + branches are re-read after every mutating action. */
  const reload = useCallback(async () => {
    await Promise.all([onRefreshStatus(), loadBranches()])
  }, [onRefreshStatus, loadBranches])

  // Panel open → refresh everything it shows.
  useEffect(() => {
    if (!open) return
    setResult(null)
    void onRefreshStatus()
    void loadBranches()
    void loadScm()
  }, [open, onRefreshStatus, loadBranches, loadScm])

  // Pull requests are only listed for supported providers with a working CLI.
  useEffect(() => {
    if (!open || tab !== "prs") return
    const supported = scm?.provider === "github" || scm?.provider === "gitlab"
    if (!supported || !scm?.cliAvailable || !scm.remoteUrl) return
    let cancelled = false
    setPrsLoading(true)
    void scmListPrs({ cwd })
      .then((res) => {
        if (cancelled) return
        setPrs(res?.prs ?? [])
        setPrsError(res?.ok ? null : (res?.output ?? "").trim() || "Could not list pull requests.")
        setPrsLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setPrs([])
        setPrsError((err as Error).message || "Could not list pull requests.")
        setPrsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, tab, scm, cwd, prTick])

  /** Run a git/scm command, surface its output, then refresh. */
  const run = useCallback(
    async <T extends CommandResult>(key: string, action: () => Promise<T>): Promise<T | null> => {
      setBusy(key)
      setResult(null)
      let res: T | null = null
      try {
        res = await action()
      } catch (err) {
        setBusy(null)
        setResult({ ok: false, text: (err as Error).message || "Command failed." })
        return null
      }
      const ok = res?.ok === true
      const text = (res?.output ?? "").trim()
      setResult({ ok, text: text || (ok ? "Done." : "Command failed.") })
      setBusy(null)
      await reload()
      return ok ? res : null
    },
    [reload],
  )

  const busyAny = busy !== null
  const upstream = status?.upstream ?? null
  const staged = status?.staged ?? []
  const unstaged = status?.unstaged ?? []
  const untracked = status?.untracked ?? []
  const clean = staged.length + unstaged.length + untracked.length === 0

  const commit = useCallback(async () => {
    const text = message.trim()
    if (!text) return
    const res = await run("commit", () => gitCommit({ cwd, message: text, stageAll }))
    if (res) setMessage("")
  }, [message, run, cwd, stageAll])

  const createBranch = useCallback(async () => {
    const name = newBranch.trim()
    if (!name) return
    const res = await run("branch", () => gitSwitch({ cwd, branch: name, create: true }))
    if (res) setNewBranch("")
  }, [newBranch, run, cwd])

  const submitPr = useCallback(async () => {
    const title = prTitle.trim()
    if (!title) return
    const res = await run("pr", () =>
      scmCreatePr({
        cwd,
        title,
        body: prBody.trim() || undefined,
        draft: prDraft,
        base: prBase.trim() || undefined,
      }),
    )
    if (res) {
      setCreatedPrUrl(res.url ?? null)
      setPrFormOpen(false)
      setPrTitle("")
      setPrBody("")
      setPrTick((n) => n + 1)
    }
  }, [prTitle, prBody, prDraft, prBase, run, cwd])

  const submitPublish = useCallback(async () => {
    const name = publishName.trim()
    if (!name) return
    const res = await run("publish", () =>
      scmPublish({ cwd, name, visibility: publishPrivate ? "private" : "public" }),
    )
    if (res) {
      setPublishedUrl(res.url ?? null)
      setPublishOpen(false)
      void loadScm()
    }
  }, [publishName, publishPrivate, run, cwd, loadScm])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="size-4 text-primary" />
            <span className="font-mono text-[13px]">{status?.branch || "detached HEAD"}</span>
            {upstream && (
              <span className="font-normal text-[11px] text-muted-foreground">→ {upstream}</span>
            )}
            {status && (status.ahead > 0 || status.behind > 0) && (
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
                {status.ahead > 0 && (
                  <span className="flex items-center">
                    <ArrowUp className="size-3" />
                    {status.ahead}
                  </span>
                )}
                {status.behind > 0 && (
                  <span className="flex items-center">
                    <ArrowDown className="size-3" />
                    {status.behind}
                  </span>
                )}
              </span>
            )}
          </DialogTitle>
          <DialogDescription className="truncate font-mono text-[11px]" title={cwd}>
            {cwd}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-1.5 px-6 pt-1">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={busyAny}
            onClick={() => void run("pull", () => gitPull({ cwd }))}
          >
            {busy === "pull" ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowDown className="size-3.5" />}
            Pull
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={busyAny}
            onClick={() => void run("push", () => gitPush({ cwd, setUpstream: !upstream }))}
          >
            {busy === "push" ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowUp className="size-3.5" />}
            {upstream ? "Push" : "Push (set upstream)"}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label="Refresh git status"
            disabled={busyAny}
            onClick={() => {
              void reload()
              void loadScm()
              setPrTick((n) => n + 1)
            }}
          >
            <RefreshCw className="size-3.5" />
          </Button>
        </div>

        <div className="mt-2 flex items-center gap-1 border-border border-b px-6">
          {(
            [
              ["changes", "Changes"],
              ["branches", "Branches"],
              ["prs", "Pull requests"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cn(
                "cursor-pointer px-3 py-2 text-sm outline-none",
                tab === id ? "border-primary border-b-2 text-primary" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="max-h-[52vh] overflow-y-auto px-6 pb-2">
          {tab === "changes" && (
            <div className="flex flex-col">
              {clean && (
                <p className="py-6 text-center text-[12px] text-muted-foreground">
                  Working tree clean.
                </p>
              )}

              {staged.length > 0 && (
                <>
                  <SectionHeading
                    label="Staged"
                    count={staged.length}
                    action={
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyAny}
                        onClick={() => void run("unstage-all", () => gitUnstage({ cwd, paths: [] }))}
                      >
                        Unstage all
                      </Button>
                    }
                  />
                  {staged.map((file) => (
                    <FileRow
                      key={`staged:${file.path}`}
                      path={file.path}
                      code={file.status}
                      action="unstage"
                      actionLabel="Unstage"
                      disabled={busyAny}
                      onAction={() => void run("unstage", () => gitUnstage({ cwd, paths: [file.path] }))}
                    />
                  ))}
                </>
              )}

              {unstaged.length > 0 && (
                <>
                  <SectionHeading
                    label="Changes"
                    count={unstaged.length}
                    action={
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyAny}
                        onClick={() =>
                          void run("stage-tracked", () =>
                            gitStage({ cwd, paths: unstaged.map((f) => f.path) }),
                          )
                        }
                      >
                        Stage all
                      </Button>
                    }
                  />
                  {unstaged.map((file) => (
                    <FileRow
                      key={`unstaged:${file.path}`}
                      path={file.path}
                      code={file.status}
                      action="stage"
                      actionLabel="Stage"
                      disabled={busyAny}
                      onAction={() => void run("stage", () => gitStage({ cwd, paths: [file.path] }))}
                    />
                  ))}
                </>
              )}

              {untracked.length > 0 && (
                <>
                  <SectionHeading
                    label="Untracked"
                    count={untracked.length}
                    action={
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyAny}
                        onClick={() => void run("stage-untracked", () => gitStage({ cwd, paths: untracked }))}
                      >
                        Stage all
                      </Button>
                    }
                  />
                  {untracked.map((path) => (
                    <FileRow
                      key={`untracked:${path}`}
                      path={path}
                      code="?"
                      action="stage"
                      actionLabel="Stage"
                      disabled={busyAny}
                      onAction={() => void run("stage", () => gitStage({ cwd, paths: [path] }))}
                    />
                  ))}
                </>
              )}

              <div className="mt-4 rounded-xl border border-border bg-muted/20 p-3">
                <textarea
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder="Commit message…"
                  className="min-h-16 w-full resize-y rounded-lg border border-input bg-transparent p-2 text-sm outline-none focus:ring-2 focus:ring-ring/40"
                />
                <div className="mt-2 flex items-center gap-2">
                  <label className="flex cursor-pointer items-center gap-2 text-[12px] text-muted-foreground">
                    <Switch checked={stageAll} onCheckedChange={setStageAll} />
                    Stage all tracked changes
                  </label>
                  <Button
                    size="sm"
                    className="ml-auto gap-1.5"
                    disabled={busyAny || !message.trim()}
                    onClick={() => void commit()}
                  >
                    {busy === "commit" ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                    Commit
                  </Button>
                </div>
              </div>
            </div>
          )}

          {tab === "branches" && (
            <div className="flex flex-col">
              <div className="flex items-center gap-2 pt-3">
                <Input
                  value={newBranch}
                  onChange={(event) => setNewBranch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault()
                      void createBranch()
                    }
                  }}
                  placeholder="new-branch-name"
                  className="font-mono text-[12px]"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 gap-1.5"
                  disabled={busyAny || !newBranch.trim()}
                  onClick={() => void createBranch()}
                >
                  {busy === "branch" ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                  Create & switch
                </Button>
              </div>

              <SectionHeading label="Local branches" count={branches?.local.length ?? 0} />
              {branches === null ? (
                <p className="py-4 text-center text-[12px] text-muted-foreground">Loading branches…</p>
              ) : branches.local.length === 0 ? (
                <p className="py-4 text-center text-[12px] text-muted-foreground">No local branches.</p>
              ) : (
                branches.local.map((name) => {
                  const current = name === (branches.current || status?.branch)
                  return (
                    <button
                      key={name}
                      type="button"
                      disabled={busyAny || current}
                      onClick={() => void run("switch", () => gitSwitch({ cwd, branch: name }))}
                      className={cn(
                        "flex items-center gap-2 rounded-md px-1.5 py-1.5 text-left outline-none transition-colors",
                        current
                          ? "cursor-default text-foreground"
                          : "cursor-pointer text-foreground/85 hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/40",
                      )}
                    >
                      {current ? (
                        <Check className="size-3.5 shrink-0 text-primary" />
                      ) : (
                        <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{name}</span>
                      {current && (
                        <span className="shrink-0 text-[10.5px] text-muted-foreground">current</span>
                      )}
                    </button>
                  )
                })
              )}

              {branches && branches.worktrees.length > 0 && (
                <>
                  <SectionHeading label="Worktrees" count={branches.worktrees.length} />
                  {branches.worktrees.map((tree) => (
                    <div
                      key={tree.path}
                      className="flex items-center gap-2 rounded-md px-1.5 py-1.5"
                      title={tree.path}
                    >
                      <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground/85">
                        {tree.path}
                      </span>
                      <span className="shrink-0 truncate font-mono text-[10.5px] text-muted-foreground">
                        {tree.branch}
                      </span>
                    </div>
                  ))}
                </>
              )}

              {branches && branches.remote.length > 0 && (
                <>
                  <SectionHeading label="Remote branches" count={branches.remote.length} />
                  <div className="flex flex-wrap gap-1 pb-1">
                    {branches.remote.map((name) => (
                      <span
                        key={name}
                        className="max-w-full truncate rounded-full border border-border bg-card px-2 py-0.5 font-mono text-[10.5px] text-muted-foreground"
                      >
                        {name}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {tab === "prs" && (
            <PrTab
              scm={scm}
              scmLoading={scmLoading}
              prs={prs}
              prsLoading={prsLoading}
              prsError={prsError}
              busy={busy}
              busyAny={busyAny}
              createdPrUrl={createdPrUrl}
              publishedUrl={publishedUrl}
              onRefreshPrs={() => setPrTick((n) => n + 1)}
              onOpenCreate={() => {
                setPrTitle("")
                setPrBody("")
                setPrBase("")
                setPrDraft(false)
                setPrFormOpen(true)
              }}
              onOpenPublish={() => {
                setPublishName(cwd.split(/[\\/]/).filter(Boolean).pop() ?? "")
                setPublishPrivate(true)
                setPublishOpen(true)
              }}
              onCheckout={(number) => void run("checkout-pr", () => scmCheckoutPr({ cwd, number }))}
            />
          )}
        </div>

        {result && (
          <div className="px-6 pb-1">
            <div
              className={cn(
                "flex max-h-32 items-start gap-2 overflow-y-auto rounded-lg border px-3 py-2 text-[11.5px]",
                result.ok
                  ? "border-border bg-muted/40 text-muted-foreground"
                  : "border-destructive/30 bg-destructive/10 text-destructive",
              )}
            >
              {result.ok ? (
                <Check className="mt-0.5 size-3.5 shrink-0" />
              ) : (
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              )}
              <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono">{result.text}</pre>
              <button
                type="button"
                onClick={() => setResult(null)}
                className="shrink-0 cursor-pointer font-medium underline-offset-2 hover:underline"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>

      {/* Create PR */}
      <Dialog open={prFormOpen} onOpenChange={setPrFormOpen}>
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Create pull request</DialogTitle>
            <DialogDescription>
              From <span className="font-mono">{status?.branch || "current branch"}</span> using the{" "}
              {scm?.cliName || "provider"} CLI.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 px-6 pb-2">
            <Input
              value={prTitle}
              onChange={(event) => setPrTitle(event.target.value)}
              placeholder="Title"
              autoFocus
            />
            <textarea
              value={prBody}
              onChange={(event) => setPrBody(event.target.value)}
              placeholder="Optional description…"
              className="min-h-24 w-full resize-y rounded-lg border border-input bg-transparent p-2 text-sm outline-none focus:ring-2 focus:ring-ring/40"
            />
            <Input
              value={prBase}
              onChange={(event) => setPrBase(event.target.value)}
              placeholder="Base branch (optional — defaults to the repo default)"
              className="font-mono text-[12px]"
            />
            <label className="flex cursor-pointer items-center gap-2 text-[12px] text-muted-foreground">
              <Switch checked={prDraft} onCheckedChange={setPrDraft} />
              Create as draft
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPrFormOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={busyAny || !prTitle.trim()} onClick={() => void submitPr()}>
              {busy === "pr" ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Create PR
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      {/* Publish repo */}
      <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Publish repository</DialogTitle>
            <DialogDescription>
              Creates a {providerLabel(scm?.provider ?? null)} repository and pushes this workspace to it.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 px-6 pb-2">
            <Input
              value={publishName}
              onChange={(event) => setPublishName(event.target.value)}
              placeholder="Repository name"
              className="font-mono text-[12px]"
              autoFocus
            />
            <label className="flex cursor-pointer items-center gap-2 text-[12px] text-muted-foreground">
              <Switch checked={publishPrivate} onCheckedChange={setPublishPrivate} />
              Private repository
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPublishOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={busyAny || !publishName.trim()}
              onClick={() => void submitPublish()}
            >
              {busy === "publish" ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Publish
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </Dialog>
  )
}

/* ── pull requests ──────────────────────────────────────────────────────── */

function PrTab({
  scm,
  scmLoading,
  prs,
  prsLoading,
  prsError,
  busy,
  busyAny,
  createdPrUrl,
  publishedUrl,
  onRefreshPrs,
  onOpenCreate,
  onOpenPublish,
  onCheckout,
}: {
  scm: ScmInfo | null
  scmLoading: boolean
  prs: ScmPr[] | null
  prsLoading: boolean
  prsError: string | null
  busy: string | null
  busyAny: boolean
  createdPrUrl: string | null
  publishedUrl: string | null
  onRefreshPrs: () => void
  onOpenCreate: () => void
  onOpenPublish: () => void
  onCheckout: (number: number) => void
}) {
  if (scmLoading && !scm) {
    return <p className="py-6 text-center text-[12px] text-muted-foreground">Detecting remote…</p>
  }

  if (!scm || scm.provider === null) {
    return (
      <p className="py-6 text-center text-[12px] text-muted-foreground">
        No source-control provider detected for this workspace.
      </p>
    )
  }

  if (scm.provider === "bitbucket" || scm.provider === "azure") {
    return (
      <p className="py-6 text-center text-[12px] text-muted-foreground">
        {providerLabel(scm.provider)} pull requests are not supported yet.
      </p>
    )
  }

  if (!scm.cliAvailable) {
    return (
      <div className="flex flex-col items-center gap-1 py-6 text-center">
        <AlertCircle className="size-4 text-muted-foreground" />
        <p className="text-[12.5px] font-medium">{cliHint(scm)}</p>
        <p className="text-[11.5px] text-muted-foreground">
          {providerLabel(scm.provider)} detected, but its CLI isn't on PATH.
        </p>
      </div>
    )
  }

  if (!scm.remoteUrl) {
    return (
      <div className="flex flex-col items-center gap-2 py-6 text-center">
        <p className="text-[12.5px] font-medium">This repository has no remote yet.</p>
        <p className="max-w-sm text-[11.5px] text-muted-foreground">
          Publish it to {providerLabel(scm.provider)} to enable pull requests.
        </p>
        <Button variant="outline" size="sm" className="gap-1.5" disabled={busyAny} onClick={onOpenPublish}>
          {busy === "publish" ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
          Publish repo
        </Button>
        {publishedUrl && (
          <button
            type="button"
            onClick={() => openExternal(publishedUrl)}
            className="flex cursor-pointer items-center gap-1 font-mono text-[11px] text-primary underline-offset-2 hover:underline"
          >
            <ExternalLink className="size-3" />
            {publishedUrl}
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 pt-3">
        <Button variant="outline" size="sm" className="gap-1.5" disabled={busyAny} onClick={onOpenCreate}>
          <GitPullRequest className="size-3.5" />
          Create PR
        </Button>
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground" title={scm.remoteUrl}>
          {scm.remoteUrl}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh pull requests"
          disabled={prsLoading}
          onClick={onRefreshPrs}
        >
          <RefreshCw className={cn("size-3.5", prsLoading && "animate-spin")} />
        </Button>
      </div>

      {createdPrUrl && (
        <button
          type="button"
          onClick={() => openExternal(createdPrUrl)}
          className="mt-2 flex cursor-pointer items-center gap-1.5 rounded-lg border border-primary/25 bg-primary/10 px-3 py-2 text-left font-mono text-[11px] text-primary"
        >
          <ExternalLink className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{createdPrUrl}</span>
        </button>
      )}

      <SectionHeading label="Open pull requests" count={prs?.length ?? 0} />
      {prsLoading && prs === null ? (
        <p className="py-4 text-center text-[12px] text-muted-foreground">Loading pull requests…</p>
      ) : prsError ? (
        <p className="py-4 text-center text-[11.5px] text-destructive">{prsError}</p>
      ) : !prs || prs.length === 0 ? (
        <p className="py-4 text-center text-[12px] text-muted-foreground">No open pull requests.</p>
      ) : (
        prs.map((pr) => (
          <div key={pr.number} className="group flex items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-accent/50">
            <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" />
            <button
              type="button"
              onClick={() => openExternal(pr.url)}
              title={pr.url}
              className="flex min-w-0 flex-1 cursor-pointer flex-col items-start text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <span className="w-full truncate text-[12.5px] text-foreground/90">
                <span className="font-mono text-muted-foreground tabular-nums">#{pr.number}</span>{" "}
                {pr.title}
              </span>
              <span className="w-full truncate text-[10.5px] text-muted-foreground">
                {pr.state} · {pr.author}
                {pr.headBranch ? ` · ${pr.headBranch}` : ""}
              </span>
            </button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busyAny}
              onClick={() => onCheckout(pr.number)}
              className="shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
            >
              {busy === "checkout-pr" ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Checkout
            </Button>
          </div>
        ))
      )}
    </div>
  )
}
