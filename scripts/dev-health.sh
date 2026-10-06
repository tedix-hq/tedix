#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HTTP_TIMEOUT_SECONDS="${TEDIX_DEV_HEALTH_HTTP_TIMEOUT_SECONDS:-15}"
FULL_STACK=false
OS_STACK=false
OS_MODE=fixtures

for arg in "$@"; do
	case "$arg" in
		--full) FULL_STACK=true ;;
		--os) OS_STACK=true ;;
		*) echo "Usage: $0 [--full|--os]" >&2; exit 2 ;;
	esac
done
if [ "$FULL_STACK" = true ] && [ "$OS_STACK" = true ]; then
	echo "Choose --full or --os, not both." >&2
	exit 2
fi
DEFAULT_LOG_DIR="$ROOT_DIR/logs/dev"
[ "$OS_STACK" = false ] || DEFAULT_LOG_DIR="$ROOT_DIR/logs/dev/os"
LOG_DIR="${TEDIX_DEV_LOG_DIR:-"$DEFAULT_LOG_DIR"}"
ALL_LOG="$LOG_DIR/all.log"

failures=0

print_result() {
	local status="$1"
	local label="$2"
	local detail="$3"
	printf "%-7s %-24s %s\n" "$status" "$label" "$detail"
}

check_http() {
	local label="$1"
	local url="$2"
	local mode="${3:-json}"
	local body_file
	body_file="$(mktemp)"
	local result
	result="$(curl -sS -o "$body_file" -w "%{http_code} %{time_total}" --max-time "$HTTP_TIMEOUT_SECONDS" "$url" 2>/dev/null || true)"
	local code="${result%% *}"
	local time="${result#* }"
	if [ "$code" != "200" ]; then
		result="$(curl -sS -o "$body_file" -w "%{http_code} %{time_total}" --max-time "$HTTP_TIMEOUT_SECONDS" "$url" 2>/dev/null || true)"
		code="${result%% *}"
		time="${result#* }"
	fi
	local health_error=""
	if [ "$code" = "200" ]; then
		if ! health_error="$(bun "$ROOT_DIR/scripts/dev/health-response.ts" "$body_file" "$mode" 2>&1)"; then
			health_error="${health_error:-health response validation failed}"
		fi
	fi
	if [ "$code" = "200" ] && [ -z "$health_error" ]; then
		print_result "ok" "$label" "$url (${time}s)"
	else
		failures=$((failures + 1))
		local body
		body="$(head -c 180 "$body_file" | tr '\n' ' ')"
		print_result "FAIL" "$label" "$url -> ${code:-curl-failed} ${health_error:-$body}"
	fi
	rm -f "$body_file"
}

# Log grep is the FALLBACK only. It is an observation, not a probe: the Vite+
# log prefix syntax changed once and silently turned every one of these checks
# into a FAIL while the bindings were in fact connected. Every line it produces
# is labelled with the reason the authoritative source could not answer, so the
# output never again quietly means something other than what it says.
# The per-app file already scopes the app, so the pattern only needs the
# binding name.
check_binding_log() {
	local label="$1"
	local app="$2"
	local binding="$3"
	local why="$4"
	local pattern="env\\.${binding} .*\\[(not )?connected\\]"
	local app_log="$LOG_DIR/${app}.log"
	local line=""

	if [ -f "$app_log" ]; then
		line="$(grep -E "$pattern" "$app_log" | tail -n 1 || true)"
	fi
	# Fall back to all.log (prefix-agnostic) when per-app splitting is absent.
	if [ -z "$line" ] && [ -f "$ALL_LOG" ]; then
		line="$(grep -E "(^|\\] )${pattern}" "$ALL_LOG" | tail -n 1 || true)"
	fi

	if [ -z "$line" ]; then
		failures=$((failures + 1))
		print_result "FAIL" "$label" "no matching binding line in logs/dev/${app}.log [log fallback: ${why}]"
		return
	fi
	local detail
	detail="$(printf "%s" "$line" | sed 's/.*env\./env./') [log fallback: ${why}]"
	if [[ "$line" == *"[connected]"* ]]; then
		print_result "ok" "$label" "$detail"
	else
		failures=$((failures + 1))
		print_result "FAIL" "$label" "$detail"
	fi
}

