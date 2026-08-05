// Which superseded servers get surfaced, and what each row offers. Run with:
//   bun test src/mainview/lib/oldServers.test.ts
import { describe, expect, test } from "bun:test"
import type { InspectedServer, ServerInspection } from "./serverLifecycle"
import {
  classifyServers,
  forceStopWarning,
  formatServerRow,
  isOldServer,
  parseInspection,
  sessionCountLabel,
} from "./oldServers"

function server(over: Partial<InspectedServer> = {}): InspectedServer {
  return {
    id: over.id ?? "srv-1",
    workspace: over.workspace ?? "/Users/me/code/chunky-app",
    version: over.version ?? "0.13.2",
    buildId: over.buildId ?? "build-abc",
    port: over.port ?? 4621,
    pid: over.pid ?? 5150,
    startedAt: over.startedAt ?? 1_700_000_000_000,
    current: over.current ?? false,
    reachable: over.reachable ?? true,
    retiring: over.retiring ?? false,
    busy: over.busy === undefined ? false : over.busy,
    busySessions: over.busySessions ?? 0,
    attachedSessions: over.attachedSessions ?? 0,
    totalSessions: over.totalSessions ?? 0,
  }
}

const inspection = (servers: InspectedServer[]): ServerInspection => ({
  servers,
  installed: { version: "0.14.0", buildId: "build-xyz" },
})

describe("sessionCountLabel", () => {
  test("never says one sessions", () => {
    expect(sessionCountLabel(1)).toBe("1 active session")
    expect(sessionCountLabel(2)).toBe("2 active sessions")
    expect(sessionCountLabel(0)).toBe("0 active sessions")
  })
})

describe("isOldServer", () => {
  test("a reachable, non-retiring, non-current server is the case we care about", () => {
    expect(isOldServer(server())).toBe(true)
  })

  test("the server this app is using is never offered for cleanup", () => {
    expect(isOldServer(server({ current: true }))).toBe(false)
  })

  test("one already draining is left alone", () => {
    expect(isOldServer(server({ retiring: true }))).toBe(false)
  })

  test("an unreachable one cannot be acted on, so it is not shown", () => {
    expect(isOldServer(server({ reachable: false }))).toBe(false)
  })
})

describe("formatServerRow", () => {
  test("idle offers a plain stop and nothing else", () => {
    const row = formatServerRow(server({ busy: false }))
    expect(row.status).toBe("idle")
    expect(row.statusLabel).toBe("idle")
    expect(row.tone).toBe("muted")
    expect([row.canStop, row.canRetire, row.canForceStop]).toEqual([true, false, false])
  })

  test("working names the active sessions and offers drain plus force", () => {
    const row = formatServerRow(server({ busy: true, busySessions: 2 }))
    expect(row.status).toBe("working")
    expect(row.statusLabel).toBe("working — 2 active sessions")
    expect(row.tone).toBe("warn")
    expect([row.canStop, row.canRetire, row.canForceStop]).toEqual([false, true, true])
  })

  test("one active session reads in the singular", () => {
    expect(formatServerRow(server({ busy: true, busySessions: 1 })).statusLabel).toBe(
      "working — 1 active session",
    )
  })

  test("unknown never offers an immediate stop, only draining", () => {
    const row = formatServerRow(server({ busy: null }))
    expect(row.status).toBe("unknown")
    expect(row.statusLabel).toBe("state unknown")
    expect([row.canStop, row.canRetire, row.canForceStop]).toEqual([false, true, false])
  })

  test("the workspace is shown by basename, not the whole path", () => {
    expect(formatServerRow(server({ workspace: "/Users/me/code/chunky-app" })).workspace).toBe(
      "chunky-app",
    )
  })

  test("a negative session count cannot leak into a label", () => {
    expect(formatServerRow(server({ busy: true, busySessions: -3 })).activeSessions).toBe(0)
  })
})

describe("classifyServers", () => {
  test("keeps only the servers worth acting on", () => {
    const rows = classifyServers(
      inspection([
        server({ id: "old", busy: false }),
        server({ id: "current", current: true }),
        server({ id: "draining", retiring: true }),
        server({ id: "gone", reachable: false }),
      ]),
    )
    expect(rows.map((r) => r.id)).toEqual(["old"])
  })

  test("nothing to say is an empty list, not a crash", () => {
    expect(classifyServers(null)).toEqual([])
    expect(classifyServers(undefined)).toEqual([])
    expect(classifyServers(inspection([]))).toEqual([])
    expect(classifyServers({ servers: undefined } as unknown as ServerInspection)).toEqual([])
  })
})

describe("forceStopWarning", () => {
  test("says exactly what will be interrupted", () => {
    const row = formatServerRow(server({ busy: true, busySessions: 3 }))
    expect(forceStopWarning(row)).toBe("Interrupts 3 active sessions.")
  })
})

describe("parseInspection", () => {
  test("accepts a well-formed payload", () => {
    const parsed = parseInspection({
      servers: [{ id: "a", workspace: "/w/one", version: "1.0", busy: true, busySessions: 2 }],
      installed: { version: "1.1", buildId: "b" },
    })
    expect(parsed?.servers).toHaveLength(1)
    expect(parsed?.servers[0]!.busy).toBe(true)
    expect(parsed?.servers[0]!.busySessions).toBe(2)
    expect(parsed?.installed).toEqual({ version: "1.1", buildId: "b" })
  })

  test("a missing busy flag becomes unknown rather than false", () => {
    const parsed = parseInspection({ servers: [{ id: "a" }] })
    expect(parsed?.servers[0]!.busy).toBeNull()
  })

  test("rows without an id are dropped", () => {
    const parsed = parseInspection({ servers: [{ id: "a" }, {}, { id: "" }, 7] })
    expect(parsed?.servers.map((s) => s.id)).toEqual(["a"])
  })

  test("a payload that is not an inspection is refused", () => {
    expect(parseInspection(null)).toBeNull()
    expect(parseInspection("nope")).toBeNull()
    expect(parseInspection({})).toBeNull()
    expect(parseInspection({ servers: "no" })).toBeNull()
  })

  test("a malformed installed block is dropped, not guessed at", () => {
    expect(parseInspection({ servers: [], installed: { buildId: "b" } })?.installed).toBeNull()
    expect(parseInspection({ servers: [] })?.installed).toBeNull()
  })
})
