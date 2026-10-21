/**
 * Capacity-deferred Home delegations.
 *
 * When the target tedi is already at its concurrent delegated-run limit, an
 * otherwise automatic delegation is recorded with dispatch mode `deferred`
 * and the Home run stays `queued` with no child run. It is not an approval:
 * no approval card or attention item exists for it. The org KernelDO's
 * reconciliation sweep dispatches it once the target has a free slot.
 *
 * Pure on purpose: KernelDO and the turn path both import it.
 */

export const DEFERRED_DELEGATION_MODE = "deferred";

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** Whether a Home run is a capacity-deferred delegation still waiting to start. */
export function isCapacityDeferredDelegation(row: {
	status: string;
	childRunId?: string | null;
	metadata?: unknown;
}): boolean {
	if (row.status !== "queued" || row.childRunId) return false;
	const delegation = record(record(row.metadata)?.homeDelegation);
	const decision = record(delegation?.decision);
	return (
		decision?.mode === DEFERRED_DELEGATION_MODE && !delegation?.resolutionStatus
	);
}
