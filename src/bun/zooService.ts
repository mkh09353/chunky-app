import { randomBytes } from "node:crypto"
import type { ZooManager } from "./zoo"

type ZooService = { target(): Promise<{ port: number; token: string }>; stop(): void }
type ZooServiceDeps = { manager: ZooManager }

// Renderer-only metadata/secret operations must never be reachable by an
// agent holding the loopback token. This allowlist is also safer than exposing
// every future ZooManager method by accident.
const AGENT_OPERATIONS = new Set([
  "board", "search", "getIdea", "getItem", "createIdea", "promoteIdea",
  "dismissIdea", "moveItem", "addNote",
])

/** Token-guarded local bridge for the server's Zoo tools. */
export function createZooService({ manager }: ZooServiceDeps): ZooService {
  const token = randomBytes(32).toString("hex")
  let server: ReturnType<typeof Bun.serve> | undefined
  const envelope = (body: unknown, status = 200) => Response.json(body, { status })
  const start = () => server ??= Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    try {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/zoo/op") return new Response("Not found", { status: 404 })
      if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response("Unauthorized", { status: 401 })
      let body: unknown
      try { body = await request.json() } catch { return envelope({ ok: false, error: "Malformed JSON" }, 400) }
      if (!body || typeof body !== "object" || Array.isArray(body)) return envelope({ ok: false, error: "Invalid operation" }, 400)
      const { method, params } = body as { method?: unknown; params?: unknown }
      if (typeof method !== "string" || !params || typeof params !== "object" || Array.isArray(params)) {
        return envelope({ ok: false, error: "Invalid operation" }, 400)
      }
      if (!AGENT_OPERATIONS.has(method)) return envelope({ ok: false, error: "Unknown Zoo operation" })
      const operation = (manager as Record<string, unknown>)[method]
      if (typeof operation !== "function") return envelope({ ok: false, error: "Unknown Zoo operation" })
      return envelope(await (operation as (params: unknown) => Promise<unknown>).call(manager, params))
    } catch (error) {
      return envelope({ ok: false, error: error instanceof Error ? error.message : "Unexpected Zoo service error" })
    }
  } })
  return { target: async () => { const active = start(); return { port: active.port!, token } }, stop: () => { server?.stop(true); server = undefined } }
}
