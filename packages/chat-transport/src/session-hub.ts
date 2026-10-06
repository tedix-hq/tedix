/**
 * The shared Cap'n Web session — ONE socket for the whole browser tab.
 *
 * This is the socket half of `createCapnChatMachine`, lifted out rather than
 * reimplemented. Before this module, every mount of
 * `useCapnStreamedOverlays` called `connect()` itself, so two OS surfaces
 * subscribing meant two WebSockets, two `CapnChatSession` roots, two token
 * buckets and two subscription ceilings. The server's limits are PER SESSION
 * ROOT (`CAPN_MAX_LIVE_SUBSCRIPTIONS` = 4, 30 calls / 10s), so
 * multiplying sockets does not buy headroom — it multiplies upstream long-poll
 * pumps against `apps/api` while the client still believes it is one client.
 *
 * Division of labour, kept strict so there is exactly ONE reconnect/epoch
 * implementation in the lane:
 *
 * - THE HUB owns the socket: connect-once, share, dispose when the last lease
 *   releases, and a `generation` that bumps the instant the socket dies.
 * - THE MACHINE owns retry: backoff, resume cursors, capability re-acquisition.
 *   It asks the hub for the current session on every establish, so a hub-level
 *   death is just another establish failure to the machine's existing loop.
 *
 * The hub therefore has NO timers and NO backoff of its own. A dead session is
 * dropped; the next `session()` call dials again, and the pacing of those calls
 * is the machine's existing 1s→30s ladder.
 */

export interface CapnConnection {
	ping(): Promise<void>;
	onRpcBroken?(callback: (error: unknown) => void): void;
	[Symbol.dispose]?(): void;
}

export type SessionLease<T extends CapnConnection> = {
	/** The live session root. NEVER disposed by the borrower — the hub owns it. */
	root: T;
	/** Hub generation this root belongs to; a death bumps it. */
	generation: number;
};

export type SessionLeaseHandle<T extends CapnConnection> = {
	/**
	 * The current shared session, dialing one if none is live. Concurrent
	 * callers share a single in-flight connect.
	 */
	session(): Promise<SessionLease<T>>;
	/**
	 * Fires when `generation` dies. Invoked immediately (on a microtask) when
	 * that generation is ALREADY dead, so a caller that registers late can never
	 * wait forever on a notification that already happened.
	 */
	onBroken(generation: number, callback: () => void): () => void;
	/** Idempotent. The last release disposes the socket. */
	release(): void;
};

export type SessionHub<T extends CapnConnection> = {
	lease(): SessionLeaseHandle<T>;
	/** Probe the current socket; false means no live session or a failed proof. */
	probe(): Promise<boolean>;
	/** Live leases. Zero MUST mean zero sockets. */
	leaseCount(): number;
	getGeneration(): number;
	/** True while a session root is held open. */
	isConnected(): boolean;
};

export type SessionHubOptions<T extends CapnConnection> = {
	connect: () => Promise<T>;
	/** Dev leak accounting (`capn-measurement.ts`). */
	trackStub?: (label: string) => () => void;
	now?: () => number;
	probeTimeoutMs?: number;
};

export const CAPN_WAKE_PROBE_TIMEOUT_MS = 10_000;
export const CAPN_WAKE_PROBE_MIN_IDLE_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`Cap'n Web probe timed out after ${timeoutMs}ms`)),
			timeoutMs,
		);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

