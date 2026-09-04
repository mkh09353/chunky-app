import { AlertTriangle, ArrowLeft, Check, ChevronDown, Copy, RotateCw } from "lucide-react"
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import type { ModeAdvisor } from "@chunky/protocol"
import { applyOnboardingMode, completeOnboarding, getOnboarding } from "~/lib/configApi"
import { prettyModelName } from "~/lib/api"
import type {
  LoginInitiation,
  OnboardingProvider,
  OnboardingResponse,
  SuggestedMode,
} from "~/lib/configApi"
import {
  connectTitle,
  fireProgressLine,
  fireSummary,
  hasRecommendation,
  isModeLocked,
  isRecommendedReady,
  lockedOn,
  onboardingProviderLabel,
  otherSuggestions,
  providerNames,
  recommendedMode,
  recommendedProviders,
  splitProviders,
} from "~/lib/onboarding"
import { modeEmoji } from "~/lib/modes"
import { cn } from "~/lib/cn"
import { copyText } from "~/lib/clipboard"
import { DRAG_REGION } from "~/lib/dragRegion"
import { useOverlayLock } from "~/lib/nativeOverlayGuard"
import { Button } from "../ui/button"
import { InlineError, Loading, Spinner, useAsync } from "./common"
import { ProviderMark } from "./ProviderMark"
import { useProviderLogin } from "./useProviderLogin"

/**
 * The boot read of onboarding state: does the wizard need to open, AND what did
 * the server recommend. One request, two consumers — App keeps the payload so
 * the post-setup fire nudge needs no second call.
 *
 * Null when the server is unreachable (nothing we can do offline): callers must
 * treat that as "don't open the wizard, don't nudge".
 */
export async function loadOnboarding(): Promise<OnboardingResponse | null> {
  try {
    return await getOnboarding()
  } catch {
    return null
  }
}

/** True when the server reports the user has not completed onboarding yet. */
export function needsOnboarding(state: OnboardingResponse | null): boolean {
  return state != null && state.onboardedAt == null
}

const STEPS = ["Connect a provider", "Pick a mode", "Finish"] as const

/** Applied-mode bookkeeping for one wizard run: which mode is pinned, and
 *  whether the USER chose it (an explicit alternative is never overridden by a
 *  later auto-apply of the recommendation). */
interface AppliedState {
  name: string
  byUser: boolean
}

/** Dev-only: `?onboarding=1` opens the flow against fixture data so the layout
 *  can be developed (and screenshotted) without a reachable server. Variants:
 *  `fail` = load error, `ready` = fire unlocked (auto-apply path), `old` = a
 *  runtime that sends no recommendation (today's flow). Stripped from
 *  production builds — `import.meta.env.DEV` is false there. */
const DEV_ONBOARDING_VARIANTS = ["1", "fail", "ready", "old"] as const
type DevOnboardingVariant = (typeof DEV_ONBOARDING_VARIANTS)[number]

function devOnboardingParam(): DevOnboardingVariant | null {
  if (!import.meta.env.DEV || typeof window === "undefined") return null
  const v = new URLSearchParams(window.location.search).get("onboarding")
  return DEV_ONBOARDING_VARIANTS.includes(v as DevOnboardingVariant)
    ? (v as DevOnboardingVariant)
    : null
}

export function devOnboardingRequested(): boolean {
  return devOnboardingParam() != null
}

