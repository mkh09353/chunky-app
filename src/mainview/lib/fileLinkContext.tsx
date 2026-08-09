// Where a relative file path in the transcript is anchored.
//
// `src/mainview/lib/markdown.tsx` only means something relative to a directory,
// and the markdown renderer is far below the code that knows which session (and
// therefore which repo) is on screen. Rather than thread a `cwd` prop through
// ChatView → MessageView → Markdown → renderInline, the chat provides it once
// as context and the chip reads it.
//
// A missing provider is a supported state: the chip then only offers to open
// paths that need no anchor (absolute and `~/`), and in a plain browser build it
// offers nothing at all.

import { createContext, useContext, useMemo, type ReactNode } from "react"
import { editorLinksAvailable } from "./openInEditor"

export interface FileLinkScope {
  /** Absolute directory relative paths resolve against, when known. */
  cwd?: string
  /** Whether the editor bridge exists at all (desktop app vs browser dev). */
  enabled: boolean
}

const FileLinkContext = createContext<FileLinkScope | null>(null)

export function FileLinkProvider({
  cwd,
  enabled,
  children,
}: {
  cwd?: string | undefined
  /** Override for tests and previews; defaults to the real RPC probe. */
  enabled?: boolean
  children: ReactNode
}): ReactNode {
  const value = useMemo<FileLinkScope>(
    () => ({ ...(cwd ? { cwd } : {}), enabled: enabled ?? editorLinksAvailable() }),
    [cwd, enabled],
  )
  return <FileLinkContext.Provider value={value}>{children}</FileLinkContext.Provider>
}

/** The active scope, or a provider-less default (probe the bridge, no cwd). */
export function useFileLinkScope(): FileLinkScope {
  const scope = useContext(FileLinkContext)
  // Not memoised on purpose: the fallback object is only read during render.
  return scope ?? { enabled: editorLinksAvailable() }
}
