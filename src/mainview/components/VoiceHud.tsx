import { Check, Loader2, Mic, MicOff, PhoneOff, X } from "lucide-react"
import type { VoiceState } from "~/lib/voice"
import type { VoiceLine, VoiceToolChip } from "~/hooks/useVoiceAgent"
import { cn } from "~/lib/cn"
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip"

/** Status colouring per engine state; `muted` only relabels listening. */
function statusOf(state: VoiceState, muted: boolean): { label: string; dot: string; text: string; pulse: boolean } {
  if (state === "connecting") return { label: "Connecting", dot: "bg-warning", text: "text-warning", pulse: true }
  if (state === "speaking") return { label: "Speaking", dot: "bg-info", text: "text-info", pulse: true }
  if (state === "tool") return { label: "Running tool", dot: "bg-primary", text: "text-primary", pulse: true }
  if (state === "error") return { label: "Voice error", dot: "bg-destructive", text: "text-destructive", pulse: false }
  if (state === "idle") return { label: "Ending", dot: "bg-muted-foreground", text: "text-muted-foreground", pulse: false }
  return muted
    ? { label: "Muted", dot: "bg-muted-foreground", text: "text-muted-foreground", pulse: false }
    : { label: "Listening", dot: "bg-primary", text: "text-primary", pulse: true }
}

function TranscriptLine({ role, line }: { role: string; line: VoiceLine | null }) {
  if (!line || !line.text.trim()) return null
  return (
    <div className="flex gap-2">
      <span className="mt-px w-9 shrink-0 font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
        {role}
      </span>
      <p
        className={cn(
          "line-clamp-2 min-w-0 flex-1 text-[12px] leading-snug",
          line.final ? "text-foreground/90" : "text-muted-foreground italic",
        )}
      >
        {line.text}
      </p>
    </div>
  )
}

function ToolChip({ chip }: { chip: VoiceToolChip }) {
  return (
    <span
      className={cn(
        "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] transition-opacity duration-500",
        chip.fading && "opacity-0",
        chip.ok === undefined
          ? "border-border bg-muted/40 text-muted-foreground"
          : chip.ok
            ? "border-success/40 bg-success/10 text-success"
            : "border-destructive/40 bg-destructive/10 text-destructive",
      )}
    >
      {chip.ok === undefined ? (
        <Loader2 className="size-3 animate-spin" />
      ) : chip.ok ? (
        <Check className="size-3" />
      ) : (
        <X className="size-3" />
      )}
      <span className="max-w-[10rem] truncate capitalize">{chip.label}</span>
    </span>
  )
}

/**
 * Compact floating voice panel. It sits above the composer, never covers the
 * transcript, and only captures pointer events on the panel itself.
 */
export function VoiceHud({
  state,
  muted,
  error,
  userLine,
  assistantLine,
  tools,
  onToggleMute,
  onEnd,
}: {
  state: VoiceState
  muted: boolean
  error: string | null
  userLine: VoiceLine | null
  assistantLine: VoiceLine | null
  tools: VoiceToolChip[]
  onToggleMute: () => void
  onEnd: () => void
}) {
  const status = statusOf(error ? "error" : state, muted)
  const hasTranscript = !!userLine?.text.trim() || !!assistantLine?.text.trim()

  return (
    <div className="pointer-events-none fixed right-5 bottom-28 z-40 flex justify-end" data-slot="voice-hud">
      <div className="pointer-events-auto w-[19rem] max-w-[calc(100vw-2.5rem)] rounded-2xl border border-border/80 bg-popover/95 p-3 text-popover-foreground shadow-panel backdrop-blur-md">
        <div className="flex items-center gap-2">
          <span className="relative flex size-2 shrink-0 items-center justify-center">
            {status.pulse && (
              <span className={cn("absolute inline-flex size-2 animate-ping rounded-full opacity-60", status.dot)} />
            )}
            <span className={cn("relative inline-flex size-2 rounded-full", status.dot)} />
          </span>
          <span className={cn("font-medium text-[12px] tracking-tight", status.text)}>{status.label}</span>
          <span className="ml-auto flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={muted ? "Unmute microphone" : "Mute microphone"}
                    aria-pressed={muted}
                    onClick={onToggleMute}
                    className={cn(
                      "inline-flex size-7 cursor-pointer items-center justify-center rounded-md outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50",
                      muted ? "text-destructive" : "text-muted-foreground hover:text-foreground",
                    )}
                  />
                }
              >
                {muted ? <MicOff className="size-3.5" /> : <Mic className="size-3.5" />}
              </TooltipTrigger>
              <TooltipPopup>{muted ? "Unmute" : "Mute"}</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="End voice session"
                    onClick={onEnd}
                    className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring/50"
                  />
                }
              >
                <PhoneOff className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup>End call</TooltipPopup>
            </Tooltip>
          </span>
        </div>

        {error ? (
          <p className="mt-2 text-[11.5px] text-destructive leading-snug">{error}</p>
        ) : hasTranscript ? (
          <div className="mt-2 flex flex-col gap-1.5">
            <TranscriptLine role="You" line={userLine} />
            <TranscriptLine role="Voice" line={assistantLine} />
          </div>
        ) : (
          <p className="mt-2 text-[11.5px] text-muted-foreground leading-snug">
            {state === "connecting" ? "Opening the voice channel…" : muted ? "Microphone is off." : "Say what you want done."}
          </p>
        )}

        {tools.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1 border-border/60 border-t pt-2">
            {tools.map((chip) => (
              <ToolChip key={chip.id} chip={chip} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
