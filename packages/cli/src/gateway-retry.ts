type FetchLike = (
	...args: Parameters<typeof fetch>
) => ReturnType<typeof fetch>;

const MAX_RETRIES = 2;
const MAX_RETRY_AFTER_SECONDS = 120;
const MAX_JITTER_MS = 15_000;

export interface GatewayRetryDeps {
	/** Waits `ms`; rejects with the signal's reason when it aborts. */
	sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
	random?: () => number;
}

function abortableSleep(ms: number, signal?: AbortSignal | null) {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function retryAfterSeconds(response: Response): number | undefined {
	const raw = response.headers.get("retry-after")?.trim();
	if (!raw || !/^\d{1,4}$/.test(raw)) return undefined;
	const seconds = Number(raw);
	return seconds <= MAX_RETRY_AFTER_SECONDS ? seconds : undefined;
}

/**
 * Resend a gateway POST that was refused with HTTP 429 and a `Retry-After`.
 *
 * The gateway answers 429 from its request limiter before the call is
 * dispatched, so no tool ran and resending the same body is safe for reads and
 * writes alike. Each wait honours `Retry-After` plus random jitter, so lanes
 * that were refused together do not return together. A caller deadline or
 * cancellation aborts the wait, and the request is then never resent.
 */
export function retryRateLimitedPosts(
	fetchFn: FetchLike,
	deps: GatewayRetryDeps = {},
): FetchLike {
	const sleep = deps.sleep ?? abortableSleep;
	const random = deps.random ?? Math.random;
	return async (input, init) => {
		const resendable =
			init?.method?.toUpperCase() === "POST" && typeof init.body === "string";
		let response = await fetchFn(input, init);
		for (let retry = 0; resendable && retry < MAX_RETRIES; retry++) {
			if (response.status !== 429) break;
			const seconds = retryAfterSeconds(response);
			if (seconds === undefined) break;
			const baseMs = Math.max(1, seconds) * 1_000;
			const jitterMs = random() * Math.min(baseMs / 4, MAX_JITTER_MS);
			await response.body?.cancel().catch(() => {});
			await sleep(Math.round(baseMs + jitterMs), init?.signal);
			response = await fetchFn(input, init);
		}
		return response;
	};
}
