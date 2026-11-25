import { coreQueryDb } from "@tedix/db/core-store/scope";
import { claimWorkDue, releaseWorkDue } from "@tedix/db/queries/work-due";
import { WORK_DUE_KINDS, type WorkDueKind } from "@tedix/db/schema/work-due";

type Track = (
	kind: WorkDueKind,
	run: () => Promise<Record<string, number>>,
) => Promise<void>;

/** No object-table discovery on the tick: each handler receives only claimed ids. */
export async function dispatchWorkDue(
	env: CloudflareEnv,
	scheduledTime: number,
	track: Track,
) {
	const db = coreQueryDb(env);
	const now = new Date(scheduledTime).toISOString();
	const rows = await claimWorkDue(
		db,
		now,
		new Date(Date.now() + 300_000).toISOString(),
	);
	for (const kind of WORK_DUE_KINDS) {
		const claimed = rows.filter((row) => row.kind === kind);
		await track(kind, async () => {
			if (!claimed.length) return { due: 0 };
			const ids = claimed.map((row) => row.objectId);
			let retire = false;
			const unprocessed = new Set<string>();
			try {
				switch (kind) {
					case "lane-stale":
					case "outbound-review":
					case "stale-delegation":
					case "uncontracted-child":
					case "repository-observer": {
						if (kind === "repository-observer" && !env.TEDI_SERVICE)
							return { deferred: ids.length };
						const { dispatchMaintenanceDue } =
							await import("./work-maintenance-due");
						const result = await dispatchMaintenanceDue(
							env,
							kind,
							scheduledTime,
							claimed,
						);
						retire = kind === "lane-stale";
						return result;
					}
					case "approval-expiry":
						return await (
							await import("./approval-expiry")
						).expireOverdueApprovals(env, ids);
					case "work-approval-redrive": {
						if (!env.TEDI_SERVICE) return { deferred: ids.length };
						const result = await (
							await import("./work-approval-redrive")
						).dispatchWorkApprovalRedrives(env, scheduledTime, ids);
						// Expired proposals have no more redrives; later edits recreate their timer.
						retire = result.observed === 0;
						return result;
					}
					case "interaction-review-dispatch":
						return await (
							await import("./interaction-follow-through")
						).dispatchInteractionReviews(env, scheduledTime, ids);
					case "delegated-run-deadline-sweep":
						return await (
							await import("./delegated-run-deadline-sweep")
						).sweepDelegatedRunDeadlines(env, scheduledTime, ids);
					case "agent-run-supervision":
						return env.TEDI_SERVICE
							? await (
									await import("./agent-run-supervision")
								).dispatchAgentRunSupervision(
									env,
									scheduledTime,
									ids,
									(pending) => {
										for (const id of pending) unprocessed.add(id);
									},
								)
							: { deferred: ids.length };
					case "orphan-run-sweep":
						return await (
							await import("./platform-tick")
						).sweepOrphanRunsTick(env, ids);
					case "work-attempt-lease-sweep":
						return await (
							await import("./work-attempt-lease-sweeper")
						).runWorkAttemptLeaseSweeperTick(env, scheduledTime, ids);
				}
			} finally {
				// Live objects which did not settle are rechecked next tick. Object
				// mutations replace/delete their row atomically and win this CAS.
				await releaseWorkDue(
					db,
					claimed.filter((row) => !unprocessed.has(row.objectId)),
					new Date(scheduledTime + 120_000).toISOString(),
					retire,
				);
				// Skipped supervisors retain their place ahead of the next-round timers.
				for (const row of claimed.filter((row) =>
					unprocessed.has(row.objectId),
				))
					await releaseWorkDue(db, [row], row.dueAt);
			}
		});
	}
	return { due: rows.length };
}
