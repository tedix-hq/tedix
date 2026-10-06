/**
 * Kernel — home-plan status projection. Normalizes persisted HomePlan route
 * kinds, maps plan/assignment/child statuses onto run and work-item states, and
 * reads child-run statuses plus terminal child outcomes for parent runs. This
 * module must NOT import kernel-runtime.ts (the router imports this module; a
 * value import back would create a cycle).
 */

import type { TediRunStatus } from "@tedix/api-contract/schemas/cognitive-runtime";
import type {
	HomeChildRunEvidence,
	HomePlan,
} from "@tedix/api-contract/schemas/kernel-runtime";
import { HomePlanSchema } from "@tedix/api-contract/schemas/kernel-runtime";
import type { kernelRuntimeRuns } from "@tedix/db/schema/cognitive-runtime";
import { terminalChildOutcomeFromStatus } from "../../../kernel/progress-ledger";
import type { BaseContext } from "../../orpc";
import {
	readChildRunEvidenceRows,
	summarizeChildRuntimeEvents,
} from "./child-run-reads";
import { delegationVerifyCommand } from "./delegated-stop";
import { isWorkstationDispatchedRunRow } from "./delegation-work-item";
import {
	childRunStatusKey,
	delegatedChildSteerRunId,
	isTerminalHomeRunStatus,
	nonNullRecord,
} from "./runtime-shared";

export function readOptionalHomePlanFromRun(
	row: typeof kernelRuntimeRuns.$inferSelect,
): HomePlan | null {
	const metadata = nonNullRecord(row.metadata);
	const parsed = HomePlanSchema.safeParse(metadata?.homePlan);
	return parsed.success ? parsed.data : null;
}

export function approvedHomePlanStatus(plan: HomePlan): HomePlan["status"] {
	const requiredAssignments = plan.assignments.filter(
		(assignment) => assignment.required,
	);
	if (
		plan.assignments.some((assignment) =>
			["queued", "running"].includes(assignment.status),
		)
	) {
		return "dispatching";
	}
	if (
		requiredAssignments.some((assignment) =>
			["failed", "canceled"].includes(assignment.status),
		)
	) {
		return "failed";
	}
	const allBranchesTerminal = plan.assignments.every((assignment) =>
		["completed", "failed", "canceled"].includes(assignment.status),
	);
	const requiredBranchesCompleted = requiredAssignments.every(
		(assignment) => assignment.status === "completed",
	);
	if (
		plan.assignments.length > 0 &&
		allBranchesTerminal &&
		requiredBranchesCompleted
	) {
		return "completed";
	}
	if (
		plan.assignments.some((assignment) =>
			["approved", "completed"].includes(assignment.status),
		)
	) {
		return "approved";
	}
	return "proposed";
}

export function homeRunStatusFromPlanStatus(
	status: HomePlan["status"],
): TediRunStatus {
	switch (status) {
		case "completed":
			return "completed";
		case "failed":
			return "failed";
		case "canceled":
			return "canceled";
		case "dispatching":
			return "running";
		case "proposed":
			return "requires_approval";
		case "approved":
			return "queued";
	}
}

export function planAssignmentStatusFromChildStatus(
	status: HomeChildRunEvidence["status"],
): HomePlan["assignments"][number]["status"] {
	switch (status) {
		case "completed":
			return "completed";
		case "partial":
		case "failed":
			return "failed";
		case "canceled":
			return "canceled";
		case "running":
		case "streaming":
		case "requires_approval":
			return "running";
		case "queued":
			return "queued";
	}
}

export function workItemStatusFromPlanAssignmentStatus(
	status: HomePlan["assignments"][number]["status"],
) {
	switch (status) {
		case "completed":
			return "done";
		case "failed":
			return "blocked";
		case "canceled":
			return "cancelled";
		case "running":
			return "in_progress";
		case "queued":
		case "approved":
			return "accepted";
		case "proposed":
			return "candidate";
	}
}

