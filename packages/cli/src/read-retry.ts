import { setTimeout as sleep } from "node:timers/promises";

export function readBudgetMs(baseMs: number, lanes: number): number {
	return Math.min(300_000, baseMs * (1 + Math.log2(Math.max(1, lanes))));
}

function isReadDeadline(error: unknown): boolean {
	return (
		error instanceof Error &&
		/(?:read|call|command) deadline (?:elapsed|exceeded)/i.test(error.message)
	);
}

function retryable(error: unknown): boolean {
	const status = (error as { status?: number } | null)?.status;
	if (status !== undefined)
		return status === 408 || status === 429 || status >= 500;
	const code = (error as { code?: string } | null)?.code;
	if (code) return ["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"].includes(code);
	return isReadDeadline(error);
}

/** Retries share a monotonic deadline; each child must enforce its supplied slice. */
export async function retryRead<T>(
	operation: (timeoutMs: number) => Promise<T>,
	options: {
		operation: string;
		budgetMs: number;
		attemptMs: number;
		log?: (line: string) => void;
		now?: () => number;
		wait?: (ms: number) => Promise<unknown>;
		random?: () => number;
		signal?: AbortSignal;
	},
): Promise<T> {
	const now = options.now ?? (() => performance.now());
	const wait =
		options.wait ??
		((ms: number) => sleep(ms, undefined, { signal: options.signal }));
	const random = options.random ?? Math.random;
	const started = now();
	const remaining = () => Math.max(0, options.budgetMs - (now() - started));
	const id = crypto.randomUUID();
	const log = (event: string, attempt: number, extra = {}) =>
		(options.log ?? ((line) => console.error(line)))(
			JSON.stringify({
				event: `read-${event}`,
				operation: options.operation,
				budgetId: id,
				budgetMs: options.budgetMs,
				elapsedMs: Math.round(now() - started),
				remainingMs: Math.floor(remaining()),
				attempt,
				...extra,
			}),
		);
	log("budget", 0);
	for (let attempt = 1; ; attempt++) {
		options.signal?.throwIfAborted();
		const timeoutMs = Math.max(
			1,
			Math.floor(Math.min(remaining(), options.attemptMs * 2 ** (attempt - 1))),
		);
		try {
			const value = await operation(timeoutMs);
			options.signal?.throwIfAborted();
			if (remaining() <= 0) throw new Error("Read deadline elapsed");
			log("succeeded", attempt);
			return value;
		} catch (error) {
			const delayMs = Math.round(
				Math.min(2_000, 250 * 2 ** (attempt - 1)) * (0.5 + random()),
			);
			if (!retryable(error) || attempt >= 4 || remaining() <= delayMs) {
				log("failed", attempt);
				throw error;
			}
			log("retry", attempt, { delayMs, timeoutMs });
			await wait(delayMs);
			if (remaining() <= 0) {
				log("failed", attempt);
				throw error;
			}
		}
	}
}
