/**
 * When the parent isolate resets mid-turn (memory limit, deploy, storage
 * reset), its in-memory per-run tool registry is gone. The facet resumes its Pi
 * loop on its own and can call the next tool before the workflow re-drive has
 * re-entered the parent and reinstalled that registry (observed: 14-34 s).
 * Rejecting that call immediately fails the durable Pi submission, and the
 * re-drive can only re-read the failure. Waiting a bounded time lets the
 * rebuild land first; nothing is claimed in the dispatch journal while waiting.
 */
export const FACET_REGISTRY_REBUILD_WAIT_MS = 90_000;
const POLL_MS = 250;

export async function awaitRebuiltFacetRegistry<T>(
	read: () => T | undefined,
	options: {
		waitMs: number;
		/** The delegation deadline also bounds the wait. */
		deadlineAt?: number;
	},
): Promise<T | undefined> {
	const sleep = (ms: number) =>
		new Promise<void>((resolve) => setTimeout(resolve, ms));
	const until = Math.min(
		Date.now() + Math.max(0, options.waitMs),
		options.deadlineAt ?? Number.POSITIVE_INFINITY,
	);
	let registry = read();
	while (registry === undefined && Date.now() < until) {
		await sleep(Math.min(POLL_MS, until - Date.now()));
		registry = read();
	}
	return registry;
}
