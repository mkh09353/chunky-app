import { describe, expect, it } from "bun:test"
import { copyText, type LegacyCopyHandle } from "./clipboard"

/** A fake of the armed legacy path, recording how it was driven. */
function armed(result = true) {
  const log: string[] = []
  const handle: LegacyCopyHandle = {
    commit: () => {
      log.push("commit")
      return result
    },
    cancel: () => {
      log.push("cancel")
    },
  }
  return { log, prepare: (t: string) => (log.push(`prepare:${t}`), handle) }
}

describe("copyText", () => {
  it("uses the async Clipboard API when it works", async () => {
    const written: string[] = []
    const ok = await copyText("/Users/me/code/app", {
      writeText: async (t) => {
        written.push(t)
      },
      exec: () => {
        throw new Error("fallback should not run")
      },
    })
    expect(ok).toBe(true)
    expect(written).toEqual(["/Users/me/code/app"])
  })

  it("falls back to execCommand when the Clipboard API rejects (WKWebView)", async () => {
    const legacy: string[] = []
    const ok = await copyText("/tmp/x", {
      writeText: async () => {
        throw new Error("NotAllowedError")
      },
      exec: (t) => {
        legacy.push(t)
        return true
      },
    })
    expect(ok).toBe(true)
    expect(legacy).toEqual(["/tmp/x"])
  })

  it("falls back when the Clipboard API is absent entirely", async () => {
    const legacy: string[] = []
    const ok = await copyText("/tmp/y", {
      exec: (t) => {
        legacy.push(t)
        return true
      },
    })
    expect(ok).toBe(true)
    expect(legacy).toEqual(["/tmp/y"])
  })

  it("reports failure when both paths fail, and never throws", async () => {
    expect(
      await copyText("/tmp/z", {
        writeText: async () => {
          throw new Error("no")
        },
        exec: () => false,
      }),
    ).toBe(false)
    expect(
      await copyText("/tmp/z", {
        exec: () => {
          throw new Error("boom")
        },
      }),
    ).toBe(false)
    expect(await copyText("/tmp/z", {})).toBe(false)
  })

  it("refuses empty text without touching the clipboard", async () => {
    let touched = false
    const ok = await copyText("", {
      writeText: async () => {
        touched = true
      },
    })
    expect(ok).toBe(false)
    expect(touched).toBe(false)
  })
})

describe("copyText: WKWebView gesture-safe fallback", () => {
  it("arms the legacy path BEFORE awaiting the Clipboard API", async () => {
    const legacy = armed()
    let awaited = false
    await copyText("/tmp/a", {
      prepare: legacy.prepare,
      writeText: async () => {
        awaited = true
        // The selection must already exist by the time we're awaited.
        expect(legacy.log[0]).toBe("prepare:/tmp/a")
      },
    })
    expect(awaited).toBe(true)
  })

  it("cancels the armed selection when the Clipboard API succeeds", async () => {
    const legacy = armed()
    const ok = await copyText("/tmp/b", {
      prepare: legacy.prepare,
      writeText: async () => {},
    })
    expect(ok).toBe(true)
    expect(legacy.log).toEqual(["prepare:/tmp/b", "cancel"])
  })

  it("commits the armed selection when the Clipboard API rejects", async () => {
    const legacy = armed(true)
    const ok = await copyText("/tmp/c", {
      prepare: legacy.prepare,
      writeText: async () => {
        throw new Error("NotAllowedError")
      },
      exec: () => {
        throw new Error("one-shot exec should not be needed")
      },
    })
    expect(ok).toBe(true)
    expect(legacy.log).toEqual(["prepare:/tmp/c", "commit"])
  })

  it("commits the armed selection when there is no Clipboard API at all", async () => {
    const legacy = armed(true)
    const ok = await copyText("/tmp/d", { prepare: legacy.prepare })
    expect(ok).toBe(true)
    expect(legacy.log).toEqual(["prepare:/tmp/d", "commit"])
  })

  it("falls back to the one-shot exec when the armed commit fails", async () => {
    const legacy = armed(false)
    const oneShot: string[] = []
    const ok = await copyText("/tmp/e", {
      prepare: legacy.prepare,
      writeText: async () => {
        throw new Error("nope")
      },
      exec: (t) => {
        oneShot.push(t)
        return true
      },
    })
    expect(ok).toBe(true)
    expect(legacy.log).toEqual(["prepare:/tmp/e", "commit", "cancel"])
    expect(oneShot).toEqual(["/tmp/e"])
  })

  it("survives a prepare that cannot arm (no DOM)", async () => {
    const ok = await copyText("/tmp/f", {
      prepare: () => null,
      writeText: async () => {
        throw new Error("nope")
      },
      exec: () => true,
    })
    expect(ok).toBe(true)
  })
})
