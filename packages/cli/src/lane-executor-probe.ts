import { spawnSync } from "node:child_process";
import { laneChildEnv } from "./lane-child-env";
import type { ExecutorAvailability, LocalExecutor } from "./lane-routing";

/** The first `<binary> --version` probe gets this long before it is tried again. */
export const EXECUTOR_PROBE_TIMEOUT_MS = 5_000;
/** A probe that timed out is tried once more with this longer limit. */
export const EXECUTOR_PROBE_RETRY_TIMEOUT_MS = 15_000;
/** A passing probe is trusted this long before the binary is run again. */
export const EXECUTOR_PROBE_CACHE_MS = 5 * 60_000;
/** A probe that timed out twice is not run again for this long. */
export const EXECUTOR_PROBE_TIMEOUT_CACHE_MS = 30_000;

export function executorBinary(executor: LocalExecutor) {
	return executor === "claude-code" ? "claude" : executor;
}

/**
 * A timeout says the machine is busy, not that the binary is gone: the probe
 * runs once more with a longer limit, and a second timeout is reported as
 * transient so routing waits instead of failing the Work.
 */
export function probeExecutorVersion(
	command: string,
	timeoutMs = EXECUTOR_PROBE_TIMEOUT_MS,
	retryTimeoutMs = EXECUTOR_PROBE_RETRY_TIMEOUT_MS,
): ExecutorAvailability {
	const probe = `${command} --version`;
	const run = (limit: number) => {
		const started = Date.now();
		const result = spawnSync(command, ["--version"], {
			env: laneChildEnv(),
			timeout: limit,
			stdio: "ignore",
		});
		return { result, elapsedMs: Date.now() - started };
	};
	const timedOut = (result: ReturnType<typeof run>["result"]) =>
		(result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
	let { result, elapsedMs } = run(timeoutMs);
	const retried = timedOut(result);
	if (retried) ({ result, elapsedMs } = run(retryTimeoutMs));
	if (result.status === 0)
		return retried
			? {
					available: true,
					slow: `${probe} timed out at ${timeoutMs} ms, then passed in ${elapsedMs} ms`,
				}
			: { available: true };
	if (timedOut(result))
		return {
			available: false,
			transient: true,
			// No elapsed time: the reason must stay identical between passes so
			// it is logged once.
			reason: `${probe} timed out twice (limits ${timeoutMs} ms, then ${retryTimeoutMs} ms); the machine is busy, trying again later`,
		};
	if (result.error)
		return {
			available: false,
			reason: `${probe} failed to start after ${elapsedMs} ms: ${result.error.message}`,
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
 * seen right away. A probe that timed out twice is the exception: it blocks
 * the runner for both limits, so its answer is reused for a short while.
 */
export function cachedExecutorProbe(
	probe: (executor: LocalExecutor) => ExecutorAvailability = (executor) =>
		probeExecutorVersion(executorBinary(executor)),
	cacheMs = EXECUTOR_PROBE_CACHE_MS,
	now: () => number = Date.now,
	timeoutCacheMs = EXECUTOR_PROBE_TIMEOUT_CACHE_MS,
): (executor: LocalExecutor) => ExecutorAvailability {
	const cache = new Map<LocalExecutor, number>();
	const busy = new Map<
		LocalExecutor,
		{ at: number; result: ExecutorAvailability }
	>();
	return (executor) => {
		const at = cache.get(executor);
		if (at !== undefined && now() - at < cacheMs) return { available: true };
		const waiting = busy.get(executor);
		if (waiting && now() - waiting.at < timeoutCacheMs) return waiting.result;
		const result = probe(executor);
		if (result.available) cache.set(executor, now());
		else cache.delete(executor);
		if (result.transient) busy.set(executor, { at: now(), result });
		else busy.delete(executor);
		return result;
	};
}
