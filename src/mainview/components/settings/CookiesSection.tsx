import { Cookie, ListChecks, RefreshCw, X } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  cookieSyncGetSettings,
  cookieSyncListProfiles,
  cookieSyncRunNow,
  cookieSyncSetSettings,
  normalizeDomain,
  type ChromeProfile,
  type CookieSyncSettings,
  type CookieSyncState,
} from "~/lib/cookieSync"
import { DEFAULT_COOKIE_DOMAINS } from "~/lib/cookieSync"
import { relativeTime } from "~/lib/format"
import { CookieSyncModal } from "../browser/CookieSyncModal"
import { Button } from "../ui/button"
import { Switch } from "../ui/switch"
import {
  Badge,
  Card,
  ErrorNote,
  FieldRow,
  InlineError,
  Loading,
  SectionShell,
  Select,
  Spinner,
  SubLabel,
  TextInput,
} from "./common"

/**
 * Browser cookies: sync selected cookies out of the user's Chrome into the
 * in-app browser pane. All reading/decryption/injection happens in Bun; this
 * surface only shows domains, counts and status, and never persists anything
 * locally — the state returned by the RPC calls is the source of truth.
 */
export function CookiesSection() {
  const [state, setState] = useState<CookieSyncState | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [profiles, setProfiles] = useState<ChromeProfile[]>([])
  const [draft, setDraft] = useState("")
  const [running, setRunning] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
  const [runResult, setRunResult] = useState<string | null>(null)
  const [runFailed, setRunFailed] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback(() => {
    setLoading(true)
    setLoadError(null)
    void cookieSyncGetSettings()
      .then((next) => {
        if (!alive.current) return
        setState(next)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (!alive.current) return
        setLoadError((err as Error).message || "Could not read cookie sync settings.")
        setLoading(false)
      })
    void cookieSyncListProfiles().then((list) => {
      if (alive.current) setProfiles(list)
    })
  }, [])

  useEffect(load, [load])

  const save = useCallback(async (patch: Partial<CookieSyncSettings>) => {
    setSaving(true)
    setSaveError(null)
    try {
      const next = await cookieSyncSetSettings(patch)
      if (alive.current) setState(next)
    } catch (err) {
      if (alive.current) setSaveError((err as Error).message || "Could not save.")
    } finally {
      if (alive.current) setSaving(false)
    }
  }, [])

  const runNow = useCallback(async () => {
    setRunning(true)
    setRunResult(null)
    const result = await cookieSyncRunNow()
    if (!alive.current) return
    setRunFailed(!result.ok)
    setRunResult(
      result.ok
        ? `Synced ${result.count} cookie${result.count === 1 ? "" : "s"}`
        : result.error || "Sync failed.",
    )
    setRunning(false)
    // The run updates lastSync/chromeAvailable server-side; re-read it.
    try {
      const next = await cookieSyncGetSettings()
      if (alive.current) setState(next)
    } catch {
      /* the run result already tells the story */
    }
  }, [])

  const domains = state ? (state.domains.length ? state.domains : [...DEFAULT_COOKIE_DOMAINS]) : []
  const seeded = !!state && state.domains.length === 0

  const addDomain = () => {
    const host = normalizeDomain(draft)
    if (!host) {
      setSaveError("Enter a domain such as google.com.")
      return
    }
    if (domains.includes(host)) {
      setDraft("")
      return
    }
    setDraft("")
    void save({ domains: [...domains, host] })
  }

  const removeDomain = (host: string) => {
    void save({ domains: domains.filter((d) => d !== host) })
  }

  const description =
    "Copy cookies for the domains you list from Chrome into Chunky's built-in browser, so signed-in pages work there too."

  if (loading) {
    return (
      <SectionShell title="Browser cookies" description={description}>
        <Loading rows={3} />
      </SectionShell>
    )
  }

  if (loadError || !state) {
    return (
      <SectionShell title="Browser cookies" description={description}>
        <ErrorNote message={loadError ?? "Cookie sync is unavailable."} onRetry={load} />
      </SectionShell>
    )
  }

  const enabled = state.enabled
  const lastSync = state.lastSync
  const singleProfile = profiles.length <= 1
  const profileName =
    profiles.find((p) => p.id === state.sourceProfile)?.name || state.sourceProfile || "Default"

  return (
    <SectionShell
      title="Browser cookies"
      description={description}
      actions={
        <Button size="sm" variant="outline" onClick={() => setManageOpen(true)}>
          <ListChecks className="size-3.5" />
          Manage sites…
        </Button>
      }
    >
      {/* The per-site picker; closing it may have changed policies, so re-read. */}
      <CookieSyncModal
        open={manageOpen}
        onOpenChange={(next) => {
          setManageOpen(next)
          if (!next) load()
        }}
      />
      <Card>
        <SubLabel>Sync</SubLabel>
        <FieldRow
          title="Sync Chrome cookies"
          description="When off, nothing is read from Chrome and no Keychain access is requested."
        >
          <Switch
            checked={enabled}
            disabled={saving}
            onCheckedChange={(v) => void save({ enabled: v })}
          />
        </FieldRow>

        <div className="flex flex-col gap-3 border-border/60 border-t pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium text-[13px]">Chrome profile</span>
              <span className="text-[12px] text-muted-foreground">
                Which Chrome profile the cookies are read from.
              </span>
            </div>
            {singleProfile ? (
              <span
                className="shrink-0 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 font-mono text-[12px] text-muted-foreground"
                aria-label="Chrome profile"
              >
                {profileName}
              </span>
            ) : (
              <label className="flex shrink-0 items-center gap-2">
                <span className="sr-only">Chrome profile</span>
                <Select
                  value={state.sourceProfile || "Default"}
                  disabled={saving || !enabled}
                  onChange={(v) => void save({ sourceProfile: v })}
                  className="max-w-[15rem]"
                >
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </label>
            )}
          </div>

          {!state.chromeAvailable && (
            <p className="text-[11.5px] text-muted-foreground">
              Chrome cookies not found for this profile.
            </p>
          )}
        </div>
      </Card>

      <Card>
        <SubLabel>Domains</SubLabel>
        <p className="pb-2 text-[12px] text-muted-foreground">
          Only cookies for these hosts (and their subdomains) are copied.
          {seeded && " Showing the defaults until you change them."}
        </p>

        <ul className="flex flex-wrap gap-1.5 pb-2.5">
          {domains.map((host) => (
            <li key={host}>
              <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 py-0.5 pr-1 pl-2.5 font-mono text-[11.5px] text-foreground">
                {host}
                <button
                  type="button"
                  aria-label={`Remove ${host}`}
                  disabled={saving}
                  onClick={() => removeDomain(host)}
                  className="flex cursor-pointer items-center justify-center rounded-full p-0.5 text-muted-foreground outline-none transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
                >
                  <X className="size-3" />
                </button>
              </span>
            </li>
          ))}
          {domains.length === 0 && (
            <li className="text-[12px] text-muted-foreground">No domains yet.</li>
          )}
        </ul>

        <div className="flex flex-wrap items-center gap-2">
          <label className="min-w-[10rem] flex-1">
            <span className="sr-only">Add a domain</span>
            <TextInput
              value={draft}
              onChange={(v) => {
                setDraft(v)
                setSaveError(null)
              }}
              placeholder="example.com"
              monospace
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  addDomain()
                }
              }}
            />
          </label>
          <Button size="sm" variant="outline" disabled={saving || !draft.trim()} onClick={addDomain}>
            Add
          </Button>
        </div>
        {saveError && (
          <div className="pt-2">
            <InlineError>{saveError}</InlineError>
          </div>
        )}
      </Card>

      <Card>
        <SubLabel>Status</SubLabel>
        <div className="flex flex-wrap items-center justify-between gap-3 py-1">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
              <Cookie className="size-3.5 shrink-0 opacity-70" />
              {lastSync?.at ? (
                lastSync.error ? (
                  <span>
                    Last attempt {relativeTime(lastSync.at)} ago failed: {lastSync.error}
                  </span>
                ) : (
                  <span>
                    Synced {lastSync.count} cookie{lastSync.count === 1 ? "" : "s"}{" "}
                    {relativeTime(lastSync.at)} ago
                  </span>
                )
              ) : (
                <span>Never synced.</span>
              )}
              {!enabled && <Badge tone="muted">Off</Badge>}
            </div>
            {runResult && (
              <span
                role="status"
                className={
                  runFailed ? "text-[12px] text-destructive" : "text-[12px] text-muted-foreground"
                }
              >
                {runResult}
              </span>
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={running || !enabled}
            onClick={() => void runNow()}
          >
            {running ? <Spinner /> : <RefreshCw className="size-3.5" />}
            {running ? "Syncing…" : "Sync now"}
          </Button>
        </div>
        <p className="border-border/60 border-t pt-3 text-[11.5px] text-muted-foreground">
          Cookies are read locally on this Mac and injected into the in-app browser only — nothing is
          uploaded. The first sync may show a macOS Keychain prompt.
        </p>
      </Card>
    </SectionShell>
  )
}
