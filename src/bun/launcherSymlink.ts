import { mkdirSync, readlinkSync, renameSync, symlinkSync, rmSync } from "node:fs"
import { join } from "node:path"

export type LauncherSymlinkFs = {
  mkdir(path: string): void
  readlink(path: string): string
  symlink(target: string, path: string): void
  rename(from: string, to: string): void
  remove(path: string): void
}

const defaultFs: LauncherSymlinkFs = {
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  readlink: (path) => readlinkSync(path),
  symlink: (target, path) => symlinkSync(target, path),
  rename: renameSync,
  remove: (path) => rmSync(path, { force: true }),
}

/** Create/refresh the runtime-local launcher without ever touching system paths. */
export function ensureChunkyServerLauncher(runtimeRoot: string, bunPath: string, fs: LauncherSymlinkFs = defaultFs): string | undefined {
  const path = join(runtimeRoot, "bin", "chunky-server")
  try {
    fs.mkdir(join(runtimeRoot, "bin"))
    try {
      if (fs.readlink(path) === bunPath) return path
    } catch {}
    const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
    fs.remove(temporary)
    fs.symlink(bunPath, temporary)
    fs.rename(temporary, path)
    return path
  } catch {
    return undefined
  }
}
