// Sidebar list shaping — pure, so the collapse rule can be reasoned about
// (and tested) without React. Run with:
//   bun test src/mainview/lib/sessionList.test.ts
//
// The session list itself is server state (listSessions is scoped to the active
// repo); nothing here reorders or filters it by identity. This only decides how
// much of an already-ordered list a settled section shows before the reader
// asks for the rest.

/** How many settled rows a collapsed section shows. */
export const SETTLED_PREVIEW = 8

export interface CollapsedList<T> {
  /** The rows to render right now. */
  visible: T[]
  /** How many rows the collapse is holding back (0 when nothing is hidden). */
  hidden: number
}

/**
 * Show at most `limit` rows until `expanded`. Order is preserved exactly: the
 * server decides what comes first, this only cuts the tail off.
 *
 * A section one row over the limit is NOT collapsed — hiding a single row to
 * show a "Show 1 more" button costs more than it saves.
 */
export function collapseList<T>(
  items: T[],
  expanded: boolean,
  limit = SETTLED_PREVIEW,
): CollapsedList<T> {
  if (expanded || limit <= 0 || items.length <= limit + 1) {
    return { visible: items, hidden: 0 }
  }
  return { visible: items.slice(0, limit), hidden: items.length - limit }
}
