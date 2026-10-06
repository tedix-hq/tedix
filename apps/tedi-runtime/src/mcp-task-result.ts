import { isEphemeralSessionKey } from "@tedix/api-contract/utils/runtime-identity";
import { clientSupportsTasks } from "@tedix/mcp-shared/tasks";
import { isRecord } from "@tedix/api-contract/utils/is-record";

/**
 * Per-tool adapter for the protocol-native 2026-07-28 Tasks envelope.
 *
 * The admission rule: a tool may only carry an adapter when the id
 * in `idField` is a runId the mounted `taskHandlers` projection can actually
 * serve — `buildDirectTediTaskHandlers.get()` resolves task ids ONLY against
 * THIS tedi's runtime-event ledger (`listRuntimeEvents({ runId })`, tediId-
 * scoped). A task envelope pointing at an unpollable id is worse than none.
 *
 * Audited and DEFERRED (ids the projection cannot serve today):
 * - `send_tedi_message` — the mesh result drops the peer's run_id/pending, and
 *   a peer run id lives in the PEER tedi's ledger, outside this projection.
 * - `run_durable_code` — paused results carry a Code Mode executionId; ledger
 *   events land under a DO-internal runId the mount cannot reconstruct.
 * - `exec` — returns a jobId served only by
 *   `read_execution`, not the runtime-event ledger.
 * - `repo_commit` — returns approval/execution-ledger ids, not runtime runIds.
 */
export interface TediTaskResultAdapter {
	/** Result field that must be exactly `true` while work is still in flight. */
	pendingFlagField: string;
	/** Result field carrying the ledger-pollable runtime runId. */
	idField: string;
	/** Suggested host poll cadence; defaults to 2 500 ms. */
	pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 2_500;

/**
 * Build the protocol-native 2026-07-28 Tasks result for a long-running tool
 * call. Returns the flat `resultType:"task"` envelope — pollable via the
 * mounted `taskHandlers` — when the adapter's pending flag is set AND the
 * caller declared the tasks extension. Returns null for a synchronous result,
 * a result without a usable id, or a caller that did not opt into tasks; the
 * tool then returns its normal result.
 */
export function nativeTediTaskResult(
	value: unknown,
	meta: unknown,
	adapter: TediTaskResultAdapter,
): Record<string, unknown> | null {
	if (!isRecord(value)) return null;
	if (value[adapter.pendingFlagField] !== true) return null;
	const taskId = value[adapter.idField];
	if (typeof taskId !== "string" || taskId.length === 0) return null;
	if (!clientSupportsTasks(meta)) return null;
	const now = new Date().toISOString();
	return {
		resultType: "task",
		taskId,
		status: "working",
		createdAt: now,
		lastUpdatedAt: now,
		ttlMs: null,
		pollIntervalMs: adapter.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
	};
}

/**
 * `run_tedi_turn`: a durable direct turn returns `{ pending: true, run_id }`
 * while the CHAT_TURN_WORKFLOW is still running; `run_id` is a runtime-ledger
 * runId in THIS tedi's ledger, so tasks/get can serve it.
 */
export const MESSAGES_SEND_TASK_ADAPTER: TediTaskResultAdapter = {
	pendingFlagField: "pending",
	idField: "run_id",
};

/**
 * Task envelope for a durable direct turn (`run_tedi_turn` while the turn is
 * still running). Thin wrapper over `nativeTediTaskResult` with the
 * `run_tedi_turn` adapter — kept as the named mount entry point.
 *
 * Replaces the former compatibility path (a `structuredContent.task` linkage
 * rewritten to native by a `resultTransform`).
 */
export function nativeDirectTediTaskResult(
	value: unknown,
	meta: unknown,
): Record<string, unknown> | null {
	if (
		isRecord(value) &&
		typeof value.session_key === "string" &&
		isEphemeralSessionKey(value.session_key)
	)
		return null;
	return nativeTediTaskResult(value, meta, MESSAGES_SEND_TASK_ADAPTER);
}
