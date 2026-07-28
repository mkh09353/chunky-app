// Session-scoped sidekick picker: the `/sidekick` surface inside a chat.
// Everything it writes is a PER-SESSION override (lib/configApi calls carry the
// session id), so one thread's sidekick never bleeds into the others. The
// global defaults for new threads still live in Settings → Sidekick.
import { Bot, Check, Loader2, RotateCcw } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { providerLabel } from "~/lib/api"
import { cn } from "~/lib/cn"
import {
  deleteSeat,
  getSidekick,
  prettyModel,
  saveDefaultSeat,
  saveNamedSeat,
} from "~/lib/configApi"
import type { ModelRow, SeatConfig, SidekickConfig } from "~/lib/configApi"
import { Button } from "./ui/button"
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu"
import { Switch } from "./ui/switch"

/** Same provider ordering as the composer's model picker. */
const PROVIDER_ORDER = ["zen", "grok", "codex", "anthropic"]

function providerSortKey(vendor: string): string {
  const i = PROVIDER_ORDER.indexOf(vendor.toLowerCase())
  return i >= 0 ? `${i}-${vendor}` : `9-${vendor}`
}

function seatKey(cfg: SeatConfig): string {
  return cfg.provider && cfg.model ? `${cfg.provider}/${cfg.model}` : ""
}

function seatLabel(cfg: SeatConfig, rows: ModelRow[], inheritLabel: string): string {
  if (!cfg.provider || !cfg.model) return inheritLabel
  const row = rows.find((r) => r.provider === cfg.provider && r.model.id === cfg.model)
  return row?.model.name || prettyModel(cfg.model)
}

