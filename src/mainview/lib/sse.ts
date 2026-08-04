// Minimal named-event SSE reader.
//
// `readSSE` from @chunky/protocol yields AgentEvents and drops the frame's
// `event:` name, which is exactly what the session stream (ROUTES.sessionStream)
// encodes its snapshot/delta distinction in. This parses whole frames instead,
// leaving the payload shape to the caller.
//
// Pure buffer + a thin Response wrapper, so frame splitting is testable without
// a server. Run with: bun test src/mainview/lib/sse.test.ts

export interface SseFrame {
  /** The frame's `event:` name; "message" when it carries none (SSE default). */
  event: string
  /** Concatenated `data:` lines (newline-joined), never trimmed of content. */
  data: string
}

/** Incremental SSE frame splitter. Feed it decoded chunks, take whole frames. */
export class SseFrameBuffer {
  private buf = ""

  push(chunk: string): SseFrame[] {
    this.buf += chunk
    const frames: SseFrame[] = []
    let idx: number
    while ((idx = this.buf.indexOf("\n\n")) !== -1) {
      const raw = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 2)
      const frame = parseSseFrame(raw)
      if (frame) frames.push(frame)
    }
    return frames
  }
}

/** One frame's lines → {event, data}, or null for a comment/keep-alive frame. */
export function parseSseFrame(raw: string): SseFrame | null {
  let event = "message"
  const data: string[] = []
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue
    if (line.startsWith("event:")) event = line.slice(6).trim()
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
  }
  if (data.length === 0) return null
  return { event, data: data.join("\n") }
}

/** Stream a Response body as named SSE frames. Resolves when the server ends it. */
export async function* readNamedSSE(res: Response, signal?: AbortSignal): AsyncGenerator<SseFrame> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const buffer = new SseFrameBuffer()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      for (const frame of buffer.push(decoder.decode(value, { stream: true }))) {
        if (signal?.aborted) return
        yield frame
      }
      if (signal?.aborted) return
    }
  } finally {
    reader.releaseLock()
  }
}
