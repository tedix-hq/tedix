import type { KernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import { nonNullRecord } from "./runtime-shared";

/**
 * The child runtime aborts inference and tools at its own deadline and then
 * commits its stop within seconds. A child still non-terminal this long after
 * the Home deadline lost its turn (eviction, lost continuation, dropped retry).
 */
export const DELEGATED_CHILD_STALL_GRACE_MS = 5 * 60_000;

const TERMINAL_CHILD_STATUSES = new Set([
	"completed",
	"partial",
	"failed",
	"canceled",
]);

function delegationDeadlineMs(row: KernelRuntimeRun): number | null {
	const metadata = nonNullRecord(row.metadata);
	const order = nonNullRecord(metadata?.delegationWorkOrder);
	const budget =
		nonNullRecord(order?.budget) ?? nonNullRecord(metadata?.delegationBudget);
	const deadlineMs = budget?.deadlineMs;
	return typeof deadlineMs === "number" && deadlineMs > 0 ? deadlineMs : null;
}

/**
 * A child summary rewritten as failed once a non-terminal child has outlived
 * its delegation deadline plus grace, so the normal terminal reconcile settles
 * Home, the Work Item and the completion message. Null when the child is fine.
 */
export function stalledChildRunStatus(
	row: KernelRuntimeRun,
	childRunStatus: Record<string, unknown>,
	now = Date.now(),
): Record<string, unknown> | null {
	if (
		typeof childRunStatus.childRunStatus === "string" &&
		TERMINAL_CHILD_STATUSES.has(childRunStatus.childRunStatus)
	)
		return null;
	const deadlineMs = delegationDeadlineMs(row);
	if (deadlineMs === null) return null;
	const startedMs = Date.parse(row.startedAt ?? row.createdAt);
	if (!Number.isFinite(startedMs)) return null;
	if (now < startedMs + deadlineMs + DELEGATED_CHILD_STALL_GRACE_MS)
		return null;
	const at = new Date(now).toISOString();
	const minutes = Math.round(deadlineMs / 60_000);
	const lastSeen =
		typeof childRunStatus.childRunLatestEventAt === "string"
			? ` Its last activity was at ${childRunStatus.childRunLatestEventAt}.`
			: "";
	return {
		...childRunStatus,
		childRunStatus: "failed",
		childRunPreview: `The tedi stopped responding and did not finish within its ${minutes}-minute limit.${lastSeen} Retry the request.`,
		childRunTerminalAt: at,
		childRunTerminalEventKind: "run.failed",
		childRunLatestEventKind: "run.failed",
		childRunLatestEventAt: at,
	};
}
