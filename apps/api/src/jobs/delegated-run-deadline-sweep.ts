import type { KernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import type { BaseContext } from "../rpc/orpc";
import { safeExceptionTopology } from "../lib/safe-log-metadata";

/** Rows one pass re-reads; a backlog drains over consecutive two-minute ticks. */
export const DELEGATED_RUN_DEADLINE_SWEEP_LIMIT = 50;

export type DelegatedRunDeadlineSweepResult = {
	delegatedRunsChecked: number;
	delegatedRunsSettled: number;
	delegatedRunOrganizations: number;
	delegatedRunSweepErrors: number;
};

/**
 * Two-minute pass over delegated Home runs that are still queued or running
 * but that nobody has read for a while. It runs the same on-read reconcile
 * the conversation views use, so a child that never published events ends
 * as a dispatch failure after its confirmed quiet window, and a child that
 * outlived its delegation deadline plus grace ends as a stall, each with the
 * reason the person would see on the next read.
 *
 * Why a sweep: both verdicts previously fired only inside a read. A person
 * who closed the thread after delegating (the normal case for a background
 * task) left the row "running" until someone opened it again; live rows from
 * 29 Oct 2026 were still shown as running a week later.
 */
export async function sweepDelegatedRunDeadlines(
	env: CloudflareEnv,
	scheduledTime: number,
): Promise<DelegatedRunDeadlineSweepResult> {
	const counts: DelegatedRunDeadlineSweepResult = {
		delegatedRunsChecked: 0,
		delegatedRunsSettled: 0,
		delegatedRunOrganizations: 0,
		delegatedRunSweepErrors: 0,
	};
	const { createDbClient } = await import("@tedix/db/client");
	const { listQuietDelegatedRuns } =
		await import("@tedix/db/queries/kernel-runtime-runs");
	const { KERNEL_DELEGATE_FIRST_EVENT_TIMEOUT_MS } =
		await import("../rpc/routers/kernel/delegation-work-item");
	const { readChildRunStatusesForRunRows } =
		await import("../rpc/routers/kernel/home-plan");
	const { reconcileHomeRunRowsFromChildStatus } =
		await import("../rpc/routers/kernel/run-store-reconciliation");
	const db = createDbClient(env.DB);
	const rows = await listQuietDelegatedRuns(db, {
		before: new Date(
			scheduledTime - KERNEL_DELEGATE_FIRST_EVENT_TIMEOUT_MS,
		).toISOString(),
		limit: DELEGATED_RUN_DEADLINE_SWEEP_LIMIT,
	});
	counts.delegatedRunsChecked = rows.length;
	const byOrganization = new Map<string, KernelRuntimeRun[]>();
	for (const row of rows) {
		const group = byOrganization.get(row.organizationId) ?? [];
		group.push(row);
		byOrganization.set(row.organizationId, group);
	}
	counts.delegatedRunOrganizations = byOrganization.size;
	// The reconcile writers only touch `context.db` and `context.env`; the
	// scheduled tick has no request, so a db-only context is the honest shape.
	const context = { db, env } as unknown as BaseContext;
	for (const [organizationId, group] of byOrganization) {
		try {
			const { childRunStatuses, unavailableChildRunKeys } =
				await readChildRunStatusesForRunRows(context, group);
			const reconciled = await reconcileHomeRunRowsFromChildStatus(context, {
				childRunStatuses,
				unavailableChildRunKeys,
				rows: group,
			});
			counts.delegatedRunsSettled += reconciled.filter(
				(row) =>
					row.status === "completed" ||
					row.status === "failed" ||
					row.status === "canceled",
			).length;
		} catch (error) {
			counts.delegatedRunSweepErrors++;
			console.warn("[Scheduled] delegated-run deadline sweep failed", {
				organizationId,
				runIds: group.map((row) => row.id).slice(0, 10),
				exception: safeExceptionTopology(error),
			});
		}
	}
	if (counts.delegatedRunsChecked > 0)
		console.log("[Scheduled] delegated-run deadline sweep", counts);
	return counts;
}
