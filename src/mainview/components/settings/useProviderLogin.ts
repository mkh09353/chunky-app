// Shared provider login flow: start a login, hand the URL off to the OS
// browser, then poll the server until the provider reports ready.
// Used by both the Settings → Providers section and the onboarding wizard so
// the polling/timeout semantics stay in exactly one place.
import { useCallback, useEffect, useRef, useState } from "react"
import { getProviderAuthStatus, startProviderLogin, testProviderAuth } from "~/lib/configApi"
import type { LoginInitiation } from "~/lib/configApi"
import { openExternal } from "~/lib/openExternal"

export interface ProviderLoginState {
  provider: string
  initiation: LoginInitiation | null
  polling: boolean
  error: string | null
  /** This run is a re-authentication of a provider that already has a credential. */
  reauth: boolean
  /**
   * Re-auth only: the server short-circuited with kind "ready" because a
   * credential is already stored, so no new login actually started. The user
   * has to disconnect first to get a real login flow.
   */
  alreadyReady: boolean
}

export interface StartLoginOptions {
  /**
   * Re-authenticate a provider that already reports ready. Completion is then
   * judged by a real credential test rather than the `ready` flag, which is
   * already true and would otherwise "succeed" on the first poll.
   */
  reauth?: boolean
}

/** Poll cadence and cap: 90 × 2s ≈ 3 minutes before we give up. */
const POLL_INTERVAL_MS = 2000
const MAX_POLL_ATTEMPTS = 90

export interface ProviderLoginController {
  /** The single in-flight (or last failed) login, or null when idle. */
  login: ProviderLoginState | null
  /** Begin a login for `provider`; safe to call while another one is pending. */
  startLogin: (provider: string, options?: StartLoginOptions) => Promise<void>
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
    (provider: string, reauth = false) => {
      stopPoll()
      let attempts = 0
      pollRef.current = setInterval(async () => {
        attempts += 1
        try {
          // A re-auth starts from ready === true, so that flag cannot mark the
          // end of the flow: preflight the credential instead, and only fall
          // back to `ready` when the server has no /test route.
          const test = reauth ? await testProviderAuth(provider) : null
          const useStatus = !test || test.unsupported === true
          const status = useStatus ? await getProviderAuthStatus(provider) : { ready: test.ok, error: undefined }
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
    async (provider: string, options?: StartLoginOptions) => {
      const reauth = options?.reauth === true
      setLogin({ provider, initiation: null, polling: true, error: null, reauth, alreadyReady: false })
      try {
        const initiation = await startProviderLogin(provider)
        if (initiation.kind === "ready") {
          // Some providers refuse to start a login while a credential exists.
          // On a plain connect that means "nothing to do"; on a re-auth it means
          // the stale credential has to be removed first, so say so.
          if (reauth) {
            setLogin({ provider, initiation, polling: false, error: null, reauth, alreadyReady: true })
            return
          }
          setLogin(null)
          readyRef.current?.()
          return
        }
        setLogin({ provider, initiation, polling: true, error: null, reauth, alreadyReady: false })
        if (initiation.kind === "url" && initiation.url) {
          // Native app: hands off to the OS browser; browser dev: new tab.
          openExternal(initiation.url)
        }
        beginPoll(provider, reauth)
      } catch (err) {
        setLogin({
          provider,
          initiation: null,
          polling: false,
          error: (err as Error).message,
          reauth,
          alreadyReady: false,
        })
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
