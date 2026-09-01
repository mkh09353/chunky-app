import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import path from "node:path"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"

// Server token for the local chunky server (dev convenience — same exposure as
// the old app passing it into the webview over RPC). Never committed anywhere.
function loadServerToken(): string {
  try {
    const p = process.env.CHUNKY_SETTINGS ?? path.join(homedir(), ".chunky", "state", "settings.json")
    const raw = JSON.parse(readFileSync(p, "utf8")) as { serverToken?: unknown }
    return typeof raw.serverToken === "string" ? raw.serverToken : ""
  } catch {
    return ""
  }
}

// Electrobun ships only .ts sources but its internal imports use `.js`
// specifiers (NodeNext style). The production build's lazy `electrobun/view`
// import needs those `.js` deep-imports rewritten to their `.ts` sibling.
// Scoped to electrobun importers so nothing else is affected.
function electrobunTsResolve(): Plugin {
  return {
    name: "electrobun-ts-resolve",
    enforce: "pre",
    async resolveId(source, importer) {
      if (importer && importer.includes("/electrobun/") && source.endsWith(".js")) {
        const asTs = source.replace(/\.js$/, ".ts")
        const resolved = await this.resolve(asTs, importer, { skipSelf: true })
        if (resolved) return resolved
      }
      return null
    },
  }
}

// Inject the local server token only for `vite` dev / `vite build --mode development`.
// Production web bundles must NOT embed the bearer token — Electrobun packaged
// builds receive it at runtime via bun RPC `getConfig` (reads settings.json).
// Plain `vite build` (production) leaves the define empty; loadConfig falls back
// to RPC or unauthenticated localhost (dev browser against a tokenless probe).
export default defineConfig(({ command, mode }) => {
  const injectToken = command === "serve" || mode === "development" || process.env.CHUNKY_INJECT_TOKEN === "1"
  const serverUrl = process.env.CHUNKY_URL ?? "http://localhost:4620"
  const devProxyPath = "/chunky-api"
  const serverToken = loadServerToken()
  // Chrome/define may show origin only. Keep userinfo/path/query out of the renderer.
  let proxyTargetForChrome = "http://localhost:4620"
  try {
    const url = new URL(serverUrl)
    if (url.protocol === "http:" || url.protocol === "https:") proxyTargetForChrome = url.origin
  } catch {
    /* keep the Vite default */
  }
  return {
  define: {
    // Dev requests use Vite's same-origin proxy. Several server JSON routes do
    // not attach CORS headers, so direct webview -> :4620 fetches are rejected
    // by WebKit even though the server returns 200. The proxy also keeps the
    // bearer token out of the renderer bundle.
    __CHUNKY_BASE_URL__: JSON.stringify(command === "serve" ? devProxyPath : serverUrl),
    // Safe origin of that proxy (CHUNKY_URL). Renderer chrome may show host:port;
    // never a token, settings path, DB path, or URL userinfo.
    __CHUNKY_PROXY_TARGET__: JSON.stringify(proxyTargetForChrome),
    __CHUNKY_TOKEN__: JSON.stringify(command === "serve" ? "" : injectToken ? serverToken : ""),
  },
  plugins: [react(), tailwindcss(), electrobunTsResolve()],
  root: "src/mainview",
  publicDir: "public",
  resolve: {
    // Ordered array form, because the object form does PREFIX substitution:
    // "@chunky/protocol" -> "…/src/index.ts" also rewrote the subpath imports
    // ("@chunky/protocol/relay" -> "…/src/index.ts/relay", which cannot
    // resolve). The bare specifier is matched exactly, and subpaths are sent
    // to the package's src directory instead.
    alias: [
      { find: "~", replacement: path.resolve(__dirname, "src/mainview") },
      {
        find: /^@chunky\/protocol$/,
        replacement: path.resolve(__dirname, "../chunky/packages/protocol/src/index.ts"),
      },
      {
        find: /^@chunky\/protocol\//,
        replacement: path.resolve(__dirname, "../chunky/packages/protocol/src/") + "/",
      },
    ],
  },
  optimizeDeps: {
    exclude: ["electrobun"],
  },
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      [devProxyPath]: {
        target: serverUrl,
        changeOrigin: true,
        rewrite: (requestPath) => requestPath.replace(new RegExp(`^${devProxyPath}`), ""),
        configure(proxy) {
          proxy.on("proxyReq", (proxyReq) => {
            if (serverToken) proxyReq.setHeader("Authorization", `Bearer ${serverToken}`)
          })
        },
      },
    },
  },
}
})
