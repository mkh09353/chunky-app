// Shared provider login flow: start a login, hand the URL off to the OS
// browser, then poll the server until the provider reports ready.
// Used by both the Settings → Providers section and the onboarding wizard so
// the polling/timeout semantics stay in exactly one place.
import { useCallback, useEffect, useRef, useState } from "react"
import { getProviderAuthStatus, startProviderLogin } from "~/lib/configApi"
import type { LoginInitiation } from "~/lib/configApi"
import { openExternal } from "~/lib/openExternal"

export interface ProviderLoginState {
  provider: string
  initiation: LoginInitiation | null
  polling: boolean
  error: string | null
}

/** Poll cadence and cap: 90 × 2s ≈ 3 minutes before we give up. */
const POLL_INTERVAL_MS = 2000
const MAX_POLL_ATTEMPTS = 90

export interface ProviderLoginController {
  /** The single in-flight (or last failed) login, or null when idle. */
  login: ProviderLoginState | null
  /** Begin a login for `provider`; safe to call while another one is pending. */
  startLogin: (provider: string) => Promise<void>
  /** Dismiss the current login state (e.g. after showing an error). */
  clearLogin: () => void
  /** True while we're waiting on authorization for that provider. */
  isPolling: (provider: string) => boolean
}

/**
 * @param onReady Called once the provider reports ready (reload your data).
 */
export function useProviderLogin(onReady?: () => void): ProviderLoginController {
  const [login, setLogin] = useState<ProviderLoginState | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const readyRef = useRef(onReady)

  useEffect(() => {
    readyRef.current = onReady
  }, [onReady])

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
            readyRef.current?.()
          } else if (status.error) {
            stopPoll()
            setLogin((s) =>
              s && s.provider === provider
                ? { ...s, polling: false, error: status.error ?? "Login failed" }
                : s,
            )
          }
        } catch {
          /* keep polling; transient */
        }
        if (attempts > MAX_POLL_ATTEMPTS) {
          stopPoll()
          setLogin((s) =>
            s && s.provider === provider
              ? { ...s, polling: false, error: "Login timed out. Try again." }
              : s,
          )
        }
      }, POLL_INTERVAL_MS)
    },
    [stopPoll],
  )

  const startLogin = useCallback(
    async (provider: string) => {
      setLogin({ provider, initiation: null, polling: true, error: null })
      try {
        const initiation = await startProviderLogin(provider)
        setLogin({ provider, initiation, polling: initiation.kind !== "ready", error: null })
        if (initiation.kind === "ready") {
          setLogin(null)
          readyRef.current?.()
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
    [beginPoll],
  )

  const clearLogin = useCallback(() => {
    stopPoll()
    setLogin(null)
  }, [stopPoll])

  const isPolling = useCallback(
    (provider: string) => login?.provider === provider && login.polling,
    [login],
  )

  return { login, startLogin, clearLogin, isPolling }
}
