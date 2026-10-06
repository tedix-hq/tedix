/**
 * A small FIFO gate for operations that must span multiple awaited calls.
 * The tail promise never rejects, so a failed task cannot strand later turns.
 */
export class FacetTurnGate {
	private tail: Promise<void> = Promise.resolve();

	async run<T>(task: () => Promise<T>): Promise<T> {
		const previous = this.tail;
		let release!: () => void;
		this.tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await task();
		} finally {
			release();
		}
	}
}

/** Serialize one run's retries without blocking independent runs. */
export class KeyedFacetTurnGate {
	private readonly entries = new Map<
		string,
		{ gate: FacetTurnGate; pending: number }
	>();

	async run<T>(key: string, task: () => Promise<T>): Promise<T> {
		let entry = this.entries.get(key);
		if (!entry) {
			entry = { gate: new FacetTurnGate(), pending: 0 };
			this.entries.set(key, entry);
		}
		entry.pending++;
		try {
			return await entry.gate.run(task);
		} finally {
			entry.pending--;
			if (entry.pending === 0) this.entries.delete(key);
		}
	}
}
