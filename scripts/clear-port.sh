#!/usr/bin/env bash
# Stop listeners owned by this checkout; never kill another project by port.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$ROOT_DIR/scripts/dev/processes.sh"
command -v lsof >/dev/null || { echo "lsof is required to verify port ownership." >&2; exit 1; }

if [ "$#" -eq 0 ]; then
	echo "Usage: $0 <port> [port...] | $0 --app <app-dir-name> [app-dir-name...]" >&2
	exit 2
fi

# Root-boot short circuit. scripts/dev-with-logs.sh sets TEDIX_DEV_WRAPPER_ACTIVE
# and, before starting anything, already swept this checkout: cleanup-dev.sh stops
# every checkout-owned dev process and clears every reserved port (or, for the os
# profile, dev-with-logs.sh clears that profile's ports itself). `vp run -r
# --parallel dev` then starts ~19 apps that each run `bun run clear-port` — 19
# more serial lsof sweeps of ports cleared seconds earlier, every one a no-op, all
# of them on the startup critical path.
#
# Do NOT "simplify" this away: the sweep is not redundant on its own, only after
# the wrapper's. A standalone `cd apps/api && bun run dev` has no wrapper, so
# TEDIX_DEV_WRAPPER_ACTIVE is unset and the full ownership-checked sweep below
# still runs — including the foreign-listener check that fails startup rather
# than signalling a process this checkout does not own.
#
# The wrapper's own deliberate sweeps run after it exports the guard, so they set
# TEDIX_DEV_PORT_SWEEP_FORCE to opt back in (it is scoped to those commands and
# their children, so it never reaches the app dev scripts).
if [ -n "${TEDIX_DEV_WRAPPER_ACTIVE:-}" ] && [ -z "${TEDIX_DEV_PORT_SWEEP_FORCE:-}" ]; then
	echo "clear-port.sh: dev-with-logs.sh already cleared this checkout's ports — skipping $*." >&2
	exit 0
fi

# `--app <name>` resolves the ports from the one derived inventory instead of a
# per-app hardcoded list. Every app's package.json used to spell its own ports
# here, which was the second hand-kept copy of the port table and drifted from
# the wrangler.jsonc that actually binds them. Literal port arguments still work
# unchanged: humans, cleanup-dev.sh and the process tests all call it that way.
#
# A failed or empty resolution is fatal. Sweeping zero ports and exiting 0 would
# look like success while leaving a stale listener to break startup later with a
# mystery "address already in use" — the exact failure this inventory prevents.
#
# Several app names may be given. They resolve into ONE port list so the
# preflight below sees every port before anything is signalled: sweeping them as
# separate invocations would stop the first app's listeners and only then
# discover that the third app's port is owned by another checkout, leaving the
# stack half torn down. dev-with-logs.sh's `os` profile depends on that.
if [ "$1" = "--app" ]; then
	shift
	if [ "$#" -eq 0 ]; then
		echo "Usage: $0 --app <app-dir-name> [app-dir-name...]" >&2
		exit 2
	fi
	RESOLVED_PORTS=()
	for app in "$@"; do
		if [ -z "$app" ]; then
			echo "Usage: $0 --app <app-dir-name> [app-dir-name...]" >&2
			exit 2
		fi
		if ! APP_PORTS="$(bun "$ROOT_DIR/scripts/dev/ports.ts" --app "$app")"; then
			echo "Could not resolve the dev ports reserved by app '$app'." >&2
			exit 1
		fi
		read -r -a APP_PORT_LIST <<<"$APP_PORTS"
		if [ "${#APP_PORT_LIST[@]}" -eq 0 ]; then
			echo "App '$app' resolved to no dev ports; refusing to report a sweep that cleared nothing." >&2
			exit 1
		fi
		RESOLVED_PORTS+=("${APP_PORT_LIST[@]}")
	done
	set -- "${RESOLVED_PORTS[@]}"
fi

# Preflight every port before stopping anything.
blocked=false
for port in "$@"; do
	if ! [[ "$port" =~ ^[0-9]{1,5}$ ]] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
		echo "Invalid TCP port: $port" >&2
		exit 2
	fi
	for pid in $(port_listeners "$port"); do
		if ! is_repo_process "$pid"; then
			echo "Port $port is occupied by PID $pid outside this checkout (or ownership is unknown). Stop it explicitly or choose another port; no signal sent." >&2
			echo "  owner: $(describe_process "$pid")" >&2
			blocked=true
		fi
	done
done
[ "$blocked" = false ] || exit 1

for port in "$@"; do
	for pid in $(port_listeners "$port"); do
		echo "Stopping checkout-owned listener $pid on port $port"
		stop_repo_process "$pid" || {
			echo "Ownership changed for PID $pid; refusing to stop it." >&2
			exit 1
		}
	done
	if [ -n "$(port_listeners "$port")" ]; then
		echo "Port $port is still occupied; startup stopped." >&2
		exit 1
	fi
done
