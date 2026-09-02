#!/usr/bin/env bash
# Isolated dev stack: a dev server (from the sibling source checkout) plus the
# dev App, wired so the installed Chunky.app can NEVER adopt the dev server and
# the dev App can never adopt the installed server.
#
# How isolation works:
#   * CHUNKY_HOME points at a separate state dir (default ~/.chunky/dev-state):
#     its own settings.json/token, DBs, desktop.json, and servers/ discovery
#     dir. The installed App only ever reads ~/.chunky/state/servers.
#   * The dev server is started directly (no CHUNKY_DISCOVERY_RECORD), so it
#     writes no discovery record anywhere.
#   * The dev App gets CHUNKY_URL, which makes src/bun/connectionManager.ts skip
#     discovery/spawn entirely, and Vite proxies /chunky-api to the same URL.
#
# Usage:
#   scripts/dev-isolated.sh seed      # copy real DBs + settings from ~/.chunky/state
#   scripts/dev-isolated.sh server    # dev server only (prints ready time + RSS)
#   scripts/dev-isolated.sh app       # dev App only (expects server on CHUNKY_DEV_PORT)
#   scripts/dev-isolated.sh           # server, then app; server stops on exit
#
# Env overrides: CHUNKY_DEV_HOME, CHUNKY_DEV_PORT (4620), CHUNKY_SERVER_SRC,
#                CHUNKY_WORKSPACE, CHUNKY_BUN_PATH.
#   CHUNKY_DEV_REQLOG=1  route the App through scripts/dev-request-log.ts on
#                        PORT+1 so every boot request is logged (startup audits),
#                        and turn on the server's own [http] request log.
#                        Summarize a run with: python3 scripts/dev-boot-report.py
set -euo pipefail

APP_DIR=$(cd "$(dirname "$0")/.." && pwd)
SERVER_DIR=${CHUNKY_SERVER_SRC:-$APP_DIR/../chunky}
PORT=${CHUNKY_DEV_PORT:-4620}
PROD_STATE=$HOME/.chunky/state
BUN=${CHUNKY_BUN_PATH:-$(command -v bun || echo "$HOME/.bun/bin/bun")}

export CHUNKY_HOME=${CHUNKY_DEV_HOME:-$HOME/.chunky/dev-state}
export CHUNKY_SETTINGS=$CHUNKY_HOME/settings.json
SERVER_URL=http://localhost:$PORT
REQLOG_PORT=$((PORT + 1))
export CHUNKY_URL=$SERVER_URL
if [ "${CHUNKY_DEV_REQLOG:-0}" = "1" ]; then export CHUNKY_URL=http://localhost:$REQLOG_PORT; fi

# Scrub launcher-session env: when this runs from a shell spawned by an
# installed Chunky session, its per-server env would leak in and re-point the
# dev stack at the installed server's state or make it think it is
# launcher-managed (lease loop then retires it).
unset CHUNKY_SERVER_NONCE CHUNKY_SERVER_ID CHUNKY_DISCOVERY_RECORD CHUNKY_BUILD_ID \
  CHUNKY_VERSION CHUNKY_RUNTIME_DIR CHUNKY_PORT CHUNKY_DB CHUNKY_GRAPH_DB CHUNKY_AUTH

log() { echo "[dev-isolated] $*" >&2; }
die() { log "error: $*"; exit 1; }

now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }

# Never print the token: read it into a variable only.
read_token() {
  python3 - "$CHUNKY_SETTINGS" <<'PY'
import json, sys
try:
    print(json.load(open(sys.argv[1])).get("serverToken", ""))
except Exception:
    print("")
PY
}

default_workspace() {
  python3 - "$CHUNKY_HOME/desktop.json" <<'PY'
import json, sys
try:
    print(json.load(open(sys.argv[1])).get("workspace", ""))
except Exception:
    print("")
PY
}

seed() {
  [ -d "$PROD_STATE" ] || die "no installed state at $PROD_STATE"
  mkdir -p "$CHUNKY_HOME"
  log "seeding $CHUNKY_HOME from $PROD_STATE (sqlite online backup, no shadow/archive/attachments)"
  for db in chunky.db chunky-graph.db zoo.db; do
    [ -f "$PROD_STATE/$db" ] && sqlite3 "$PROD_STATE/$db" ".backup '$CHUNKY_HOME/$db'"
  done
  for f in settings.json auth.json repos.json desktop.json models-dev-cache.json anthropic-models-cache.json update-check.json; do
    [ -f "$PROD_STATE/$f" ] && cp -p "$PROD_STATE/$f" "$CHUNKY_HOME/$f"
  done
  for d in session-snapshots memory workflows agents-md; do
    [ -d "$PROD_STATE/$d" ] && rm -rf "$CHUNKY_HOME/$d" && cp -Rp "$PROD_STATE/$d" "$CHUNKY_HOME/$d"
  done
  chmod 600 "$CHUNKY_HOME/settings.json" "$CHUNKY_HOME/auth.json" 2>/dev/null || true
  du -sh "$CHUNKY_HOME" >&2
}

