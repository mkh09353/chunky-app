import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "@fontsource-variable/dm-sans/index.css"
import "@fontsource/jetbrains-mono/400.css"
import "@fontsource/jetbrains-mono/500.css"
import "@xterm/xterm/css/xterm.css"
import "./index.css"
import { App } from "./App"
import { installExternalLinkHandler } from "./lib/openExternal"

// One delegated listener for every external link in the app (markdown
// autolinks, PR links, …). Installed outside React so StrictMode's double
// effect pass cannot register it twice.
installExternalLinkHandler()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
