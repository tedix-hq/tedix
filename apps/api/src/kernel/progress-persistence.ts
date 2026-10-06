/**
 * Tracks fail-soft persistence started from the synchronous kernel progress
 * callback and lets the async turn finalizer wait for every in-flight write.
 *
 * A synthetic KernelDO turn context deliberately has no `waitUntil`. Leaving a
 * D1 write detached here means a DO reset or eviction can drop the write before
 * the D1-draining Home SSE stream observes it. The turn still must not fail when
 * an advisory progress write fails, so tracked rejections are swallowed after
 * they become observable to `drain()`.
 */

export interface ProgressPersistenceTracker {
	track(work: Promise<unknown>): void;
	drain(): Promise<void>;
}

export function createProgressPersistenceTracker(): ProgressPersistenceTracker {
	const pending = new Set<Promise<void>>();

	return {
		track(work): void {
			let tracked: Promise<void>;
			tracked = work
				.then(
					() => undefined,
					() => undefined,
				)
				.finally(() => pending.delete(tracked));
			pending.add(tracked);
		},
		async drain(): Promise<void> {
			// Loop so work synchronously registered by a settling callback cannot
			// escape the finalizer's initial snapshot.
			while (pending.size > 0) {
				await Promise.allSettled(pending);
			}
		},
	};
}
