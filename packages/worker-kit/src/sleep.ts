/** Resolve after `ms` milliseconds; reject with AbortError when cancelled. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("Aborted", "AbortError"));
			return;
		}
		const onAbort = () => {
			clearTimeout(id);
			reject(new DOMException("Aborted", "AbortError"));
		};
		const id = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
