// Cross-tree link between a run's tool pill (deep inside a transcript message)
// and its card (in the rail or the gutter). Hovering either end highlights both,
// and an idle seat can jump the transcript back to its last parked run.
//
// A context rather than prop-drilling: the pill lives inside Message → block →
// ToolCard, several levels below anything that knows about runs.
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react"

export interface RunLinkValue {
  /** Run id currently hovered at either end, or null. */
  hovered: string | null
  setHovered: (runId: string | null) => void
  /** Run id briefly flashed after a jump. */
  flashed: string | null
  jumpToRun: (runId: string) => void
}

const noop: RunLinkValue = {
  hovered: null,
  setHovered: () => {},
  flashed: null,
  jumpToRun: () => {},
}

const RunLinkContext = createContext<RunLinkValue>(noop)

export function useRunLink(): RunLinkValue {
  return useContext(RunLinkContext)
}

export function RunLinkProvider({
  children,
  onJump,
}: {
  children: React.ReactNode
  /** Scroll a parked run into view; returns false when it isn't rendered. */
  onJump: (runId: string) => boolean
}) {
  const [hovered, setHovered] = useState<string | null>(null)
  const [flashed, setFlashed] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const jumpToRun = useCallback(
    (runId: string) => {
      if (!onJump(runId)) return
      if (timer.current) clearTimeout(timer.current)
      setFlashed(runId)
      timer.current = setTimeout(() => setFlashed(null), 1600)
    },
    [onJump],
  )

  const value = useMemo<RunLinkValue>(
    () => ({ hovered, setHovered, flashed, jumpToRun }),
    [hovered, flashed, jumpToRun],
  )

  return <RunLinkContext.Provider value={value}>{children}</RunLinkContext.Provider>
}

/** Props that make an element a live end of a run link. */
export function runLinkProps(runId: string | undefined, link: RunLinkValue) {
  if (!runId) return {}
  return {
    onMouseEnter: () => link.setHovered(runId),
    onMouseLeave: () => link.setHovered(null),
  }
}

/** True when this run should render in its highlighted state. */
export function isRunLit(runId: string | undefined, link: RunLinkValue): boolean {
  return !!runId && (link.hovered === runId || link.flashed === runId)
}
