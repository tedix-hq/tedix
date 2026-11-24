import { spawn } from "node:child_process";

/**
 * Ends a process that is still running some seconds from now, from outside
 * it. A quit that stalls inside the system's own quit code stops the app's
 * timers too, so the app cannot be relied on to end itself.
 *
 * The helper remembers when the process started and ends it only if that is
 * unchanged, so a process id the system has handed to something else since
 * is left alone.
 */
export function exitGuardScript(pid: number, seconds: number): string {
	const started = `ps -o lstart= -p ${pid}`;
	return `s=$(${started}); [ -n "$s" ] || exit 0; sleep ${seconds}; [ "$(${started})" = "$s" ] && kill -9 ${pid}; exit 0`;
}

/** Starts the helper on its own, so it outlives a stalled app. */
export function startExitGuard(pid: number, seconds: number): void {
	if (!Number.isInteger(pid) || pid <= 1) return;
	spawn("/bin/sh", ["-c", exitGuardScript(pid, seconds)], {
		detached: true,
		stdio: "ignore",
	}).unref();
}
