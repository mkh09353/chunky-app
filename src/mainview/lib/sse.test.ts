import { describe, expect, test } from "bun:test"
import { SseFrameBuffer, parseSseFrame } from "./sse"

describe("parseSseFrame", () => {
  test("reads the event name and data", () => {
    expect(parseSseFrame("event: delta\ndata: {\"a\":1}")).toEqual({
      event: "delta",
      data: '{"a":1}',
    })
  })

  test("defaults to the SSE `message` event", () => {
    expect(parseSseFrame("data: plain")).toEqual({ event: "message", data: "plain" })
  })

  test("ignores comment/keep-alive frames", () => {
    expect(parseSseFrame(": ping")).toBeNull()
    expect(parseSseFrame(": ready")).toBeNull()
    expect(parseSseFrame("")).toBeNull()
  })

  test("joins multi-line data", () => {
    expect(parseSseFrame("event: snapshot\ndata: one\ndata: two")).toEqual({
      event: "snapshot",
      data: "one\ntwo",
    })
  })
})

describe("SseFrameBuffer", () => {
  test("splits frames and holds the incomplete tail", () => {
    const buffer = new SseFrameBuffer()
    expect(buffer.push("event: snapshot\ndata: {\"sessions\":[]}\n\nevent: del")).toEqual([
      { event: "snapshot", data: '{"sessions":[]}' },
    ])
    expect(buffer.push("ta\ndata: {\"upsert\":[]}")).toEqual([])
    expect(buffer.push("\n\n")).toEqual([{ event: "delta", data: '{"upsert":[]}' }])
  })

  test("survives a chunk boundary inside the payload and drops keep-alives", () => {
    const buffer = new SseFrameBuffer()
    expect(buffer.push(": ping\n\nevent: delta\ndata: {\"upse")).toEqual([])
    expect(buffer.push('rt":[{"sessionId":"a"}],"remove":[]}\n\n')).toEqual([
      { event: "delta", data: '{"upsert":[{"sessionId":"a"}],"remove":[]}' },
    ])
  })

  test("yields several frames arriving in one chunk", () => {
    const buffer = new SseFrameBuffer()
    const frames = buffer.push("data: one\n\ndata: two\n\ndata: three\n\n")
    expect(frames.map((f) => f.data)).toEqual(["one", "two", "three"])
  })
})
