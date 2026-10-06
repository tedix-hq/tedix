import { stallWatchdogDelayMs } from "./turn-stall";

/** Stop waiting promptly; an already dispatched host operation is never replayed. */
export function waitForTurnPreparation<T>(
	operation: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () =>
			reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
		const timer = setTimeout(
			() => {
				cleanup();
				reject(new Error("Subscription ended before completion"));
			},
			stallWatchdogDelayMs({ text: "" }),
		);
		const cleanup = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			cleanup();
			abort();
		};
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		operation.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error) => {
				cleanup();
				reject(error);
			},
		);
	});
}
