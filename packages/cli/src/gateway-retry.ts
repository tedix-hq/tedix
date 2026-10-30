import { fileGatewayCooldown, type GatewayCooldown } from "./gateway-cooldown";
import { preDispatchRetryAfterMs } from "@tedix/mcp-shared/tool-result";
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

/**
 * 503 refusals from access checks or catalog admission, before any tool is
 * dispatched. They are as safe to resend as a 429.
 */
const PRE_DISPATCH_UNAVAILABLE = new Set([
	"human_mcp_grant_unavailable",
	"external_agent_validation_unavailable",
	"mcp_catalog_busy",
]);

async function isPreDispatchUnavailable(response: Response) {
	if (response.status !== 503) return false;
	if (!response.headers.get("content-type")?.includes("application/json"))
		return false;
	const body: unknown = await response
		.clone()
		.json()
		.catch(() => undefined);
	return (
		typeof body === "object" &&
		body !== null &&
		"error" in body &&
		typeof body.error === "string" &&
		PRE_DISPATCH_UNAVAILABLE.has(body.error)
	);
}

function retryAfterSeconds(
	response: Response,
	now = Date.now,
): number | undefined {
	const raw = response.headers.get("retry-after")?.trim();
	if (!raw) return undefined;
	if (/^\d{1,4}$/.test(raw)) {
		const seconds = Number(raw);
		return seconds <= MAX_RETRY_AFTER_SECONDS ? seconds : undefined;
	}
	const date = Date.parse(raw);
	if (!Number.isFinite(date)) return undefined;
	const seconds = Math.ceil((date - now()) / 1000);
	return seconds > 0 && seconds <= MAX_RETRY_AFTER_SECONDS
		? seconds
		: undefined;
}

/**
 * Resend a gateway POST that was refused with HTTP 429 and a `Retry-After`,
 * or with a 503 because access checks or catalog admission are unavailable.
 *
 * The gateway answers both before the call is dispatched, so no tool ran and
 * resending the same body is safe for reads and writes alike. Each wait
 * honours `Retry-After` plus random jitter, so lanes that were refused together
 * do not return together; a 503 waits up to twice its `Retry-After` because the
 * backend it names is already under load. A caller deadline or cancellation
 * aborts the wait, and the request is then never resent.
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
		const wait = async (baseMs: number, jitterShare = 0.25) => {
			const jitterMs = random() * Math.min(baseMs * jitterShare, MAX_JITTER_MS);
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
			if (resendable && (await isPreDispatchUnavailable(response))) {
				const seconds = retryAfterSeconds(response, now);
				if (seconds === undefined || retry >= MAX_RETRIES) break;
				await response.body?.cancel().catch(() => {});
				await wait(Math.max(1, seconds) * 1_000, 1);
				response = await send();
				continue;
			}
			if (response.status !== 429) break;
			const raw = response.headers.get("retry-after")?.trim();
			const until =
				raw && /^\d+$/.test(raw)
					? now() + Math.max(1, Number(raw)) * 1000
					: raw
						? Date.parse(raw)
						: NaN;
			if (Number.isFinite(until) && until > now()) cooldown?.extend(url, until);
			const seconds = retryAfterSeconds(response, now);
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

/**
 * Run one tool call, and resend it at most twice when the gateway refused it
 * with a typed pre-dispatch "unavailable" tool error. Such an error says no
 * tool ran, so resending is as safe as after a 429. Each wait honours the
 * error's Retry-After plus up to as much jitter; a wait that would pass the
 * caller's deadline, or a cancellation, ends with the original error.
 */
export async function resendPreDispatchToolRefusals<T>(
	call: () => Promise<T>,
	options: {
		signal?: AbortSignal | null;
		deadlineAt?: number;
	} & Pick<GatewayRetryDeps, "sleep" | "random" | "now"> = {},
): Promise<T> {
	const sleep = options.sleep ?? abortableSleep;
	const random = options.random ?? Math.random;
	const now = options.now ?? Date.now;
	for (let retry = 0; ; retry++) {
		try {
			return await call();
		} catch (error) {
			const retryAfterMs = preDispatchRetryAfterMs(error);
			if (retryAfterMs === null || retry >= MAX_RETRIES) throw error;
			const waitMs = Math.round(
				retryAfterMs + random() * Math.min(retryAfterMs, MAX_JITTER_MS),
			);
			if (now() + waitMs >= (options.deadlineAt ?? Infinity)) throw error;
			await sleep(waitMs, options.signal);
			options.signal?.throwIfAborted();
		}
	}
}
