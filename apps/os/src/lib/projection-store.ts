/**
 * Immutable projection store used by the realtime connection status owner.
 * Subscribers share stable snapshots; identity-preserving reductions do not
 * notify, and frame coalescing batches bursts. Connection generation guards
 * belong to the stream pump.
 */

import {
	createFrameCoalescer,
	defaultFrameScheduler,
	type FrameCoalescer,
	type FrameScheduler,
} from "@/lib/conversation-stream";

export type ProjectionStoreOptions<TState, TEvent> = {
	/** Builds the initial projection. */
	initial: () => TState;
	/**
	 * Pure fold. MUST return the same reference when the event changes nothing
	 * — that identity is the store's "did anything happen" signal, and it is
	 * what keeps a replayed stream from re-rendering the app.
	 */
	reduce: (state: TState, event: TEvent) => TState;
	/** Defaults to rAF (16ms timeout outside a browser). Injectable for tests. */
	scheduler?: FrameScheduler;
};

export type ProjectionStore<TState, TEvent> = {
	/** `useSyncExternalStore` subscribe. Returns the unsubscribe. */
	subscribe(listener: () => void): () => void;
	/** `useSyncExternalStore` getSnapshot — a stable reference between changes. */
	getSnapshot(): TState;
	/** Folds one event and returns whether the projection changed. */
	apply(event: TEvent): boolean;
	/** Runs any coalesced notification now (tests, and flush-before-read). */
	flush(): void;
};

export function createProjectionStore<TState, TEvent>(
	options: ProjectionStoreOptions<TState, TEvent>,
): ProjectionStore<TState, TEvent> {
	const listeners = new Set<() => void>();
	let state = options.initial();
	let pending = false;

	const notify = () => {
		pending = false;
		// Snapshot: a listener may unsubscribe itself during notification.
		const snapshot = Array.from(listeners);
		for (const listener of snapshot) listener();
	};

	const coalescer: FrameCoalescer = createFrameCoalescer(
		notify,
		options.scheduler ?? defaultFrameScheduler,
	);

	return {
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		getSnapshot() {
			return state;
		},
		apply(event) {
			const next = options.reduce(state, event);
			if (next === state) return false;
			state = next;
			pending = true;
			coalescer.schedule();
			return true;
		},
		flush() {
			if (!pending) return;
			notify();
		},
	};
}