free_port() {
  local pids
  pids=$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true)
  [ -z "$pids" ] && return 0
  log "freeing port $PORT (stale listener: $pids)"
  kill $pids 2>/dev/null || true
  sleep 0.3
}

SERVER_PID=""
start_server() {
  [ -f "$SERVER_DIR/packages/server/src/index.ts" ] || die "server source not found at $SERVER_DIR (set CHUNKY_SERVER_SRC)"
  [ -f "$CHUNKY_SETTINGS" ] || die "no $CHUNKY_SETTINGS — run: $0 seed"
  local token workspace t0 t1 rss
  token=$(read_token)
  [ -n "$token" ] || die "no serverToken in $CHUNKY_SETTINGS"
  workspace=${CHUNKY_WORKSPACE:-$(default_workspace)}
  workspace=${workspace:-$APP_DIR}
  free_port
  log "starting dev server on :$PORT  state=$CHUNKY_HOME  src=$SERVER_DIR  workspace=$workspace"
  t0=$(now_ms)
  (
    cd "$SERVER_DIR"
    exec env \
      CHUNKY_PORT="$PORT" \
      CHUNKY_WORKSPACE="$workspace" \
      CHUNKY_DB="$CHUNKY_HOME/chunky.db" \
      CHUNKY_GRAPH_DB="$CHUNKY_HOME/chunky-graph.db" \
      CHUNKY_AUTH="$CHUNKY_HOME/auth.json" \
      CHUNKY_RELAY=0 \
      CHUNKY_REQUEST_LOG="${CHUNKY_DEV_REQLOG:-0}" \
      "$BUN" run packages/server/src/index.ts
  ) &
  SERVER_PID=$!
  local deadline=$(( $(now_ms) + 30000 ))
  while [ "$(now_ms)" -lt "$deadline" ]; do
    if curl -fsS -o /dev/null -m 1 -H "Authorization: Bearer $token" "$SERVER_URL/api/info" 2>/dev/null; then
      t1=$(now_ms)
      rss=$(ps -o rss= -p "$SERVER_PID" 2>/dev/null | tr -d ' ')
      log "server ready in $((t1 - t0)) ms  (pid $SERVER_PID, rss $(( ${rss:-0} / 1024 )) MB)"
      return 0
    fi
    kill -0 "$SERVER_PID" 2>/dev/null || die "server exited before becoming ready"
    sleep 0.05
  done
  die "server did not become ready within 30s"
}

REQLOG_PID=""
start_reqlog() {
  [ "${CHUNKY_DEV_REQLOG:-0}" = "1" ] || return 0
  local pids
  pids=$(lsof -ti "tcp:$REQLOG_PORT" -sTCP:LISTEN 2>/dev/null || true)
  [ -n "$pids" ] && kill $pids 2>/dev/null && sleep 0.3
  "$BUN" "$APP_DIR/scripts/dev-request-log.ts" --listen "$REQLOG_PORT" --target "$SERVER_URL" --out "${CHUNKY_REQLOG_OUT:-/tmp/chunky-reqlog.jsonl}" &
  REQLOG_PID=$!
  sleep 0.3
  log "request log proxy on :$REQLOG_PORT -> $SERVER_URL (summary: curl localhost:$REQLOG_PORT/__reqlog/summary)"
}

stop_server() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "$REQLOG_PID" ] && kill "$REQLOG_PID" 2>/dev/null || true
}

start_app() {
  export CHUNKY_WORKSPACE=${CHUNKY_WORKSPACE:-$(default_workspace)}
  log "starting dev App  CHUNKY_URL=$CHUNKY_URL  CHUNKY_HOME=$CHUNKY_HOME"
  cd "$APP_DIR"
  "$BUN" run dev
}

case "${1:-all}" in
  seed) seed ;;
  server) trap stop_server EXIT INT TERM; start_server; start_reqlog; wait "$SERVER_PID" ;;
  app) start_app ;;
  all) trap stop_server EXIT INT TERM; start_server; start_reqlog; start_app ;;
  *) die "unknown command: $1 (seed|server|app)" ;;
esac