function disposeQuietly(stub: unknown): void {
	if (
		stub === null ||
		(typeof stub !== "object" && typeof stub !== "function")
	) {
		return;
	}
	try {
		(stub as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
	} catch {
		// disposal must never throw into the app
	}
}

export function createSessionHub<T extends CapnConnection>(
	options: SessionHubOptions<T>,
): SessionHub<T> {
	let leases = 0;
	let generation = 1;
	let root: T | null = null;
	let pending: Promise<SessionLease<T>> | null = null;
	let releaseTracked: (() => void) | null = null;
	let probeInFlight: Promise<boolean> | null = null;
	let lastProvenAt = 0;
	const now = options.now ?? Date.now;
	/** generation -> callbacks awaiting that generation's death. */
	const brokenListeners = new Map<number, Set<() => void>>();

	const teardown = () => {
		const dying = root;
		root = null;
		pending = null;
		const release = releaseTracked;
		releaseTracked = null;
		if (dying !== null) {
			try {
				disposeQuietly(dying);
			} finally {
				release?.();
			}
		}
	};

	/** Kills the current session and notifies everyone bound to its generation. */
	const kill = () => {
		const dead = generation;
		generation += 1;
		teardown();
		const listeners = brokenListeners.get(dead);
		brokenListeners.delete(dead);
		if (listeners === undefined) return;
		// Snapshot: a handler may unsubscribe itself while being notified.
		const snapshot = Array.from(listeners);
		for (const listener of snapshot) {
			try {
				listener();
			} catch {
				// a broken-notification handler must never break the hub
			}
		}
	};

	const connect = (): Promise<SessionLease<T>> => {
		const myGeneration = generation;
		const attempt = options.connect().then((connected) => {
			// The hub was killed or drained while the dial was in flight: the
			// socket belongs to nobody, so it must not become the shared root.
			if (myGeneration !== generation || leases === 0) {
				disposeQuietly(connected);
				throw new Error("The Cap'n Web session was released while connecting.");
			}
			root = connected;
			lastProvenAt = now();
			releaseTracked = options.trackStub?.("session") ?? null;
			connected.onRpcBroken?.(() => {
				// Only the LIVE generation's death is meaningful; a callback from a
				// socket we already replaced must not kill its successor.
				if (myGeneration === generation) kill();
			});
			return { root: connected, generation: myGeneration };
		});
		pending = attempt.catch((error: unknown) => {
			// A failed dial leaves no session behind; the next caller re-dials.
			if (myGeneration === generation) pending = null;
			throw error;
		});
		return pending;
	};

	return {
		async probe() {
			if (root === null || leases === 0) return false;
			if (now() - lastProvenAt < CAPN_WAKE_PROBE_MIN_IDLE_MS) return true;
			if (probeInFlight !== null) return probeInFlight;
			const target = root;
			const targetGeneration = generation;
			probeInFlight = withTimeout(
				Promise.resolve(target.ping()),
				options.probeTimeoutMs ?? CAPN_WAKE_PROBE_TIMEOUT_MS,
			)
				.then(() => {
					if (root === target && generation === targetGeneration) {
						lastProvenAt = now();
					}
					return true;
				})
				.catch(() => {
					if (root === target && generation === targetGeneration) kill();
					return false;
				})
				.finally(() => {
					probeInFlight = null;
				});
			return probeInFlight;
		},
		lease() {
			leases += 1;
			let released = false;
			/** Per-lease unsubscribe ledger, so release() cannot leak listeners. */
			const registered = new Set<() => void>();
			return {
				session() {
					if (released) {
						return Promise.reject(
							new Error("This Cap'n Web session lease was released."),
						);
					}
					if (root !== null) {
						return Promise.resolve({ root, generation });
					}
					return pending ?? connect();
				},
				onBroken(target, callback) {
					if (released) return () => {};
					if (target !== generation) {
						// Already dead. Notify out-of-band so registration order never
						// changes whether the caller learns about it.
						queueMicrotask(() => {
							if (!released) callback();
						});
						return () => {};
					}
					let listeners = brokenListeners.get(target);
					if (listeners === undefined) {
						listeners = new Set();
						brokenListeners.set(target, listeners);
					}
					listeners.add(callback);
					const unsubscribe = () => {
						listeners?.delete(callback);
						if (listeners?.size === 0) brokenListeners.delete(target);
						registered.delete(unsubscribe);
					};
					registered.add(unsubscribe);
					return unsubscribe;
				},
				release() {
					if (released) return;
					released = true;
					// Snapshot: each unsubscribe removes itself from `registered`.
					const unsubscribes = Array.from(registered);
					for (const unsubscribe of unsubscribes) unsubscribe();
					registered.clear();
					leases -= 1;
					// No subscribers means no socket — enforced, not aspirational.
					if (leases === 0) {
						generation += 1;
						brokenListeners.clear();
						teardown();
					}
				},
			};
		},
		leaseCount() {
			return leases;
		},
		getGeneration() {
			return generation;
		},
		isConnected() {
			return root !== null;
		},
	};
}