function devOnboardingFixture(variant: DevOnboardingVariant): OnboardingResponse {
  const codexReady = variant === "ready"
  const missing = codexReady ? [] : ["codex"]
  const base: OnboardingResponse = {
    onboardedAt: null,
    providers: [
      {
        id: "anthropic",
        label: "Anthropic",
        status: "ready",
        detail: "Claude subscription detected.",
        ready: true,
      },
      {
        id: "codex",
        label: "Codex",
        status: codexReady ? "ready" : "missing",
        detail: codexReady ? "Signed in." : "CLI detected; not signed in.",
        ready: codexReady,
      },
      { id: "zen", label: "Zen", status: "missing", detail: "Free tier available.", ready: false },
      { id: "grok", label: "Grok", status: "missing", detail: "API key required.", ready: false },
    ],
    recommended: { name: "fire", requires: ["anthropic", "codex"], missing },
    suggestedModes: [
      {
        name: "fire",
        description: "The full Chunky pairing: a lead, a sidekick, an advisor and named seats.",
        locked: missing.length > 0,
        ...(missing.length > 0 ? { missingProviders: missing } : {}),
        spec: {
          provider: "anthropic",
          model: "claude-fable-5-1[1m]",
          effort: "high",
          sidekick: { provider: "codex", model: "gpt-5.6-sol", effort: "medium" },
          advisor: { provider: "codex", model: "gpt-5.6-sol", effort: "high" },
          sidekickSeats: {
            frontend: { provider: "anthropic", model: "opus[1m]", effort: "medium" },
            // `speed` rides along on newer servers; ModeAdvisor doesn't declare
            // it yet, so the fixture asserts the shape the server will send.
            websearch: {
              provider: "codex",
              model: "gpt-5.6-luna",
              effort: "high",
              speed: "fast",
            } as ModeAdvisor,
          },
        },
      },
      {
        name: "balanced",
        description: "Sonnet executor with a GPT advisor — the everyday pairing.",
        spec: { provider: "anthropic", model: "claude-sonnet-4-6", effort: "medium" },
      },
      {
        name: "deep",
        description: "Opus executor at high effort for gnarly refactors.",
        spec: { provider: "anthropic", model: "claude-opus-4-1", effort: "high" },
      },
      {
        name: "thrifty",
        description: "Fast, cheap models for scripted or repetitive work.",
        spec: { provider: "zen", model: "glm-4.6", effort: "low" },
      },
    ],
  }
  // "old" mimics a runtime that predates the recommendation: no `recommended`,
  // no locks, no fire entry — the classic three-step flow.
  if (variant === "old") {
    return {
      ...base,
      recommended: null,
      suggestedModes: base.suggestedModes
        .filter((m) => m.name !== "fire")
        .map(({ name, description, spec }) => ({ name, description, spec, locked: false })),
    }
  }
  return base
}

/** Apply a mode — short-circuited in the dev fixture, which has no server. */
async function applyMode(mode: SuggestedMode): Promise<void> {
  if (import.meta.env.DEV && devOnboardingRequested()) {
    await new Promise((resolve) => setTimeout(resolve, 400))
    return
  }
  await applyOnboardingMode(mode)
}

/** Mark onboarding complete — likewise a no-op in the dev fixture, so the
 *  flow can be walked end to end without a server behind the proxy. */
async function completeSetup(): Promise<void> {
  if (import.meta.env.DEV && devOnboardingRequested()) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    return
  }
  await completeOnboarding()
}

/** Status pill shape shared by READY / SIGN IN / SIGNING IN. */
const PILL =
  "inline-flex h-[22px] shrink-0 items-center justify-center gap-1.5 rounded-full px-2.5 font-mono text-[10.5px] font-medium uppercase leading-none tracking-[0.08em]"

/** Docked CTA pill shape (Buzz's 38px onboarding button). */
const CTA = "h-[2.375rem] min-w-[180px] rounded-full px-6 text-sm"

