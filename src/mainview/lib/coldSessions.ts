// Cold (server-archived) sessions.
//
// Two unrelated things share the sidebar's "Archived" section:
//   * DEVICE-archived threads — a local view filter (lib/archivedSessions), the
//     row still exists in the live list and can be un-archived here;
//   * COLD threads — rows the SERVER has archived (>14 days idle). They have
//     left the live list and the summary stream entirely and are fetched on
//     demand, per repo, when the section is opened.
//
// This module owns only the pure part: which cold rows are still worth drawing
// once the locally archived ones are on screen. Cold rows are presentation
// state and never enter the live session caches.
import type { Thread } from "./mock"

/** Cold rows to render BELOW the locally archived ones.
 *
 *  A session can be both (archived on this device and later archived by the
 *  server); it shows once, as the local row, which keeps its un-archive
 *  affordance. Also drops ids already visible in the live list, so a session
 *  the server restored while the section is open cannot appear twice. */
export function mergeColdThreads(
  localArchived: readonly Thread[],
  cold: readonly Thread[] | undefined,
  liveIds?: ReadonlySet<string>,
): Thread[] {
  if (!cold || cold.length === 0) return []
  const seen = new Set(localArchived.map((t) => t.id))
  const out: Thread[] = []
  for (const row of cold) {
    if (seen.has(row.id)) continue
    if (liveIds?.has(row.id)) continue
    seen.add(row.id)
    out.push(row)
  }
  return out
}