export async function readChildRunStatusesForRunRows(
	context: BaseContext,
	rows: Array<typeof kernelRuntimeRuns.$inferSelect>,
): Promise<Map<string, Record<string, unknown>>> {
	const refs = new Map<
		string,
		{
			workstationDispatch: boolean;
			runId: string;
			tediId: string;
			verifyCommand?: string | null;
		}
	>();
	for (const row of rows) {
		// Terminal parent rows (completed/failed/canceled) have their child-run
		// evidence already persisted via reconcileHomeRunRowsFromChildStatus
		// (preview, latestEventAt, latestEventKind, metadata.childRunStatus).
		// Re-querying live child events for them is O(N) unnecessary work that
		// makes heavy conversations time out. normalizeHomeRunRecord falls back
		// to the persisted row fields when childRunStatus is absent.
		if (row.delegatedTediId && row.childRunId) {
			if (!isTerminalHomeRunStatus(row.status as TediRunStatus)) {
				refs.set(childRunStatusKey(row.delegatedTediId, row.childRunId), {
					workstationDispatch: isWorkstationDispatchedRunRow(row),
					runId: row.childRunId,
					tediId: row.delegatedTediId,
					verifyCommand: delegationVerifyCommand(row.metadata),
				});
			}
		}
		const steerRunId = delegatedChildSteerRunId(row);
		if (row.delegatedTediId && steerRunId) {
			refs.set(childRunStatusKey(row.delegatedTediId, steerRunId), {
				workstationDispatch: false,
				runId: steerRunId,
				tediId: row.delegatedTediId,
			});
		}
		const homePlan = readOptionalHomePlanFromRun(row);
		for (const assignment of homePlan?.assignments ?? []) {
			if (!assignment.ownerTediId || !assignment.childRunId) continue;
			// Skip terminal plan assignments — their status is persisted in the
			// assignment record itself; only active assignments need live evidence.
			if (
				assignment.status === "completed" ||
				assignment.status === "failed" ||
				assignment.status === "canceled"
			) {
				continue;
			}
			refs.set(
				childRunStatusKey(assignment.ownerTediId, assignment.childRunId),
				{
					workstationDispatch: false,
					runId: assignment.childRunId,
					tediId: assignment.ownerTediId,
				},
			);
		}
	}
	const statuses = new Map<string, Record<string, unknown>>();
	await Promise.all(
		[...refs.entries()].map(async ([key, ref]) => {
			try {
				const { eventRows: childRows, observedRunIds } =
					await readChildRunEvidenceRows(context, {
						artifactLimit: 0,
						eventLimit: 25,
						includeMappedWorkstationRun: ref.workstationDispatch,
						runId: ref.runId,
						tediId: ref.tediId,
					});
				const status = summarizeChildRuntimeEvents(childRows, {
					verifyCommand: ref.verifyCommand ?? null,
				});
				if (status) {
					statuses.set(key, {
						...status,
						childRunObservedRunIds: observedRunIds,
					});
				}
			} catch (error) {
				console.warn("[kernelRuntime] child run-set status read failed", {
					error: error instanceof Error ? error.message : String(error),
					runId: ref.runId,
					tediId: ref.tediId,
				});
			}
		}),
	);
	return statuses;
}

/**
 * For delegation PARENT run rows, the terminal failure outcome of each parent's
 * CHILD run (failed/canceled only), keyed by PARENT runId — for the kernel
 * reconcile backstop that propagates a dead child to a parent the fail-soft,
 * event-driven reconcileChildStatus missed. Reuses readChildRunStatusesForRunRows
 * (which already resolves the workstation child-run id mapping); a child that
 * completed or is still live is omitted (the normal path owns it / it's running).
 */
export async function readTerminalChildOutcomesForParents(
	context: BaseContext,
	rows: Array<typeof kernelRuntimeRuns.$inferSelect>,
): Promise<Map<string, "failed" | "canceled">> {
	const statuses = await readChildRunStatusesForRunRows(context, rows);
	const out = new Map<string, "failed" | "canceled">();
	for (const row of rows) {
		if (!row.delegatedTediId || !row.childRunId) continue;
		const status = statuses.get(
			childRunStatusKey(row.delegatedTediId, row.childRunId),
		);
		const outcome = terminalChildOutcomeFromStatus(status?.childRunStatus);
		if (outcome) out.set(row.id, outcome);
	}
	return out;
}