export function OnboardingWizard({
  open,
  onOpenChange,
  onComplete,
  onOpenProviderSettings,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onComplete?: () => void
  /** Optional: open the Settings center at the Providers section. */
  onOpenProviderSettings?: () => void
}) {
  // Only hit the server while the flow is on screen; reopening re-reads state.
  const onboarding = useAsync<OnboardingResponse | null>(
    () =>
      !open
        ? Promise.resolve(null)
        : // The literal DEV check lets the bundler drop the fixture entirely.
          import.meta.env.DEV && devOnboardingRequested()
          ? devOnboardingParam() === "fail"
            ? Promise.reject(new Error("Dev fixture: the server didn't respond."))
            : Promise.resolve(devOnboardingFixture(devOnboardingParam() ?? "1"))
          : getOnboarding(),
    [open],
  )
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [finishError, setFinishError] = useState<string | null>(null)
  const [applied, setApplied] = useState<AppliedState | null>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)

  // A fresh run starts at the beginning with nothing applied.
  useEffect(() => {
    if (!open) {
      setStep(0)
      setApplied(null)
      setFinishError(null)
    }
  }, [open])

  // Hand-rolled full-window surface (no Base UI portal), so it takes the
  // overlay lock itself — "always", since it covers the entire window — and the
  // browser pane's native webview steps aside.
  useOverlayLock(open, "always")

  const data = onboarding.data
  const providers = data?.providers ?? []
  const anyReady = providers.some((p) => p.ready)
  const isLast = step === STEPS.length - 1

  // Keyboard: land focus on the primary CTA so Enter advances the flow.
  useEffect(() => {
    if (open) primaryRef.current?.focus()
  }, [open, step])

  const close = useCallback(() => {
    onComplete?.()
    onOpenChange(false)
  }, [onComplete, onOpenChange])

  /** Finish: surface a failure (server may be down) and stay put. */
  const finish = useCallback(async () => {
    setBusy(true)
    setFinishError(null)
    try {
      await completeSetup()
      close()
    } catch (err) {
      setFinishError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [close])

  /** Skip / Settings link: never soft-lock, close even if the call fails. */
  const bailOut = useCallback(
    async (after?: () => void) => {
      setBusy(true)
      try {
        await completeSetup()
      } catch {
        /* offline or already complete — closing anyway */
      }
      setBusy(false)
      close()
      after?.()
    },
    [close],
  )

  if (!open) return null

  const primaryDisabled = busy || (step === 0 && !anyReady)

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Set up Chunky"
      // Explicit buttons are the only way out: no Escape/click-outside dismiss.
      onKeyDown={(e) => {
        if (e.key === "Escape") e.stopPropagation()
      }}
      className="chunky-onboarding-bg fixed inset-0 z-100 overflow-y-auto text-foreground"
    >
      {/* This surface covers the whole window, including the app's normal drag
          strips, so it carries its own: a fixed band across the top (clear of
          every control, which starts at pt-28) that keeps the window movable. */}
      <div
        aria-hidden
        className={cn(DRAG_REGION, "fixed inset-x-0 top-0 z-30 h-14")}
      />
      <OnboardingChrome step={step} />

      <div className="flex min-h-full w-full flex-col items-center px-6 pt-28 pb-52">
        {onboarding.loading ? (
          <div className="w-full max-w-[520px] pt-16">
            <Loading rows={4} />
          </div>
        ) : onboarding.error ? (
          <LoadErrorStep message={onboarding.error} onRetry={onboarding.reload} />
        ) : step === 0 ? (
          <ProviderStep data={data} providers={providers} onReload={onboarding.reload} />
        ) : step === 1 ? (
          <ModeStep
            data={data}
            applied={applied}
            onApplied={setApplied}
            onConnectProviders={() => setStep(0)}
          />
        ) : (
          <FinishStep ready={anyReady} data={data} applied={applied} />
        )}
      </div>

      {/* Docked CTA stack over a scrim so content fades under it. */}
      <div
        aria-hidden
        className="chunky-onboarding-scrim pointer-events-none fixed inset-x-0 bottom-0 z-10 h-40"
      />
      <div className="pointer-events-none fixed inset-x-0 bottom-6 z-20 flex justify-center px-4">
        <div className="pointer-events-auto flex w-full max-w-[520px] flex-col items-center gap-2.5">
          {finishError && <InlineError>{finishError}</InlineError>}

          <Button
            ref={primaryRef}
            className={CTA}
            disabled={primaryDisabled}
            onClick={() => (isLast ? void finish() : setStep((s) => s + 1))}
          >
            {busy && isLast ? <Spinner /> : isLast ? <Check className="size-3.5" /> : null}
            {isLast ? "Finish setup" : "Next"}
          </Button>

          <Button
            variant="ghost"
            className={cn(CTA, "bg-foreground/5 hover:bg-foreground/10")}
            disabled={busy}
            onClick={() => void bailOut()}
          >
            Skip for now
          </Button>

          {step > 0 && (
            <Button
              variant="ghost"
              className="h-8 rounded-full px-4 text-[13px] text-muted-foreground hover:text-foreground"
              onClick={() => setStep((s) => Math.max(0, s - 1))}
            >
              <ArrowLeft className="size-3.5" />
              Back
            </Button>
          )}

          <p className="pt-1 text-center text-[12px] text-muted-foreground">
            More providers and settings in{" "}
            <button
              type="button"
              disabled={busy}
              onClick={() => void bailOut(onOpenProviderSettings)}
              className="cursor-pointer underline underline-offset-2 hover:text-foreground disabled:opacity-60"
            >
              Settings → Providers
            </button>{" "}
            after setup.
          </p>
        </div>
      </div>
    </div>
  )
}

