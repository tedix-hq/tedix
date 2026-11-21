import type { DbQueryClient } from "@tedix/db/query-client";
import { deleteExpiredCmsRestorePermitLeases } from "@tedix/db/queries/cms-restore-fences";

let nextSweepAt = 0;

/** Each invocation owns its own I/O; a lost request cannot lose the D1 expiry. */
export async function sweepCmsRestorePermitLeases(
	db: DbQueryClient,
	force = false,
): Promise<number> {
	if (!force && Date.now() < nextSweepAt) return 0;
	nextSweepAt = Date.now() + 10_000;
	try {
		const removed = await deleteExpiredCmsRestorePermitLeases(db, {
			limit: 1_000,
		});
		if (removed.length)
			console.info("[cms-runtime] expired restore leases reclaimed", {
				removed: removed.length,
				byKind: removed.reduce<Record<string, number>>((counts, row) => {
					counts[row.kind] = (counts[row.kind] ?? 0) + 1;
					return counts;
				}, {}),
			});
		return removed.length;
	} catch (error) {
		nextSweepAt = 0;
		throw error;
	}
}
