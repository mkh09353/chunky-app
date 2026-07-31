import { useEffect, useRef } from "react"
import { isPttKey, isTypingTarget, PTT_CODE, type PttEvent } from "~/lib/pushToTalk"

export interface PushToTalkHotkeyOptions {
  /** Read at event time: whether a voice session is already running. */
  isActive: () => boolean
  /** Called when the hotkey is pressed with no session running. */
  onStart: () => void
  /** Feed the push-to-talk state machine. */
  dispatch: (event: PttEvent) => void
}

/**
 * Window-level push-to-talk hotkey.
 *
 * Split out from useVoiceAgent so the DOM-facing half — the typing guard, the
 * modal guard, auto-repeat, and the press that only starts a session — can be
 * driven directly in a browser harness.
 */
export function usePushToTalkHotkey({ isActive, onStart, dispatch }: PushToTalkHotkeyOptions): void {
  const ref = useRef({ isActive, onStart, dispatch })
  ref.current = { isActive, onStart, dispatch }

  useEffect(() => {
    // The press that starts a session must not also open the microphone, so
    // its release is swallowed rather than read as a tap.
    let suppressKeyup = false

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPttKey(event)) return
      if (isTypingTarget(event.target)) return
      // A modal owns the keyboard while it is open (palette, settings, confirm).
      if (document.querySelector('[role="dialog"],[role="alertdialog"]')) return
      event.preventDefault()
      if (!ref.current.isActive()) {
        suppressKeyup = true
        ref.current.onStart()
        return
      }
      ref.current.dispatch({ type: "keydown", at: event.timeStamp || Date.now() })
    }

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== PTT_CODE) return
      if (suppressKeyup) {
        suppressKeyup = false
        return
      }
      if (isTypingTarget(event.target)) return
      ref.current.dispatch({ type: "keyup", at: event.timeStamp || Date.now() })
    }

    // Losing focus or switching tabs must never leave the microphone open.
    const onRelease = () => ref.current.dispatch({ type: "release" })

    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("keyup", onKeyUp)
    window.addEventListener("blur", onRelease)
    window.addEventListener("pointerup", onRelease)
    document.addEventListener("visibilitychange", onRelease)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("keyup", onKeyUp)
      window.removeEventListener("blur", onRelease)
      window.removeEventListener("pointerup", onRelease)
      document.removeEventListener("visibilitychange", onRelease)
    }
  }, [])
}