/** Top chrome: the mark at the left, pagination dots dead centre. */
function OnboardingChrome({ step }: { step: number }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-10 z-10 flex items-center px-6">
      <img src="/chunky-mark.svg" alt="" aria-hidden className="size-7 opacity-80" />
      <div
        aria-hidden
        className="-translate-x-1/2 -translate-y-1/2 absolute top-1/2 left-1/2 flex items-center gap-2"
      >
        {STEPS.map((label, i) => (
          <span
            key={label}
            className={cn(
              "block rounded-full",
              i === step ? "h-1.5 w-7 bg-foreground" : "h-1.5 w-1.5 bg-foreground/30",
            )}
          />
        ))}
      </div>
    </div>
  )
}

// ---- Shared layout pieces -------------------------------------------------

function StepHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="w-full max-w-[820px] text-center">
      <h1 className="font-medium text-3xl tracking-tight md:text-4xl">{title}</h1>
      <p className="mx-auto mt-3 max-w-[640px] text-[14px] text-muted-foreground leading-6">
        {subtitle}
      </p>
    </div>
  )
}

/** Borderless card: soft surface floating in a feathered halo (see index.css). */
function GlowCard({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className="relative min-w-0">
      <div aria-hidden className="chunky-glow-halo pointer-events-none absolute -inset-16 z-0" />
      <div
        className={cn(
          "chunky-glow-surface relative z-1 flex h-full min-w-0 flex-col rounded-2xl p-5",
          className,
        )}
      >
        {children}
      </div>
    </div>
  )
}

// ---- Step 1: providers ----------------------------------------------------

/** getOnboarding() failed (server down / restarting): offer a retry. The docked
 *  Skip / Settings buttons stay live, so this is never a dead end. */
