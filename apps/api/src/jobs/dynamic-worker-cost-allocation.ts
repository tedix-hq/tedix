import type { DbClient } from "@tedix/db/client";
import {
	applyDynamicWorkerCostAllocation,
	sumDynamicWorkerAllocatedCost,
} from "@tedix/db/queries/billing/provider-usage";

/** Anonymous loads count once each. Missing provider identities stay unallocated. */
export async function allocateDynamicWorkerCostForPeriod(
	db: DbClient,
	input: {
		periodStart: string;
		periodEnd: string;
		totalCostMicros: number;
		billedQuantity: number | null;
		evidenceRef: string;
	},
) {
	await applyDynamicWorkerCostAllocation(db, input);
	const attributed = await sumDynamicWorkerAllocatedCost(db, input);
	return {
		allocatedMicros: attributed.micros,
		unallocatedMicros: input.totalCostMicros - attributed.micros,
		rows: attributed.rows,
	};
}
