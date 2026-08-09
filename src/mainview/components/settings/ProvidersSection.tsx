import {
  ArrowLeft,
  Check,
  ExternalLink,
  KeyRound,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  Plus,
  RotateCw,
  X,
} from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { cn } from "~/lib/cn"
import { addCustomProvider, listProviders, logoutProvider, selectProvider, testProviderAuth } from "~/lib/configApi"
import type { CustomProviderInput, ProviderInfo } from "~/lib/configApi"
import { confirm } from "~/lib/confirm"
import { Button } from "../ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu"
import { ProviderMark } from "./ProviderMark"
import { useProviderLogin } from "./useProviderLogin"
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

/**
 * Whether the card offers the OAuth actions (re-authenticate / disconnect).
 *
 * The server does not report a "has a login flow" capability on /api/providers,
 * but every provider with one is a subscription provider (anthropic, codex,
 * grok); metered and custom providers authenticate with a stored key instead.
 */
function isOAuthProvider(p: ProviderInfo): boolean {
  return p.custom !== true && p.billing === "subscription"
}

/**
 * Hand a provider off to a chat session that will work out how to add it.
 * Supplied by the host (App wires it to a fresh session + setup brief); when
 * it is absent the chat path is hidden rather than rendered dead.
 */
export type SetupProviderChat = (providerName: string, baseURL?: string) => Promise<void>

/** A stale credential usually says so; point those at Re-authenticate. */
function looksStale(message: string): boolean {
  return /revok|expir|invalid[_ ]?grant|unauthor|401|re-?auth/i.test(message)
}

type TestState =
  | { status: "running" }
  | { status: "ok" }
  | { status: "error"; message: string; stale: boolean }

/** How long a successful test stays on the card before fading out. */
const TEST_OK_MS = 6000

// ---- Trailing action column ---------------------------------------------
// Every row renders the SAME slots in the same order — [Log in] · Test ·
// Set active/Active · overflow — so the cards read as a table instead of a
// ragged pile. Two rules keep the columns still:
//   1. Each slot has a fixed min width, so a label swap (Test <-> spinner,
//      "Set active" <-> "Active") can never resize its column.
//   2. The group is right-anchored (justify-between on the row), so the
//      optional "Log in" button grows LEFTWARD into free space and leaves the
//      three trailing columns exactly where they are on every row.

// Widths measured against DM Sans 500 at text-xs (12px) plus the size="sm"
// padding/border (22px), with slack for a fallback font:
//   "Log in" 56px · "Test" 47px · "Active" 58px · "Set active" 79px.

/** Fits "Log in" and the spinner that replaces it while polling. */
const LOGIN_SLOT = "min-w-16"
/** Fits "Test" and the spinner that replaces it while running. */
const TEST_SLOT = "min-w-14"
/** Fits the wider label ("Set active") with room to spare, so the swap to
 *  "Active" — and to the busy spinner — leaves the column alone. */
const SELECT_SLOT = "min-w-24"
/** Matches Button size="icon-sm" (size-7), for the overflow placeholder. */
const OVERFLOW_SLOT = "size-7 shrink-0"

