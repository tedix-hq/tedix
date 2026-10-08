#!/usr/bin/env bash
# Stop only this checkout's dev processes. Port conflicts never grant ownership.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$ROOT_DIR/scripts/dev/processes.sh"
command -v lsof >/dev/null || { echo "lsof is required to verify process ownership." >&2; exit 1; }

echo "Cleaning this checkout's dev processes..."
for pattern in "vp.*run.*dev" "wrangler.*dev" "workerd serve" "vite dev" "astro dev"; do
	for pid in $(pgrep -f "$pattern" 2>/dev/null || true); do
		[ "$pid" = "$$" ] && continue
		if is_repo_process "$pid"; then
			echo "Stopping checkout-owned dev process $pid"
			stop_repo_process "$pid" || true
		fi
	done
done

# The reserved-port list is DERIVED, not hand-kept. scripts/dev/ports.ts reads
# each app's committed wrangler.jsonc `dev` block (and, for the vp-dev/Astro
# apps, the config that actually binds the port), so adding an app no longer
# means editing the same table here, in that app's package.json `clear-port`
# args, and in docs/engineering/development.md. Shared OAuth/debug ports are still not ours
# and never appear in the inventory.
#
# The sweep below runs with TEDIX_DEV_PORT_SWEEP_FORCE set because this script
# is invoked BY dev-with-logs.sh, which has already exported
# TEDIX_DEV_WRAPPER_ACTIVE — the guard that makes the 19 per-app clear-port
# calls no-ops. This one root sweep is the call that must still do the work.
if ! DEV_PORTS="$(bun "$ROOT_DIR/scripts/dev/ports.ts")"; then
	echo "Could not derive the dev port inventory from the app configs." >&2
	exit 1
fi
read -r -a PORTS <<<"$DEV_PORTS"
if [ "${#PORTS[@]}" -eq 0 ]; then
	echo "Derived dev port inventory is empty; refusing to start without a sweep." >&2
	exit 1
fi

TEDIX_DEV_PORT_SWEEP_FORCE=1 "$ROOT_DIR/scripts/clear-port.sh" "${PORTS[@]}"

# Wrangler persists Local Explorer spans separately from product data. Only
# prune this checkout's known observability directories after its dev processes
# are stopped; leave D1, R2, KV and Durable Object state untouched.
prune_local_traces() {
	local state_root="$1" parent trace_dir
	[ -L "$state_root" ] && { echo "Skipping symlinked trace state: $state_root" >&2; return; }
	parent="$state_root"
	for segment in state v3 observability; do
		parent="$parent/$segment"
		[ -L "$parent" ] && { echo "Skipping symlinked trace state: $parent" >&2; return; }
	done
	trace_dir="$state_root/state/v3/observability"
	if [ -d "$trace_dir" ]; then
		rm -rf -- "$trace_dir"
		echo "Pruned local traces: $trace_dir"
	fi
}

prune_local_traces "$ROOT_DIR/.wrangler"
for app_dir in "$ROOT_DIR"/apps/*; do
	[ -d "$app_dir" ] && [ ! -L "$app_dir" ] || continue
	prune_local_traces "$app_dir/.wrangler"
done
echo "Dev ports are available for this checkout."
