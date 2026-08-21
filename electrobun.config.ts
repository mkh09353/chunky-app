import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ElectrobunConfig } from "electrobun/bun"

const isRelease = process.argv[2] === "build"
const isStableRelease = process.argv.includes("--env=stable")
// Signing credentials exist only in the tag-release workflow. Keeping this
// false locally makes `bun run build` a useful unsigned release-build check.
const signAndNotarize = isStableRelease && process.env.GITHUB_ACTIONS === "true"
// Keep desktop bundle metadata in lockstep with the package/release tag.
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string
}

/**
 * Electrobun uses `Bun.build({ target: "bun" })` (not `--compile`).
 * FFF's dynamic `import(..., { with: { type: "file" } })` does NOT emit the
 * native dylib as a build asset, so a shipped .app has no libfff unless we
 * stage the platform package next to the bundled bun entry.
 *
 * At runtime, fff-bun resolves the dylib via createRequire from the parent of
 * `Resources/app/bun` → `Resources/app/node_modules/@ff-labs/fff-bin-*`.
 */
const FFF_BIN_PACKAGES = [
  "fff-bin-darwin-arm64",
  "fff-bin-darwin-x64",
  "fff-bin-linux-x64-gnu",
  "fff-bin-linux-arm64-gnu",
  "fff-bin-linux-x64-musl",
  "fff-bin-linux-arm64-musl",
  "fff-bin-win32-x64",
  "fff-bin-win32-arm64",
] as const

/**
 * Bundle Chromium (CEF) instead of using the system WebView.
 *
 * Tagged releases set CHUNKY_BUNDLE_CEF=1 so the shipped .app includes CEF
 * (needed for the in-app browser pane's Chrome DevTools Protocol listener;
 * Electrobun starts CEF with `remote_debugging_port` = the first free port in
 * 9222-9232, loopback only, which is what the app announces to the Chunky
 * server). Local `bun run build` / `bun run dev` still default to the system
 * WebView unless you export CHUNKY_BUNDLE_CEF=1 — CEF is a ~131MB download that
 * lands as a ~400MB framework inside the bundle.
 *
 * Nothing else has to change: the main window stays on the system WebView
 * (`renderer: "native"` in src/bun/index.ts) and only the browser pane asks for
 * `renderer="cef"`, which it does automatically once build.json advertises it.
 */
const bundleCEF = process.env.CHUNKY_BUNDLE_CEF === "1"

const fffBinCopy: Record<string, string> = {}
for (const name of FFF_BIN_PACKAGES) {
  const src = join("node_modules", "@ff-labs", name)
  if (existsSync(join(import.meta.dir, src))) {
    fffBinCopy[src] = join("node_modules", "@ff-labs", name)
  }
}

export default {
  app: {
    name: isRelease ? "Chunky" : "Chunky Dev",
    identifier: isRelease ? "to.chunky.app" : "to.chunky.app.dev",
    version,
  },
  build: {
    // Releases currently ship macOS Apple Silicon only.
    targets: "macos-arm64",
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    // The Vite build emits to dist/ (see vite.config.ts). Stage the WHOLE dist
    // tree so the installed app can serve the UI over views://mainview/*.
    //
    // This must not be narrowed to index.html + assets/: Vite copies everything
    // in src/mainview/public/ to the *root* of dist (chunky-mark.svg,
    // chunky-config.json), not into dist/assets. Listing only those two entries
    // shipped a bundle where `/chunky-mark.svg` 404'd and the logo rendered as a
    // broken image. Copying dist wholesale keeps packaging correct for any
    // future public/ asset. src/bun/rendererAssets.test.ts guards this.
    //
    // Also stage FFF native bins for production packaging (see above).
    copy: {
      dist: "views/mainview",
      ...fffBinCopy,
    },
    watchIgnore: ["dist/**"],
    mac: {
      bundleCEF,
      // Electrobun runs `iconutil -c icns` on this folder and writes
      // Contents/Resources/AppIcon.icns, which the generated Info.plist already
      // references via CFBundleIconFile. Without it Electrobun silently ships a
      // bundle with a dangling icon reference. The iconset is derived
      // mechanically from the approved artwork in assets/brand/ — regenerate it
      // with `bun run icons` and verify with `bun run icons:check`.
      icons: "assets/icon.iconset",
      // Electrobun's default hardened-runtime entitlements include the Bun/JIT
      // allowances it needs, so no project-specific entitlements file is needed.
      codesign: signAndNotarize,
      notarize: signAndNotarize,
    },
    linux: { bundleCEF },
    win: { bundleCEF },
  },
  // Electrobun signs Mach-O files in Contents/MacOS and .node files under
  // Resources/app/bun, but not dylibs copied into Resources/app/node_modules.
  // This hook runs after staging and before Electrobun signs/notarizes the app.
  scripts: signAndNotarize ? { postBuild: "scripts/sign-nested-macho.ts" } : undefined,
  release: {
    baseUrl: "https://github.com/mkh09353/chunky-app/releases/latest/download",
  },
} satisfies ElectrobunConfig