export function ProvidersSection({ onSetupProviderChat }: { onSetupProviderChat?: SetupProviderChat }) {
  const providers = useAsync<ProviderInfo[]>(() => listProviders(), [])
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [tests, setTests] = useState<Record<string, TestState>>({})
  const { login, startLogin, clearLogin } = useProviderLogin(providers.reload)
  const okTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const clearTest = useCallback((provider: string) => {
    const timer = okTimers.current.get(provider)
    if (timer) {
      clearTimeout(timer)
      okTimers.current.delete(provider)
    }
    setTests((prev) => {
      if (!(provider in prev)) return prev
      const next = { ...prev }
      delete next[provider]
      return next
    })
  }, [])

  useEffect(() => {
    const timers = okTimers.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }, [])

  const handleLogin = useCallback(
    async (provider: string, reauth = false) => {
      setActionError(null)
      clearTest(provider)
      await startLogin(provider, { reauth })
    },
    [startLogin, clearTest],
  )

  const handleTest = useCallback(
    async (provider: string, wasReady: boolean) => {
      setActionError(null)
      clearTest(provider)
      setTests((prev) => ({ ...prev, [provider]: { status: "running" } }))
      const result = await testProviderAuth(provider)
      setTests((prev) => ({
        ...prev,
        [provider]: result.ok
          ? { status: "ok" }
          : {
              status: "error",
              message: result.error ?? "The connection test failed.",
              // An unsupported route is a server gap, not a stale credential.
              stale: result.unsupported !== true && looksStale(result.error ?? ""),
            },
      }))
      if (result.ok) {
        okTimers.current.set(
          provider,
          setTimeout(() => {
            okTimers.current.delete(provider)
            setTests((prev) => {
              const next = { ...prev }
              delete next[provider]
              return next
            })
          }, TEST_OK_MS),
        )
        // The badge said otherwise, so the list is out of date.
        if (!wasReady) providers.reload()
      }
    },
    [clearTest, providers],
  )

  const handleDisconnect = useCallback(
    async (p: ProviderInfo, thenReauth = false) => {
      const ok = await confirm({
        title: `Disconnect ${p.label}?`,
        body: thenReauth
          ? "Chunky removes the stored credential and then starts a fresh login for this provider."
          : "Chunky removes the stored credential for this provider. You can connect again at any time.",
        confirmLabel: thenReauth ? "Disconnect and log in" : "Disconnect",
        destructive: true,
      })
      if (!ok) return
      setActionError(null)
      clearTest(p.id)
      setBusy(p.id)
      try {
        await logoutProvider(p.id)
        clearLogin()
        providers.reload()
        if (thenReauth) await startLogin(p.id)
      } catch (err) {
        setActionError((err as Error).message)
      } finally {
        setBusy(null)
      }
    },
    [clearTest, clearLogin, providers, startLogin],
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
        <Button variant="outline" size="sm" onClick={() => setShowAdd((v) => !v)}>
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
          {providers.data.map((p) => {
            const test = tests[p.id]
            return (
            <Card key={p.id}>
              <div className="flex items-center justify-between gap-3">
                <ProviderMark id={p.id} label={p.label} className="size-7 shrink-0" />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
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
                      className={LOGIN_SLOT}
                      disabled={login?.provider === p.id && login.polling}
                      onClick={() => void handleLogin(p.id)}
                    >
                      {login?.provider === p.id && login.polling ? <Spinner /> : "Log in"}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn(TEST_SLOT, "text-muted-foreground hover:text-foreground")}
                    disabled={test?.status === "running" || busy === p.id}
                    onClick={() => void handleTest(p.id, p.ready)}
                  >
                    {test?.status === "running" ? <Spinner /> : "Test"}
                  </Button>
                  <Button
                    variant={p.active ? "outline" : "default"}
                    size="sm"
                    className={SELECT_SLOT}
                    disabled={p.active || !p.ready || busy === p.id}
                    onClick={() => void handleSelect(p.id)}
                  >
                    {busy === p.id ? <Spinner /> : p.active ? "Active" : "Set active"}
                  </Button>
                  {isOAuthProvider(p) ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={<Button variant="ghost" size="icon-sm" aria-label={`More ${p.label} actions`} />}
                      >
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {/* Always offered: a provider can report Ready on a
                            credential that no longer works. */}
                        <DropdownMenuItem onClick={() => void handleLogin(p.id, true)}>
                          <RotateCw />
                          Re-authenticate
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onClick={() => void handleDisconnect(p)}>
                          <LogOut />
                          Disconnect
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : (
                    // Nothing to offer on this row (custom / API-key providers
                    // have no re-auth or disconnect action). Hold the column
                    // open with an inert placeholder rather than a dead button:
                    // a control that is rendered has to work.
                    <div aria-hidden className={OVERFLOW_SLOT} />
                  )}
                </div>
              </div>

              {test && test.status !== "running" && (
                <div className="mt-2.5 flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-2.5 text-[12px]">
                  {test.status === "ok" ? (
                    <span className="flex items-center gap-1.5 font-medium text-success">
                      <Check className="size-3.5" />
                      Connection OK
                    </span>
                  ) : (
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <InlineError>{test.message}</InlineError>
                      {test.stale && (
                        <span className="text-[11.5px] text-muted-foreground">
                          That credential looks stale.{" "}
                          <button
                            type="button"
                            className="cursor-pointer font-medium text-primary underline-offset-2 hover:underline"
                            onClick={() => void handleLogin(p.id, true)}
                          >
                            Re-authenticate
                          </button>{" "}
                          to sign in again.
                        </span>
                      )}
                    </div>
                  )}
                  <button
                    type="button"
                    aria-label="Dismiss"
                    className="ml-auto shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
                    onClick={() => clearTest(p.id)}
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              )}

              {login?.provider === p.id && (login.initiation || login.error || login.polling) && (
                <div className="mt-3 rounded-lg border border-border bg-muted/30 p-2.5 text-[12px]">
                  {login.alreadyReady ? (
                    // The provider refused to start a login because a credential
                    // is already stored — the exact case where `ready` can lie.
                    <div className="flex flex-col gap-1.5">
                      <span className="text-muted-foreground">
                        The server still holds a credential for {p.label}, so it did not start a new login. Disconnect
                        it first to sign in again.
                      </span>
                      <div className="flex items-center gap-1.5">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy === p.id}
                          onClick={() => void handleDisconnect(p, true)}
                        >
                          {busy === p.id ? <Spinner /> : "Disconnect and log in"}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={clearLogin}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : login.error ? (
                    <div className="flex items-center justify-between gap-2">
                      <InlineError>{login.error}</InlineError>
                      <button
                        type="button"
                        className="cursor-pointer text-muted-foreground hover:text-foreground"
                        onClick={clearLogin}
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
            )
          })}
        </div>
      )}

      {showAdd && (
        <AddProviderCard
          onSetupProviderChat={onSetupProviderChat}
          onDone={() => {
            setShowAdd(false)
            providers.reload()
          }}
          onCancel={() => setShowAdd(false)}
        />
      )}
    </SectionShell>
  )
}

/** Provider ids are lowercase alphanumerics and dashes, so a typed name can
 *  seed one: "Together AI" -> "together-ai". Editable afterwards. */
function deriveProviderId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/**
 * Adding a provider, in two steps.
 *
 * Step one asks only what the user actually knows: the provider's name, and
 * its base URL if they have it. From there the flow forks:
 *   A. "I have an API key" reveals the fields the server's custom-provider
 *      route already takes (id seeded from the name, label, base URL, key) and
 *      posts them with addCustomProvider.
 *   B. "Set it up with a chat" hands the name to a fresh session with a setup
 *      brief, for a provider whose endpoint/auth story nobody here knows yet.
 *      Hidden entirely when the host supplied no handler.
 */
function AddProviderCard({
  onDone,
  onCancel,
  onSetupProviderChat,
}: {
  onDone: () => void
  onCancel: () => void
  onSetupProviderChat?: SetupProviderChat
}) {
  const [step, setStep] = useState<"intro" | "key">("intro")
  const [name, setName] = useState("")
  const [baseURL, setBaseURL] = useState("")
  // The key lives here and nowhere else: it goes up with the POST and is never
  // read back, persisted, or logged.
  const [form, setForm] = useState<CustomProviderInput>({ id: "", label: "", baseURL: "", apiKey: "" })
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [handoff, setHandoff] = useState(false)

  const set = (k: keyof CustomProviderInput, v: string) => setForm((f) => ({ ...f, [k]: v }))

  /** Path A: carry step one's answers into the full form. */
  const toKeyStep = () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError("Enter the provider's name first.")
      return
    }
    setError(null)
    setForm((f) => ({
      ...f,
      id: f.id || deriveProviderId(trimmed),
      label: f.label || trimmed,
      baseURL: f.baseURL || baseURL.trim(),
    }))
    setStep("key")
  }

  /** Path B: the host closes Settings and opens the seeded chat. */
  const startChat = async () => {
    if (!onSetupProviderChat) return
    const trimmed = name.trim()
    if (!trimmed) {
      setError("Enter the provider's name first.")
      return
    }
    setError(null)
    setHandoff(true)
    try {
      await onSetupProviderChat(trimmed, baseURL.trim() || undefined)
      // Nothing was added here, so close without re-reading the list.
      onCancel()
    } catch (err) {
      setError((err as Error).message)
      setHandoff(false)
    }
  }

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

  if (step === "intro") {
    return (
      <Card className="border-primary/25">
        <SubLabel>Add a provider</SubLabel>
        <div className="flex flex-col gap-2.5 pt-1">
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">Provider name</span>
            <TextInput
              value={name}
              onChange={setName}
              placeholder="Together, Fireworks, my-llm-host…"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") toKeyStep()
              }}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">Base URL (optional)</span>
            <TextInput
              value={baseURL}
              onChange={setBaseURL}
              placeholder="https://api.example.com/v1"
              monospace
            />
          </div>
          <p className="text-[11.5px] text-muted-foreground">
            Chunky talks to OpenAI-compatible endpoints. Have the URL and a key? Add it directly.
            {onSetupProviderChat
              ? " Otherwise a chat can work out the endpoint and how it authenticates."
              : ""}
          </p>
          {error && <InlineError>{error}</InlineError>}
          <div className="flex flex-wrap justify-end gap-1.5 pt-1">
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={handoff}>
              Cancel
            </Button>
            {onSetupProviderChat && (
              <Button variant="outline" size="sm" disabled={handoff} onClick={() => void startChat()}>
                {handoff ? <Spinner /> : <MessageSquare className="size-3.5" />}
                Set it up with a chat
              </Button>
            )}
            <Button size="sm" disabled={handoff} onClick={toKeyStep}>
              <KeyRound className="size-3.5" />
              I have an API key
            </Button>
          </div>
        </div>
      </Card>
    )
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
      <div className="flex flex-wrap justify-end gap-1.5 pt-3">
        <Button
          variant="ghost"
          size="sm"
          disabled={saving}
          onClick={() => {
            setError(null)
            setStep("intro")
          }}
        >
          <ArrowLeft className="size-3.5" />
          Back
        </Button>
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
