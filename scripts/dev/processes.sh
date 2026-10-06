#!/usr/bin/env bash
# Shared by root cleanup and focused app startup. A port is not ownership.
# Callers set ROOT_DIR to this checkout's physical root.

is_repo_process() {
	local process_cwd
	process_cwd="$(lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
	case "$process_cwd" in
		"$ROOT_DIR"|"$ROOT_DIR"/*) return 0 ;;
		*) return 1 ;;
	esac
}

port_listeners() {
	# Ignore outbound clients connected to the same port.
	lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true
}

stop_repo_process() {
	local pid="$1"
	# Recheck immediately before each signal; an unknown cwd fails closed.
	is_repo_process "$pid" || return 1
	kill -TERM "$pid" 2>/dev/null || return 0
	sleep 0.5
	if kill -0 "$pid" 2>/dev/null && is_repo_process "$pid"; then
		kill -KILL "$pid" 2>/dev/null || true
	fi
}

# Describe a foreign listener by its working directory and command, not a bare
# PID, so a port held by another checkout's dev server is actionable.
describe_process() {
	local pid="$1" cwd command
	cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
	command="$(ps -o command= -p "$pid" 2>/dev/null | cut -c1-80)"
	printf '%s' "${cwd:-<unknown cwd>}${command:+ — $command}"
}
