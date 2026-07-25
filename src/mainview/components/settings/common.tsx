// Shared building blocks for the Settings Center sections.
import { AlertCircle, Loader2, RotateCw } from "lucide-react"
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DependencyList,
  type ReactNode,
} from "react"
import { cn } from "~/lib/cn"
import { EFFORTS, SPEEDS, prettyModel, providerLabel, splitModelKey } from "~/lib/configApi"
import type { Effort, ModelRow, Speed } from "~/lib/configApi"
import { Skeleton } from "../ui/skeleton"

// ---- Async data loading --------------------------------------------------

export interface AsyncState<T> {
  data: T | null
  loading: boolean
  error: string | null
  reload: () => void
  setData: (updater: T | ((prev: T | null) => T | null)) => void
}

/** Load async data with stale-guarding + a reload() trigger. */
export function useAsync<T>(loader: () => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const gen = useRef(0)

  const reload = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    const g = ++gen.current
    setLoading(true)
    setError(null)
    loader()
      .then((d) => {
        if (g === gen.current) {
          setData(d)
          setLoading(false)
        }
      })
      .catch((e: unknown) => {
        if (g === gen.current) {
          setError((e as Error).message || "Something went wrong")
          setLoading(false)
        }
      })
    return () => {
      gen.current++
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])

  const update = useCallback((updater: T | ((prev: T | null) => T | null)) => {
    setData((prev) =>
      typeof updater === "function" ? (updater as (p: T | null) => T | null)(prev) : updater,
    )
  }, [])

  return { data, loading, error, reload, setData: update }
}

// ---- Layout primitives ---------------------------------------------------

export function SectionShell({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <h2 className="font-semibold text-[15px] tracking-tight">{title}</h2>
          {description && <p className="text-[12.5px] text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>
      {children}
    </div>
  )
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("rounded-xl border border-border bg-card/40 p-3.5", className)}>
      {children}
    </div>
  )
}

export function FieldRow({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium text-[13px]">{title}</span>
        {description && <span className="text-[12px] text-muted-foreground">{description}</span>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function SubLabel({ children }: { children: ReactNode }) {
  return (
    <p className="pb-1 font-medium text-[10.5px] text-muted-foreground uppercase tracking-wide">
      {children}
    </p>
  )
}

// ---- Status primitives ---------------------------------------------------

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-11 w-full" />
      ))}
    </div>
  )
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-[12.5px] text-destructive">
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 flex-1">{message}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="flex shrink-0 cursor-pointer items-center gap-1 font-medium underline-offset-2 hover:underline"
        >
          <RotateCw className="size-3" />
          Retry
        </button>
      )}
    </div>
  )
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border border-dashed bg-muted/20 p-6 text-center text-[12.5px] text-muted-foreground">
      {children}
    </div>
  )
}

export function InlineError({ children }: { children: ReactNode }) {
  return <p className="text-[11.5px] text-destructive">{children}</p>
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("size-3.5 animate-spin", className)} />
}

export type BadgeTone = "success" | "warning" | "muted" | "primary" | "destructive"

export function Badge({ tone = "muted", children }: { tone?: BadgeTone; children: ReactNode }) {
  const tones: Record<BadgeTone, string> = {
    success: "border-success/30 bg-success/10 text-success",
    warning: "border-warning/30 bg-warning/10 text-amber-700 dark:text-amber-300",
    muted: "border-border bg-muted/50 text-muted-foreground",
    primary: "border-primary/30 bg-primary/10 text-primary",
    destructive: "border-destructive/30 bg-destructive/10 text-destructive",
  }
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-medium text-[10px]",
        tones[tone],
      )}
    >
      {children}
    </span>
  )
}

// ---- Form controls -------------------------------------------------------

export function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
  disabled,
  className,
  onKeyDown,
  autoFocus,
  monospace,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  disabled?: boolean
  className?: string
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void
  autoFocus?: boolean
  monospace?: boolean
}) {
  return (
    <input
      value={value}
      type={type}
      disabled={disabled}
      placeholder={placeholder}
      spellCheck={false}
      // eslint-disable-next-line jsx-a11y/no-autofocus
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus-visible:border-ring/60 focus-visible:ring-2 focus-visible:ring-ring/25 disabled:pointer-events-none disabled:opacity-60",
        monospace && "font-mono text-[12px]",
        className,
      )}
    />
  )
}

