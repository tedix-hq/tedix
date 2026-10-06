/**
 * Shared canonical-state convergence for OS Chat and embedded chat.
 *
 * Realtime callbacks are wake hints. The `read` result is authority, and a
 * revision is committed only after the consumer has accepted the snapshot.
 */
export const ACTIVE_PROJECTION_RECONCILE_MS = 15_000;
export const IDLE_PROJECTION_RECONCILE_MS = 60_000;

export type CanonicalProjectionReason = "initial" | "hint" | "interval";

function canonicalize(value: unknown, seen: Set<object>): unknown {
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) throw new Error("Projection contains a cycle");
	seen.add(value);
	try {
		if (Array.isArray(value))
			return value.map((item) => canonicalize(item, seen));
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, item]) => item !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, item]) => [key, canonicalize(item, seen)]),
		);
	} finally {
		seen.delete(value);
	}
}

/** Stable local watermark for JSON-shaped canonical projections. */
export function stableProjectionRevision(value: unknown): string {
	return JSON.stringify(canonicalize(value, new Set()));
}

export function canonicalProjectionInterval(input: {
	active: boolean;
	urgent?: boolean;
	activeMs?: number;
	idleMs?: number | false;
}): number | false {
	if (input.urgent) return input.activeMs ?? ACTIVE_PROJECTION_RECONCILE_MS;
	if (input.active) return input.activeMs ?? ACTIVE_PROJECTION_RECONCILE_MS;
	return input.idleMs ?? false;
}

export interface CanonicalProjectionWatcherOptions<T> {
	read(): Promise<T>;
	revision(value: T): string;
	isActive(value: T): boolean;
	deliver(value: T, reason: CanonicalProjectionReason): void | Promise<void>;
	/** Install live wake hints before the initial read. */
	subscribe?(
		wake: () => void,
	): void | (() => void) | Promise<void | (() => void)>;
	activeMs?: number;
	idleMs?: number | false;
	onRead?(input: {
		reason: CanonicalProjectionReason;
		revision: string;
		changed: boolean;
		active: boolean;
	}): void;
	onError?(error: unknown, reason: CanonicalProjectionReason): void;
	setTimeoutFn?: (callback: () => void, ms: number) => unknown;
	clearTimeoutFn?: (handle: unknown) => void;
}

export interface CanonicalProjectionWatcher {
	start(): Promise<void>;
	wake(): void;
	refresh(): Promise<void>;
	dispose(): void;
	getRevision(): string | null;
}

/**
 * Subscribe first, then read canonical state. Wake hints coalesce while a read
 * is in flight. Revisions are delivery-committed: a failed consumer never
 * parks the watermark, so the same canonical snapshot is retried.
 */
export function createCanonicalProjectionWatcher<T>(
	options: CanonicalProjectionWatcherOptions<T>,
): CanonicalProjectionWatcher {
	const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
	const clearTimeoutFn =
		options.clearTimeoutFn ??
		((handle: unknown) =>
			clearTimeout(handle as ReturnType<typeof setTimeout>));
	let disposed = false;
	let started = false;
	let starting: Promise<void> | null = null;
	let reading: Promise<void> | null = null;
	let queuedHint = false;
	let timer: unknown = null;
	let unsubscribe: (() => void) | null = null;
	let committedRevision: string | null = null;

	const clearTimer = () => {
		if (timer === null) return;
		clearTimeoutFn(timer);
		timer = null;
	};

	const schedule = (active: boolean) => {
		clearTimer();
		if (disposed) return;
		const interval = canonicalProjectionInterval({
			active,
			activeMs: options.activeMs,
			idleMs: options.idleMs,
		});
		if (interval === false) return;
		timer = setTimeoutFn(() => {
			timer = null;
			void run("interval");
		}, interval);
	};

	const run = async (reason: CanonicalProjectionReason): Promise<void> => {
		if (disposed) return;
		if (reading !== null) {
			if (reason === "hint") queuedHint = true;
			return reading;
		}
		reading = (async () => {
			try {
				const value = await options.read();
				if (disposed) return;
				const revision = options.revision(value);
				const active = options.isActive(value);
				const changed = revision !== committedRevision;
				if (changed) {
					await options.deliver(value, reason);
					if (disposed) return;
					committedRevision = revision;
				}
				options.onRead?.({ reason, revision, changed, active });
				schedule(active);
			} catch (error) {
				options.onError?.(error, reason);
				// A failed delivery/read keeps the previous watermark and retries on
				// the active cadence rather than silently parking stale state.
				schedule(true);
			} finally {
				reading = null;
				if (queuedHint && !disposed) {
					queuedHint = false;
					void run("hint");
				}
			}
		})();
		return reading;
	};

	return {
		async start() {
			if (disposed) return;
			if (started) return starting ?? Promise.resolve();
			started = true;
			starting = (async () => {
				const release = await options.subscribe?.(() => {
					if (!disposed) void run("hint");
				});
				if (disposed) {
					release?.();
					return;
				}
				unsubscribe = release ?? null;
				await run("initial");
			})();
			return starting;
		},
		wake() {
			if (!disposed) void run("hint");
		},
		refresh() {
			return run("hint");
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			clearTimer();
			unsubscribe?.();
			unsubscribe = null;
		},
		getRevision() {
			return committedRevision;
		},
	};
}
