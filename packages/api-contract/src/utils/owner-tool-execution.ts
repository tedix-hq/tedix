/**
 * The recorded run of an owner's approved gateway call (`mcp.tool_call`
 * requests, `payload.execution`). Approval runs the stored call once; this is
 * what the platform recorded about that run, read by the API's retry rules
 * and by Activity.
 */
export interface OwnerToolExecutionRecord {
	status: "queued" | "running" | "executed" | "failed";
	nextAttemptAt?: string;
	startedAt?: string;
	finishedAt?: string;
	/** Plain-language result for people: "Client deleted", "Scope 'x' required". */
	summary?: string;
	error?: string;
	/**
	 * A failure the platform caused (catalog lookup, transport) rather than
	 * the target refusing or changing; an owner may try the call once more.
	 */
	retryable?: boolean;
	/** 2 on the first retry an owner or admin started, and so on; absent on the first run. */
	attempt?: number;
	retriedBy?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The execution record on a request payload, or null when there is none. */
export function parseOwnerToolExecution(
	value: unknown,
): OwnerToolExecutionRecord | null {
	if (!isRecord(value)) return null;
	const { status } = value;
	if (
		status !== "queued" &&
		status !== "running" &&
		status !== "executed" &&
		status !== "failed"
	)
		return null;
	return {
		status,
		...(typeof value.nextAttemptAt === "string"
			? { nextAttemptAt: value.nextAttemptAt }
			: {}),
		...(typeof value.startedAt === "string"
			? { startedAt: value.startedAt }
			: {}),
		...(typeof value.finishedAt === "string"
			? { finishedAt: value.finishedAt }
			: {}),
		...(typeof value.summary === "string" ? { summary: value.summary } : {}),
		...(typeof value.error === "string" ? { error: value.error } : {}),
		...(typeof value.retryable === "boolean"
			? { retryable: value.retryable }
			: {}),
		...(typeof value.attempt === "number" && value.attempt >= 2
			? { attempt: value.attempt }
			: {}),
		...(typeof value.retriedBy === "string"
			? { retriedBy: value.retriedBy }
			: {}),
	};
}

/**
 * Errors that mean the platform never reached the target: the tool could not
 * be found in the gateway catalog, the gateway or the service binding was not
 * reachable, or the gateway refused before dispatch ("No side effect was
 * executed"). Read on every failed row, so a refusal the recorder marked
 * final is still recognised.
 */
const PLATFORM_SIDE_ERROR =
	/no longer available on|could not be verified on|\(transport\)|is not configured|No side effect was executed/;

/**
 * A run still marked running this long after it started never finished: the
 * request that ran it was cut off. The gateway consumes the approval before
 * it dispatches, so an unconsumed stale run had no effect.
 */
export const STALE_OWNER_TOOL_RUN_MS = 10 * 60 * 1000;

export function isStaleOwnerToolRun(
	execution: OwnerToolExecutionRecord | null | undefined,
	now = Date.now(),
): boolean {
	if (execution?.status !== "running" || !execution.startedAt) return false;
	const startedAt = Date.parse(execution.startedAt);
	return (
		Number.isFinite(startedAt) && now - startedAt > STALE_OWNER_TOOL_RUN_MS
	);
}

/**
 * Whether an execution may be tried again: the platform itself failed (or
 * the run never finished) and the target neither refused nor changed. Each
 * retry takes an owner's click; the gateway's consumed receipt, not a count,
 * is what keeps the call to one run.
 */
export function isRetryableOwnerToolExecution(
	execution: OwnerToolExecutionRecord | null | undefined,
	now = Date.now(),
): boolean {
	if (!execution) return false;
	if (execution.status === "running")
		return isStaleOwnerToolRun(execution, now);
	if (execution.status !== "failed") return false;
	// A stored `retryable: false` is not final: a gateway refusal before
	// dispatch is recognisable from its text whatever the recorder decided.
	return (
		execution.retryable === true ||
		PLATFORM_SIDE_ERROR.test(execution.error ?? "")
	);
}

/** What happened after approval, in words: "Done: …", "Failed: …", "Running now". */
export function ownerToolExecutionOutcome(
	execution: OwnerToolExecutionRecord | null | undefined,
	now = Date.now(),
): string | null {
	if (!execution) return null;
	if (execution.status === "queued")
		return "Queued: waiting for the tool limit; Tedix will retry automatically";
	if (execution.status === "executed")
		return `Done${execution.summary ? `: ${execution.summary}` : ""}`;
	if (execution.status === "failed")
		return `Failed${execution.error ? `: ${execution.error}` : ""}`;
	return isStaleOwnerToolRun(execution, now)
		? "Did not finish: the run was cut off before it reached the target"
		: "Running now";
}
