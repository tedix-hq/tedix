import { scrubText } from "@tedix/context-core/trace-safety";
import { asRecord } from "@tedix/api-contract/utils/is-record";

function sanitizeJobError(value: string): string {
	return value
		.replace(/\bprocesses\b/gi, "jobs")
		.replace(/\bprocess\b/gi, "job");
}

/**
 * The workstation adapter is process-backed, but process identity and raw
 * runner metadata are private implementation details. Public job receipts use
 * job ids and job lifecycle names only.
 */
function sanitizePublicWorkstationJobValue(value: unknown): unknown {
	if (Array.isArray(value))
		return value.map((item) => sanitizePublicWorkstationJobValue(item));
	const record = asRecord(value);
	if (!record) return value;

	const sanitized: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(record)) {
		if (key === "processId" || key === "process") continue;
		sanitized[key] =
			typeof item === "string" && key === "error"
				? sanitizeJobError(item)
				: key === "eventType" &&
					  typeof item === "string" &&
					  item.startsWith("workstation.process.")
					? item.replace("workstation.process.", "workstation.job.")
					: sanitizePublicWorkstationJobValue(item);
	}
	return sanitized;
}

export function sanitizePublicWorkstationJobReceipt(value: unknown): unknown {
	const sanitized = asRecord(sanitizePublicWorkstationJobValue(value));
	if (!sanitized) return sanitizePublicWorkstationJobValue(value);

	const job = asRecord(sanitized.job);
	if (!job) return sanitized;

	const { job: _redundantJobWrapper, ...receipt } = sanitized;
	return {
		...receipt,
		...job,
	};
}

const PUBLIC_JOB_READ_RECEIPT_KEYS = [
	"ok",
	"found",
	"error",
	"retryable",
	"running",
	"terminal",
	"exitCode",
	"canceled",
	"canceledAt",
	"timeoutMs",
	"timedOut",
	"timedOutAt",
	"startedAt",
	"endedAt",
	"stdoutBytes",
	"stderrBytes",
	"stdoutTruncated",
	"stderrTruncated",
	"stdoutTail",
	"stderrTail",
	"artifactRefs",
	"artifactWriteStatus",
	"artifactRowPersistence",
] as const;

const MODEL_JOB_LOG_TAIL_CHAR_LIMIT = 8_000;

/** Keep the actionable HTTP error, never the adapter's unrestricted body. */
function compactJobFailure(
	value: Record<string, unknown>,
): Record<string, unknown> {
	if (value.ok !== false) return {};
	const body = asRecord(value.body);
	const error =
		typeof body?.error === "string" && body.error.trim()
			? body.error
			: value.error;
	const status = value.status ?? body?.status;
	const retryable = body?.retryable ?? value.retryable;
	return {
		...(typeof error === "string"
			? { error: scrubText(sanitizeJobError(error)).slice(0, 2_000) }
			: {}),
		...(typeof status === "number" &&
		Number.isInteger(status) &&
		status >= 400 &&
		status <= 599
			? { status }
			: {}),
		...(typeof retryable === "boolean" ? { retryable } : {}),
		// The tedi-runtime request stopped waiting; the job itself was not
		// touched. Keep the marker so the exec tool returns a running receipt.
		...(value.requestTimedOut === true
			? {
					requestTimedOut: true,
					...(typeof value.waitedMs === "number"
						? { waitedMs: value.waitedMs }
						: {}),
				}
			: {}),
	};
}

function compactLogTail(value: unknown): unknown {
	if (
		typeof value !== "string" ||
		value.length <= MODEL_JOB_LOG_TAIL_CHAR_LIMIT
	)
		return value;
	const tail = value.slice(-MODEL_JOB_LOG_TAIL_CHAR_LIMIT);
	return `[Truncated: showing last ${tail.length} of ${value.length} chars; use artifactRefs for complete logs]\n${tail}`;
}

/**
 * Starting a job only needs to hand the model a stable polling handle and a
 * small amount of scheduling state. The adapter response also contains the
 * full workstation, lease, repo-sync, tool, and evidence projections; echoing
 * those through Code Mode can consume the entire model-facing result budget
 * before the caller sees the job id it must poll.
 */
/** Keep terminal state and evidence locators while removing adapter envelopes. */
export function compactPublicWorkstationJobReadReceipt(
	value: unknown,
): Record<string, unknown> {
	const sanitized = asRecord(sanitizePublicWorkstationJobReceipt(value));
	if (!sanitized) return {};

	const receipt: Record<string, unknown> = {};
	for (const key of PUBLIC_JOB_READ_RECEIPT_KEYS) {
		if (sanitized[key] === undefined) continue;
		receipt[key] =
			key === "stdoutTail" || key === "stderrTail"
				? compactLogTail(sanitized[key])
				: sanitized[key];
	}
	if (
		sanitized.observation === "unavailable" ||
		sanitized.observation === "generation_replaced"
	) {
		receipt.observation = sanitized.observation;
	}
	return { ...receipt, ...compactJobFailure(sanitized) };
}
