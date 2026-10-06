/**
 * In-flight run registry for the non-blocking interactive multiplexer.
 *
 * Each dispatched turn registers an entry here. Background pollers call
 * settle() when the run resolves, then the REPL prints the result above the
 * live prompt and removes the entry.
 *
 * No external deps — pure TS, no I/O. I/O happens in index.ts.
 */

export interface InFlightEntry {
	/** First ~40 chars of the question, used for labelling. */
	label: string;
	homeRunId: string;
	conversationId: string;
	startedAt: number;
	/** Guard: true once settle() has been called so we never double-print. */
	settled: boolean;
}

export class InFlightRegistry {
	readonly #now: () => number;
	readonly #entries = new Map<string, InFlightEntry>();

	constructor(opts?: { now?: () => number }) {
		this.#now = opts?.now ?? (() => Date.now());
	}

	/**
	 * Register a newly dispatched run. The label is truncated to 40 code-points
	 * so prompt labels are readable even on narrow terminals.
	 */
	add(entry: {
		homeRunId: string;
		label: string;
		conversationId: string;
	}): InFlightEntry {
		const codepoints = [...entry.label];
		const truncated =
			codepoints.length > 40
				? `${codepoints.slice(0, 39).join("")}…`
				: entry.label;
		const e: InFlightEntry = {
			homeRunId: entry.homeRunId,
			label: truncated,
			conversationId: entry.conversationId,
			startedAt: this.#now(),
			settled: false,
		};
		this.#entries.set(entry.homeRunId, e);
		return e;
	}

	/**
	 * Mark as settled. Returns the entry (for printing) or undefined if the id
	 * was not registered or was already settled (double-settle guard).
	 */
	settle(homeRunId: string): InFlightEntry | undefined {
		const e = this.#entries.get(homeRunId);
		if (!e || e.settled) return undefined;
		e.settled = true;
		return e;
	}

	/** Remove a settled entry from the registry. */
	remove(homeRunId: string): void {
		this.#entries.delete(homeRunId);
	}

	/** All in-flight (unsettled) entries, sorted by startedAt ascending. */
	list(): InFlightEntry[] {
		return [...this.#entries.values()]
			.filter((e) => !e.settled)
			.sort((a, b) => a.startedAt - b.startedAt);
	}

	/** Count of currently in-flight (unsettled) runs. */
	get count(): number {
		return this.list().length;
	}

	/**
	 * Promise that resolves once there are no more in-flight runs.
	 * Polls at the given interval (default 200 ms). Accepts an abort signal.
	 */
	waitAll(opts?: {
		pollIntervalMs?: number;
		signal?: AbortSignal;
	}): Promise<void> {
		const intervalMs = opts?.pollIntervalMs ?? 200;
		const signal = opts?.signal;
		return new Promise<void>((resolve, reject) => {
			const check = () => {
				if (signal?.aborted) {
					reject(new Error("waitAll aborted"));
					return;
				}
				if (this.count === 0) {
					resolve();
					return;
				}
				const t = setTimeout(check, intervalMs);
				// Allow the process to exit even if this timer is still pending.
				if (typeof t === "object" && t !== null && "unref" in t) {
					(
						t as ReturnType<typeof setTimeout> & { unref?: () => void }
					).unref?.();
				}
			};
			check();
		});
	}

	/** Elapsed time in human-readable form, e.g. "1.2s", "34s", "2m5s". */
	elapsed(entry: InFlightEntry): string {
		const ms = this.#now() - entry.startedAt;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
		const totalSec = Math.floor(ms / 1000);
		const m = Math.floor(totalSec / 60);
		const s = totalSec % 60;
		return s > 0 ? `${m}m${s}s` : `${m}m`;
	}
}
