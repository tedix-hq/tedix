import { spawnSync } from "node:child_process";
import { laneChildEnv } from "./lane-child-env";
import type { ExecutorAvailability, LocalExecutor } from "./lane-routing";

/** One `<binary> --version` probe gets this long before the executor counts as unavailable. */
export const EXECUTOR_PROBE_TIMEOUT_MS = 5_000;
/** A passing probe is trusted this long before the binary is run again. */
export const EXECUTOR_PROBE_CACHE_MS = 5 * 60_000;

export function executorBinary(executor: LocalExecutor) {
	return executor === "claude-code" ? "claude" : executor;
}

export function probeExecutorVersion(
	command: string,
	timeoutMs = EXECUTOR_PROBE_TIMEOUT_MS,
): ExecutorAvailability {
	const started = Date.now();
	const result = spawnSync(command, ["--version"], {
		env: laneChildEnv(),
		timeout: timeoutMs,
		stdio: "ignore",
	});
	const elapsedMs = Date.now() - started;
	if (result.status === 0) return { available: true };
	const probe = `${command} --version`;
	if (result.error)
		return {
			available: false,
			reason:
				(result.error as NodeJS.ErrnoException).code === "ETIMEDOUT"
					? `${probe} timed out after ${elapsedMs} ms (limit ${timeoutMs} ms)`
					: `${probe} failed to start after ${elapsedMs} ms: ${result.error.message}`,
		};
	if (result.signal)
		return {
			available: false,
			reason: `${probe} killed by signal ${result.signal} after ${elapsedMs} ms`,
		};
	return {
		available: false,
		reason: `${probe} exited ${result.status} after ${elapsedMs} ms`,
	};
}

/**
 * Cache only a passing probe. Re-running `<binary> --version` on every pass
 * lets one slow spawn on a busy machine drop a healthy executor, while an
 * uncached failure is re-probed on the next pass so a returning binary is
 * seen right away.
 */
export function cachedExecutorProbe(
	probe: (executor: LocalExecutor) => ExecutorAvailability = (executor) =>
		probeExecutorVersion(executorBinary(executor)),
	cacheMs = EXECUTOR_PROBE_CACHE_MS,
	now: () => number = Date.now,
): (executor: LocalExecutor) => ExecutorAvailability {
	const cache = new Map<LocalExecutor, number>();
	return (executor) => {
		const at = cache.get(executor);
		if (at !== undefined && now() - at < cacheMs) return { available: true };
		const result = probe(executor);
		if (result.available) cache.set(executor, now());
		else cache.delete(executor);
		return result;
	};
}
