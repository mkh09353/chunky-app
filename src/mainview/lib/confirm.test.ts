// The confirmation queue behind the in-app dialog. Run with:
//   bun test src/mainview/lib/confirm.test.ts
import { afterEach, describe, expect, test } from "bun:test"
import { confirm, currentConfirm, resetConfirms, subscribeConfirm } from "./confirm"

afterEach(() => {
  resetConfirms()
})

describe("confirm queue", () => {
  test("resolves true only when the request is confirmed", async () => {
    const answer = confirm({ title: "Remove repo?" })
    currentConfirm()!.settle(true)
    expect(await answer).toBe(true)
  })

  test("cancelling resolves false and empties the queue", async () => {
    const answer = confirm({ title: "Delete the seat?" })
    currentConfirm()!.settle(false)
    expect(await answer).toBe(false)
    expect(currentConfirm()).toBeNull()
  })

  test("carries its options through to the host", () => {
    void confirm({
      title: "Remove skill repo?",
      body: "This deletes the local clone.",
      confirmLabel: "Remove",
      destructive: true,
    })
    expect(currentConfirm()).toMatchObject({
      title: "Remove skill repo?",
      body: "This deletes the local clone.",
      confirmLabel: "Remove",
      destructive: true,
    })
  })

  test("a second prompt waits its turn instead of replacing the first", async () => {
    const first = confirm({ title: "first" })
    const second = confirm({ title: "second" })
    expect(currentConfirm()?.title).toBe("first")

    currentConfirm()!.settle(true)
    expect(await first).toBe(true)
    // Answering the first must not answer the second.
    expect(currentConfirm()?.title).toBe("second")

    currentConfirm()!.settle(false)
    expect(await second).toBe(false)
    expect(currentConfirm()).toBeNull()
  })

  test("settling twice is ignored, so a click racing Escape cannot answer the next prompt", async () => {
    const first = confirm({ title: "first" })
    const second = confirm({ title: "second" })
    const request = currentConfirm()!
    request.settle(true)
    request.settle(false)
    expect(await first).toBe(true)
    // The stale second call must not have touched the queue.
    expect(currentConfirm()?.title).toBe("second")
    currentConfirm()!.settle(true)
    expect(await second).toBe(true)
  })

  test("subscribers see the head of the queue as it changes", async () => {
    const seen: (string | null)[] = []
    const unsubscribe = subscribeConfirm((request) => seen.push(request?.title ?? null))

    const answer = confirm({ title: "only" })
    currentConfirm()!.settle(true)
    await answer

    unsubscribe()
    void confirm({ title: "after unsubscribe" })
    expect(seen).toEqual(["only", null])
  })

  test("a reset answers everything still pending with false", async () => {
    const first = confirm({ title: "first" })
    const second = confirm({ title: "second" })
    resetConfirms()
    expect(await first).toBe(false)
    expect(await second).toBe(false)
    expect(currentConfirm()).toBeNull()
  })
})
