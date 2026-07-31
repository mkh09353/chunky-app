import { AlertTriangle, ArrowLeft, Check, RotateCw } from "lucide-react"
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import {
  applyOnboardingMode,
  completeOnboarding,
  getOnboarding,
  prettyModel,
  providerLabel,
} from "~/lib/configApi"
import type { OnboardingProvider, OnboardingResponse, SuggestedMode } from "~/lib/configApi"
import { cn } from "~/lib/cn"
import { Button } from "../ui/button"
import { InlineError, Loading, Spinner, useAsync } from "./common"
import { useProviderLogin } from "./useProviderLogin"

/** True when the server reports the user has not completed onboarding yet.
 *  Returns false when the server is unreachable (nothing we can do offline). */
export async function needsOnboarding(): Promise<boolean> {
  try {
    const data = await getOnboarding()
    return data.onboardedAt == null
  } catch {
    return false
  }
}

const STEPS = ["Connect a provider", "Pick a mode", "Finish"] as const

/** Dev-only: `?onboarding=1` opens the flow against fixture data so the layout
 *  can be developed (and screenshotted) without a reachable server;
 *  `?onboarding=fail` exercises the load-error path. Stripped from production
 *  builds — `import.meta.env.DEV` is false there. */
function devOnboardingParam(): string | null {
  if (!import.meta.env.DEV || typeof window === "undefined") return null
  const v = new URLSearchParams(window.location.search).get("onboarding")
  return v === "1" || v === "fail" ? v : null
}

export function devOnboardingRequested(): boolean {
  return devOnboardingParam() != null
}

function devOnboardingFixture(): OnboardingResponse {
  return {
    onboardedAt: null,
    providers: [
      {
        id: "anthropic",
        label: "Anthropic",
        status: "ready",
        detail: "Claude subscription detected.",
        ready: true,
      },
      { id: "codex", label: "Codex", status: "missing", detail: "CLI detected; not signed in.", ready: false },
      { id: "zen", label: "Zen", status: "missing", detail: "Free tier available.", ready: false },
      { id: "grok", label: "Grok", status: "missing", detail: "API key required.", ready: false },
    ],
    suggestedModes: [
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
            : Promise.resolve(devOnboardingFixture())
          : getOnboarding(),
    [open],
  )
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [finishError, setFinishError] = useState<string | null>(null)
  const primaryRef = useRef<HTMLButtonElement>(null)

  const providers = onboarding.data?.providers ?? []
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
      await completeOnboarding()
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
        await completeOnboarding()
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
      <OnboardingChrome step={step} />

      <div className="flex min-h-full w-full flex-col items-center px-6 pt-28 pb-52">
        {onboarding.loading ? (
          <div className="w-full max-w-[520px] pt-16">
            <Loading rows={4} />
          </div>
        ) : onboarding.error ? (
          <LoadErrorStep message={onboarding.error} onRetry={onboarding.reload} />
        ) : step === 0 ? (
          <ProviderStep providers={providers} onReload={onboarding.reload} />
        ) : step === 1 ? (
          <ModeStep modes={onboarding.data?.suggestedModes ?? []} />
        ) : (
          <FinishStep ready={anyReady} />
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

function ProviderStep({
  providers,
  onReload,
}: {
  providers: OnboardingProvider[]
  onReload: () => void
}) {
  const { login, startLogin, isPolling } = useProviderLogin(onReload)
  const shown = providers.slice(0, 4)

  return (
    <section className="flex w-full flex-1 flex-col items-center">
      <StepHeader
        title="Connect a provider"
        subtitle="Chunky checks for model providers on this machine. Sign in to at least one to continue."
      />

      <div className="flex w-full flex-1 flex-col items-center justify-center gap-8 py-12">
        {shown.length > 0 ? (
          <div className="grid w-full min-w-0 max-w-[1200px] grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4">
            {shown.map((p) => (
              <ProviderCard
                key={p.id}
                provider={p}
                polling={isPolling(p.id)}
                error={login?.provider === p.id ? login.error : null}
                onSignIn={() => void startLogin(p.id)}
              />
            ))}
          </div>
        ) : (
          <GlowCard className="max-w-[560px] items-center justify-center px-8 py-8 text-center">
            <p className="text-[13px] text-muted-foreground">
              No providers reported by the server yet.
            </p>
          </GlowCard>
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

function ProviderCard({
  provider,
  polling,
  error,
  onSignIn,
}: {
  provider: OnboardingProvider
  polling: boolean
  error: string | null
  onSignIn: () => void
}) {
  const detail =
    provider.detail ??
    (provider.ready ? "Credentials detected on this machine." : "Sign in to use this provider.")

  return (
    <GlowCard className="h-[224px] select-none items-center justify-center gap-3 px-4 text-center">
      <span
        aria-hidden
        className="flex size-10 items-center justify-center rounded-xl bg-foreground/8 font-medium text-[16px] text-foreground"
      >
        {provider.label.trim().charAt(0).toUpperCase() || "?"}
      </span>
      <h2 className="max-w-full truncate font-normal text-[14px] text-foreground leading-5">
        {provider.label}
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
          aria-label={`Sign in to ${provider.label}`}
          className={cn(
            PILL,
            "cursor-pointer bg-primary/15 text-primary outline-none motion-safe:transition-colors hover:bg-primary/25 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          )}
        >
          Sign in
        </button>
      )}

      {error ? (
        <p className="max-w-[13rem] text-[11px] text-destructive leading-4">{error}</p>
      ) : (
        <p className="max-w-[13rem] text-[11px] text-muted-foreground leading-4">{detail}</p>
      )}
    </GlowCard>
  )
}

// ---- Step 2: suggested modes ---------------------------------------------

function ModeStep({ modes }: { modes: SuggestedMode[] }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [applied, setApplied] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const apply = async (mode: SuggestedMode) => {
    setBusy(mode.name)
    setError(null)
    try {
      await applyOnboardingMode(mode)
      setApplied(mode.name)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="flex w-full flex-1 flex-col items-center">
      <StepHeader
        title="Pick a mode"
        subtitle="A tuned executor + advisor pairing to start from. Optional — you can change this any time in Settings."
      />

      <div className="flex w-full flex-1 flex-col items-center justify-center gap-6 py-12">
        {error && <InlineError>{error}</InlineError>}

        {modes.length === 0 ? (
          <GlowCard className="max-w-[560px] items-center justify-center px-8 py-8 text-center">
            <p className="text-[13px] text-muted-foreground">
              No suggested modes — you're all set to continue.
            </p>
          </GlowCard>
        ) : (
          <div className="grid w-full min-w-0 max-w-[1200px] grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
            {modes.map((mode) => {
              const isApplied = applied === mode.name
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
                      `${providerLabel(mode.spec.provider)} · ${prettyModel(mode.spec.model)}${
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
        )}
      </div>
    </section>
  )
}

// ---- Step 3: finish -------------------------------------------------------

function FinishStep({ ready }: { ready: boolean }) {
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
        </GlowCard>
      </div>
    </section>
  )
}
