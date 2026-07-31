import { Mic, MicOff } from "lucide-react"
import { useEffect, useState } from "react"
import type { VoiceState } from "~/lib/voice"
import { cn } from "~/lib/cn"
import { Button } from "./ui/button"
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "./ui/dialog"
import { Input } from "./ui/input"
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip"

/**
 * Header microphone toggle for the voice agent, plus the one-time xAI API key
 * prompt the engine asks for when no key is configured.
 */
export function VoiceButton({
  state,
  active,
  error,
  disabled = false,
  onToggle,
  apiKeyPromptOpen,
  onApiKeyPromptOpenChange,
  onSubmitApiKey,
}: {
  state: VoiceState
  active: boolean
  error: string | null
  disabled?: boolean
  onToggle: () => void
  apiKeyPromptOpen: boolean
  onApiKeyPromptOpenChange: (open: boolean) => void
  onSubmitApiKey: (key: string) => Promise<{ ok: boolean; error?: string }>
}) {
  const [key, setKey] = useState("")
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    if (apiKeyPromptOpen) {
      setKey("")
      setSaveError(null)
      setSaving(false)
    }
  }, [apiKeyPromptOpen])

  const failed = !!error || state === "error"
  const label = failed
    ? "Voice error — click to reset"
    : active
      ? "Stop voice control"
      : "Start voice control (or hold ` to talk)"

  const submit = async () => {
    const trimmed = key.trim()
    if (!trimmed || saving) return
    setSaving(true)
    setSaveError(null)
    const result = await onSubmitApiKey(trimmed)
    setSaving(false)
    if (!result.ok) setSaveError(result.error || "Could not save the xAI API key.")
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={label}
              aria-pressed={active}
              disabled={disabled}
              onClick={onToggle}
              className={cn(
                failed
                  ? "text-destructive [&_svg]:text-destructive hover:bg-destructive/10"
                  : active
                    ? "bg-primary/10 text-primary [&_svg]:text-primary hover:bg-primary/15"
                    : undefined,
              )}
            />
          }
        >
          {failed ? <MicOff className="size-4" /> : <Mic className={cn("size-4", active && state !== "idle" && "animate-pulse")} />}
        </TooltipTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>

      <Dialog open={apiKeyPromptOpen} onOpenChange={onApiKeyPromptOpenChange}>
        <DialogPopup className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Connect xAI voice</DialogTitle>
            <DialogDescription>
              Voice control uses the xAI realtime API. The key is stored by the desktop app and never sent to the renderer.
            </DialogDescription>
          </DialogHeader>
          <div className="px-6 pb-2">
            <Input
              autoFocus
              type="password"
              value={key}
              placeholder="xai-…"
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-[12.5px]"
              onChange={(event) => setKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  void submit()
                }
              }}
            />
            {saveError && <p className="mt-2 text-[11.5px] text-destructive">{saveError}</p>}
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => onApiKeyPromptOpenChange(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={!key.trim() || saving} onClick={() => void submit()}>
              {saving ? "Saving…" : "Save and start"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  )
}
