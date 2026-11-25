import { coreQueryDb } from "@tedix/db/core-store/scope";
import type { WorkDueRow } from "@tedix/db/queries/work-due";

type MaintenanceDueKind =
	| "lane-stale"
	| "outbound-review"
	| "stale-delegation"
	| "uncontracted-child"
	| "repository-observer";

/** Each canonical lookup keeps both the organization and the claimed object IDs. */
export async function dispatchMaintenanceDue(
	env: CloudflareEnv,
	kind: MaintenanceDueKind,
	scheduledTime: number,
	rows: WorkDueRow[],
): Promise<Record<string, number>> {
	const db = coreQueryDb(env);
	const now = new Date(scheduledTime).toISOString();
	const groups = new Map<string, string[]>();
	for (const row of rows) {
		const ids = groups.get(row.orgId) ?? [];
		ids.push(row.objectId);
		groups.set(row.orgId, ids);
	}
	const counts: Record<string, number> = {};
	for (const [orgId, ids] of groups) {
		const scope = { orgId, ids };
		let result: Record<string, number>;
		switch (kind) {
			case "lane-stale": {
				const { recordStaleLanes } =
					await import("@tedix/db/queries/work-items/lane-lifecycle");
				result = { lanesStale: await recordStaleLanes(db, now, scope) };
				break;
			}
			case "outbound-review": {
				const { sweepStuckOutboundReviews } =
					await import("@tedix/db/queries/work-items/outbound");
				result = await sweepStuckOutboundReviews(db, {
					now,
					limit: ids.length,
					scope,
				});
				break;
			}
			case "stale-delegation": {
				const { sweepStaleFailedDelegationWorkItems } =
					await import("@tedix/db/queries/work-items/stale-delegation-sweep");
				result = {
					...(await sweepStaleFailedDelegationWorkItems(db, {
						now,
						limit: ids.length,
						scope,
					})),
				};
				break;
			}
			case "uncontracted-child": {
				const { sweepUncontractedChildWorkItems } =
					await import("@tedix/db/queries/work-items/stale-delegation-sweep");
				result = {
					...(await sweepUncontractedChildWorkItems(db, {
						now,
						limit: ids.length,
						scope,
					})),
				};
				break;
			}
			case "repository-observer": {
				const { maintainRepositoryObservers } =
					await import("./repository-observer");
				result = await maintainRepositoryObservers(env, scope);
				break;
			}
		}
		for (const [key, value] of Object.entries(result))
			counts[key] = (counts[key] ?? 0) + value;
	}
	return counts;
}
