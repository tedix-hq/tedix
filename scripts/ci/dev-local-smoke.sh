#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SMOKE_DIR="$(mktemp -d)"
SMOKE_LOG="$SMOKE_DIR/api.log"
SMOKE_PID=""

terminate_process_tree() {
	local pid="$1"
	local child_pid

	while read -r child_pid; do
		[[ -n "$child_pid" ]] && terminate_process_tree "$child_pid"
	done < <(pgrep -P "$pid" 2>/dev/null || true)

	kill "$pid" 2>/dev/null || true
}

cleanup() {
	if [[ -n "$SMOKE_PID" ]] && kill -0 "$SMOKE_PID" 2>/dev/null; then
		terminate_process_tree "$SMOKE_PID"
		wait "$SMOKE_PID" 2>/dev/null || true
	fi
}
trap cleanup EXIT INT TERM

(
	cd "$REPO_ROOT/apps/api"
	XDG_CONFIG_HOME="$SMOKE_DIR/config" \
		bun ../../scripts/dev-local.ts -- wrangler dev --show-interactive-dev-session=false \
		>"$SMOKE_LOG" 2>&1
) &
SMOKE_PID=$!

for _attempt in $(seq 1 60); do
	if curl --fail --silent http://localhost:8787/health >"$SMOKE_DIR/health.json"; then
		break
	fi
	if ! kill -0 "$SMOKE_PID" 2>/dev/null; then
		cat "$SMOKE_LOG" >&2
		exit 1
	fi
	sleep 1
done

if [[ ! -s "$SMOKE_DIR/health.json" ]]; then
	cat "$SMOKE_LOG" >&2
	echo "Local API did not become healthy within 60 seconds" >&2
	exit 1
fi

if grep -Eiq 'always access remote|Mode[[:space:]]+remote|remote preview session' "$SMOKE_LOG"; then
	cat "$SMOKE_LOG" >&2
	echo "Default local development exposed a remote binding" >&2
	exit 1
fi

grep -q '"status":"ok"' "$SMOKE_DIR/health.json"
echo "Default local API booted without secret injection or remote bindings."
