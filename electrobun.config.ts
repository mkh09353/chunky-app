import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ElectrobunConfig } from "electrobun/bun"

const isRelease = process.argv[2] === "build"
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
    // The Vite build emits to dist/ (see vite.config.ts). Copy it into the
    // bundle so the installed app can serve the UI over views://mainview/*.
    // Also stage FFF native bins for production packaging (see above).
    copy: {
      "dist/index.html": "views/mainview/index.html",
      "dist/assets": "views/mainview/assets",
      ...fffBinCopy,
    },
    watchIgnore: ["dist/**"],
    mac: {
      bundleCEF: false,
      // When Apple Developer credentials are available, enable codesign/notarize
      // here and configure the required signing identity and notarization secrets in CI.
      // codesign: true,
      // notarize: true,
    },
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
  release: {
    baseUrl: "https://github.com/mkh09353/chunky-app/releases/latest/download",
  },
} satisfies ElectrobunConfig
