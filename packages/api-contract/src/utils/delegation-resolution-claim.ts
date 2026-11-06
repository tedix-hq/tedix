/**
 * The owner marker a Home delegation approval writes before it records the
 * decision (`metadata.homeDelegationResolutionClaim`). While a resolver holds
 * it, no second decision may start. A resolver that was cut off leaves it
 * behind; after `HOME_DELEGATION_RESOLUTION_STALE_MS` the next decision may
 * take it over, or finish the decision it had already recorded. The API and
 * the approvals UI read the claim through these helpers so the UI never
 * offers an action the server refuses.
 */

/** A resolver that has not finished in this long was cut off. */
export const HOME_DELEGATION_RESOLUTION_STALE_MS = 5 * 60 * 1000;

export interface DelegationResolutionClaim {
	claimId: string;
	claimedAt: string;
	approvalEventId: string | null;
	approvalResolvedAt: string | null;
}

/**
 * Read-side annotation the API adds next to a stale claim
 * (`metadata.homeDelegationResolutionRecovery`): the decision the cut-off
 * resolver already recorded, or null when it recorded none.
 */
export interface DelegationResolutionRecovery {
	recordedDecision: "approve" | "reject" | null;
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function text(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** The run's in-flight resolution claim, or null when none is resolving. */
export function readResolvingDelegationClaim(
	metadata: unknown,
): DelegationResolutionClaim | null {
	const claim = record(record(metadata)?.homeDelegationResolutionClaim);
	if (claim?.phase !== "resolving") return null;
	const claimId = text(claim.claimId);
	const claimedAt = text(claim.claimedAt);
	if (!claimId || !claimedAt || !Number.isFinite(Date.parse(claimedAt)))
		return null;
	return {
		claimId,
		claimedAt,
		approvalEventId: text(claim.approvalEventId),
		approvalResolvedAt: text(claim.approvalResolvedAt),
	};
}

/** The latest `claimedAt` a claim may carry and still be taken over at `nowMs`. */
export function delegationResolutionStaleBefore(nowMs: number): string {
	return new Date(nowMs - HOME_DELEGATION_RESOLUTION_STALE_MS).toISOString();
}

export function isStaleDelegationResolutionClaim(
	claim: Pick<DelegationResolutionClaim, "claimedAt">,
	nowMs: number,
): boolean {
	return (
		Date.parse(claim.claimedAt) <= nowMs - HOME_DELEGATION_RESOLUTION_STALE_MS
	);
}

export function readDelegationResolutionRecovery(
	metadata: unknown,
): DelegationResolutionRecovery | null {
	const recovery = record(record(metadata)?.homeDelegationResolutionRecovery);
	if (!recovery) return null;
	const decision = recovery.recordedDecision;
	return decision === "approve" || decision === "reject" || decision === null
		? { recordedDecision: decision }
		: null;
}

/**
 * What a person may do about a delegation hold:
 * - `decide`: no resolver holds it (or a cut-off one recorded nothing), so
 *   Approve and Reject both work;
 * - `recording`: a resolver is recording a decision now; only a refresh helps;
 * - `finish`: a cut-off resolver recorded this decision; repeating it finishes
 *   the decision, and the opposite decision is refused.
 */
export type DelegationResolutionAction =
	| { kind: "decide" }
	| { kind: "recording"; staleAt: string }
	| { kind: "finish"; decision: "approve" | "reject" };

export function delegationResolutionAction(
	metadata: unknown,
	nowMs: number,
): DelegationResolutionAction {
	const claim = readResolvingDelegationClaim(metadata);
	if (!claim) return { kind: "decide" };
	const staleAt = new Date(
		Date.parse(claim.claimedAt) + HOME_DELEGATION_RESOLUTION_STALE_MS,
	).toISOString();
	if (!isStaleDelegationResolutionClaim(claim, nowMs))
		return { kind: "recording", staleAt };
	const recovery = readDelegationResolutionRecovery(metadata);
	// Without the server's receipt check the safe answer is "check again".
	if (!recovery) return { kind: "recording", staleAt };
	return recovery.recordedDecision
		? { kind: "finish", decision: recovery.recordedDecision }
		: { kind: "decide" };
}
