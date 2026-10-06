const BACKLOG_DISPATCH_SLOTS = 20;
const RECERTIFICATION_DISPATCH_SLOTS = 5;

export interface GraphProjectionDrainCandidate {
	organizationId: string;
	cursor: number;
}

interface GraphProjectionDrainBatchBinding {
	createBatch(
		batch: Array<{
			id: string;
			params: { organizationId: string };
		}>,
	): Promise<unknown[]>;
}

/**
 * Create all currently eligible projection drains in one idempotent operation.
 * Cloudflare's createBatch() skips retained duplicate IDs instead of throwing,
 * so a tenant whose cursor has not advanced is deduplicated rather than
 * reported as a failed dispatch on every two-minute tick.
 */
export async function createGraphProjectionDrainBatch(
	binding: GraphProjectionDrainBatchBinding,
	candidates: GraphProjectionDrainCandidate[],
	retryBucket: number,
): Promise<{ candidates: number; started: number; deduplicated: number }> {
	if (candidates.length === 0) {
		return { candidates: 0, started: 0, deduplicated: 0 };
	}

	const started = await binding.createBatch(
		candidates.map(({ organizationId, cursor }) => ({
			id: `graph-projection-${organizationId}-${cursor}-${retryBucket}`,
			params: { organizationId },
		})),
	);

	return {
		candidates: candidates.length,
		started: started.length,
		deduplicated: candidates.length - started.length,
	};
}

/**
 * Reserve recertification capacity even when the outbox backlog is saturated.
 * Otherwise a quiet tenant can age past the six-hour admission window while
 * the first 25 backlog tenants consume every two-minute dispatch.
 */
export function selectGraphProjectionDispatchOrganizations(input: {
	backlogOrganizationIds: string[];
	recertificationOrganizationIds: string[];
}): string[] {
	return [
		...new Set([
			...input.backlogOrganizationIds.slice(0, BACKLOG_DISPATCH_SLOTS),
			...input.recertificationOrganizationIds.slice(
				0,
				RECERTIFICATION_DISPATCH_SLOTS,
			),
		]),
	];
}
