#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

port=8793
log_file="${TMPDIR:-/tmp}/agentfall-worker-test.log"
./node_modules/.bin/wrangler d1 migrations apply agentfall --local >"$log_file" 2>&1
./node_modules/.bin/wrangler dev --local --port "$port" >"$log_file" 2>&1 &
worker_pid=$!
cleanup() {
  kill "$worker_pid" 2>/dev/null || true
  wait "$worker_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

attempt=0
until curl --fail --silent --show-error "http://127.0.0.1:$port/health" >"$log_file.response"; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    cat "$log_file" >&2
    exit 1
  fi
  sleep 1
done
test "$(cat "$log_file.response")" = '{"status":"ok"}'
version="$(curl --fail --silent --show-error "http://127.0.0.1:$port/version")"
test "$version" = '{"service":"agentfall","version":"dev"}'
status="$(curl --silent --show-error --output "$log_file.error" --dump-header "$log_file.headers" --write-out '%{http_code}' "http://127.0.0.1:$port/not-a-route")"
test "$status" = "404"
rg -q '"code":"NOT_FOUND"' "$log_file.error"
rg -q '^X-Request-Id:' "$log_file.headers"
status="$(curl --silent --show-error --output "$log_file.session-error" --write-out '%{http_code}' "http://127.0.0.1:$port/v1/floor-sessions/missing/observation")"
test "$status" = "404"
rg -q '"code":"NOT_FOUND"' "$log_file.session-error"
status="$(curl --silent --show-error --output "$log_file.admin-error" --write-out '%{http_code}' \
  --request GET "http://127.0.0.1:$port/v1/admin/seasons/missing")"
test "$status" = "401"
rg -q '"code":"AUTH_REQUIRED"' "$log_file.admin-error"
status="$(curl --silent --show-error --output "$log_file.mcp" --write-out '%{http_code}' \
  --request POST \
  --header 'Accept: application/json, text/event-stream' \
  --header 'Content-Type: application/json' \
  --header 'MCP-Protocol-Version: 2025-03-26' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  "http://127.0.0.1:$port/mcp")"
test "$status" = "200"
rg -q '"floor_observation"' "$log_file.mcp"
status="$(curl --silent --show-error --output "$log_file.mcp-auth" --write-out '%{http_code}' \
  --request POST \
  --header 'Accept: application/json, text/event-stream' \
  --header 'Content-Type: application/json' \
  --header 'MCP-Protocol-Version: 2025-03-26' \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"character_get","arguments":{}}}' \
  "http://127.0.0.1:$port/mcp")"
test "$status" = "200"
rg -q '"code":"AUTH_REQUIRED"' "$log_file.mcp-auth"
