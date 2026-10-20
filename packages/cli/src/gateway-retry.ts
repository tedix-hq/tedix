import { fileGatewayCooldown, type GatewayCooldown } from "./gateway-cooldown";
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
	now?: () => number;
	cooldown?: GatewayCooldown | null;
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
	const now = deps.now ?? Date.now;
	const cooldown =
		deps.cooldown === undefined ? fileGatewayCooldown() : deps.cooldown;
	return async (input, init) => {
		const resendable =
			init?.method?.toUpperCase() === "POST" && typeof init.body === "string";
		const url = input instanceof Request ? input.url : String(input);
		const signal =
			init?.signal ?? (input instanceof Request ? input.signal : undefined);
		const wait = async (baseMs: number) => {
			const jitterMs = random() * Math.min(baseMs / 4, MAX_JITTER_MS);
			await sleep(Math.round(baseMs + jitterMs), signal);
			signal?.throwIfAborted();
		};
		const send = async () => {
			let remaining: number;
			while ((remaining = (cooldown?.read(url) ?? 0) - now()) > 0) {
				await wait(Math.min(remaining, MAX_RETRY_AFTER_SECONDS * 1000));
			}
			return fetchFn(input, init);
		};
		let response = await send();
		for (let retry = 0; ; retry++) {
			if (response.status !== 429) break;
			const raw = response.headers.get("retry-after")?.trim();
			const until =
				raw && /^\d+$/.test(raw)
					? now() + Math.max(1, Number(raw)) * 1000
					: raw
						? Date.parse(raw)
						: NaN;
			if (Number.isFinite(until) && until > now()) cooldown?.extend(url, until);
			const seconds = retryAfterSeconds(response);
			if (seconds === undefined) break;
			const baseMs = Math.max(1, seconds) * 1_000;
			if (!resendable || retry >= MAX_RETRIES) break;
			await response.body?.cancel().catch(() => {});
			await wait(baseMs);
			response = await send();
		}
		return response;
	};
}
