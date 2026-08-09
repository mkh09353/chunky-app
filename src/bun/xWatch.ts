// X-watch collection through an ordinary authenticated Chunky session. This
// module owns no provider credentials: it discovers a ready Grok executor from
// the local server and pins it to a fresh repository-less session.
import { readSSE, ROUTES, type AgentEvent } from "@chunky/protocol"

const DEFAULT_INITIAL_HOURS = 24
const MIN_WINDOW_HOURS = 2
const MAX_WINDOW_HOURS = 24 * 30
const DEFAULT_TIMEOUT_MS = 5 * 60_000
const MAX_POSTS = 50
const MAX_TEXT = 4_000

export type XFinding = { url: string; author: string; text: string; postedAt: number }
export type XCollection = { findings: XFinding[]; provider: string; model: string }
export type XWatchRun = (params: { handle: string; since: number | null; now: number }) => Promise<XCollection>

export function normalizeXHandle(value: unknown): string | null {
  if (typeof value !== "string") return null
  let input = value.trim()
  const url = /^(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com)\/(@?[A-Za-z0-9_]{1,15})(?:[/?#].*)?$/i.exec(input)
  if (url) input = url[1] ?? ""
  input = input.replace(/^@/, "")
  return /^[A-Za-z0-9_]{1,15}$/.test(input) ? input.toLowerCase() : null
}

export function normalizeXPostUrl(value: unknown): string | null {
  if (typeof value !== "string") return null
  const match = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x\.com|twitter\.com)\/(@?[A-Za-z0-9_]{1,15})\/status\/(\d+)(?:[/?#].*)?$/i.exec(value.trim())
  if (!match) return null
  return `https://x.com/${match[1]!.replace(/^@/, "").toLowerCase()}/status/${match[2]}`
}

export function xWindowHours(lastSuccessAt: number | null, now: number): number {
  if (lastSuccessAt === null || !Number.isFinite(lastSuccessAt) || lastSuccessAt > now) return DEFAULT_INITIAL_HOURS
  return Math.max(MIN_WINDOW_HOURS, Math.min(MAX_WINDOW_HOURS, Math.ceil((now - lastSuccessAt) / 3_600_000)))
}

export function buildXWatchPrompt(handle: string, hours: number): string {
  return [
    `Find original posts published by @${handle} during the last ${hours} hours.`,
    "Use available X/web search tools. Do not include replies, reposts, quoted posts, or posts outside the window.",
    `Return at most ${MAX_POSTS} findings. Every URL must be the canonical public X status URL for @${handle}.`,
    "Reply with ONLY a fenced ```json block containing an array of objects:",
    '{ "url": "https://x.com/handle/status/123", "author": "@handle", "text": string, "postedAt": ISO-8601 string }',
    "If there are no matching posts, reply with a fenced empty array: ```json\n[]\n```.",
  ].join("\n")
}

export function parseXFindings(reply: string, expectedHandle: string): XFinding[] {
  const fences = [...reply.matchAll(/```[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi)]
  if (!fences.length) throw new Error("The Grok reply contained no fenced JSON block.")
  let parsed: unknown
  try { parsed = JSON.parse(fences.at(-1)![1] ?? "") } catch { throw new Error("The Grok reply contained invalid fenced JSON.") }
  if (!Array.isArray(parsed)) throw new Error("The Grok fenced JSON was not an array.")
  if (parsed.length > MAX_POSTS) throw new Error(`The Grok reply exceeded ${MAX_POSTS} posts.`)
  const expected = normalizeXHandle(expectedHandle)
  if (!expected) throw new Error("Invalid X handle.")
  const findings: XFinding[] = []
  const seen = new Set<string>()
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("A Grok finding was not an object.")
    const row = raw as Record<string, unknown>
    const url = normalizeXPostUrl(row.url)
    const author = normalizeXHandle(row.author)
    const body = typeof row.text === "string" ? row.text.trim() : ""
    const postedAt = typeof row.postedAt === "string" ? Date.parse(row.postedAt) : Number.NaN
    const urlAuthor = url ? normalizeXHandle(new URL(url).pathname.split("/")[1]) : null
    if (!url || author !== expected || urlAuthor !== expected || !body || body.length > MAX_TEXT || !Number.isFinite(postedAt)) {
      throw new Error("A Grok finding had an invalid URL, author, text, or timestamp.")
    }
    if (!seen.has(url)) { seen.add(url); findings.push({ url, author: `@${author}`, text: body, postedAt }) }
  }
  return findings
}

type RunnerDeps = {
  baseUrl: string
  token?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

function headers(token: string | undefined, json = false): HeadersInit {
  return { ...(json ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }
}

async function jsonRequest(request: typeof fetch, url: string, token: string | undefined, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await request(url, { ...init, headers: { ...headers(token, !!init?.body), ...(init?.headers || {}) } })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok || typeof body.error === "string") {
    const message = typeof body.error === "string" ? body.error : `Chunky request failed (${response.status}).`
    throw new Error(token ? message.split(token).join("[redacted]") : message)
  }
  return body
}

export async function runXWatchSession(params: { handle: string; since: number | null; now: number }, deps: RunnerDeps): Promise<XCollection> {
  const handle = normalizeXHandle(params.handle)
  if (!handle) throw new Error("Invalid X handle.")
  if (!deps.baseUrl) throw new Error("The Chunky server is unavailable.")
  const request = deps.fetch ?? fetch
  const base = deps.baseUrl.replace(/\/$/, "")
  const providerBody = await jsonRequest(request, `${base}/api/providers`, deps.token)
  const providers = Array.isArray(providerBody.providers) ? providerBody.providers as Record<string, unknown>[] : []
  const provider = providers.find((row) => row.id === "grok" && row.ready === true && row.active === true)
  if (!provider) throw new Error("A configured, active Grok provider is required for X watch.")
  const modelBody = await jsonRequest(request, `${base}/api/providers/grok/models`, deps.token)
  const models = Array.isArray(modelBody.models) ? modelBody.models as Record<string, unknown>[] : []
  const model = models.find((row) => typeof row.id === "string" && row.id.length > 0)
  if (!model || typeof model.id !== "string") throw new Error("The configured Grok provider has no ready model.")

  const created = await jsonRequest(request, base + ROUTES.createSession, deps.token, { method: "POST", body: JSON.stringify({ repositoryScope: "none" }) })
  const sessionId = typeof created.sessionId === "string" ? created.sessionId : ""
  if (!sessionId) throw new Error("Chunky returned no session id.")
  const selected = await jsonRequest(request, `${base}/api/model/select`, deps.token, { method: "POST", body: JSON.stringify({ provider: "grok", model: model.id, sessionId }) })
  if (selected.provider !== "grok" || selected.model !== model.id || selected.pinned !== true) throw new Error("Grok could not be pinned to the X-watch session.")

  const controller = new AbortController()
  let text = ""
  let finish!: () => void
  let fail!: (error: Error) => void
  const completed = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject })
  const timeout = setTimeout(() => {
    fail(new Error("The X-watch session timed out."))
    controller.abort()
  }, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const eventsResponse = await request(base + ROUTES.events(sessionId), { headers: headers(deps.token), signal: controller.signal })
    if (!eventsResponse.ok) throw new Error(`Session event stream failed (${eventsResponse.status}).`)
    void (async () => {
      try {
        for await (const event of readSSE(eventsResponse)) {
          const ev = event as AgentEvent
          if (ev.type === "message.start" && !ev.threadId) text = ""
          else if (ev.type === "message.delta" && !ev.threadId) text += ev.text
          else if (ev.type === "message.end" && !ev.threadId) { finish(); return }
          else if (ev.type === "session.status" && ev.status === "idle" && text.trim()) { finish(); return }
        }
        fail(new Error("The session stream closed before Grok replied."))
      } catch (error) { if (!controller.signal.aborted) fail(error instanceof Error ? error : new Error("The session stream failed.")) }
    })()
    const sent = await request(base + ROUTES.sendMessage(sessionId), { method: "POST", headers: headers(deps.token, true), body: JSON.stringify({ text: buildXWatchPrompt(handle, xWindowHours(params.since, params.now)) }) })
    if (sent.status === 409) throw new Error("The X-watch prompt was blocked by the session cache guard.")
    if (!sent.ok && sent.status !== 202) throw new Error(`Sending the X-watch prompt failed (${sent.status}).`)
    await completed
    const hours = xWindowHours(params.since, params.now)
    const cutoff = params.now - hours * 3_600_000
    const findings = parseXFindings(text, handle).filter((finding) => finding.postedAt >= cutoff && finding.postedAt <= params.now)
    return { findings, provider: "grok", model: model.id }
  } catch (error) {
    const message = error instanceof Error ? error.message : "The X-watch session failed."
    // Defensive redaction: HTTP/network errors should not contain the bearer
    // token, but never let a hostile server echo it into durable watch state.
    throw new Error(deps.token ? message.split(deps.token).join("[redacted]") : message)
  } finally { clearTimeout(timeout); controller.abort() }
}

export function formatXArtifact(finding: XFinding): { externalId: string; title: string; content: string; url: string } {
  return {
    externalId: finding.url,
    url: finding.url,
    title: `${finding.author} on X — ${finding.text.slice(0, 120)}`,
    content: [`X post by ${finding.author}`, `Published: ${new Date(finding.postedAt).toISOString()}`, `URL: ${finding.url}`, "", finding.text].join("\n"),
  }
}
