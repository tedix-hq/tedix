/** Bound outstanding RPC acknowledgments without making every frame pay one RTT. */
export function createFrameDeliveryWindow<T>(
	deliver: (value: T) => Promise<void>,
) {
	const pending = new Set<Promise<void>>();
	let failed = false;
	let failure: unknown;
	return {
		async send(value: T): Promise<void> {
			if (failed) throw failure;
			const task = Promise.resolve().then(() => deliver(value));
			pending.add(task);
			void task.then(
				() => pending.delete(task),
				(error) => {
					failed = true;
					failure = error;
					pending.delete(task);
				},
			);
			if (pending.size >= 8) await Promise.race(pending);
		},
		async drain(): Promise<void> {
			await Promise.allSettled(pending);
			if (failed) throw failure;
		},
	};
}
