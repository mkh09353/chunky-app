#!/usr/bin/env python3
"""Summarize one dev-stack boot recorded by scripts/dev-request-log.ts.

    CHUNKY_DEV_REQLOG=1 scripts/dev-isolated.sh        # launch, wait for the window
    python3 scripts/dev-boot-report.py [--window 6000] [--log /tmp/chunky-reqlog.jsonl]

Prints the renderer's bootPerf stages (if the renderer posted them), the request
timeline of the boot window, per-endpoint totals, and the steady-state cadence
of the polled endpoints. Times are relative to the first request the proxy saw.
"""
import argparse, collections, json, os, re, sys

ap = argparse.ArgumentParser()
ap.add_argument("--log", default=os.environ.get("CHUNKY_REQLOG_OUT", "/tmp/chunky-reqlog.jsonl"))
ap.add_argument("--window", type=int, default=6000, help="boot window in ms after the first request")
args = ap.parse_args()

rows = [json.loads(l) for l in open(args.log) if l.strip()]
if not rows:
    sys.exit("no requests logged")
t0 = rows[0]["t"]
boot = [r for r in rows if r["t"] - t0 < args.window]

perf = args.log.replace(".jsonl", "") + ".bootperf.txt"
if os.path.exists(perf):
    print("== renderer bootPerf (ms from renderer start: stage, start, duration)")
    for line in open(perf):
        cols = line.rstrip("\n").split("\t")
        if len(cols) >= 3:
            print(f"  {cols[0]:<34} {cols[1]:>8} {cols[2]:>8}")
    print()

print(f"== boot timeline (first {args.window/1000:.0f}s; {len(boot)} requests)")
for r in boot:
    tag = f" [sse {r['stream']}]" if r.get("stream") else ""
    print(f"  +{r['t']-t0:6.0f}ms {r['status']} {r['ms']:6.0f}ms {r['bytes']:8}B {r['path'][:78]}{tag}")

def norm(p):
    p = re.sub(r"/[0-9a-f-]{36}", "/:id", p.split("?")[0])
    return p

print("\n== boot totals per endpoint")
agg = collections.defaultdict(lambda: [0, 0, 0.0])
for r in boot:
    if r.get("stream") == "open":
        continue
    k = f"{r['method']} {norm(r['path'])}" + (" ?repo" if "repo=" in r["path"] else "")
    a = agg[k]; a[0] += 1; a[1] += r["bytes"]; a[2] += r["ms"]
for k, (n, b, ms) in sorted(agg.items(), key=lambda x: -x[1][0]):
    print(f"  {n:3} req {b/1024:8.1f}KB {ms:7.0f}ms  {k}")
non_sse = [r for r in boot if not r.get("stream")]
print(f"  total: {len(non_sse)} requests, {sum(r['bytes'] for r in non_sse)/1024:.0f}KB, "
      f"{sum(1 for r in boot if r.get('stream')=='open')} SSE opens")

ev = []
for r in non_sse:
    ev.append((r["t"], 1)); ev.append((r["t"] + r["ms"], -1))
ev.sort(); c = m = 0
for _, d in ev:
    c += d; m = max(m, c)
print(f"  max concurrent non-SSE requests seen by the proxy: {m}")

if rows[-1]["t"] - t0 > args.window + 5000:
    print(f"\n== steady state after boot ({(rows[-1]['t']-t0)/1000:.0f}s total)")
    later = [r for r in rows if r["t"] - t0 >= args.window and not r.get("stream")]
    span = (rows[-1]["t"] - t0 - args.window) / 1000
    agg2 = collections.defaultdict(lambda: [0, 0])
    for r in later:
        k = f"{r['method']} {norm(r['path'])}" + (" ?repo" if "repo=" in r["path"] else "")
        agg2[k][0] += 1; agg2[k][1] += r["bytes"]
    for k, (n, b) in sorted(agg2.items(), key=lambda x: -x[1][0]):
        print(f"  {n:4} req  {n/span*60:6.1f}/min {b/1024:8.1f}KB  {k}")
