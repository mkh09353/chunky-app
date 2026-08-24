import { Component, Fragment, type ErrorInfo, type ReactNode } from "react"
import { Button } from "./ui/button"

/**
 * Last line of defense for the whole renderer.
 *
 * Without a boundary at the root, one uncaught render error anywhere unmounts
 * the React root: the window goes blank and every DOM node React owns is
 * removed. That used to be fatal in a very literal sense — the browser pane's
 * `<electrobun-webview>` was inside that tree, and disconnecting it closes the
 * pane's CEF browser, which closes the app's main window, which exits the
 * process (see `~/lib/browserGuest`). So the app did not "crash to a blank
 * window", it silently vanished.
 *
 * Interaction with the browser pane: the webview element now lives in a
 * body-level stage created imperatively (`getBrowserStage` in BrowserPane), so
 * it is NOT part of this boundary's subtree. When the boundary trips, React
 * unmounts App — BrowserPane's effect cleanup parks the element and hides its
 * native view, so the page keeps running (and keeps its scroll position and
 * history) but stops painting over the fallback. Pressing Reload re-renders
 * App, whose BrowserPane reuses that same element (module-level `liveWebview`)
 * rather than creating a second native view, and un-hides it if the pane is
 * open. Nothing here may call `location.reload()`: reloading the host document
 * would strand the native view with no tag to drive it.
 */
interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  /** Bumped on reset so the subtree is rebuilt from scratch, not resumed. */
  attempt: number
}

export class AppErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, attempt: 0 }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Never swallow it: this is the only record that the UI went down.
    console.error("[chunky] uncaught render error", error, info.componentStack)
  }

  private reset = () => {
    this.setState((state) => ({ error: null, attempt: state.attempt + 1 }))
  }

  override render(): ReactNode {
    const { error } = this.state
    // A Fragment, not a wrapper element: the app root owns its own layout and
    // an extra box between #root and App would change it. The key still forces
    // a fresh subtree on reset, so a component that failed does not resume with
    // the state that broke it.
    if (!error) return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>

    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-background px-8 text-center">
        <div>
          <p className="font-medium text-[15px] text-foreground">Something went wrong in the interface</p>
          <p className="mt-1.5 max-w-md text-[12.5px] leading-relaxed text-muted-foreground">
            Your sessions and any running work are unaffected — this is only the window. Reloading
            rebuilds the interface; the browser pane keeps the page it was on.
          </p>
        </div>
        <pre className="max-h-32 max-w-lg overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-left font-mono text-[11.5px] text-muted-foreground">
          {error.message || String(error)}
        </pre>
        <Button onClick={this.reset}>Reload</Button>
      </div>
    )
  }
}
