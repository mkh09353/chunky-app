import { Monitor, Moon, Sparkles, Sun, Wifi } from "lucide-react"
import { useEffect, useState } from "react"
import { getCacheGuard, runDream, setCacheGuard } from "~/lib/configApi"
import type { CacheGuardResponse } from "~/lib/configApi"
import { cn } from "~/lib/cn"
import { browserDevLabel, formatSafeServerTarget } from "~/lib/connectionSource"
import { FALLBACK_DISPLAY_NAME } from "~/lib/identity"
import { graphemeLength } from "~/lib/quickKeys"
import { useTheme, type ThemeMode } from "~/lib/theme"
import type { SettingsIdentityInfo } from "./SettingsCenter"
import { Button } from "../ui/button"
import { Switch } from "../ui/switch"
import {
  Card,
  ErrorNote,
  FieldRow,
  InlineError,
  Loading,
  SectionShell,
  Spinner,
  SubLabel,
  TextInput,
  useAsync,
} from "./common"

const THEME_OPTIONS: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
]

/** Same bound the desktop-state writer applies, so the field can say no before
 *  Bun silently truncates. */
const MAX_DISPLAY_NAME = 40

export function GeneralSection({ connection, identity }: { connection?: { state: string; baseUrl: string; workspace: string; sessionCount: number; mode: "live" | "demo"; connectionSource?: "vite-proxy" | "native" | "static"; proxyTarget?: string }; identity?: SettingsIdentityInfo }) {
  const { mode, setMode } = useTheme()

  return (
    <SectionShell title="General" description="Appearance, cache safety, and repository memory.">
      {identity && <IdentityCard identity={identity} />}
      <Card>
        <SubLabel>Appearance</SubLabel>
        <FieldRow title="Theme" description="Light, dark, or follow the system.">
          <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/40 p-0.5">
            {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                className={cn(
                  "flex cursor-pointer items-center gap-1.5 rounded-[7px] px-2.5 py-1 font-medium text-[12px] outline-none transition-colors",
                  mode === value
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-3.5" />
                {label}
              </button>
            ))}
          </div>
        </FieldRow>
      </Card>

      {connection && <Card>
        <SubLabel>Connection</SubLabel>
        <FieldRow
          title={
            connection.connectionSource === "vite-proxy"
              ? browserDevLabel(connection.proxyTarget)
              : connection.mode === "live"
                ? connection.state
                : "Demo mode"
          }
          description={
            connection.connectionSource === "vite-proxy"
              ? "Vite / browser-dev proxy — not the installed Chunky app."
              : connection.mode === "live"
                ? "Local Chunky server connection."
                : "Mock data only; no server is connected."
          }
        >
          <Wifi className={cn("size-4", connection.connectionSource === "vite-proxy" ? "text-amber-600 dark:text-amber-400" : connection.state === "connected" && connection.mode === "live" ? "text-success" : "text-muted-foreground")} />
        </FieldRow>
        <div className="grid gap-1 border-border/60 border-t pt-3 text-[12px] text-muted-foreground">
          {connection.connectionSource === "vite-proxy" && (
            <span className="truncate text-amber-600 dark:text-amber-400" title={browserDevLabel(connection.proxyTarget)}>
              {browserDevLabel(connection.proxyTarget)}
            </span>
          )}
          <span className="truncate" title={connection.connectionSource === "vite-proxy" ? (formatSafeServerTarget(connection.proxyTarget) || "localhost:4620") : connection.baseUrl}>
            Server · {connection.connectionSource === "vite-proxy"
              ? formatSafeServerTarget(connection.proxyTarget) || "localhost:4620"
              : connection.baseUrl}
          </span>
          <span className="truncate" title={connection.workspace}>Workspace · {connection.workspace || "—"}</span>
          <span>Sessions · {connection.sessionCount}</span>
        </div>
      </Card>}

      <CacheGuardCard />
      <DreamCard />
    </SectionShell>
  )
}

/**
 * The sidebar's display name. An explicit override that beats the git name;
 * empty means "no override", not an empty name.
 *
 * Explicit save (Enter or Apply), like every other text field in Settings —
 * App persists it and re-renders the sidebar underneath the open dialog.
 */
