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
 * Whether a failed execution may be tried once more: the platform itself
 * failed, the target neither refused nor changed, and nobody retried yet.
 */
export function isRetryableOwnerToolExecution(
	execution: OwnerToolExecutionRecord | null | undefined,
): boolean {
	if (!execution || execution.status !== "failed") return false;
	if (execution.attempt !== undefined) return false;
	if (typeof execution.retryable === "boolean") return execution.retryable;
	return PLATFORM_SIDE_ERROR.test(execution.error ?? "");
}

/** What happened after approval, in words: "Done: …", "Failed: …", "Running now". */
export function ownerToolExecutionOutcome(
	execution: OwnerToolExecutionRecord | null | undefined,
): string | null {
	if (!execution) return null;
	if (execution.status === "executed")
		return `Done${execution.summary ? `: ${execution.summary}` : ""}`;
	if (execution.status === "failed")
		return `Failed${execution.error ? `: ${execution.error}` : ""}`;
	return "Running now";
}
