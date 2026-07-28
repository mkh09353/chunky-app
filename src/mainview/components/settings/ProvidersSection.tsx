import { Check, ExternalLink, Plus, X } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  addCustomProvider,
  getProviderAuthStatus,
  listProviders,
  selectProvider,
  startProviderLogin,
} from "~/lib/configApi"
import type { CustomProviderInput, LoginInitiation, ProviderInfo } from "~/lib/configApi"
import { openExternal } from "~/lib/openExternal"
import { Button } from "../ui/button"
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

interface LoginState {
  provider: string
  initiation: LoginInitiation | null
  polling: boolean
  error: string | null
}

export function ProvidersSection() {
  const providers = useAsync<ProviderInfo[]>(() => listProviders(), [])
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [login, setLogin] = useState<LoginState | null>(null)
  const [showCustom, setShowCustom] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  useEffect(() => () => stopPoll(), [stopPoll])

  const beginPoll = useCallback(
    (provider: string) => {
      stopPoll()
      let attempts = 0
      pollRef.current = setInterval(async () => {
        attempts += 1
        try {
          const status = await getProviderAuthStatus(provider)
          if (status.ready) {
            stopPoll()
            setLogin(null)
            providers.reload()
          } else if (status.error) {
            stopPoll()
            setLogin((s) => (s && s.provider === provider ? { ...s, polling: false, error: status.error ?? "Login failed" } : s))
          }
        } catch {
          /* keep polling; transient */
        }
        if (attempts > 90) {
          stopPoll()
          setLogin((s) =>
            s && s.provider === provider ? { ...s, polling: false, error: "Login timed out. Try again." } : s,
          )
        }
      }, 2000)
    },
    [providers, stopPoll],
  )

  const handleLogin = useCallback(
    async (provider: string) => {
      setActionError(null)
      setLogin({ provider, initiation: null, polling: true, error: null })
      try {
        const initiation = await startProviderLogin(provider)
        setLogin({ provider, initiation, polling: initiation.kind !== "ready", error: null })
        if (initiation.kind === "ready") {
          setLogin(null)
          providers.reload()
          return
        }
        if (initiation.kind === "url" && initiation.url) {
          // Native app: hands off to the OS browser; browser dev: new tab.
          openExternal(initiation.url)
        }
        beginPoll(provider)
      } catch (err) {
        setLogin({ provider, initiation: null, polling: false, error: (err as Error).message })
      }
    },
    [beginPoll, providers],
  )

  const handleSelect = useCallback(
    async (provider: string) => {
      setActionError(null)
      setBusy(provider)
      try {
        await selectProvider(provider)
        providers.reload()
      } catch (err) {
        setActionError((err as Error).message)
      } finally {
        setBusy(null)
      }
    },
    [providers],
  )

  return (
    <SectionShell
      title="Providers"
      description="Log in to model providers and choose the active one. Add your own OpenAI-compatible endpoint too."
      actions={
        <Button variant="outline" size="sm" onClick={() => setShowCustom((v) => !v)}>
          <Plus className="size-3.5" />
          Custom
        </Button>
      }
    >
      {actionError && <ErrorNote message={actionError} />}

      {providers.loading ? (
        <Loading rows={4} />
      ) : providers.error ? (
        <ErrorNote message={providers.error} onRetry={providers.reload} />
      ) : !providers.data || providers.data.length === 0 ? (
        <EmptyNote>No providers reported by the server.</EmptyNote>
      ) : (
        <div className="flex flex-col gap-2">
          {providers.data.map((p) => (
            <Card key={p.id}>
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-[13.5px]">{p.label}</span>
                    {p.active && (
                      <Badge tone="primary">
                        <Check className="size-2.5" />
                        Active
                      </Badge>
                    )}
                    {p.custom && <Badge tone="muted">Custom</Badge>}
                    <Badge tone={p.ready ? "success" : "warning"}>
                      {p.ready ? "Ready" : "Not logged in"}
                    </Badge>
                  </div>
                  {p.billing && (
                    <span className="text-[11.5px] text-muted-foreground">Billing: {p.billing}</span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {!p.ready && (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={login?.provider === p.id && login.polling}
                      onClick={() => void handleLogin(p.id)}
                    >
                      {login?.provider === p.id && login.polling ? <Spinner /> : "Log in"}
                    </Button>
                  )}
                  <Button
                    variant={p.active ? "outline" : "default"}
                    size="sm"
                    disabled={p.active || !p.ready || busy === p.id}
                    onClick={() => void handleSelect(p.id)}
                  >
                    {busy === p.id ? <Spinner /> : p.active ? "Active" : "Set active"}
                  </Button>
                </div>
              </div>

              {login?.provider === p.id && (login.initiation || login.error || login.polling) && (
                <div className="mt-3 rounded-lg border border-border bg-muted/30 p-2.5 text-[12px]">
                  {login.error ? (
                    <div className="flex items-center justify-between gap-2">
                      <InlineError>{login.error}</InlineError>
                      <button
                        type="button"
                        className="cursor-pointer text-muted-foreground hover:text-foreground"
                        onClick={() => setLogin(null)}
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      <span className="text-muted-foreground">
                        {login.initiation?.instructions ?? "Starting login…"}
                      </span>
                      {login.initiation?.kind === "url" && (
                        <div className="flex flex-col gap-1">
                          <a
                            href={login.initiation.url}
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center gap-1.5 font-medium text-primary underline-offset-2 hover:underline"
                          >
                            <ExternalLink className="size-3.5" />
                            Open login page
                          </a>
                          {login.initiation.userCode && (
                            <span className="font-mono text-[12px]">
                              Code: <span className="font-semibold">{login.initiation.userCode}</span>
                            </span>
                          )}
                        </div>
                      )}
                      {login.polling && (
                        <span className="flex items-center gap-1.5 text-muted-foreground">
                          <Spinner />
                          Waiting for authorization…
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {showCustom && (
        <CustomProviderForm
          onDone={() => {
            setShowCustom(false)
            providers.reload()
          }}
          onCancel={() => setShowCustom(false)}
        />
      )}
    </SectionShell>
  )
}

function CustomProviderForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [form, setForm] = useState<CustomProviderInput>({ id: "", label: "", baseURL: "", apiKey: "" })
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const set = (k: keyof CustomProviderInput, v: string) => setForm((f) => ({ ...f, [k]: v }))

  const submit = async () => {
    if (!form.id.trim() || !form.baseURL.trim()) {
      setError("Provider id and base URL are required.")
      return
    }
    setSaving(true)
    setError(null)
    try {
      await addCustomProvider({
        id: form.id.trim(),
        label: form.label.trim() || form.id.trim(),
        baseURL: form.baseURL.trim(),
        apiKey: form.apiKey,
      })
      onDone()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="border-primary/25">
      <SubLabel>Add a custom OpenAI-compatible provider</SubLabel>
      <div className="grid grid-cols-2 gap-2.5 pt-1">
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">Provider id</span>
          <TextInput value={form.id} onChange={(v) => set("id", v)} placeholder="my-openai" monospace />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">Label</span>
          <TextInput value={form.label} onChange={(v) => set("label", v)} placeholder="My OpenAI" />
        </div>
        <div className="col-span-2 flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">Base URL</span>
          <TextInput
            value={form.baseURL}
            onChange={(v) => set("baseURL", v)}
            placeholder="https://api.example.com/v1"
            monospace
          />
        </div>
        <div className="col-span-2 flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">API key</span>
          <TextInput
            value={form.apiKey}
            onChange={(v) => set("apiKey", v)}
            placeholder="sk-…"
            type="password"
            monospace
          />
        </div>
      </div>
      {error && <div className="pt-2"><InlineError>{error}</InlineError></div>}
      <div className="flex justify-end gap-1.5 pt-3">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void submit()} disabled={saving}>
          {saving ? <Spinner /> : "Add provider"}
        </Button>
      </div>
    </Card>
  )
}
