/**
 * Provider-error classification for durable turn retry.
 *
 * Runtime-neutral and dependency-free so every entrypoint that can burn a retry
 * budget on a model call — the durable `facet-turn` step, inline facet turns,
 * cron turns, delegated child turns — reaches the SAME verdict for the same
 * error text. A comparable coding agent's `src/agent/turn-recovery-policy.ts` is the prior art:
 * one pure policy module consumed by both its TUI and headless entrypoints
 * precisely so two surfaces cannot drift into two recovery behaviors.
 *
 * WHY THIS EXISTS: `apps/tedi-runtime/src/durable-object-recovery.ts` classifies
 * INFRASTRUCTURE loss (deploy reset, isolate OOM, storage reset). Nothing
 * classified PROVIDER faults. Every non-infrastructure throw out of `facet-turn`
 * inherited the blanket `IDEMPOTENT_STEP_RETRY` budget (5 attempts from 15s,
 * exponential), so a deterministic 4xx — a rejected key, an unknown deployment,
 * a context-window overflow — re-ran the model four more times before sealing
 * the same failure, and an exhausted org quota was indistinguishable from a
 * transient overload.
 *
 * CONSERVATIVE BY CONSTRUCTION: an unrecognized error stays `retryable: true`,
 * which is exactly today's behavior. This module only ever SHORT-CIRCUITS a
 * retry when a definite non-retryable signature matches, so adopting it cannot
 * make a currently-recovering turn stop recovering.
 */

/** Coarse failure family, used for telemetry and stop-reason attribution. */
export type ProviderErrorClass =
	| "auth"
	| "bad_request"
	| "billing"
	| "not_found"
	| "quota"
	| "context_overflow"
	| "content_filter"
	| "rate_limit"
	| "overloaded"
	| "edge_5xx"
	| "network"
	| "empty_response"
	| "unknown";

export interface ProviderErrorVerdict {
	/** Whether the caller should re-drive. `false` means seal the turn now. */
	retryable: boolean;
	family: ProviderErrorClass;
	/**
	 * Suggested base delay before the next attempt (ms). Callers running under a
	 * fixed Workflow retry policy can ignore it; inline callers should honor it.
	 */
	retryAfterMs: number;
}

/** Cloudflare edge 52x: the colo could not get a response from the origin. */
const EDGE_5XX_PATTERNS = [
	/\berror\s*(?:code:?\s*)?52[0-9]\b/i,
	/\bweb server is returning an unknown error\b/i,
	/\bconnection timed out\b.*\bcloudflare\b/i,
];

/**
 * Definitely NOT worth another identical request. Checked FIRST — a 429 whose
 * body names an exhausted quota is terminal even though bare 429 is transient.
 */
const NON_RETRYABLE_PATTERNS: ReadonlyArray<
	readonly [RegExp, ProviderErrorClass]
> = [
	// Credentials / authorization
	[/\binvalid[_ ]api[_ ]key\b/i, "auth"],
	[/\bincorrect api key\b/i, "auth"],
	[/\bauthentication (?:error|failed)\b/i, "auth"],
	[/\bunauthorized\b/i, "auth"],
	[/\bpermission[_ ]denied\b/i, "auth"],
	[/\bforbidden\b/i, "auth"],
	[/\baccess denied\b/i, "auth"],
	// Deterministic request faults
	[/\binvalid[_ ]request[_ ]error\b/i, "bad_request"],
	[/\bunsupported[_ ](?:value|parameter)\b/i, "bad_request"],
	[/\bmodel[_ ]not[_ ]found\b/i, "not_found"],
	[/\binvalid model\b/i, "not_found"],
	[/\bdeployment (?:does not exist|not found)\b/i, "not_found"],
	[/\bdoes not exist or you do not have access\b/i, "not_found"],
	// Context window — retrying the identical payload cannot fit
	[/\bcontext[_ ]length[_ ]exceeded\b/i, "context_overflow"],
	[/\bmaximum context length\b/i, "context_overflow"],
	[/\bprompt is too long\b/i, "context_overflow"],
	[/\breduce the length of the messages\b/i, "context_overflow"],
	// Azure content policy — deterministic for the same payload
	[/\bcontent[_ ]filter\b/i, "content_filter"],
	[/\bresponsibleaipolicyviolation\b/i, "content_filter"],
	// Quota / credit exhaustion (terminal for the current accounting window).
	// A provider-side account gate is not transient throttling and must never be
	// presented as a tenant billing-policy decision.
	[/\bspend[_ ]limited\b/i, "billing"],
	[/\binsufficient[_ ](?:quota|credits|funds)\b/i, "quota"],
	[/\bexceeded[- ]quota\b/i, "quota"],
	[/\bout of credits\b/i, "quota"],
	[/\bnot[- ]enough[- ]credits\b/i, "quota"],
	[/\busage[_ ]limit[_ ]reached\b/i, "quota"],
	[/\bbilling[_ ]hard[_ ]limit[_ ]reached\b/i, "quota"],
	[/\b(?:free|premium|standard|basic)[- ]usage[- ]exceeded\b/i, "quota"],
	[/\bagents[- ]limit[- ]exceeded\b/i, "quota"],
];

