import { Monitor, Moon, Sparkles, Sun, Wifi } from "lucide-react"
import { useState } from "react"
import { getCacheGuard, runDream, setCacheGuard } from "~/lib/configApi"
import type { CacheGuardResponse } from "~/lib/configApi"
import { cn } from "~/lib/cn"
import { useTheme, type ThemeMode } from "~/lib/theme"
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

export function GeneralSection({ connection }: { connection?: { state: string; baseUrl: string; workspace: string; sessionCount: number; mode: "live" | "demo" } }) {
  const { mode, setMode } = useTheme()

  return (
    <SectionShell title="General" description="Appearance, cache safety, and repository memory.">
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
        <FieldRow title={connection.mode === "live" ? connection.state : "Demo mode"} description={connection.mode === "live" ? "Local Chunky server connection." : "Mock data only; no server is connected."}>
          <Wifi className={cn("size-4", connection.state === "connected" && connection.mode === "live" ? "text-success" : "text-muted-foreground")} />
        </FieldRow>
        <div className="grid gap-1 border-border/60 border-t pt-3 text-[12px] text-muted-foreground">
          <span className="truncate" title={connection.baseUrl}>Server · {connection.baseUrl}</span>
          <span className="truncate" title={connection.workspace}>Workspace · {connection.workspace || "—"}</span>
          <span>Sessions · {connection.sessionCount}</span>
        </div>
      </Card>}

      <CacheGuardCard />
      <DreamCard />
    </SectionShell>
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
