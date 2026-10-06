/**
 * descopeFetch — a thin, base-url-agnostic wrapper around `fetch` for Descope
 * management / token / AIH calls that do NOT go through the Descope SDK.
 *
 * Goals (additive, behavior-preserving for callers):
 * - Per-attempt timeout via AbortController (modeled on access-key-exchange.ts).
 * - Bounded retries on transient failures, with a retry-safety policy that
 *   guarantees zero double-execution on mutations.
 * - Never throws on HTTP status. Returns the final Response (ok OR non-ok) with
 *   its body intact, so every caller's existing `if (!response.ok) throw …` plus
 *   `response.text()/json()` parsing keeps working byte-identically. Only
 *   intermediate (retried) responses have their bodies drained/discarded.
 * - Throws only when all attempts fail with a thrown (network/abort) error —
 *   the same failure mode as a bare `fetch` that rejects on a network error.
 *
 * The caller is responsible for building the full URL (resolving its own
 * base-url default). Subsystems use different base-url defaults, so folding a
 * single global default in here would silently change behavior for some callers.
 *
 * Retry-safety policy:
 *
 * | idempotent | 429 | network/abort(timeout) | 5xx |
 * |------------|-----|------------------------|-----|
 * | true       | yes | yes                    | yes |
 * | false      | yes | no                     | no  |
 *
 * Rationale: 429 is returned by Descope's rate limiter BEFORE the mutation
 * executes, so it is always safe to retry. A network error or timeout on a
 * mutation may fire AFTER the server already executed the write, so retrying it
 * risks double-execution. Mutations therefore retry 429 only.
 */

export interface DescopeFetchOptions {
	/** Per-attempt timeout. Default 10_000ms (matches access-key-exchange.ts). */
	timeoutMs?: number;
	/** Number of retries (additional attempts) after the first. Default 2 → up to 3 attempts. */
	retries?: number;
	/** true = safe to retry on network/timeout/5xx (GET-equivalent reads). Default false. */
	idempotent?: boolean;
	/** Injectable fetch for tests. */
	fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 2;
const MAX_BACKOFF_MS = 2_000;
const BASE_BACKOFF_MS = 250;
const MAX_RETRY_AFTER_MS = 10_000;

function backoffDelayMs(attempt: number): number {
	// Jittered exponential backoff: min(2000, 250 * 2^attempt) + random(0..125)
	const base = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
	return base + Math.floor(Math.random() * 125);
}

function retryAfterMs(response: Response): number | null {
	const header = response.headers.get("retry-after");
	if (!header) return null;
	// Retry-After may be seconds (delta) or an HTTP-date.
	const seconds = Number(header);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
	}
	const dateMs = Date.parse(header);
	if (Number.isFinite(dateMs)) {
		const delta = dateMs - Date.now();
		if (delta > 0) return Math.min(delta, MAX_RETRY_AFTER_MS);
	}
	return null;
}

async function sleep(ms: number): Promise<void> {
	if (ms <= 0) return;
	await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Drain and discard an intermediate (retried) response body to avoid leaks. */
async function discardBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// best-effort; ignore
	}
}

/**
 * Fetch with per-attempt timeout + bounded, retry-safe retries.
 *
 * Returns the Response (ok OR final non-ok) — NEVER throws on HTTP status.
 * Throws only when all attempts fail with a thrown (network/abort) error.
 */
export async function descopeFetch(
	url: string,
	init: RequestInit,
	opts?: DescopeFetchOptions,
): Promise<Response> {
	const fetchImpl = opts?.fetch ?? fetch;
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const retries = opts?.retries ?? DEFAULT_RETRIES;
	const idempotent = opts?.idempotent ?? false;
	const maxAttempts = retries + 1;

	let lastThrown: unknown;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const isLastAttempt = attempt === maxAttempts - 1;
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);

		let response: Response;
		try {
			response = await fetchImpl(url, { ...init, signal: controller.signal });
		} catch (error) {
			// Network error or abort (timeout). Retry only for idempotent calls.
			lastThrown = error;
			if (idempotent && !isLastAttempt) {
				await sleep(backoffDelayMs(attempt));
				continue;
			}
			throw error;
		} finally {
			clearTimeout(timeout);
		}

		// 429: rate limiter rejects BEFORE execution → safe to retry for both
		// idempotent and non-idempotent (mutation) calls.
		if (response.status === 429 && !isLastAttempt) {
			const wait = retryAfterMs(response) ?? backoffDelayMs(attempt);
			await discardBody(response);
			await sleep(wait);
			continue;
		}

		// 5xx: only safe to retry for idempotent reads (mutation may have executed).
		if (
			idempotent &&
			response.status >= 500 &&
			response.status <= 599 &&
			!isLastAttempt
		) {
			await discardBody(response);
			await sleep(backoffDelayMs(attempt));
			continue;
		}

		// Final response (ok OR non-ok) — return with body intact.
		return response;
	}

	// Exhausted all attempts via thrown errors.
	throw lastThrown instanceof Error
		? lastThrown
		: new Error("descopeFetch: all attempts failed");
}

/**
 * Descope Management API credentials — the `{projectId}:{managementKey}` pair
 * that authorizes every non-SDK management/AIH call.
 */
export interface DescopeManagementAuth {
	DESCOPE_PROJECT_ID: string;
	DESCOPE_MANAGEMENT_KEY: string;
}

export interface DescopeManagementRequest {
	/**
	 * Fully-resolved request URL. Callers own base-url selection (subsystems use
	 * different defaults and trailing-slash policies), so this helper never folds
	 * one in — matching descopeFetch's own base-url contract.
	 */
	url: string;
	method: "GET" | "POST";
	/** JSON-encoded into the request body when provided. */
	body?: unknown;
	/** Retry-safety: true for reads / stateless issuance, false for mutations. */
	idempotent: boolean;
	/**
	 * Prefix for the thrown Error on a non-ok status; suffixed with
	 * ` [<status> <statusText>]: <body>`.
	 */
	errorPrefix: string;
}

/**
 * Shared Descope Management API fetch. The one primitive behind the previously
 * duplicated per-module wrappers: it builds the `Bearer {projectId}:{key}` auth
 * header, delegates to `descopeFetch` (so per-attempt timeout + retry-safety are
 * preserved unchanged), and throws on a non-ok status. Returns the ok `Response`
 * with its body intact so each caller parses its own payload shape.
 */
export async function descopeManagementFetch(
	auth: DescopeManagementAuth,
	request: DescopeManagementRequest,
): Promise<Response> {
	const response = await descopeFetch(
		request.url,
		{
			method: request.method,
			headers: {
				Authorization: `Bearer ${auth.DESCOPE_PROJECT_ID}:${auth.DESCOPE_MANAGEMENT_KEY}`,
				"Content-Type": "application/json",
			},
			body:
				request.body === undefined ? undefined : JSON.stringify(request.body),
		},
		{ idempotent: request.idempotent },
	);

	if (!response.ok) {
		const bodyText = await response.text().catch(() => "(no body)");
		throw new Error(
			`${request.errorPrefix} [${response.status} ${response.statusText}]: ${bodyText}`,
		);
	}

	return response;
}