function LoadErrorStep({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section className="flex w-full flex-1 flex-col items-center">
      <StepHeader
        title="Can't reach Chunky"
        subtitle="The server didn't answer, so we couldn't check which providers are available."
      />
      <div className="flex w-full flex-1 flex-col items-center justify-center py-12">
        <GlowCard className="w-full max-w-[560px] items-center justify-center gap-4 px-8 py-10 text-center">
          <p className="max-w-[26rem] text-[13px] text-destructive leading-5">{message}</p>
          <button
            type="button"
            onClick={onRetry}
            className={cn(
              PILL,
              "cursor-pointer bg-primary/15 text-primary outline-none motion-safe:transition-colors hover:bg-primary/25 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            )}
          >
            <RotateCw className="size-3" />
            Retry
          </button>
          <p className="text-[11px] text-muted-foreground leading-4">
            You can also skip setup and connect a provider later.
          </p>
        </GlowCard>
      </div>
    </section>
  )
}

/** A collapsed section that opens in place — used for "More providers" and
 *  "Use something else for now", both of which must stay out of the way of the
 *  one thing this wizard is selling. */
function Disclosure({
  label,
  children,
  className,
}: {
  label: string
  children: ReactNode
  className?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className={cn("flex w-full min-w-0 flex-col items-center gap-5", className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex cursor-pointer items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground"
      >
        <ChevronDown className={cn("size-3.5 motion-safe:transition-transform", open && "rotate-180")} />
        {label}
      </button>
      {open && <div className="flex w-full min-w-0 flex-col items-center">{children}</div>}
    </div>
  )
}

function ProviderStep({
  data,
  providers,
  onReload,
}: {
  data: OnboardingResponse | null | undefined
  providers: OnboardingProvider[]
  onReload: () => void
}) {
  const { login, startLogin, isPolling } = useProviderLogin(onReload)
  const requires = recommendedProviders(data)
  const { hero, rest } = splitProviders(providers, requires)
  // Old server (no recommendation) → today's flat four-card grid.
  const fireFirst = hero.length > 0
  const shown = fireFirst ? hero : providers.slice(0, 4)
  const more = fireFirst ? rest : []
  const progress = fireProgressLine(data)
  const ready = isRecommendedReady(data)

  const card = (p: OnboardingProvider) => (
    <ProviderCard
      key={p.id}
      provider={p}
      polling={isPolling(p.id)}
      error={login?.provider === p.id ? login.error : null}
      // Device code / instructions belong to the one pending login only:
      // the hook nulls `login` on success and drops `polling` on
      // failure or timeout, so this clears itself.
      initiation={login?.provider === p.id && login.polling ? login.initiation : null}
      onSignIn={() => void startLogin(p.id)}
    />
  )

  return (
    <section className="flex w-full flex-1 flex-col items-center">
      <StepHeader
        title={fireFirst ? connectTitle(data) : "Connect a provider"}
        subtitle={
          fireFirst
            ? `Chunky is at its best with both signed in — that's what ${data?.recommended?.name ?? "the recommended mode"} runs on. You can continue with just one.`
            : "Chunky checks for model providers on this machine. Sign in to at least one to continue."
        }
      />

      <div className="flex w-full flex-1 flex-col items-center justify-center gap-8 py-12">
        {progress && (
          <p
            role="status"
            className={cn(
              "max-w-[36rem] text-center text-[13px] leading-5",
              ready ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {progress}
          </p>
        )}

        {shown.length > 0 ? (
          <div
            className={cn(
              "grid w-full min-w-0 gap-6 grid-cols-1 md:grid-cols-2",
              fireFirst ? "max-w-[760px]" : "max-w-[1200px] lg:grid-cols-4",
            )}
          >
            {shown.map(card)}
          </div>
        ) : (
          <GlowCard className="max-w-[560px] items-center justify-center px-8 py-8 text-center">
            <p className="text-[13px] text-muted-foreground">
              No providers reported by the server yet.
            </p>
          </GlowCard>
        )}

        {more.length > 0 && (
          <Disclosure label="More providers">
            <div className="grid w-full min-w-0 max-w-[760px] grid-cols-1 gap-6 md:grid-cols-2">
              {more.map(card)}
            </div>
          </Disclosure>
        )}

        <button
          type="button"
          onClick={onReload}
          className="flex cursor-pointer items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground"
        >
          <RotateCw className="size-3" />
          Check again
        </button>
      </div>
    </section>
  )
}

/** How long the copied-check stays up on the device-code copy button. */
const COPY_FEEDBACK_MS = 1600

function ProviderCard({
  provider,
  polling,
  error,
  initiation,
  onSignIn,
}: {
  provider: OnboardingProvider
  polling: boolean
  error: string | null
  /** Pending login details for THIS provider, or null when nothing is in flight. */
  initiation: LoginInitiation | null
  onSignIn: () => void
}) {
  // Onboarding spelling: the title says "Connect Claude and Codex", so the card
  // under it must not say "Anthropic". Server labels stay authoritative for
  // every provider that has no onboarding alias.
  const label = onboardingProviderLabel(provider.id) || provider.label
  const detail =
    provider.detail ??
    (provider.ready ? "Credentials detected on this machine." : "Sign in to use this provider.")

  // A device-code login (Codex, Grok) opens a page that asks for a code the
  // user can only get from here — show it, or the wizard is a dead end.
  const pending = polling && initiation && initiation.kind !== "ready" ? initiation : null
  const userCode = pending?.kind === "url" ? pending.userCode : undefined

  const [copied, setCopied] = useState<boolean | null>(null)
  const copyTimer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    },
    [],
  )

  // Stale confirmation would outlive the code it belongs to.
  useEffect(() => {
    if (!userCode) setCopied(null)
  }, [userCode])

  const copyCode = useCallback(async (code: string) => {
    const ok = await copyText(code)
    setCopied(ok)
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => {
      setCopied(null)
      copyTimer.current = null
    }, COPY_FEEDBACK_MS)
  }, [])

  return (
    <GlowCard className="min-h-[224px] select-none items-center justify-center gap-3 px-4 text-center">
      <ProviderMark id={provider.id} label={label} className="size-11" />
      <h2 className="max-w-full truncate font-normal text-[14px] text-foreground leading-5">
        {label}
      </h2>

      {provider.ready ? (
        <span className={cn(PILL, "bg-foreground/10 text-foreground")}>Ready</span>
      ) : polling ? (
        <span className={cn(PILL, "bg-foreground/10 text-foreground")} role="status">
          <Spinner className="size-3" />
          Signing in
        </span>
      ) : (
        <button
          type="button"
          onClick={onSignIn}
          aria-label={`Sign in to ${label}`}
          className={cn(
            PILL,
            "cursor-pointer bg-primary/15 text-primary outline-none motion-safe:transition-colors hover:bg-primary/25 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          )}
        >
          Sign in
        </button>
      )}

      {pending && (
        <div className="flex w-full min-w-0 flex-col items-center gap-1.5">
          {userCode && (
            <div className="flex w-full min-w-0 items-center justify-center gap-1.5 rounded-lg border border-border bg-muted/30 px-2 py-1.5">
              <code className="min-w-0 select-text break-all font-mono font-semibold text-[13px] text-foreground leading-4 tracking-[0.12em]">
                {userCode}
              </code>
              <button
                type="button"
                onClick={() => void copyCode(userCode)}
                aria-label={`Copy ${label} login code`}
                className="shrink-0 cursor-pointer rounded-md p-0.5 text-muted-foreground outline-none motion-safe:transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                {copied === true ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              </button>
            </div>
          )}
          <p className="max-w-[13rem] text-[11px] text-muted-foreground leading-4" role="status">
            {copied === true
              ? "Code copied."
              : copied === false
                ? "Couldn't copy — select the code above."
                : pending.instructions}
          </p>
        </div>
      )}

      {error ? (
        <p className="max-w-[13rem] text-[11px] text-destructive leading-4">{error}</p>
      ) : pending ? null : (
        <p className="max-w-[13rem] text-[11px] text-muted-foreground leading-4">{detail}</p>
      )}
    </GlowCard>
  )
}

// ---- Step 2: suggested modes ---------------------------------------------

/** The recommended mode's pairing, in plain words. Every label comes from the
 *  spec the server sent — no model names live in this file. */
function SeatList({ spec, className }: { spec: SuggestedMode["spec"]; className?: string }) {
  const seats = fireSummary(spec)
  if (seats.length === 0) return null
  return (
    <dl className={cn("flex w-full min-w-0 flex-col gap-1.5 text-left", className)}>
      {seats.map((seat) => (
        <div key={`${seat.role}-${seat.detail}`} className="flex min-w-0 items-baseline gap-2">
          <dt className="w-[5.5rem] shrink-0 text-[12px] text-muted-foreground">{seat.role}</dt>
          <dd className="min-w-0 break-words text-[13px] text-foreground leading-5">
            {seat.detail}
            <span className="text-muted-foreground"> · {seat.provider}</span>
          </dd>
        </div>
      ))}
    </dl>
  )
}

function ModeStep({
  data,
  applied,
  onApplied,
  onConnectProviders,
}: {
  data: OnboardingResponse | null | undefined
  applied: AppliedState | null
  onApplied: (state: AppliedState) => void
  onConnectProviders: () => void
}) {
  const recommended = recommendedMode(data)
  if (hasRecommendation(data) && recommended) {
    return (
      <RecommendedModeStep
        data={data}
        mode={recommended}
        applied={applied}
        onApplied={onApplied}
        onConnectProviders={onConnectProviders}
      />
    )
  }
  return <LegacyModeStep modes={data?.suggestedModes ?? []} applied={applied} onApplied={onApplied} />
}

/** Fire-first: one hero card that applies itself the moment it can. */
function RecommendedModeStep({
  data,
  mode,
  applied,
  onApplied,
  onConnectProviders,
}: {
  data: OnboardingResponse | null | undefined
  mode: SuggestedMode
  applied: AppliedState | null
  onApplied: (state: AppliedState) => void
  onConnectProviders: () => void
}) {
  const locked = isModeLocked(mode, data)
  const missing = lockedOn(mode, data)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const isApplied = applied?.name === mode.name
  // An alternative the user picked deliberately outranks the auto-apply.
  const overridden = !!applied && applied.name !== mode.name && applied.byUser

  const apply = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await applyMode(mode)
      onApplied({ name: mode.name, byUser: false })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [mode, onApplied])

  // Auto-apply on entering the step — once, and never for a locked spec (that
  // is a guaranteed 409) or over a mode the user chose themselves.
  const startedRef = useRef(false)
  useEffect(() => {
    if (locked || overridden || isApplied || startedRef.current) return
    startedRef.current = true
    void apply()
  }, [locked, overridden, isApplied, apply])

  const retry = () => {
    setAttempt((n) => n + 1)
    void apply()
  }

  const emoji = modeEmoji(mode.name)

  return (
    <section className="flex w-full flex-1 flex-col items-center">
      <StepHeader
        title={locked ? `${emoji} ${mode.name} is one sign-in away` : `You're getting ${mode.name}`}
        subtitle={
          locked
            ? `${providerNames(missing)} isn't connected yet, so ${mode.name} can't be applied. Connect it and we'll set it up for you.`
            : mode.description ||
              `${mode.name} pairs a lead, a sidekick and named seats so every job goes to the right model.`
        }
      />

      <div className="flex w-full flex-1 flex-col items-center justify-center gap-6 py-12">
        <GlowCard
          className={cn(
            "w-full max-w-[560px] gap-4 px-7 py-7",
            isApplied && "ring-2 ring-primary/40",
          )}
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <span aria-hidden className="text-[20px] leading-none">
              {emoji}
            </span>
            <h2 className="min-w-0 truncate font-normal text-[16px] text-foreground leading-5">
              {mode.name}
            </h2>
            {isApplied ? (
              <span className={cn(PILL, "ml-auto bg-foreground/10 text-foreground")}>
                <Check className="size-3" />
                Applied
              </span>
            ) : locked ? (
              <span className={cn(PILL, "ml-auto bg-warning/15 text-amber-700 dark:text-amber-300")}>
                Locked
              </span>
            ) : busy ? (
              <span className={cn(PILL, "ml-auto bg-foreground/10 text-foreground")} role="status">
                <Spinner className="size-3" />
                Applying
              </span>
            ) : null}
          </div>

          <SeatList spec={mode.spec} />

          {locked && (
            <button
              type="button"
              onClick={onConnectProviders}
              className={cn(
                PILL,
                "self-start cursor-pointer bg-primary/15 text-primary outline-none motion-safe:transition-colors hover:bg-primary/25 focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              Connect {providerNames(missing)}
            </button>
          )}

          {overridden && !locked && (
            <p className="text-[12px] text-muted-foreground leading-4">
              You applied {applied?.name} — we left it in place.
            </p>
          )}
        </GlowCard>

        {error && (
          <div className="flex flex-col items-center gap-2">
            <InlineError>{error}</InlineError>
            <button
              type="button"
              key={attempt}
              disabled={busy}
              onClick={retry}
              className={cn(
                PILL,
                "cursor-pointer bg-primary/15 text-primary outline-none hover:bg-primary/25 disabled:opacity-60",
              )}
            >
              {busy ? <Spinner className="size-3" /> : <RotateCw className="size-3" />}
              Retry
            </button>
          </div>
        )}

        {/* Alternatives exist only as an escape hatch while fire is locked. */}
        {locked && otherSuggestions(data).length > 0 && (
          <Disclosure label="Use something else for now">
            <AlternativeModes
              modes={otherSuggestions(data)}
              applied={applied}
              onApplied={onApplied}
            />
          </Disclosure>
        )}
      </div>
    </section>
  )
}

/** The classic grid of equal suggestions (older servers, and the locked-fire
 *  escape hatch). */
function AlternativeModes({
  modes,
  applied,
  onApplied,
}: {
  modes: SuggestedMode[]
  applied: AppliedState | null
  onApplied: (state: AppliedState) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const apply = async (mode: SuggestedMode) => {
    setBusy(mode.name)
    setError(null)
    try {
      await applyMode(mode)
      onApplied({ name: mode.name, byUser: true })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex w-full min-w-0 flex-col items-center gap-6">
      {error && <InlineError>{error}</InlineError>}
      <div className="grid w-full min-w-0 max-w-[1200px] grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
        {modes.map((mode) => {
          const isApplied = applied?.name === mode.name
          return (
            <GlowCard
              key={mode.name}
              className={cn(
                "min-h-[224px] items-center justify-center gap-3 px-5 text-center",
                isApplied && "ring-2 ring-primary/40",
              )}
            >
              <h2 className="max-w-full truncate font-normal text-[15px] text-foreground leading-5">
                {mode.name}
              </h2>
              <p className="max-w-[16rem] text-[12px] text-muted-foreground leading-4">
                {mode.description ||
                  `${onboardingProviderLabel(mode.spec.provider)} · ${prettyModelName(mode.spec.model)}${
                    mode.spec.effort ? ` · effort ${mode.spec.effort}` : ""
                  }`}
              </p>
              {isApplied ? (
                <span className={cn(PILL, "bg-foreground/10 text-foreground")}>
                  <Check className="size-3" />
                  Applied
                </span>
              ) : (
                <button
                  type="button"
                  disabled={busy === mode.name}
                  onClick={() => void apply(mode)}
                  className={cn(
                    PILL,
                    "cursor-pointer bg-primary/15 text-primary outline-none motion-safe:transition-colors hover:bg-primary/25 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-60",
                  )}
                >
                  {busy === mode.name ? <Spinner className="size-3" /> : null}
                  Apply
                </button>
              )}
            </GlowCard>
          )
        })}
      </div>
    </div>
  )
}

function LegacyModeStep({
  modes,
  applied,
  onApplied,
}: {
  modes: SuggestedMode[]
  applied: AppliedState | null
  onApplied: (state: AppliedState) => void
}) {
  return (
    <section className="flex w-full flex-1 flex-col items-center">
      <StepHeader
        title="Pick a mode"
        subtitle="A tuned executor + advisor pairing to start from. Optional — you can change this any time in Settings."
      />

      <div className="flex w-full flex-1 flex-col items-center justify-center gap-6 py-12">
        {modes.length === 0 ? (
          <GlowCard className="max-w-[560px] items-center justify-center px-8 py-8 text-center">
            <p className="text-[13px] text-muted-foreground">
              No suggested modes — you're all set to continue.
            </p>
          </GlowCard>
        ) : (
          <AlternativeModes modes={modes} applied={applied} onApplied={onApplied} />
        )}
      </div>
    </section>
  )
}

// ---- Step 3: finish -------------------------------------------------------

function FinishStep({
  ready,
  data,
  applied,
}: {
  ready: boolean
  data: OnboardingResponse | null | undefined
  applied: AppliedState | null
}) {
  const recommended = recommendedMode(data)
  // "You're running fire" only when fire is what actually got pinned.
  const fireApplied = !!recommended && applied?.name === recommended.name
  const missing = lockedOn(recommended, data)

  if (fireApplied && recommended) {
    return (
      <section className="flex w-full flex-1 flex-col items-center">
        <StepHeader
          title={`You're running ${recommended.name}`}
          subtitle={`Every new thread starts with this pairing. Type /${recommended.name} to re-apply it any time — modes live in Settings → Modes.`}
        />
        <div className="flex w-full flex-1 flex-col items-center justify-center py-12">
          <GlowCard className="w-full max-w-[560px] gap-4 px-7 py-7">
            <div className="flex min-w-0 items-center gap-2.5">
              <span aria-hidden className="text-[20px] leading-none">
                {modeEmoji(recommended.name)}
              </span>
              <h2 className="min-w-0 truncate font-normal text-[16px] text-foreground leading-5">
                {recommended.name}
              </h2>
              <span className={cn(PILL, "ml-auto bg-foreground/10 text-foreground")}>
                <Check className="size-3" />
                Applied
              </span>
            </div>
            <SeatList spec={recommended.spec} />
          </GlowCard>
        </div>
      </section>
    )
  }

  return (
    <section className="flex w-full flex-1 flex-col items-center">
      <StepHeader
        title="You're set up"
        subtitle="That's the essentials. Models, sidekick seats, skills and more are all in Settings whenever you need them."
      />

      <div className="flex w-full flex-1 flex-col items-center justify-center py-12">
        <GlowCard className="w-full max-w-[560px] items-center justify-center gap-3 px-8 py-10 text-center">
          {ready ? (
            <>
              <span className={cn(PILL, "bg-foreground/10 text-foreground")}>
                <Check className="size-3" />
                Ready
              </span>
              <p className="max-w-[26rem] text-[13px] text-muted-foreground leading-5">
                A provider is connected. Finish setup and start your first thread.
              </p>
            </>
          ) : (
            <>
              <span className={cn(PILL, "bg-warning/15 text-amber-700 dark:text-amber-300")}>
                <AlertTriangle className="size-3" />
                No provider
              </span>
              <p className="max-w-[26rem] text-[13px] text-muted-foreground leading-5">
                No provider is logged in yet. You can still finish, but Chunky won't run until one
                is connected from Settings → Providers.
              </p>
            </>
          )}
          {recommended && missing.length > 0 && (
            <p className="max-w-[26rem] text-[12px] text-muted-foreground leading-5">
              {modeEmoji(recommended.name)} Connect {providerNames(missing)} in Settings → Providers
              to unlock {recommended.name}, then run /{recommended.name}.
            </p>
          )}
        </GlowCard>
      </div>
    </section>
  )
}