export function SidekickPicker({
  open,
  onOpenChange,
  sessionId,
  rows,
  onChanged,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The session every write is scoped to. */
  sessionId: string
  rows: ModelRow[]
  /** Effective config after a change — lets the composer status repaint. */
  onChanged?: (next: SidekickConfig) => void
}) {
  const [config, setConfig] = useState<SidekickConfig | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Read this session's EFFECTIVE config (its overrides merged over the global
  // defaults) each time the picker opens.
  useEffect(() => {
    if (!open || !sessionId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    getSidekick(sessionId)
      .then((cfg) => {
        if (!cancelled) setConfig(cfg)
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, sessionId])

  const apply = useCallback(
    async (key: string, run: () => Promise<SidekickConfig>) => {
      setBusy(key)
      setError(null)
      try {
        const next = await run()
        setConfig(next)
        onChanged?.(next)
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setBusy(null)
      }
    },
    [onChanged],
  )

  const def = config?.default ?? {}
  const namedSeats = Object.entries(config?.seats ?? {})

  const setDefault = (patch: SeatConfig) =>
    apply("default", () => saveDefaultSeat({ ...def, ...patch }, sessionId))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="size-4 text-primary" />
            Sidekick
            <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-medium text-[10.5px] text-primary">
              this thread
            </span>
          </DialogTitle>
          <DialogDescription>
            Applies to this thread only. Settings → Sidekick sets the default that new threads
            start from.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 px-6 pb-4">
          {loading && !config ? (
            <div className="flex items-center gap-2 py-6 text-[12.5px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Loading sidekick config…
            </div>
          ) : (
            <>
              <div className="rounded-xl border border-border p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-col">
                    <span className="font-medium text-[13.5px]">Default seat</span>
                    <span className="text-[11.5px] text-muted-foreground">
                      The worker the lead delegates to when no named seat is asked for.
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {busy === "default" && <Loader2 className="size-3.5 animate-spin text-primary" />}
                    <Switch
                      checked={def.enabled ?? false}
                      disabled={busy !== null}
                      onCheckedChange={(v) => void setDefault({ enabled: v })}
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3 pt-3">
                  <span className="text-[12px] text-muted-foreground">Model</span>
                  <ModelMenu
                    rows={rows}
                    value={seatKey(def)}
                    label={seatLabel(def, rows, "Inherit executor")}
                    allowInherit
                    inheritLabel="Inherit executor"
                    disabled={busy !== null || !(def.enabled ?? false)}
                    onPick={(v) => {
                      const slash = v.indexOf("/")
                      void setDefault(
                        v
                          ? { provider: v.slice(0, slash), model: v.slice(slash + 1) }
                          : { provider: null, model: null },
                      )
                    }}
                  />
                </div>
              </div>

              {namedSeats.length > 0 && (
                <div className="flex flex-col gap-2">
                  <span className="font-medium text-[11.5px] text-muted-foreground uppercase tracking-wide">
                    Named seats
                  </span>
                  {namedSeats.map(([name, cfg]) => (
                    <div
                      key={name}
                      className="flex items-center justify-between gap-3 rounded-xl border border-border p-3"
                    >
                      <span className="truncate font-medium font-mono text-[12.5px]">{name}</span>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {busy === `seat:${name}` && (
                          <Loader2 className="size-3.5 animate-spin text-primary" />
                        )}
                        <ModelMenu
                          rows={rows}
                          value={seatKey(cfg)}
                          label={seatLabel(cfg, rows, "Pick a model")}
                          disabled={busy !== null}
                          onPick={(v) => {
                            const slash = v.indexOf("/")
                            void apply(`seat:${name}`, () =>
                              saveNamedSeat(
                                name,
                                {
                                  ...cfg,
                                  provider: v.slice(0, slash),
                                  model: v.slice(slash + 1),
                                },
                                sessionId,
                              ),
                            )
                          }}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy !== null}
                          title="Drop this thread's override and use the global seat again"
                          onClick={() =>
                            void apply(`seat:${name}`, () => deleteSeat(name, sessionId))
                          }
                        >
                          <RotateCcw className="size-3.5" />
                          Reset
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <p className="text-[11px] text-muted-foreground">
                Changes take effect on this thread's next delegation. Named seats are created in
                Settings → Sidekick; here you re-point or reset them for this thread.
              </p>
            </>
          )}

          {error && (
            <div className="rounded-lg border border-destructive/25 bg-destructive/10 px-2.5 py-1.5 text-[11.5px] text-destructive">
              {error}
            </div>
          )}
        </div>
      </DialogPopup>
    </Dialog>
  )
}

/** The composer model picker's menu, reused for a seat's model. */
function ModelMenu({
  rows,
  value,
  label,
  allowInherit = false,
  inheritLabel = "Inherit",
  disabled,
  onPick,
}: {
  rows: ModelRow[]
  /** "provider/model", or "" for inherit/unset. */
  value: string
  label: string
  allowInherit?: boolean
  inheritLabel?: string
  disabled?: boolean
  onPick: (value: string) => void
}) {
  const groups = new Map<string, ModelRow[]>()
  for (const r of rows) {
    const list = groups.get(r.provider) ?? []
    list.push(r)
    groups.set(r.provider, list)
  }
  const ordered = [...groups.entries()].sort((a, b) =>
    providerSortKey(a[0]).localeCompare(providerSortKey(b[0])),
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={
          <Button variant="outline" size="sm" className="max-w-[15rem] gap-1.5 font-normal" />
        }
      >
        <span className="truncate">{label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="end"
        className="flex max-h-80 min-w-64 flex-col overflow-hidden p-0"
      >
        <div className="border-border/70 border-b px-2.5 py-1.5">
          <DropdownMenuLabel className="p-0">Model · this thread</DropdownMenuLabel>
        </div>
        <div className="overflow-y-auto p-1">
          {allowInherit && (
            <DropdownMenuItem onClick={() => onPick("")} className={cn(!value && "bg-accent/60")}>
              <span className="flex size-4 shrink-0 items-center justify-center">
                {!value ? <Check className="size-3.5 text-primary" /> : null}
              </span>
              <span className="text-[13px]">{inheritLabel}</span>
            </DropdownMenuItem>
          )}
          {ordered.length === 0 ? (
            <DropdownMenuItem disabled>No models available</DropdownMenuItem>
          ) : (
            ordered.map(([provider, list], gi) => (
              <div key={provider}>
                {(gi > 0 || allowInherit) && <DropdownMenuSeparator />}
                <DropdownMenuLabel>{providerLabel(provider)}</DropdownMenuLabel>
                {list.map((r) => {
                  const key = `${r.provider}/${r.model.id}`
                  const selected = key === value
                  return (
                    <DropdownMenuItem
                      key={key}
                      disabled={!r.ready}
                      onClick={() => onPick(key)}
                      className={cn(selected && "bg-accent/60")}
                    >
                      <span className="flex size-4 shrink-0 items-center justify-center">
                        {selected ? (
                          <Check className="size-3.5 text-primary" />
                        ) : (
                          <Bot className="size-3.5 opacity-50" />
                        )}
                      </span>
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate font-medium text-[13px] text-foreground">
                          {r.model.name || prettyModel(r.model.id)}
                        </span>
                        <span className="truncate text-[11px] text-muted-foreground">
                          {r.ready ? providerLabel(r.provider) : "not logged in"}
                        </span>
                      </div>
                    </DropdownMenuItem>
                  )
                })}
              </div>
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
