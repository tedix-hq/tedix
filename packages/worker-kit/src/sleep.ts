/** Resolve after `ms` milliseconds. No abort signal, no clamping. */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