/** Worth another attempt after a delay. */
const RETRYABLE_PATTERNS: ReadonlyArray<readonly [RegExp, ProviderErrorClass]> =
	[
		[/\bError code:\s*429\b/i, "rate_limit"],
		[/\brate[_ ]limit\b/i, "rate_limit"],
		[/\btoo many requests\b/i, "rate_limit"],
		[/\boverloaded\b/i, "overloaded"],
		[/\bservice[_ ]unavailable\b/i, "overloaded"],
		[/\bserver[_ ]error\b/i, "overloaded"],
		[/\binternal[_ ]error\b/i, "overloaded"],
		[/\bError code:\s*5\d{2}\b/i, "overloaded"],
		[/\bfetch failed\b/i, "network"],
		[/\bsocket hang up\b/i, "network"],
		[/\bconnection (?:error|reset|closed|lost|ended|refused)\b/i, "network"],
		[/\bnetwork error\b/i, "network"],
		[/\brequest timed out\b/i, "network"],
		[/\betimedout\b/i, "network"],
		[/\becconnreset\b/i, "network"],
		[/\bstream (?:closed|ended) (?:unexpectedly|without)\b/i, "network"],
		[/\bterminated\b/i, "network"],
	];

/**
 * Any 4xx other than 408/409/425/429 is deterministic. Kept as a numeric guard
 * after the literal patterns so an unrecognized provider phrasing still lands
 * on the right side of the retry decision.
 */
const HTTP_STATUS_PATTERN = /\bError code:\s*(\d{3})\b/i;
const RETRYABLE_4XX = new Set([408, 409, 425, 429]);

const DEFAULT_RETRY_MS = 1_000;
const RATE_LIMIT_RETRY_MS = 10_000;
const EDGE_5XX_RETRY_MS = 5_000;
const EMPTY_RESPONSE_RETRY_MS = 500;

/**
 * Flatten an unknown throwable into searchable text: message plus one level of
 * `cause` / `detail` / `error`, which is where AI Gateway and the Azure SDK
 * bury the provider body.
 */
export function providerErrorText(error: unknown): string {
	if (error === null || error === undefined) return "";
	if (typeof error === "string") return error;
	if (typeof error !== "object") return String(error);

	const parts: string[] = [];
	const value = error as Record<string, unknown>;
	if (error instanceof Error) parts.push(error.message);
	for (const key of ["detail", "error", "body", "responseBody", "cause"]) {
		const nested = value[key];
		if (typeof nested === "string") {
			parts.push(nested);
		} else if (nested && typeof nested === "object") {
			const message = (nested as { message?: unknown }).message;
			if (typeof message === "string") parts.push(message);
			const detail = (nested as { detail?: unknown }).detail;
			if (typeof detail === "string") parts.push(detail);
		}
	}
	if (parts.length === 0) {
		const message = value.message;
		if (typeof message === "string") parts.push(message);
	}
	return parts.join("\n");
}

/** True when the text carries a Cloudflare edge 52x signature. */
export function isCloudflareEdge5xxError(text: string): boolean {
	return EDGE_5XX_PATTERNS.some((pattern) => pattern.test(text));
}

function statusVerdict(text: string): ProviderErrorVerdict | null {
	const match = HTTP_STATUS_PATTERN.exec(text);
	if (!match?.[1]) return null;
	const status = Number.parseInt(match[1], 10);
	if (!Number.isFinite(status)) return null;
	if (status >= 400 && status < 500 && !RETRYABLE_4XX.has(status)) {
		return { retryable: false, family: "bad_request", retryAfterMs: 0 };
	}
	return null;
}

/**
 * Classify a provider/turn error.
 *
 * Order is load-bearing: non-retryable signatures are matched BEFORE retryable
 * ones so a quota-exhaustion 429 does not read as an ordinary rate limit.
 */
export function classifyProviderError(error: unknown): ProviderErrorVerdict {
	const text = providerErrorText(error);
	if (!text.trim()) {
		return {
			retryable: true,
			family: "unknown",
			retryAfterMs: DEFAULT_RETRY_MS,
		};
	}

	for (const [pattern, family] of NON_RETRYABLE_PATTERNS) {
		if (pattern.test(text))
			return { retryable: false, family, retryAfterMs: 0 };
	}

	// An empty assistant message is a real (recoverable) provider miss, not a
	// successful turn — `cron-turn-outcome.ts` already refuses to seal it.
	if (/\bempty_assistant_message\b/.test(text)) {
		return {
			retryable: true,
			family: "empty_response",
			retryAfterMs: EMPTY_RESPONSE_RETRY_MS,
		};
	}

	if (isCloudflareEdge5xxError(text)) {
		return {
			retryable: true,
			family: "edge_5xx",
			retryAfterMs: EDGE_5XX_RETRY_MS,
		};
	}

	for (const [pattern, family] of RETRYABLE_PATTERNS) {
		if (pattern.test(text)) {
			return {
				retryable: true,
				family,
				retryAfterMs:
					family === "rate_limit" ? RATE_LIMIT_RETRY_MS : DEFAULT_RETRY_MS,
			};
		}
	}

	const byStatus = statusVerdict(text);
	if (byStatus) return byStatus;

	return { retryable: true, family: "unknown", retryAfterMs: DEFAULT_RETRY_MS };
}