function IdentityCard({ identity }: { identity: SettingsIdentityInfo }) {
  const [draft, setDraft] = useState(identity.override)

  // Adopt the value App owns whenever it actually changes (first load from
  // desktop.json, or a clear), rather than stranding a stale draft.
  useEffect(() => setDraft(identity.override), [identity.override])

  const fallback = identity.gitName || FALLBACK_DISPLAY_NAME
  const trimmed = draft.trim()
  const tooLong = graphemeLength(trimmed) > MAX_DISPLAY_NAME
  const dirty = trimmed !== identity.override
  // Enter and Apply share one guard: an unchanged (or too long) draft commits
  // nothing, so Enter can't re-save what the disabled button refuses.
  const apply = () => {
    if (dirty && !tooLong) identity.onChange(trimmed)
  }

  return (
    <Card>
      <SubLabel>Identity</SubLabel>
      <FieldRow
        title="Display name"
        description={
          identity.override
            ? `Overriding ${identity.gitName ? "your Git name" : "the default"}, ${fallback}.`
            : `Using ${identity.gitName ? "your Git name" : "the default"}. Set one to override it.`
        }
      >
        <div className="flex items-center gap-2">
          <TextInput
            value={draft}
            onChange={setDraft}
            placeholder={fallback}
            className="w-[12rem]"
            onKeyDown={(e) => {
              if (e.key === "Enter") apply()
            }}
          />
          <Button size="sm" variant="outline" disabled={!dirty || tooLong} onClick={apply}>
            Apply
          </Button>
        </div>
      </FieldRow>
      {tooLong && (
        <InlineError>{`Keep the name to ${MAX_DISPLAY_NAME} characters or fewer.`}</InlineError>
      )}
      {identity.override && (
        <div className="flex items-center justify-between gap-3 border-border/60 border-t pt-3">
          <span className="min-w-0 truncate text-[12px] text-muted-foreground">
            {identity.gitName ? `Git name · ${identity.gitName}` : "No Git name is configured."}
          </span>
          <Button size="sm" variant="ghost" onClick={() => identity.onChange("")}>
            {identity.gitName ? "Use Git name" : "Clear"}
          </Button>
        </div>
      )}
    </Card>
  )
}

function CacheGuardCard() {
  const guard = useAsync<CacheGuardResponse>(() => getCacheGuard(), [])
  const [tokens, setTokens] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const enabled = guard.data?.tokens != null
  const shownTokens = tokens !== "" ? tokens : guard.data?.tokens != null ? String(guard.data.tokens) : ""

  const save = async (value: number | null) => {
    setSaving(true)
    setError(null)
    try {
      const next = await setCacheGuard(value)
      guard.setData(next)
      setTokens(next.tokens != null ? String(next.tokens) : "")
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const toggle = (on: boolean) => {
    if (on) void save(shownTokens ? Number(shownTokens) : 20000)
    else void save(null)
  }

  const applyTokens = () => {
    const n = Number(shownTokens)
    if (!Number.isFinite(n) || n <= 0) {
      setError("Enter a positive token count, or turn the guard off.")
      return
    }
    void save(Math.round(n))
  }

  return (
    <Card>
      <SubLabel>Cache guard</SubLabel>
      {guard.loading ? (
        <Loading rows={1} />
      ) : guard.error ? (
        <ErrorNote message={guard.error} onRetry={guard.reload} />
      ) : (
        <>
          <FieldRow
            title="Confirm before a cold re-send"
            description="Block a send that would re-send at least this many tokens on a cold cache."
          >
            <Switch checked={enabled} disabled={saving} onCheckedChange={toggle} />
          </FieldRow>
          {enabled && (
            <div className="flex items-center gap-2 border-border/60 border-t pt-3">
              <span className="text-[12px] text-muted-foreground">Threshold (tokens)</span>
              <TextInput
                value={shownTokens}
                onChange={setTokens}
                type="number"
                placeholder="20000"
                className="max-w-[9rem]"
                onKeyDown={(e) => {
                  if (e.key === "Enter") applyTokens()
                }}
              />
              <Button size="sm" variant="outline" disabled={saving} onClick={applyTokens}>
                {saving ? <Spinner /> : "Apply"}
              </Button>
            </div>
          )}
          {error && (
            <div className="pt-2">
              <InlineError>{error}</InlineError>
            </div>
          )}
        </>
      )}
    </Card>
  )
}

function DreamCard() {
  const [state, setState] = useState<"idle" | "running" | "done">("idle")
  const [error, setError] = useState<string | null>(null)

  const dream = async () => {
    setState("running")
    setError(null)
    try {
      await runDream()
      setState("done")
    } catch (err) {
      setError((err as Error).message)
      setState("idle")
    }
  }

  return (
    <Card>
      <SubLabel>Repository memory</SubLabel>
      <FieldRow
        title="Dream now"
        description="Consolidate what Chunky has learned about this repo into durable memory."
      >
        <Button variant="secondary" size="sm" disabled={state === "running"} onClick={() => void dream()}>
          {state === "running" ? <Spinner /> : <Sparkles className="size-3.5" />}
          {state === "running" ? "Dreaming…" : state === "done" ? "Done — run again" : "Dream"}
        </Button>
      </FieldRow>
      {error && <InlineError>{error}</InlineError>}
    </Card>
  )
}
