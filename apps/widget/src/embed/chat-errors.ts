import type { Translate } from "@tedix/widget-i18n";
/**
 * One taxonomy for embedded chat failures: the code telemetry records and the
 * sentence the customer reads, derived from the same match.
 *
 * These lived as two sibling closures in `embed.mjs` that each re-implemented
 * the abort check and the capacity regex. Nothing kept them agreeing, so the
 * pair could drift into telling the customer one thing and analytics another —
 * and neither had any test, in a file whose only coverage is source-text
 * assertions.
 *
 * The drift that mattered most was silent: every rule here matches on runtime
 * MESSAGE TEXT, so an upstream reword does not fail anything. It just falls
 * through to `runtime_error`, and the `failed` milestone's `errorCode` and the
 * `answer-failed` event's `code` quietly stop distinguishing a billing stop
 * from an expired session. The table below is the thing to keep in sync with
 * the runtime, and the tests are what make a reword visible.
 */

/** Codes the embed reports for a failed turn. Ordered most specific first. */
export type ChatErrorCode =
	| "aborted"
	| "inference_capacity_exhausted"
	| "runtime_interrupted"
	| "session_expired"
	| "stream_ended_before_completion"
	| "stream_unavailable"
	| "runtime_error";

interface ChatErrorRule {
	code: ChatErrorCode;
	/** Matched against the error's message; `null` for non-message rules. */
	pattern: RegExp | null;
	/** Catalog key for the sentence the customer reads. */
	copy: string;
}

const ABORTED: ChatErrorRule = {
	code: "aborted",
	pattern: null,
	copy: "error_request_stopped",
};

const FALLBACK: ChatErrorRule = {
	code: "runtime_error",
	pattern: null,
	copy: "error_generic",
};

/**
 * Message-matched rules, most specific first.
 *
 * Only the capacity case has ever had its own customer copy; the rest are
 * distinct for telemetry but read as the generic failure, which is deliberate —
 * "your session expired" is not something a customer of the host site can act
 * on. Keeping them in one table means adding copy later cannot desynchronise
 * from the code.
 */
const MESSAGE_RULES: readonly ChatErrorRule[] = [
	{
		code: "runtime_interrupted",
		pattern: /durable object reset because its code was updated/i,
		copy: "error_service_update",
	},
	{
		code: "inference_capacity_exhausted",
		pattern:
			/inference_capacity_exhausted|inference blocked by billing policy|inference daily budget exhausted|daily inference (?:token )?budget exhausted/i,
		copy: "error_capacity",
	},
	{
		code: "session_expired",
		pattern: /session expired/i,
		copy: FALLBACK.copy,
	},
	{
		code: "stream_ended_before_completion",
		pattern: /subscription ended before completion/i,
		copy: FALLBACK.copy,
	},
	{
		code: "stream_unavailable",
		pattern: /stream_unavailable/i,
		copy: FALLBACK.copy,
	},
];

function isAbort(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error || "");
}

/** The single decision both public helpers read. */
function matchChatError(error: unknown): ChatErrorRule {
	if (isAbort(error)) return ABORTED;
	const message = errorMessage(error);
	return (
		MESSAGE_RULES.find((rule) => rule.pattern?.test(message) === true) ??
		FALLBACK
	);
}

export function classifyChatError(error: unknown): ChatErrorCode {
	return matchChatError(error).code;
}

export function userFacingChatError(error: unknown, t: Translate): string {
	return t(matchChatError(error).copy);
}

/**
 * The runtime's quota refusal says when the hour rolls over, both as a
 * `retryAfterSeconds` frame field and inside the message ("retry in 1234s").
 * The transport forwards only the message, so the wait is read from the text;
 * a field on the error wins when a caller attached one.
 */
export function chatErrorRetryAfterSeconds(error: unknown): number | undefined {
	if (matchChatError(error).code !== "inference_capacity_exhausted")
		return undefined;
	const field =
		error && typeof error === "object"
			? (error as { retryAfterSeconds?: unknown }).retryAfterSeconds
			: undefined;
	if (typeof field === "number" && Number.isFinite(field) && field > 0)
		return Math.ceil(field);
	const match = /retry in (\d+)s\b/i.exec(errorMessage(error));
	if (!match) return undefined;
	const seconds = Number(match[1]);
	return seconds > 0 ? seconds : undefined;
}

/** Capacity copy that names the wait: whole minutes past one, else seconds. */
export function capacityRetryCopy(secondsLeft: number, t: Translate): string {
	const seconds = Math.max(0, Math.ceil(secondsLeft));
	if (seconds === 0) return t("error_capacity_retry_now");
	if (seconds > 60)
		return t("error_capacity_retry_minutes", {
			minutes: Math.ceil(seconds / 60),
		});
	return t("error_capacity_retry_seconds", { seconds });
}

/**
 * Count a retry-after down once a second. `onTick` receives the remaining
 * whole seconds (never zero); `onExpire` fires once when the wait is over.
 * Returns a stop function for teardown; stopping never fires `onExpire`.
 */
export function startRetryCountdown(
	seconds: number,
	hooks: { onTick(secondsLeft: number): void; onExpire(): void },
	clock: { now(): number } = Date,
): () => void {
	const deadline = clock.now() + Math.max(0, seconds) * 1000;
	let timer: ReturnType<typeof setInterval> | undefined;
	const tick = () => {
		const left = Math.ceil((deadline - clock.now()) / 1000);
		if (left > 0) {
			hooks.onTick(left);
			return;
		}
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
		hooks.onExpire();
	};
	tick();
	if (clock.now() < deadline) timer = setInterval(tick, 1000);
	return () => {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
	};
}
