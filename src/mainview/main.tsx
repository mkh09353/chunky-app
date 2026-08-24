import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "@fontsource-variable/dm-sans/index.css"
import "@fontsource/jetbrains-mono/400.css"
import "@fontsource/jetbrains-mono/500.css"
import "@xterm/xterm/css/xterm.css"
import "./index.css"
import { App } from "./App"
import { AppErrorBoundary } from "./components/AppErrorBoundary"
import { installExternalLinkHandler } from "./lib/openExternal"

// One delegated listener for every external link in the app (markdown
// autolinks, PR links, …). Installed outside React so StrictMode's double
// effect pass cannot register it twice.
installExternalLinkHandler()

// The boundary is OUTSIDE StrictMode's child so an error while rendering App
// lands on a fallback instead of tearing the root down. That is not only
// cosmetic: a torn-down root removes every React-owned node, and the browser
// pane's native webview used to be one of them — disconnecting it exits the
// process. The element now lives in a body-level stage outside React (see
// BrowserPane's `getBrowserStage`), so tripping the boundary parks the pane's
// page instead of killing the app, and "Reload" re-renders App, which reuses
// that same live webview.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
)