export function Select({
  value,
  onChange,
  disabled,
  className,
  children,
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "h-8 min-w-0 cursor-pointer rounded-lg border border-input bg-background px-2 text-[13px] text-foreground outline-none transition-colors focus-visible:border-ring/60 focus-visible:ring-2 focus-visible:ring-ring/25 disabled:pointer-events-none disabled:opacity-60",
        className,
      )}
    >
      {children}
    </select>
  )
}

const INHERIT = "__inherit__"

/** Provider+model picker backed by the flattened catalog rows. Value is the
 *  UI key `provider/modelId`, or "" for the inherit/none option. */
export function ModelSelect({
  rows,
  value,
  onChange,
  allowInherit = false,
  inheritLabel = "Inherit",
  disabled,
  className,
}: {
  rows: ModelRow[]
  value: string
  onChange: (v: string) => void
  allowInherit?: boolean
  inheritLabel?: string
  disabled?: boolean
  className?: string
}) {
  const groups = new Map<string, ModelRow[]>()
  for (const r of rows) {
    const list = groups.get(r.provider) ?? []
    list.push(r)
    groups.set(r.provider, list)
  }
  // Ensure the current value is representable even if catalogs are still loading.
  const parts = value ? splitModelKey(value) : null
  const known = rows.some((r) => `${r.provider}/${r.model.id}` === value)

  return (
    <Select
      value={value === "" && allowInherit ? INHERIT : value}
      onChange={(v) => onChange(v === INHERIT ? "" : v)}
      disabled={disabled}
      className={cn("max-w-[15rem]", className)}
    >
      {allowInherit && <option value={INHERIT}>{inheritLabel}</option>}
      {!allowInherit && value === "" && (
        <option value="" disabled>
          Select a model…
        </option>
      )}
      {parts && !known && (
        <option value={value}>
          {providerLabel(parts.provider)} · {prettyModel(parts.model)}
        </option>
      )}
      {[...groups.entries()].map(([provider, list]) => (
        <optgroup key={provider} label={providerLabel(provider)}>
          {list.map((r) => (
            <option key={`${provider}/${r.model.id}`} value={`${provider}/${r.model.id}`}>
              {r.model.name || prettyModel(r.model.id)}
              {r.ready ? "" : " (not logged in)"}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  )
}

export function EffortSelect({
  value,
  onChange,
  allowInherit = false,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  allowInherit?: boolean
  disabled?: boolean
}) {
  return (
    <Select
      value={value === "" && allowInherit ? INHERIT : value}
      onChange={(v) => onChange(v === INHERIT ? "" : v)}
      disabled={disabled}
      className="w-[7.5rem]"
    >
      {allowInherit && <option value={INHERIT}>Default effort</option>}
      {!allowInherit && value === "" && (
        <option value="" disabled>
          Effort…
        </option>
      )}
      {EFFORTS.map((e) => (
        <option key={e} value={e}>
          {e}
        </option>
      ))}
    </Select>
  )
}

export function SpeedSelect({
  value,
  onChange,
  allowInherit = false,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  allowInherit?: boolean
  disabled?: boolean
}) {
  return (
    <Select
      value={value === "" && allowInherit ? INHERIT : value}
      onChange={(v) => onChange(v === INHERIT ? "" : v)}
      disabled={disabled}
      className="w-[7.5rem]"
    >
      {allowInherit && <option value={INHERIT}>Default speed</option>}
      {SPEEDS.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </Select>
  )
}

export function asEffort(v: string): Effort | undefined {
  return (EFFORTS as string[]).includes(v) ? (v as Effort) : undefined
}

export function asSpeed(v: string): Speed | undefined {
  return (SPEEDS as string[]).includes(v) ? (v as Speed) : undefined
}
