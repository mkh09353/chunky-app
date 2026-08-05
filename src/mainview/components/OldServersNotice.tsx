import { useState } from "react"
import { cn } from "~/lib/cn"
import { confirm } from "~/lib/confirm"
import {
  classifyServers,
  forceStopWarning,
  type OldServerRow,
} from "~/lib/oldServers"
import {
  retireChunkyServer,
  stopChunkyServer,
  type ServerInspection,
} from "~/lib/serverLifecycle"
import { Button } from "./ui/button"

/** Roughly how long a drain is allowed to take before the server gives up. */
const DRAIN_HINT = "Finishes in-flight work first, then exits — up to about 5 minutes."

/**
 * Superseded Chunky servers that are still running after a runtime upgrade.
 *
 * Presentation only: the rows and their available actions come from
 * lib/oldServers, and the caller owns when to inspect and when to dismiss.
 * Sits where every other transient notice does — bottom right, above the
 * composer, dismissible.
 */
export function OldServersNotice({
  inspection,
  onRefresh,
  onDismiss,
}: {
  inspection: ServerInspection | null
  /** Re-inspect after an action so the list reflects what actually happened. */
  onRefresh: () => Promise<void>
  /** Hide until the next launch or upgrade announcement (in-memory). */
  onDismiss: () => void
}) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  /** The idle row currently asking "are you sure?" inline. */
  const [armed, setArmed] = useState<string | null>(null)

  const rows = classifyServers(inspection)
  if (rows.length === 0) return null

  const run = async (id: string, action: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusyId(id)
    setErrors((prev) => {
      if (!prev[id]) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    let result: { ok: boolean; error?: string }
    try {
      result = await action()
    } catch (err) {
      result = { ok: false, error: (err as Error).message }
    }
    setBusyId(null)
    setArmed(null)
    if (!result.ok) {
      setErrors((prev) => ({ ...prev, [id]: result.error || "The server did not respond." }))
      return
    }
    // The row may now be gone, still draining, or unchanged: ask rather than guess.
    await onRefresh()
  }

  const forceStop = async (row: OldServerRow) => {
    const ok = await confirm({
      title: `Stop Chunky ${row.version} now?`,
      body: `${forceStopWarning(row)} Work in progress on ${row.workspace} will be lost.`,
      confirmLabel: "Stop now",
      destructive: true,
    })
    if (!ok) return
    await run(row.id, () => stopChunkyServer(row.id))
  }

  return (
    <div className="fixed right-5 bottom-5 z-50 flex max-h-[60vh] w-[22rem] flex-col overflow-y-auto rounded-xl border border-border/70 bg-popover shadow-panel">
      <div className="flex flex-col gap-0.5 px-4 pt-3 pb-2">
        <span className="font-medium text-[13px]">Older Chunky servers are still running</span>
        <span className="text-[11.5px] text-muted-foreground">
          A newer version took over. These can be shut down when their work is done.
        </span>
      </div>

      <div className="flex flex-col divide-y divide-border/60 border-border/60 border-t">
        {rows.map((row) => {
          const busy = busyId === row.id
          const error = errors[row.id]
          return (
            <div key={row.id} className="flex flex-col gap-1.5 px-4 py-2.5">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[11.5px] text-muted-foreground">{row.version}</span>
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{row.workspace}</span>
              </div>

              <span
                className={cn(
                  "text-[11.5px]",
                  row.tone === "warn" ? "text-warning" : "text-muted-foreground",
                )}
              >
                {row.statusLabel}
              </span>

              {row.canRetire && (
                <span className="text-[11px] text-muted-foreground/70">{DRAIN_HINT}</span>
              )}

              {error && <span className="text-[11.5px] text-destructive">{error}</span>}

              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                {row.canStop &&
                  (armed === row.id ? (
                    <>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busy}
                        onClick={() => void run(row.id, () => stopChunkyServer(row.id))}
                      >
                        {busy ? "Stopping…" : "Confirm stop"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setArmed(null)}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setArmed(row.id)}
                    >
                      Stop server
                    </Button>
                  ))}

                {row.canRetire && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void run(row.id, () => retireChunkyServer(row.id))}
                  >
                    {busy ? "Working…" : "Finish work, then stop"}
                  </Button>
                )}

                {row.canForceStop && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void forceStop(row)}
                    className="cursor-pointer text-[11.5px] text-muted-foreground underline-offset-2 outline-none transition-colors hover:text-destructive hover:underline focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-60"
                  >
                    Stop now
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="flex items-center justify-end border-border/60 border-t px-4 py-2">
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Keep running
        </Button>
      </div>
    </div>
  )
}
