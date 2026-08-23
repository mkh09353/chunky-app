import { Ban, Check, RefreshCw, Repeat, Search } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { cn } from "~/lib/cn"
import {
  cookieSyncCompleteFirstRun,
  cookieSyncGetSettings,
  cookieSyncListDomains,
  cookieSyncSetPolicy,
  cookieSyncSyncDomains,
  faviconUrl,
  type CookieDomainPolicy,
  type CookieSyncState,
  type DiscoveredDomain,
} from "~/lib/cookieSync"
import { relativeTime } from "~/lib/format"
import { Button } from "../ui/button"
import { Dialog, DialogPopup } from "../ui/dialog"
import { ScrollArea } from "../ui/scroll-area"
import { EmptyNote, ErrorNote, InlineError, Loading, Spinner } from "../settings/common"

/** Stable-ish tile colour per domain so the fallback avatar is not all one hue. */
const TILE_TONES = [
  "bg-primary/15 text-primary",
  "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  "bg-rose-500/15 text-rose-600 dark:text-rose-400",
]

function toneFor(domain: string): string {
  let hash = 0
  for (let i = 0; i < domain.length; i += 1) hash = (hash * 31 + domain.charCodeAt(i)) >>> 0
  return TILE_TONES[hash % TILE_TONES.length] as string
}

/**
 * Site icon. Only the bare domain is ever sent to the public icon service; a
 * failed load degrades to a letter tile rather than a broken image.
 */
function SiteIcon({ domain }: { domain: string }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [domain])

  if (failed) {
    return (
      <span
        aria-hidden
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full font-semibold text-[10px] uppercase",
          toneFor(domain),
        )}
      >
        {domain.slice(0, 1)}
      </span>
    )
  }
  return (
    <img
      src={faviconUrl(domain)}
      alt=""
      width={20}
      height={20}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="size-5 shrink-0 rounded-full bg-muted/60 object-contain"
    />
  )
}

function metaLine(row: DiscoveredDomain): string {
  const parts = [`${row.cookieCount} cookie${row.cookieCount === 1 ? "" : "s"}`]
  if (row.lastAccess) parts.push(`last used ${relativeTime(row.lastAccess)} ago`)
  return parts.join(" · ")
}

function policyRank(policy: CookieDomainPolicy): number {
  return policy === "continuous" ? 0 : policy === "block" ? 1 : 2
}

/** Segmented toggle button used for the sticky "continuous" / "block" states. */
function SegButton({
  active,
  label,
  disabled,
  onClick,
  children,
}: {
  active: boolean
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border px-2 font-medium text-[11.5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-60",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  )
}

function DomainRow({
  row,
  busy,
  synced,
  onSyncOnce,
  onPolicy,
}: {
  row: DiscoveredDomain
  busy: boolean
  synced: number | null
  onSyncOnce: () => void
  onPolicy: (policy: CookieDomainPolicy) => void
}) {
  const blocked = row.policy === "block"
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-2 py-2 transition-colors hover:bg-accent/40">
      <SiteIcon domain={row.domain} />
      <div className="flex min-w-0 flex-1 basis-40 flex-col">
        <span
          className={cn(
            "truncate font-mono text-[12.5px] text-foreground",
            blocked && "line-through opacity-70",
          )}
        >
          {row.domain}
        </span>
        <span className="truncate text-[11px] text-muted-foreground">{metaLine(row)}</span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || blocked}
          onClick={onSyncOnce}
          aria-label={`Sync ${row.domain} once`}
        >
          {busy ? (
            <Spinner />
          ) : synced != null ? (
            <>
              <Check className="size-3.5 text-success" />
              {synced}
            </>
          ) : (
            "Sync"
          )}
        </Button>
        <div
          role="group"
          aria-label={`Standing setting for ${row.domain}`}
          className="flex items-center gap-0.5 rounded-lg border border-border bg-muted/30 p-0.5"
        >
          <SegButton
            active={row.policy === "continuous"}
            label={`Sync ${row.domain} continuously`}
            disabled={busy}
            onClick={() => onPolicy(row.policy === "continuous" ? "none" : "continuous")}
          >
            <Repeat className="size-3.5" />
            <span className="hidden sm:inline">Continuous</span>
          </SegButton>
          <SegButton
            active={blocked}
            label={`Block ${row.domain}`}
            disabled={busy}
            onClick={() => onPolicy(blocked ? "none" : "block")}
          >
            <Ban className="size-3.5" />
            <span className="hidden sm:inline">Block</span>
          </SegButton>
        </div>
      </div>
    </li>
  )
}

