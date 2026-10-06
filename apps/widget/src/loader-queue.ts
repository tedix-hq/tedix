export interface DeferredLoaderCall {
	method: string;
	args: unknown[];
	resolve: (value: unknown) => void;
	reject: (reason: unknown) => void;
}

export type LoaderCall = unknown[] | DeferredLoaderCall;

export function rejectDeferredLoaderCalls(
	queues: LoaderCall[][],
	reason: unknown,
	retainReplayable = true,
): void {
	for (const queue of queues) {
		const replayable: unknown[][] = [];
		for (const entry of queue.splice(0)) {
			if (Array.isArray(entry)) replayable.push(entry);
			else entry.reject(reason);
		}
		if (retainReplayable) queue.push(...replayable);
	}
}

export async function replayLoaderCall(
	entry: LoaderCall,
	api: Record<string, (...args: unknown[]) => unknown>,
): Promise<void> {
	const method = Array.isArray(entry) ? entry[0] : entry.method;
	const args = Array.isArray(entry) ? entry.slice(1) : entry.args;

	try {
		const value = await api[String(method)]!(...args);
		if (!Array.isArray(entry)) entry.resolve(value);
	} catch (error) {
		if (!Array.isArray(entry)) entry.reject(error);
	}
}
