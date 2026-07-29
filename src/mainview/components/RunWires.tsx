// Dashed wires from a running run's tool pill to its card in the live rail.
//
// Electrobun renders in WKWebView, so CSS anchor positioning is not available:
// the geometry has to be measured. Redraws are rAF-throttled and driven by
// scroll / resize / layout mutations, and every wire is culled the moment
// either end is off screen (or the rail is minimised), so an idle thread costs
// nothing.
import { useCallback, useEffect, useRef } from "react"
import { runAccent } from "~/lib/runs"

const SVGNS = "http://www.w3.org/2000/svg"
/** Panel width at which the gutter exists (mirrors the @[1074px] container
 *  breakpoint in ChatView). Narrower than this the rail is a bottom strip and
 *  cards sit inline, so there is nothing to wire. */
const GUTTER_AT = 1074

export function RunWires({
  scrollRef,
  containerRef,
  /** Changes whenever run state moves, to force a redraw. */
  revision,
}: {
  scrollRef: React.RefObject<HTMLElement | null>
  containerRef: React.RefObject<HTMLElement | null>
  revision: string
}) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const frame = useRef<number | null>(null)
  const observer = useRef<MutationObserver | null>(null)
  const sizeObserver = useRef<ResizeObserver | null>(null)
  const observedRail = useRef<Element | null>(null)

  /** The scrollport, resolved from the DOM: the ScrollArea primitive attaches
   *  its viewport ref late, so trusting the ref alone loses whole redraws. */
  const scrollportOf = useCallback(
    (container: HTMLElement | null): HTMLElement | null =>
      scrollRef.current ??
      container?.closest<HTMLElement>("[data-slot='scroll-area-viewport']") ??
      null,
    [scrollRef],
  )

  const draw = useCallback(() => {
    const svg = svgRef.current
    const container = containerRef.current
    const scroller = scrollportOf(container)
    if (!svg || !container || !scroller) return

    while (svg.firstChild) svg.removeChild(svg.firstChild)
    if (container.clientWidth < GUTTER_AT) return

    const box = svg.getBoundingClientRect()
    const view = scroller.getBoundingClientRect()

    for (const pill of Array.from(container.querySelectorAll<HTMLElement>("[data-run-pill]"))) {
      const runId = pill.dataset.runPill
      if (!runId) continue
      const card = container.querySelector<HTMLElement>(
        `[data-run-live="${CSS.escape(runId)}"]`,
      )
      if (!card || !card.offsetParent) continue // rail minimised / not mounted

      const pane = card.closest<HTMLElement>(".overflow-y-auto")
      const p = pill.getBoundingClientRect()
      const c = card.getBoundingClientRect()
      const rail = card.closest<HTMLElement>("aside")
      if (!rail) continue
      // Minimising the rail changes ITS height only — the zero-height sticky
      // layer keeps the container the same size — so watch the panel directly.
      if (sizeObserver.current && observedRail.current !== rail) {
        if (observedRail.current) sizeObserver.current.unobserve(observedRail.current)
        sizeObserver.current.observe(rail)
        observedRail.current = rail
      }
      const r = rail.getBoundingClientRect()

      // Cull: pill scrolled out of the transcript, or card out of the rail's pane.
      if (p.bottom < view.top + 8 || p.top > view.bottom - 8) continue
      if (pane) {
        const q = pane.getBoundingClientRect()
        if (c.bottom < q.top + 4 || c.top > q.bottom - 4) continue
      }

      const x1 = p.right - box.left + 5
      const y1 = p.top - box.top + Math.min(p.height / 2, 17)
      const x2 = r.left - box.left - 4
      const y2 = c.top - box.top + Math.min(c.height / 2, 18)
      if (x2 - x1 < 10) continue

      const dx = Math.max(16, Math.min(72, (x2 - x1) * 0.55))
      const hue = runAccent(runId)

      const path = document.createElementNS(SVGNS, "path")
      path.setAttribute(
        "d",
        `M${x1} ${y1} C${x1 + dx} ${y1},${x2 - dx} ${y2},${x2} ${y2}`,
      )
      path.setAttribute("fill", "none")
      path.setAttribute("stroke", hue)
      path.setAttribute("stroke-width", "1.25")
      path.setAttribute("stroke-dasharray", "3 3")
      path.setAttribute("opacity", "0.85")
      svg.appendChild(path)

      for (const [cx, cy] of [
        [x1, y1],
        [x2, y2],
      ] as const) {
        const dot = document.createElementNS(SVGNS, "circle")
        dot.setAttribute("cx", String(cx))
        dot.setAttribute("cy", String(cy))
        dot.setAttribute("r", "2.2")
        dot.setAttribute("fill", hue)
        svg.appendChild(dot)
      }
    }

  }, [containerRef, scrollportOf])

  // One frame per burst. The pending id is cleared BEFORE drawing so a frame
  // that never arrives (throttled/backgrounded window) can't wedge the
  // scheduler and kill every later redraw. Changes React commits after this
  // frame are picked up by the MutationObserver below, not by a second rAF.
  const schedule = useCallback(() => {
    if (frame.current != null) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      draw()
    })
  }, [draw])

  useEffect(() => {
    schedule()
    const container = containerRef.current
    // Capture-phase on window: scroll does not bubble, and the ScrollArea's
    // viewport may not be an ancestor yet when this effect first runs, so
    // binding to the element directly silently loses every redraw.
    window.addEventListener("scroll", schedule, { capture: true, passive: true })
    window.addEventListener("resize", schedule)

    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null
    sizeObserver.current = ro
    observedRail.current = null
    if (ro && container) ro.observe(container)

    // The rail lives in a zero-height sticky layer, so minimising it resizes
    // nothing the observer above can see — and a click handler would measure
    // before React commits. Watching for committed DOM changes catches every
    // toggle (rail, cards, mount/unmount). characterData is deliberately NOT
    // observed: streaming text must not trigger a redraw per token.
    const mo =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver((records) => {
            // Ignore the <path> elements we just drew ourselves.
            const svg = svgRef.current
            if (svg && records.every((r) => svg === r.target || svg.contains(r.target))) return
            schedule()
          })
        : null
    observer.current = mo
    if (mo && container) {
      mo.observe(container, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "style"],
      })
    }

    return () => {
      window.removeEventListener("scroll", schedule, { capture: true })
      window.removeEventListener("resize", schedule)
      ro?.disconnect()
      mo?.disconnect()
      observer.current = null
      sizeObserver.current = null
      observedRail.current = null
      if (frame.current != null) cancelAnimationFrame(frame.current)
      frame.current = null
    }
  }, [schedule, scrollportOf, containerRef])

  // Run state moved (spawn/settle/output) — remeasure.
  useEffect(schedule, [schedule, revision])

  return (
    <svg
      ref={svgRef}
      aria-hidden="true"
      data-run-wires=""
      className="pointer-events-none absolute inset-0 z-[15] h-full w-full overflow-visible @max-[1073px]:hidden"
    />
  )
}
