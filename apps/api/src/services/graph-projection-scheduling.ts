/**
 * Per-tick limits for the two-minute projection drain. D1 is the bottleneck,
 * so one tick reads at most
 * (BACKLOG + RECERTIFICATION slots) x GRAPH_PROJECTION_DRAIN_BATCHES_PER_RUN
 * x GRAPH_PROJECTION_BATCH_SIZE (100) outbox rows: 7 x 5 x 100 = 3,500.
 * That still clears about 2.5 million events a day, far above the few
 * thousand a day the triggers append.
 */
export const BACKLOG_DISPATCH_SLOTS = 5;
export const RECERTIFICATION_DISPATCH_SLOTS = 2;
export const GRAPH_PROJECTION_DRAIN_BATCHES_PER_RUN = 5;
/**
 * An organization whose last drain failed waits this long before the tick
 * dispatches it again. Each failing event also backs off on its own
 * (2^attempt seconds, up to one hour, poisoned after 8 attempts).
 */
export const GRAPH_PROJECTION_FAILURE_COOLDOWN_MS = 10 * 60 * 1000;

export interface GraphProjectionDrainCandidate {
	organizationId: string;
	cursor: number;
}

interface GraphProjectionDrainBatchBinding {
	createBatch(
		batch: Array<{
			id: string;
			params: { organizationId: string; maxBatches: number };
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
			params: {
				organizationId,
				maxBatches: GRAPH_PROJECTION_DRAIN_BATCHES_PER_RUN,
			},
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
 * the backlog tenants consume every two-minute dispatch.
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
