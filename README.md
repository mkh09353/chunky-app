# Chunky

A standalone coding-agent chat desktop app.
Electrobun shell (bun-based), React 19 + Vite + Tailwind v4 webview, UI kit on
**@base-ui/react**. Phase 0 talks to the local Chunky server over authenticated
HTTP + SSE (`@chunky/protocol`).

## Run

```sh
# Terminal A — Chunky server (port 4620)
cd ~/Downloads/chunky && bun run server

# Terminal B — this app
cd ~/Downloads/chunky-app
bun install
bun run dev        # vite (HMR) + electrobun window
```

- `bun run dev` opens the native Electrobun window; it loads the Vite dev
  server (http://localhost:5173) when reachable, else the bundled `dist/`.
- `bun run dev:web` — web-only fallback: plain Vite in a browser.
- `bun run build` — vite build + `electrobun build` (packaged .app).
- `bun run typecheck` — TS7 native preview (`tsgo`); `typecheck:tsc` for classic tsc.

First `electrobun dev` downloads the platform core (dist-macos-arm64) — the
very first invocation may exit after downloading; just run it again.

## Install

macOS on Apple Silicon (arm64) is currently the supported release target:

```sh
curl -fsSL https://raw.githubusercontent.com/mkh09353/chunky-app/main/scripts/install.sh | bash
```

The installer downloads the latest release DMG and installs `Chunky.app` in
`/Applications`. It preserves quarantine metadata for signed releases and only
removes it as a fallback for legacy unsigned releases. To install manually, download
[`stable-macos-arm64-Chunky.dmg`](https://github.com/mkh09353/chunky-app/releases/latest/download/stable-macos-arm64-Chunky.dmg),
open it, and copy `Chunky.app` to `/Applications`.

## Releases

Chunky checks GitHub Releases for updates shortly after launch and from
**Chunky → Check for Updates…**. Available updates download in the background
and are installed after confirmation.

To cut a release, update the `version` in `package.json`, then create and push
the matching tag:

```sh
git tag vX.Y.Z
git push origin vX.Y.Z
```

The release workflow verifies the tag matches `package.json`, runs the stable
macOS arm64 build, and publishes every Electrobun artifact from `artifacts/` to
the GitHub Release. The updater polls
`https://github.com/mkh09353/chunky-app/releases/latest/download/stable-macos-arm64-update.json`.

### macOS signing and notarization setup

Tag releases sign and notarize with `xcrun notarytool`; local `bun run build`
remains unsigned and does not require Apple credentials. Before creating the
first release, create a **Developer ID Application** certificate in the Apple
Developer portal for the team, export it from Keychain Access as a passworded
`.p12`, and base64 encode it without line wrapping:

```sh
base64 < developer-id-application.p12 | tr -d '\n'
```

Create an app-specific password for the Apple ID used to submit notarization
(`appleid.apple.com`), and record that Apple Developer Team ID. Add these
repository secrets with these exact names and values:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE_P12_BASE64` | Single-line base64 of the exported Developer ID Application `.p12`. |
| `APPLE_CERTIFICATE_PASSWORD` | Password assigned while exporting that `.p12`. |
| `APPLE_KEYCHAIN_PASSWORD` | A new random password used only for the throwaway CI keychain. |
| `ELECTROBUN_DEVELOPER_ID` | Exact signing identity shown by `security find-identity`, e.g. `Developer ID Application: Your Name (TEAMID)`. |
| `ELECTROBUN_APPLEID` | Apple ID email address authorized for notarization. |
| `ELECTROBUN_APPLEIDPASS` | App-specific password created for that Apple ID. |
| `ELECTROBUN_TEAMID` | Ten-character Apple Developer Team ID. |

The workflow imports the certificate into a temporary keychain, grants
`codesign` access, then deletes the keychain in an `always()` cleanup step.
Electrobun signs the app bundles and DMG with hardened runtime, submits each
for notarization, and staples the results. Its built-in default entitlements
already allow Bun's JIT, unsigned executable memory, and dynamic library
loading, so this app does not add an entitlements file.

## Server connection (Phase 0)

| Mode | Base URL | Auth token |
|------|----------|------------|
| Vite dev (`dev:web` / HMR) | Same-origin `/chunky-api` proxy → Chunky server (default `http://localhost:4620`, override with `CHUNKY_URL`) | Vite reads `~/.chunky/state/settings.json` (or `CHUNKY_SETTINGS`) and attaches the bearer header server-side. The token is not embedded in the renderer bundle. |
| Electrobun window (dev) | Uses the same Vite `/chunky-api` proxy while HMR is active. | Attached by Vite server-side. |
| Electrobun packaged view | Bun process RPC `getConfig` → `{ baseUrl, serverToken, workspace }` (reads settings + `CHUNKY_URL`/`CHUNKY_PORT`) | Runtime only via RPC — production `vite build` does **not** embed the token in `dist/`. |
| Fallback | `public/chunky-config.json` (`baseUrl` only — do not put tokens in this file) | Dev define token if present; otherwise RPC. |

Force-token-in-bundle (local debugging only): `CHUNKY_INJECT_TOKEN=1 bun run build:web`. Do not ship that.

If the server is unreachable, the app shows a connection banner with **Retry**
and an explicit **Demo mode** that keeps the polished mock UI offline. Live
server state is the default whenever connected.

## What's inside

- **Live client** (`src/mainview/lib/api.ts`, `transcript.ts`, `reconnect.ts`) —
  sessions list/create, SSE transcript reduce, send/interrupt, model picker.
- **Theme** — Chunky brand purple, dark default, pre-paint bootstrap in `index.html`.
- **Brand** (`assets/brand/`) — the approved Chunky "Minimal Purple" artwork,
  committed byte-for-byte from the Chunky asset package (see
  `assets/brand/README.txt`). It is the source of truth and is never edited in
  place. `src/mainview/public/chunky-mark.svg` is a verbatim copy of
  `chunky-minimal-purple-exact.svg`. `bun run icons` mechanically derives the
  10-file `assets/icon.iconset/` that Electrobun turns into `AppIcon.icns` —
  uniform scale, centred on a transparent square canvas, nothing else — and
  `bun run icons:check` fails if anything committed has drifted from the
  approved artwork.
- **UI kit** (`src/mainview/components/ui/`) — button, input, textarea, dialog,
  dropdown-menu, tooltip, scroll-area, kbd, skeleton, switch, separator.
- **Screens** — sidebar (real sessions when live), chat view with code blocks +
  streaming caret, composer (real models), ⌘K palette, settings (connection info).

## Keyboard

⌘K palette · ⌘, settings · ⌘N new thread · Enter send / Shift-Enter newline · Esc stop
