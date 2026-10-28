/**
 * The recorded run of an owner's approved gateway call (`mcp.tool_call`
 * requests, `payload.execution`). Approval runs the stored call once; this is
 * what the platform recorded about that run, read by the API's retry rules
 * and by Activity.
 */
export interface OwnerToolExecutionRecord {
	status: "running" | "executed" | "failed";
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
	/** Set on the one retry an owner or admin started; absent on the first run. */
	attempt?: 2;
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
	if (status !== "running" && status !== "executed" && status !== "failed")
		return null;
	return {
		status,
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
		...(value.attempt === 2 ? { attempt: 2 } : {}),
		...(typeof value.retriedBy === "string"
			? { retriedBy: value.retriedBy }
			: {}),
	};
}

/**
 * Errors that mean the platform never reached the target: the tool could not
 * be found in the gateway catalog, the gateway or the service binding was not
 * reachable. Used only for rows recorded before `retryable` was stored.
 */
const PLATFORM_SIDE_ERROR =
	/no longer available on|could not be verified on|\(transport\)|is not configured/;

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
 * Whether an execution may be tried once more: the platform itself failed
 * (or the run never finished), the target neither refused nor changed, and
 * no completed retry exists yet.
 */
export function isRetryableOwnerToolExecution(
	execution: OwnerToolExecutionRecord | null | undefined,
	now = Date.now(),
): boolean {
	if (!execution) return false;
	if (execution.status === "running")
		return isStaleOwnerToolRun(execution, now);
	if (execution.status !== "failed") return false;
	if (execution.attempt !== undefined) return false;
	if (typeof execution.retryable === "boolean") return execution.retryable;
	return PLATFORM_SIDE_ERROR.test(execution.error ?? "");
}

/** What happened after approval, in words: "Done: …", "Failed: …", "Running now". */
export function ownerToolExecutionOutcome(
	execution: OwnerToolExecutionRecord | null | undefined,
	now = Date.now(),
): string | null {
	if (!execution) return null;
	if (execution.status === "executed")
		return `Done${execution.summary ? `: ${execution.summary}` : ""}`;
	if (execution.status === "failed")
		return `Failed${execution.error ? `: ${execution.error}` : ""}`;
	return isStaleOwnerToolRun(execution, now)
		? "Did not finish: the run was cut off before it reached the target"
		: "Running now";
}
