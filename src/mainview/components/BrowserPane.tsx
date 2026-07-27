import { ArrowLeft, ArrowRight, Globe2, LoaderCircle, RotateCw, X } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { FormEvent } from "react"
import { cn } from "~/lib/cn"
import { Button } from "./ui/button"

const LAST_URL_KEY = "chunky.browser.lastUrl"
const DEFAULT_URL = "https://duckduckgo.com/"

function readLastUrl(): string {
  try {
    return localStorage.getItem(LAST_URL_KEY) || DEFAULT_URL
  } catch {
    return DEFAULT_URL
  }
}

function persistUrl(url: string) {
  try {
    localStorage.setItem(LAST_URL_KEY, url)
  } catch {
    // Storage may be unavailable in private/locked-down contexts.
  }
}

/** Resolve browser-style address input without sending arbitrary prose to a host. */
export function normalizeBrowserAddress(input: string): string {
  const value = input.trim()
  if (!value) return DEFAULT_URL

  if (/^[a-z][a-z\d+.-]*:/i.test(value)) {
    try {
      return new URL(value).href
    } catch {
      return `https://duckduckgo.com/?q=${encodeURIComponent(value)}`
    }
  }

  // Hosts, localhost, IPv4 addresses, and paths with a host-like first segment.
  const looksLikeUrl =
    value === "localhost" ||
    value.startsWith("localhost:") ||
    /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/|$)/.test(value) ||
    /^(?:[\w-]+\.)+[a-z]{2,}(?::\d+)?(?:\/|$)/i.test(value)
  if (looksLikeUrl) {
    try {
      return new URL(`https://${value}`).href
    } catch {
      // Fall through to search for malformed host-looking input.
    }
  }

  return `https://duckduckgo.com/?q=${encodeURIComponent(value)}`
}

function desktopWebviewAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean((window as unknown as { __electrobunWebviewId?: number }).__electrobunWebviewId) &&
    typeof customElements !== "undefined" &&
    customElements.get("electrobun-webview") !== undefined
  )
}

export function BrowserPane({ onClose }: { onClose: () => void }) {
  const webviewRef = useRef<ElectrobunWebviewElement | null>(null)
  const [available, setAvailable] = useState(false)
  const [url, setUrl] = useState(DEFAULT_URL)
  const [draft, setDraft] = useState(DEFAULT_URL)
  const [loading, setLoading] = useState(false)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)

  useEffect(() => {
    const initialUrl = readLastUrl()
    setUrl(initialUrl)
    setDraft(initialUrl)
    setAvailable(desktopWebviewAvailable())
  }, [])

  const syncNavigation = useCallback(() => {
    const webview = webviewRef.current
    if (!webview) return
    const nextUrl = webview.src
    if (nextUrl) {
      setUrl(nextUrl)
      setDraft(nextUrl)
      persistUrl(nextUrl)
    }
    void Promise.all([webview.canGoBack(), webview.canGoForward()])
      .then(([back, forward]) => {
        setCanGoBack(back)
        setCanGoForward(forward)
      })
      .catch(() => {
        setCanGoBack(false)
        setCanGoForward(false)
      })
  }, [])

  useEffect(() => {
    if (!available) return
    const webview = webviewRef.current
    if (!webview) return
    const onNavigation = () => {
      setLoading(false)
      syncNavigation()
    }
    const onReady = () => {
      setLoading(false)
      syncNavigation()
    }
    webview.on("did-navigate", onNavigation)
    webview.on("did-navigate-in-page", onNavigation)
    webview.on("did-commit-navigation", onNavigation)
    webview.on("dom-ready", onReady)
    return () => {
      webview.off("did-navigate", onNavigation)
      webview.off("did-navigate-in-page", onNavigation)
      webview.off("did-commit-navigation", onNavigation)
      webview.off("dom-ready", onReady)
    }
  }, [available, syncNavigation])

  const navigate = useCallback((rawUrl: string) => {
    const nextUrl = normalizeBrowserAddress(rawUrl)
    setUrl(nextUrl)
    setDraft(nextUrl)
    persistUrl(nextUrl)
    setLoading(true)
    webviewRef.current?.loadURL(nextUrl)
  }, [])

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    navigate(draft)
  }

  return (
    <aside className="flex min-h-0 min-w-[20rem] basis-[44%] flex-col border-border/70 border-l bg-background/70" aria-label="Browser pane">
      <form className="no-drag flex h-[52px] shrink-0 items-center gap-1 border-border/70 border-b px-2" onSubmit={submit}>
        <Button type="button" variant="ghost" size="icon-sm" disabled={!available || !canGoBack} onClick={() => { setLoading(true); webviewRef.current?.goBack() }} aria-label="Back">
          <ArrowLeft />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" disabled={!available || !canGoForward} onClick={() => { setLoading(true); webviewRef.current?.goForward() }} aria-label="Forward">
          <ArrowRight />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" disabled={!available} onClick={() => { setLoading(true); webviewRef.current?.reload() }} aria-label="Reload">
          <RotateCw className={cn(loading && "animate-spin")} />
        </Button>
        <div className="relative min-w-0 flex-1">
          <Globe2 className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            placeholder="Search or enter URL"
            spellCheck={false}
            className="h-8 w-full rounded-lg border border-input bg-muted/30 py-1 pl-8 pr-3 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-ring focus:ring-[3px] focus:ring-ring/25"
            aria-label="Browser address"
          />
        </div>
        <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close browser">
          <X />
        </Button>
      </form>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-muted/30">
        {available ? (
          <electrobun-webview
            ref={webviewRef}
            src={url}
            sandbox=""
            renderer="native"
            className="h-full w-full bg-background"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-7 text-center">
            <div className="flex size-10 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary"><Globe2 className="size-5" /></div>
            <div>
              <p className="font-medium text-[13px] text-foreground">Embedded browser is available in the desktop app</p>
              <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">Run Chunky through Electrobun to browse here. The web development build does not embed native webviews.</p>
            </div>
          </div>
        )}
        {available && loading ? <LoaderCircle className="pointer-events-none absolute right-3 top-3 size-4 animate-spin text-primary" aria-label="Loading" /> : null}
      </div>
    </aside>
  )
}
