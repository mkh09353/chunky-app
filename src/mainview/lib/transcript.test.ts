import { describe, expect, test } from "bun:test"
import { initialState, isTreeIdle, reduce } from "./transcript"

describe("session tree status", () => {
  test("keeps a delegate run live when the root turn goes idle", () => {
    const running = reduce(
      reduce(
        reduce(initialState, { type: "session.status", sessionId: "session", status: "running" }),
        { type: "thread.spawn", threadId: "child", parentThreadId: null, title: "Child" },
      ),
      { type: "thread.status", threadId: "child", status: "running" },
    )
    const rootIdle = reduce(running, { type: "session.status", sessionId: "session", status: "idle" })

    expect(rootIdle.runs.find((run) => run.threadId === "child")?.status).toBe("running")
    expect(isTreeIdle(rootIdle)).toBe(false)

    const settled = reduce(rootIdle, { type: "thread.status", threadId: "child", status: "idle" })
    expect(settled.runs.find((run) => run.threadId === "child")?.status).toBe("done")
    expect(isTreeIdle(settled)).toBe(true)
  })
})
