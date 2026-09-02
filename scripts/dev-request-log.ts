#!/usr/bin/env bun
// Request-logging reverse proxy for startup audits. Sits between the dev App
// (CHUNKY_URL) and the dev server so every request the App makes during boot is
// recorded: relative time, method, path, status, duration, response bytes.
// Streams (SSE) pass through untouched; their row is logged when the stream
// opens and again when it closes.
//
//   bun scripts/dev-request-log.ts [--listen 4621] [--target http://localhost:4620] [--out /tmp/chunky-reqlog.jsonl]
//
//   GET  http://localhost:4621/__reqlog/reset    -> clear log + restart the clock
//   GET  http://localhost:4621/__reqlog/summary  -> per-path counts/bytes as JSON
//
// Never logs headers (the Authorization bearer passes through unlogged).
const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1] ?? "")
const listen = Number(args.get("listen") ?? process.env.CHUNKY_REQLOG_PORT ?? 4621)
const target = (args.get("target") ?? process.env.CHUNKY_REQLOG_TARGET ?? "http://localhost:4620").replace(/\/$/, "")
const out = args.get("out") ?? process.env.CHUNKY_REQLOG_OUT ?? "/tmp/chunky-reqlog.jsonl"

type Row = { t: number; method: string; path: string; status: number; ms: number; bytes: number; stream?: "open" | "close" }
let rows: Row[] = []
let t0 = performance.now()
let seq = 0

function record(row: Row): void {
  rows.push(row)
  const line = JSON.stringify(row)
  void Bun.write(out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n")
  const tag = row.stream ? ` [sse ${row.stream}]` : ""
  console.log(`+${row.t.toFixed(0).padStart(6)}ms ${row.method.padEnd(6)} ${row.status} ${row.ms.toFixed(0).padStart(5)}ms ${String(row.bytes).padStart(8)}B ${row.path}${tag}`)
  void line
}

function summary() {
  const byPath = new Map<string, { count: number; bytes: number; ms: number }>()
  for (const r of rows) {
    if (r.stream === "open") continue
    const key = `${r.method} ${r.path.replace(/\/[0-9a-f-]{36}(?=\/|$)/g, "/:id").replace(/\?.*$/, "")}`
    const agg = byPath.get(key) ?? { count: 0, bytes: 0, ms: 0 }
    agg.count += 1; agg.bytes += r.bytes; agg.ms += r.ms
    byPath.set(key, agg)
  }
  const list = [...byPath.entries()].map(([path, v]) => ({ path, ...v })).sort((a, b) => b.bytes - a.bytes)
  const totalBytes = rows.reduce((n, r) => n + (r.stream === "open" ? 0 : r.bytes), 0)
  return { requests: rows.filter((r) => r.stream !== "open").length, totalBytes, spanMs: rows.length ? Math.max(...rows.map((r) => r.t + r.ms)) : 0, byPath: list }
}

Bun.serve({
  port: listen,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/__reqlog/reset") { rows = []; seq = 0; t0 = performance.now(); return Response.json({ ok: true }) }
    if (url.pathname === "/__reqlog/summary") return Response.json(summary(), { headers: { "Access-Control-Allow-Origin": "*" } })
    // Renderer boot stages (src/mainview/lib/bootPerf.ts posts its table here in dev).
    if (url.pathname === "/__reqlog/bootperf" && req.method === "POST") {
      const body = await req.text()
      console.log(`[bootperf] +${(performance.now() - t0).toFixed(0)}ms\n${body}`)
      void Bun.write(out.replace(/\.jsonl$/, "") + ".bootperf.txt", body + "\n")
      return Response.json({ ok: true })
    }
    const started = performance.now()
    const id = ++seq
    const path = url.pathname + url.search
    const upstream = await fetch(target + path, {
      method: req.method,
      headers: req.headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      redirect: "manual",
      // @ts-expect-error bun supports duplex for streaming bodies
      duplex: "half",
    })
    const headers = new Headers(upstream.headers)
    headers.delete("content-encoding")
    headers.delete("content-length")
    const isStream = (upstream.headers.get("content-type") ?? "").includes("text/event-stream")
    if (isStream) {
      record({ t: started - t0, method: req.method, path, status: upstream.status, ms: performance.now() - started, bytes: 0, stream: "open" })
      let bytes = 0
      const body = upstream.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) { bytes += chunk.byteLength; controller.enqueue(chunk) },
        flush() { record({ t: started - t0, method: req.method, path, status: upstream.status, ms: performance.now() - started, bytes, stream: "close" }) },
      }))
      return new Response(body, { status: upstream.status, headers })
    }
    const buf = await upstream.arrayBuffer()
    record({ t: started - t0, method: req.method, path, status: upstream.status, ms: performance.now() - started, bytes: buf.byteLength })
    void id
    return new Response(buf, { status: upstream.status, headers })
  },
})
console.log(`[reqlog] listening on http://localhost:${listen} -> ${target}; log: ${out}`)
