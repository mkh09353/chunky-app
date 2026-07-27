// Bun-main-only embedded terminal sessions. This module deliberately owns no
// renderer state: the renderer reattaches by asking terminalOpen for its
// buffered output and receives subsequent output through the supplied sender.

const MAX_TERMINAL_ID_LENGTH = 128
const MAX_CWD_LENGTH = 4096
const MAX_INPUT_LENGTH = 64 * 1024
const MAX_SCROLLBACK_LENGTH = 200 * 1024
const MIN_DIMENSION = 2
const MAX_DIMENSION = 500

type TerminalMessageName = "terminalData" | "terminalExit"

export type TerminalMessageSender = (
  name: TerminalMessageName,
  payload: { id: string; data: string } | { id: string; exitCode: number | null },
) => void

type TerminalProcess = ReturnType<typeof Bun.spawn>

type TerminalSession = {
  id: string
  process: TerminalProcess
  buffer: string
  decoder: TextDecoder
  exited: boolean
}

type OpenResult = { ok: true; snapshot: string } | { ok: false; error: string }
type OkResult = { ok: boolean }

function objectBody(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function terminalId(value: unknown): string | null {
  if (typeof value !== "string") return null
  const id = value.trim()
  if (!id || id.length > MAX_TERMINAL_ID_LENGTH) return null
  return id
}

function terminalDimension(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(number)) return null
  return Math.max(MIN_DIMENSION, Math.min(Math.floor(number), MAX_DIMENSION))
}

function terminalCwd(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") return null
  const cwd = value.trim()
  if (!cwd || cwd.length > MAX_CWD_LENGTH || cwd.includes("\0")) return null
  return cwd
}

function appendToBuffer(session: TerminalSession, data: string): void {
  session.buffer += data
  if (session.buffer.length > MAX_SCROLLBACK_LENGTH) {
    session.buffer = session.buffer.slice(-MAX_SCROLLBACK_LENGTH)
  }
}

function shellCandidates(): string[] {
  const requested = process.env.SHELL?.trim()
  return [...new Set([requested, "zsh", "bash", "sh"].filter((shell): shell is string => !!shell))]
}

/**
 * Creates the native PTY session manager. The callback maps these messages to
 * Electrobun's rpc.send in index.ts, keeping this file testable with a plain
 * Bun script.
 */
export function createTerminalManager(send: TerminalMessageSender) {
  const sessions = new Map<string, TerminalSession>()

  const publish = (name: TerminalMessageName, payload: Parameters<TerminalMessageSender>[1]) => {
    try {
      send(name, payload)
    } catch (error) {
      // Renderer teardown must not bring down a live shell.
      console.warn("[chunky] terminal renderer message failed:", error)
    }
  }

  const spawn = (id: string, cwd: string | undefined, cols: number, rows: number): OpenResult => {
    let lastError: unknown = null

    for (const shell of shellCandidates()) {
      let session: TerminalSession | null = null
      try {
        const subprocess = Bun.spawn([shell, "-il"], {
          ...(cwd ? { cwd } : {}),
          env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
          terminal: {
            cols,
            rows,
            data: (_terminal, chunk) => {
              if (!session || sessions.get(id) !== session || session.exited) return
              const data = session.decoder.decode(chunk, { stream: true })
              if (!data) return
              appendToBuffer(session, data)
              publish("terminalData", { id, data })
            },
          },
        })

        session = { id, process: subprocess, buffer: "", decoder: new TextDecoder(), exited: false }
        sessions.set(id, session)
        void subprocess.exited.then((exitCode) => {
          if (sessions.get(id) !== session || session.exited) return
          session.exited = true
          const remainder = session.decoder.decode()
          if (remainder) {
            appendToBuffer(session, remainder)
            publish("terminalData", { id, data: remainder })
          }
          publish("terminalExit", {
            id,
            exitCode: typeof exitCode === "number" ? exitCode : null,
          })
        })
        return { ok: true, snapshot: "" }
      } catch (error) {
        lastError = error
      }
    }

    const detail = lastError instanceof Error ? lastError.message : "Unable to start shell"
    return { ok: false, error: detail }
  }

  return {
    open(params: unknown): OpenResult {
      const body = objectBody(params)
      const id = terminalId(body?.id)
      const cols = terminalDimension(body?.cols)
      const rows = terminalDimension(body?.rows)
      const cwd = terminalCwd(body?.cwd)
      if (!id || cols === null || rows === null || cwd === null) {
        return { ok: false, error: "Invalid terminal open parameters" }
      }

      const existing = sessions.get(id)
      if (existing && !existing.exited) {
        return { ok: true, snapshot: existing.buffer }
      }
      if (existing) sessions.delete(id)
      return spawn(id, cwd, cols, rows)
    },

    write(params: unknown): OkResult {
      const body = objectBody(params)
      const id = terminalId(body?.id)
      const data = body?.data
      if (!id || typeof data !== "string" || data.length > MAX_INPUT_LENGTH) return { ok: false }
      const session = sessions.get(id)
      if (!session || session.exited || session.process.terminal?.closed) return { ok: false }
      try {
        session.process.terminal?.write(data)
        return { ok: true }
      } catch {
        return { ok: false }
      }
    },

    resize(params: unknown): OkResult {
      const body = objectBody(params)
      const id = terminalId(body?.id)
      const cols = terminalDimension(body?.cols)
      const rows = terminalDimension(body?.rows)
      if (!id || cols === null || rows === null) return { ok: false }
      const session = sessions.get(id)
      // A ResizeObserver can dispatch after the terminal UI has closed.
      if (!session || session.exited || session.process.terminal?.closed) return { ok: true }
      try {
        session.process.terminal?.resize(cols, rows)
        return { ok: true }
      } catch {
        return { ok: true }
      }
    },

    close(params: unknown): OkResult {
      const body = objectBody(params)
      const id = terminalId(body?.id)
      if (!id) return { ok: false }
      const session = sessions.get(id)
      if (!session) return { ok: true }
      sessions.delete(id)
      session.exited = true
      try {
        session.process.kill("SIGTERM")
      } catch {
        // The process may have won the race to exit.
      }
      return { ok: true }
    },

    destroy(): void {
      for (const session of sessions.values()) {
        session.exited = true
        try {
          session.process.kill("SIGTERM")
        } catch {
          // Best effort during process shutdown.
        }
      }
      sessions.clear()
    },
  }
}