# Wrangler's cross-process dev registry is authoritative for "is the target
# Worker running": every live `wrangler dev` writes and heartbeats its own file
# there. Exit codes from binding-registry.ts are the contract — 0 ok, 1 target
# not registered, 3 the registry cannot answer at all, anything else a usage or
# config error worth surfacing as a failure.
check_binding() {
	local label="$1"
	local app="$2"
	local binding="$3"
	local detail=""
	local status=0
	local error_file
	error_file="$(mktemp)"
	# stdout carries the single-line result; stderr carries usage errors AND
	# scripts/dev-local.ts's own chatter (a TEDIX_DEV_VAR_* override announces
	# itself there). Merging the two with 2>&1 puts a newline inside the detail
	# argument and breaks print_result's fixed-width row, so they are captured
	# apart and stderr is only read when stdout had nothing to say.
	detail="$(bun "$ROOT_DIR/scripts/dev/binding-registry.ts" "$ROOT_DIR/apps/$app" "$binding" 2>"$error_file")" || status=$?
	local diagnostics
	diagnostics="$(tr '\n' ' ' < "$error_file")"
	rm -f "$error_file"
	case "$status" in
		0)
			print_result "ok" "$label" "$detail"
			;;
		3)
			check_binding_log "$label" "$app" "$binding" "$detail"
			;;
		*)
			failures=$((failures + 1))
			print_result "FAIL" "$label" "${detail:-$diagnostics}"
			;;
	esac
}

warn_recent_log() {
	local label="$1"
	local file="$2"
	local pattern="$3"
	if [ ! -f "$file" ]; then
		return
	fi
	local line
	line="$(tail -n 240 "$file" | grep -E "$pattern" | tail -n 1 || true)"
	if [ -n "$line" ]; then
		print_result "warn" "$label" "$line"
	fi
}

cd "$ROOT_DIR"

echo "Tedix local dev health"
echo "log dir: $LOG_DIR"
echo "expected OS mode: $OS_MODE (liveness only; not login, binding execution, or rendering proof)"
echo

check_http "api" "http://localhost:8787/health"
if [ "$OS_STACK" = true ]; then
	check_http "os-$OS_MODE" "http://localhost:3010/health" "$OS_MODE"
	check_http "mcp" "http://localhost:3000/health"
	echo "Sidecars outside the OS profile are not checked; this does not certify their features."
else
	check_http "tedi-edge" "http://localhost:3007/health"
	check_http "tedi-workstation-runtime" "http://localhost:3017/health"
	check_http "tedi-runtime" "http://localhost:3014/health"
	if [ "$FULL_STACK" = true ]; then
		check_http "os-$OS_MODE" "http://localhost:3010/health" "$OS_MODE"
		check_http "mcp" "http://localhost:3000/health"
		check_http "skill-runtime" "http://localhost:3011/health"
	fi

	echo
	check_binding "tedi->runtime" "tedi" "TEDI_RUNTIME_SERVICE"
	check_binding "tedi->workstation" "tedi" "TEDI_WORKSTATION_RUNTIME_SANDBOX"
	if [ "$FULL_STACK" = true ]; then
		check_binding "runtime->api" "tedi-runtime" "API_SERVICE"
		check_binding "mcp->api" "mcp" "API_SERVICE"
		check_binding "mcp->tedi" "mcp" "TEDI_SERVICE"
		check_binding "mcp->cms" "mcp" "CMS"
		check_binding "skill->api" "skill-runtime" "API_SERVICE"
		check_binding "skill->mcp" "skill-runtime" "MCP_SERVICE"
		check_binding "skill->runtime" "skill-runtime" "TEDI_RUNTIME_SERVICE"
	fi
fi

echo
if [ "$OS_STACK" = false ]; then
	warn_recent_log "runtime-log" "$LOG_DIR/tedi-runtime.log" "signal #11|Segmentation fault|TimeoutError|blockConcurrencyWhile|Worker \"tedix-tedi-runtime\" not found"
	warn_recent_log "tedi-log" "$LOG_DIR/tedi.log" "Worker \"tedix-tedi-workstation-runtime\" not found|GET /acp 503|isolate-forward.*503"
fi
if [ "$FULL_STACK" = true ] || [ "$OS_STACK" = true ]; then
	warn_recent_log "os-session-binding" "$LOG_DIR/os.log" "Worker .*session-broker.* not found|Network connection lost"
	warn_recent_log "api-remote-binding" "$LOG_DIR/api.log" "Network connection lost|D1 DB is overloaded|timed out after [0-9]+ms|Error: internal error; reference"
	warn_recent_log "mcp-remote-binding" "$LOG_DIR/mcp.log" "Network connection lost|entry_timeout|503 Service Unavailable"
fi

if [ "$failures" -gt 0 ]; then
	echo
	if [ "$OS_STACK" = true ]; then
		echo "OS dev health failed with $failures issue(s). Start bun run dev:os-stack (fixtures) or bun run dev:os-stack:remote (real login); inspect $LOG_DIR."
		echo "If local OS health passes but os-tunnel fails, inspect the managed cloudflared tunnel and TLS. Session-broker failure is an upstream auth issue."
	else
		echo "Dev health failed with $failures issue(s). For runtime or workstation validation, restart the root 'bun dev' stack or run the focused stack with the required sidecars once ports are clear."
	fi
	exit 1
fi

echo
echo "Dev health ok."
