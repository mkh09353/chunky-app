// The UI half of lib/apiKeyRequest.ts: one host mounted at the app root that
// prompts for a provider API key when the agent asks for one
// (`app.request_api_key`).
//
// It lives at the root, not in Settings, because the user is almost certainly
// looking at the chat when the agent gets to this point.
//
// Secret handling: the key is component state and nothing else. It is cleared
// when the prompt closes and whenever a new request replaces the one on screen,
// it is never echoed back (the input is a password field the server never reads
// back), never logged, never written to storage, and never put in the
// transcript — it goes straight into the POST body of ROUTES.providerKey.
import { KeyRound } from "lucide-react"
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import {
  cancelProviderKeyRequest,
  submitProviderKey,
  UNSUPPORTED_PROVIDER_KEY,
} from "~/lib/configApi"
import {
  clearApiKeyRequest,
  currentApiKeyRequest,
  subscribeApiKeyRequests,
  type ApiKeyRequest,
} from "~/lib/apiKeyRequest"
import { Button } from "./ui/button"
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "./ui/dialog"
import { Input } from "./ui/input"

export function ApiKeyRequestHost() {
  // The server snapshot is null: nothing is ever pending during SSR/hydration.
  const request = useSyncExternalStore(subscribeApiKeyRequests, currentApiKeyRequest, () => null)
  const [key, setKey] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // Requests this host has already answered. Escape can reach both the local
  // handler and Base UI's own dismissal, and a successful send closes the
  // dialog itself — without this, one of those paths would post a second
  // (cancelling) answer for a request that is already settled.
  const settled = useRef(new Set<string>())
  const shown = useRef<ApiKeyRequest | null>(null)
  const requestId = request?.requestId ?? null

  // A replacement request (newest wins) must never inherit the previous one's
  // typed key, error or in-flight flag — and the request it displaced is
  // declined right away rather than left for the server's timeout.
  useEffect(() => {
    const previous = shown.current
    shown.current = request
    if (previous && previous.requestId !== requestId && !settled.current.has(previous.requestId)) {
      settled.current.add(previous.requestId)
      void cancelProviderKeyRequest(previous.providerId, previous.requestId)
    }
    setKey("")
    setError(null)
    setBusy(false)
  }, [request, requestId])

  /** Answer with no key: the server reads that as "the user declined". */
  const cancel = useCallback(() => {
    if (!request) return
    const { providerId, requestId: id } = request
    if (settled.current.has(id)) return
    settled.current.add(id)
    // Fire-and-forget: the prompt goes away either way, and an unanswered
    // request is settled by the server's own timeout.
    void cancelProviderKeyRequest(providerId, id)
    setKey("")
    clearApiKeyRequest(id)
  }, [request])

  const submit = useCallback(async () => {
    if (!request || busy || settled.current.has(request.requestId)) return
    const value = key
    if (!value.trim()) {
      setError("Paste the API key first, or cancel the request.")
      return
    }
    setBusy(true)
    setError(null)
    const result = await submitProviderKey(request.providerId, {
      requestId: request.requestId,
      key: value,
    })
    if (result.ok) {
      // Drop the secret from state before anything else re-renders.
      setKey("")
      setBusy(false)
      settled.current.add(request.requestId)
      clearApiKeyRequest(request.requestId)
      return
    }
    // A failure keeps the dialog open so the key can be corrected and resent.
    setBusy(false)
    setError(result.unsupported ? UNSUPPORTED_PROVIDER_KEY : (result.error ?? "The server did not accept that key."))
  }, [busy, key, request])

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) cancel()
      }}
    >
      <DialogPopup
        showClose={false}
        className="max-w-md"
        initialFocus={inputRef}
        onKeyDown={(event) => {
          if (event.defaultPrevented) return
          if (event.key === "Escape") {
            // Owned here: the app's global Escape (stop the run) must not also
            // fire, and neither must any ancestor handler.
            event.preventDefault()
            event.stopPropagation()
            cancel()
            return
          }
          if (event.key === "Enter") {
            // A focused button handles its own Enter — don't override Cancel.
            if (event.target instanceof HTMLElement && event.target.closest("button")) return
            event.preventDefault()
            void submit()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-primary" />
            {request ? `${request.label} needs an API key` : ""}
          </DialogTitle>
          <DialogDescription>
            Chunky is setting up{" "}
            <span className="font-mono text-[12px] text-foreground">{request?.providerId ?? ""}</span> and needs its
            key. It goes straight to the Chunky server — it is never shown in the chat or saved in this window.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 px-6 py-2">
          <Input
            ref={inputRef}
            type="password"
            value={key}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-…"
            aria-label={`API key for ${request?.label ?? "this provider"}`}
            onChange={(event) => {
              setKey(event.target.value)
              if (error) setError(null)
            }}
            className="font-mono text-[12px]"
          />
          {error && <p className="text-[11.5px] text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={cancel}>
            Cancel
          </Button>
          <Button disabled={busy || !key.trim()} onClick={() => void submit()}>
            {busy ? "Sending…" : "Send key"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}
