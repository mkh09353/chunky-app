import { Keyboard, RotateCcw } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { usePttHotkeyCode } from "~/hooks/usePttHotkeyCode"
import { cn } from "~/lib/cn"
import { codeToLabel, DEFAULT_PTT_CODE, resetPttCode, setPttCode, validatePttCode } from "~/lib/pushToTalk"
import { Button } from "../ui/button"
import { Card, FieldRow, InlineError, SectionShell, SubLabel } from "./common"

/** Keys that only ever cancel or commit; never captured as a hotkey. */
const CANCEL_CODE = "Escape"

export function VoiceSection() {
  const code = usePttHotkeyCode()
  const [capturing, setCapturing] = useState(false)
  const [rejected, setRejected] = useState<string | null>(null)
  const fieldRef = useRef<HTMLButtonElement>(null)
  const label = codeToLabel(code)

  const stopCapture = useCallback(() => {
    setCapturing(false)
    fieldRef.current?.blur()
  }, [])

  // Capture runs on the field itself so the press never escapes to the app.
  // The push-to-talk hook additionally ignores every key while a dialog is
  // open, so recording a key here can never trigger the microphone.
  useEffect(() => {
    if (!capturing) return
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      // Keep Escape local: it cancels capture rather than closing Settings.
      event.stopPropagation()
      if (event.code === CANCEL_CODE) {
        setRejected(null)
        stopCapture()
        return
      }
      const check = validatePttCode(event.code)
      if (!check.ok) {
        setRejected(check.reason)
        return
      }
      setRejected(null)
      setPttCode(event.code)
      stopCapture()
    }
    // Capture phase, so Base UI's dialog handlers never see the key first.
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [capturing, stopCapture])

  return (
    <SectionShell
      title="Voice"
      description="Push-to-talk for the voice agent. These settings are stored on this machine only."
    >
      <Card>
        <SubLabel>Hotkey</SubLabel>
        <FieldRow
          title="Push-to-talk hotkey"
          description="Held to talk. Letters, digits and app keys such as Escape or Tab are not available."
        >
          <div className="flex items-center gap-1.5">
            <button
              ref={fieldRef}
              type="button"
              aria-label="Push-to-talk hotkey"
              onClick={() => {
                setRejected(null)
                setCapturing((on) => !on)
              }}
              className={cn(
                "inline-flex h-8 min-w-28 cursor-pointer items-center justify-center gap-1.5 rounded-lg border px-3 font-medium text-[12.5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
                capturing
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-input bg-transparent text-foreground hover:bg-accent/60",
              )}
            >
              {capturing ? (
                "Press a key…"
              ) : (
                <>
                  <Keyboard className="size-3.5 text-muted-foreground" />
                  <span className="font-mono">{label}</span>
                </>
              )}
            </button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Reset hotkey to default"
              disabled={code === DEFAULT_PTT_CODE && !capturing}
              onClick={() => {
                setRejected(null)
                setCapturing(false)
                resetPttCode()
              }}
            >
              <RotateCcw className="size-3.5" />
            </Button>
          </div>
        </FieldRow>
        {capturing && (
          <p className="pb-1 text-[11.5px] text-muted-foreground">
            Press the key to use. Escape cancels.
          </p>
        )}
        {rejected && (
          <div className="pb-1">
            <InlineError>{rejected}</InlineError>
          </div>
        )}
      </Card>

      <Card>
        <SubLabel>How it works</SubLabel>
        <ul className="flex flex-col gap-1.5 pt-0.5 text-[12.5px] text-muted-foreground">
          <li>
            Hold <Key>{label}</Key> to talk. The microphone is muted the rest of the time, so nothing is
            uploaded until you hold it.
          </li>
          <li>
            Double-tap <Key>{label}</Key> for open mic: the microphone stays on for a longer conversation.
            A single tap returns to push-to-talk.
          </li>
          <li>
            Press <Key>{label}</Key> with no voice session running to start one.
          </li>
          <li>The hotkey is ignored while you are typing in a text field or a dialog is open.</li>
          <li>A voice session disconnects on its own after three minutes with nothing to do.</li>
        </ul>
      </Card>
    </SectionShell>
  )
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-foreground">
      {children}
    </kbd>
  )
}