/**
 * "Sync cookies from Chrome": per-site one-off sync, continuous sync, or block,
 * plus Sync All. Every decision is persisted by the Bun side; the state it
 * returns is the source of truth here.
 */
export function CookieSyncModal({
  open,
  onOpenChange,
  onSynced,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after cookies are successfully injected, so the host can reload the
   *  pane — synced cookies only take effect on the next page load. */
  onSynced?: () => void
}) {
  const [rows, setRows] = useState<DiscoveredDomain[]>([])
  const [state, setState] = useState<CookieSyncState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyDomain, setBusyDomain] = useState<string | null>(null)
  const [syncedCounts, setSyncedCounts] = useState<Record<string, number>>({})
  const [allBusy, setAllBusy] = useState(false)
  const [allResult, setAllResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [query, setQuery] = useState("")
  const alive = useRef(true)

  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? rows.filter((row) => row.domain.includes(q)) : rows
  }, [rows, query])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    void Promise.all([cookieSyncGetSettings(), cookieSyncListDomains()])
      .then(([next, list]) => {
        if (!alive.current) return
        setState(next)
        setRows(list)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (!alive.current) return
        setError((err as Error).message || "Could not read Chrome cookies.")
        setLoading(false)
      })
  }, [])

  // Reload each time the dialog opens: Chrome's store moves under us.
  useEffect(() => {
    if (open) {
      setQuery("")
      load()
    }
  }, [open, load])

  /** Fold a fresh CookieSyncState back into the visible rows. */
  const applyState = useCallback((next: CookieSyncState) => {
    setState(next)
    setRows((current) =>
      current
        .map((row) => {
          const policy: CookieDomainPolicy = next.blocked.includes(row.domain)
            ? "block"
            : next.domains.includes(row.domain)
              ? "continuous"
              : "none"
          return { ...row, policy, known: policy !== "none" }
        })
        .sort(
          (a, b) =>
            policyRank(a.policy) - policyRank(b.policy) ||
            (b.lastAccess ?? 0) - (a.lastAccess ?? 0) ||
            a.domain.localeCompare(b.domain),
        ),
    )
  }, [])

  const setPolicy = async (domain: string, policy: CookieDomainPolicy) => {
    setBusyDomain(domain)
    setActionError(null)
    try {
      const next = await cookieSyncSetPolicy(domain, policy)
      if (alive.current) applyState(next)
    } catch (err) {
      if (alive.current) setActionError((err as Error).message || "Could not save.")
    } finally {
      if (alive.current) setBusyDomain(null)
    }
  }

  const syncOne = async (domain: string) => {
    setBusyDomain(domain)
    setActionError(null)
    const result = await cookieSyncSyncDomains([domain])
    if (!alive.current) return
    setBusyDomain(null)
    if (result.ok) {
      onSynced?.()
      setSyncedCounts((current) => ({ ...current, [domain]: result.count }))
      window.setTimeout(() => {
        if (!alive.current) return
        setSyncedCounts((current) => {
          const { [domain]: _drop, ...rest } = current
          return rest
        })
      }, 2600)
    } else {
      setActionError(result.error || "Sync failed.")
    }
  }

  const syncAll = async () => {
    setAllBusy(true)
    setAllResult(null)
    const result = await cookieSyncSyncDomains()
    if (!alive.current) return
    setAllBusy(false)
    if (result.ok) onSynced?.()
    setAllResult({
      ok: result.ok,
      text: result.ok
        ? `Synced ${result.count} cookie${result.count === 1 ? "" : "s"} — reload or revisit a site to see your session`
        : result.error || "Sync failed.",
    })
    try {
      const next = await cookieSyncGetSettings()
      if (alive.current) setState(next)
    } catch {
      /* the result line already reports the outcome */
    }
  }

  /** Finishing here means the first-launch prompt has served its purpose. */
  const finish = () => {
    void cookieSyncCompleteFirstRun()
    onOpenChange(false)
  }

  const chromeMissing = !!state && !state.chromeAvailable

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) finish()
        else onOpenChange(true)
      }}
    >
      <DialogPopup className="h-[min(85vh,44rem)] max-w-xl gap-0 p-0">
        <header className="flex shrink-0 flex-col gap-2 border-border/70 border-b px-5 py-4 pr-12">
          <div className="flex flex-col gap-1">
            <h2 className="font-semibold text-[15px] tracking-tight">Sync cookies from Chrome</h2>
            <p className="text-[12.5px] text-muted-foreground">
              Copies your logged-in sessions into Chunky's built-in browser. Cookies are read locally
              on this Mac and never uploaded.
            </p>
          </div>
          {!loading && !error && !chromeMissing && rows.length > 0 ? (
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Search ${rows.length} sites`}
                spellCheck={false}
                aria-label="Search sites"
                className="h-8 w-full rounded-lg border border-input bg-muted/30 py-1 pr-3 pl-8 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-ring focus:ring-[3px] focus:ring-ring/25"
              />
            </div>
          ) : null}
        </header>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {loading ? (
            <div className="p-5">
              <Loading rows={4} />
            </div>
          ) : error ? (
            <div className="p-5">
              <ErrorNote message={error} onRetry={load} />
            </div>
          ) : chromeMissing || rows.length === 0 ? (
            <div className="p-5">
              <EmptyNote>
                {chromeMissing
                  ? "No Chrome cookies found for this profile."
                  : "No sites with cookies were found in Chrome."}
              </EmptyNote>
            </div>
          ) : visibleRows.length === 0 ? (
            <div className="p-5">
              <EmptyNote>No sites match “{query.trim()}”.</EmptyNote>
            </div>
          ) : (
            <ScrollArea className="min-h-0 flex-1" viewportClassName="px-3 py-2">
              <ul className="flex flex-col gap-0.5">
                {visibleRows.map((row) => (
                  <DomainRow
                    key={row.domain}
                    row={row}
                    busy={busyDomain === row.domain}
                    synced={syncedCounts[row.domain] ?? null}
                    onSyncOnce={() => void syncOne(row.domain)}
                    onPolicy={(policy) => void setPolicy(row.domain, policy)}
                  />
                ))}
              </ul>
            </ScrollArea>
          )}
        </div>

        <footer className="flex shrink-0 flex-col gap-2 border-border/70 border-t px-5 py-4">
          {actionError && <InlineError>{actionError}</InlineError>}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span
              role="status"
              className={cn(
                "min-w-0 flex-1 basis-32 text-[11.5px]",
                allResult && !allResult.ok ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {allResult ? allResult.text : "Site icons are loaded from a public icon service."}
            </span>
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="ghost" size="sm" onClick={finish}>
                Done
              </Button>
              <Button size="sm" disabled={allBusy || chromeMissing} onClick={() => void syncAll()}>
                {allBusy ? <Spinner /> : <RefreshCw className="size-3.5" />}
                {allBusy ? "Syncing…" : "Sync All"}
              </Button>
            </div>
          </div>
        </footer>
      </DialogPopup>
    </Dialog>
  )
}
