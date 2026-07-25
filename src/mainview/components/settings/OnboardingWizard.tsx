import { ArrowLeft, ArrowRight, Check, RotateCw } from "lucide-react"
import { useState } from "react"
import {
  applyOnboardingMode,
  completeOnboarding,
  getOnboarding,
  prettyModel,
  providerLabel,
} from "~/lib/configApi"
import type { OnboardingResponse, SuggestedMode } from "~/lib/configApi"
import { cn } from "~/lib/cn"
import { Button } from "../ui/button"
import { Dialog, DialogPopup } from "../ui/dialog"
import { ScrollArea } from "../ui/scroll-area"
import { ProvidersSection } from "./ProvidersSection"
import {
  Badge,
  Card,
  EmptyNote,
  ErrorNote,
  InlineError,
  Loading,
  Spinner,
  SubLabel,
  useAsync,
} from "./common"

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

export function OnboardingWizard({
  open,
  onOpenChange,
  onComplete,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onComplete?: () => void
}) {
  const onboarding = useAsync<OnboardingResponse>(() => getOnboarding(), [])
  const [step, setStep] = useState(0)

  const anyReady = (onboarding.data?.providers ?? []).some((p) => p.ready)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        showClose={false}
        className="flex h-[80vh] max-h-[700px] w-[calc(100vw-2rem)] max-w-2xl flex-col overflow-hidden p-0"
      >
        <header className="flex shrink-0 flex-col gap-3 border-border/70 border-b px-6 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex size-8 items-center justify-center rounded-xl border border-primary/20 bg-primary/10">
              <img src="/chunky-mark.svg" alt="" aria-hidden className="size-6" />
            </div>
            <div className="flex flex-col">
              <span className="font-semibold text-[15px] tracking-tight">Welcome to Chunky</span>
              <span className="text-[12px] text-muted-foreground">Let's get you set up.</span>
            </div>
          </div>
          <Stepper step={step} />
        </header>

        <ScrollArea className="min-h-0 flex-1" viewportClassName="p-6">
          {onboarding.loading ? (
            <Loading rows={4} />
          ) : onboarding.error ? (
            <ErrorNote message={onboarding.error} onRetry={onboarding.reload} />
          ) : step === 0 ? (
            <div className="flex flex-col gap-3">
              <p className="text-[13px] text-muted-foreground">
                Log in to at least one model provider so Chunky can run. You can add more later.
              </p>
              <ProvidersSection />
            </div>
          ) : step === 1 ? (
            <ModeStep modes={onboarding.data?.suggestedModes ?? []} />
          ) : (
            <FinishStep ready={anyReady} />
          )}
        </ScrollArea>

        <footer className="flex shrink-0 items-center justify-between gap-3 border-border/70 border-t px-6 py-3.5">
          <Button
            variant="ghost"
            size="sm"
            disabled={step === 0}
            onClick={() => setStep((s) => Math.max(0, s - 1))}
          >
            <ArrowLeft className="size-3.5" />
            Back
          </Button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onboarding.reload()}
              className="flex cursor-pointer items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
            >
              <RotateCw className="size-3" />
              Refresh
            </button>
            {step < STEPS.length - 1 ? (
              <Button size="sm" onClick={() => setStep((s) => s + 1)}>
                Next
                <ArrowRight className="size-3.5" />
              </Button>
            ) : (
              <FinishButton
                onDone={() => {
                  onComplete?.()
                  onOpenChange(false)
                }}
              />
            )}
          </div>
        </footer>
      </DialogPopup>
    </Dialog>
  )
}

function Stepper({ step }: { step: number }) {
  return (
    <div className="flex items-center gap-2">
      {STEPS.map((label, i) => (
        <div key={label} className="flex items-center gap-2">
          <div
            className={cn(
              "flex size-5 items-center justify-center rounded-full border text-[10px] font-semibold",
              i < step
                ? "border-primary bg-primary text-primary-foreground"
                : i === step
                  ? "border-primary text-primary"
                  : "border-border text-muted-foreground",
            )}
          >
            {i < step ? <Check className="size-3" /> : i + 1}
          </div>
          <span
            className={cn(
              "text-[12px]",
              i === step ? "font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            {label}
          </span>
          {i < STEPS.length - 1 && <span className="h-px w-4 bg-border" />}
        </div>
      ))}
    </div>
  )
}

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
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-muted-foreground">
        Pick a suggested mode to start with — a tuned executor + advisor pairing. Optional; you can
        skip and configure this later.
      </p>
      {error && <InlineError>{error}</InlineError>}
      {modes.length === 0 ? (
        <EmptyNote>No suggested modes — you're all set to continue.</EmptyNote>
      ) : (
        <div className="flex flex-col gap-2">
          {modes.map((mode) => {
            const isApplied = applied === mode.name
            return (
              <Card key={mode.name}>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-[13.5px]">{mode.name}</span>
                      {isApplied && (
                        <Badge tone="success">
                          <Check className="size-2.5" />
                          Applied
                        </Badge>
                      )}
                    </div>
                    <span className="truncate text-[12px] text-muted-foreground">
                      {mode.description ||
                        `${providerLabel(mode.spec.provider)} · ${prettyModel(mode.spec.model)}${mode.spec.effort ? ` · effort ${mode.spec.effort}` : ""}`}
                    </span>
                  </div>
                  <Button
                    variant={isApplied ? "outline" : "default"}
                    size="sm"
                    disabled={busy === mode.name || isApplied}
                    onClick={() => void apply(mode)}
                  >
                    {busy === mode.name ? <Spinner /> : isApplied ? "Applied" : "Apply"}
                  </Button>
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}

function FinishStep({ ready }: { ready: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <SubLabel>Almost there</SubLabel>
      {!ready && (
        <InlineError>
          No provider is logged in yet. You can still finish, but Chunky won't run until a provider
          is connected.
        </InlineError>
      )}
      <Card>
        <p className="text-[13px] text-muted-foreground">
          That's the essentials. You can fine-tune models, sidekick seats, skills, and more any time
          from Settings.
        </p>
      </Card>
    </div>
  )
}

function FinishButton({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const finish = async () => {
    setBusy(true)
    setError(null)
    try {
      await completeOnboarding()
      onDone()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      {error && <InlineError>{error}</InlineError>}
      <Button size="sm" disabled={busy} onClick={() => void finish()}>
        {busy ? <Spinner /> : <Check className="size-3.5" />}
        Finish setup
      </Button>
    </div>
  )
}
