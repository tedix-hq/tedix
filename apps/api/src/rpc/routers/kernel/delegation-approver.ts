/**
 * Kernel — agent approver for held Home delegations.
 *
 * Owner directive: agent-in-the-loop, not human-in-the-loop. A Home delegation
 * held with an agent-routable `approvalRoute` goes to the organization's
 * designated approval tedi through the Work approval plane; the operator card
 * appears only when the hold is human-reserved, no valid approver exists, the
 * approver rejects, or its review expires or cannot be requested.
 *
 * The designation is data (`gatingPolicy.delegationApprover` on the org's
 * active policy pack). This module re-validates it on every hold: a stale or
 * self-dealing designation must degrade to the operator card, never to an
 * approval by a party that is not independent of the work.
 */

import type { DbClient } from "@tedix/db/client";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import {
	assertWorkApprovalCapabilities,
	buildWorkApprovalCapabilityRequest,
} from "../../../jobs/work-approval-redrive";
import type { DelegationApproverDesignation } from "./dispatch-policy";

/** Work admission authority an approved Home delegation review satisfies. */
export const HOME_DELEGATION_AUTHORITY = "home_delegation";
/** `work_items.metadata.source` of the held Work Item an agent reviews. */
export const HOME_DELEGATION_REVIEW_SOURCE =
	"kernelRuntime.homeDelegationReview";

export interface ResolvedDelegationApprover {
	tediId: string;
	label: string;
}

export type DelegationApproverResolution =
	| { approver: ResolvedDelegationApprover; reason: null }
	| { approver: null; reason: string };

/**
 * Durable state of the agent review, stamped on
 * `kernel_runtime_runs.metadata.homeDelegation.agentReview`.
 * - pending: a Work approval proposal awaits the approver tedi.
 * - approved: the approver admitted the delegation; dispatch followed.
 * - rejected: the approver declined (or its approval could not be carried
 *   out); the operator decides.
 * - unavailable: the review could not be requested; the operator decides.
 * Expiry is derived from `expiresAt` at read time, not stored.
 */
export interface HomeDelegationAgentReview {
	status: "pending" | "approved" | "rejected" | "unavailable";
	approverTediId: string;
	approverTediLabel: string | null;
	proposalId?: string;
	proposalVersion?: number;
	workItemId?: string;
	requestedAt?: string;
	expiresAt?: string;
	decidedAt?: string;
	rationale?: string;
	reason?: string;
}

function unresolved(reason: string): DelegationApproverResolution {
	return { approver: null, reason };
}

/**
 * Resolve the designated approver for one held delegation. Valid only when the
 * designation names an active tedi of the same organization that is not the
 * delegation target, not the delegating parent tedi (a nested delegation), not
 * the requester, and that carries the native Work approval tools. Every other
 * outcome, including any read or preflight failure, is `approver: null` with
 * the reason, which keeps the operator card.
 */
export async function resolveDelegationApprover(input: {
	db: DbClient;
	env: { TEDI_SERVICE?: Fetcher; ENVIRONMENT?: string };
	organizationId: string;
	designation: DelegationApproverDesignation | null | undefined;
	targetTediId: string;
	/** Delegating parent tedi of a nested (`delegationDepth > 0`) run. */
	parentTediId?: string | null;
	/** Tedi principal that asked Home for this turn, when one did. */
	requesterTediId?: string | null;
	delegationDepth?: number;
}): Promise<DelegationApproverResolution> {
	const designation = input.designation;
	if (!designation) return unresolved("no delegation approver is designated");
	if (designation.id === input.targetTediId)
		return unresolved("the designated approver is the delegation target");
	if ((input.delegationDepth ?? 0) > 0) {
		if (!input.parentTediId)
			return unresolved(
				"a nested delegation cannot prove approver independence from its parent tedi",
			);
		if (designation.id === input.parentTediId)
			return unresolved("the designated approver is the delegating parent");
	}
	if (input.requesterTediId && designation.id === input.requesterTediId)
		return unresolved("the designated approver requested this delegation");
	try {
		const tedi = await getTediByIdForOrganization(
			input.db,
			designation.id,
			input.organizationId,
		);
		if (!tedi || tedi.retiredAt)
			return unresolved("the designated approver is not a tedi of this org");
		if (tedi.status !== "active" || !tedi.slug)
			return unresolved("the designated approver is not active");
		if (!input.env.TEDI_SERVICE)
			return unresolved("the tedi runtime is unavailable for agent review");
		const domain =
			input.env.ENVIRONMENT === "production" ? "tedix.dev" : "tedix.tech";
		await assertWorkApprovalCapabilities(
			await input.env.TEDI_SERVICE.fetch(
				buildWorkApprovalCapabilityRequest({ tediSlug: tedi.slug, domain }),
			),
		);
		return {
			approver: { tediId: tedi.id, label: tedi.name?.trim() || tedi.slug },
			reason: null,
		};
	} catch (error) {
		return unresolved(
			`the designated approver failed its capability preflight: ${
				error instanceof Error ? error.message : String(error)
			}`.slice(0, 300),
		);
	}
}

/** The durable Home line for a held delegation, with or without an approver. */
export function renderHeldDelegationLine(
	owner: string,
	approverLabel: string | null | undefined,
): string {
	return approverLabel
		? `I prepared a delegation to ${owner}. It is not dispatched yet: I routed the decision to ${approverLabel}, and I'll ask you only if ${approverLabel} declines or cannot decide.`
		: `I prepared a delegation to ${owner}. It is not dispatched yet; approve this Home run to dispatch the work order.`;
}

/** Pending and unexpired: the operator's approve is fenced off. */
export function agentReviewIsPending(
	review: HomeDelegationAgentReview | null | undefined,
	nowMs = Date.now(),
): boolean {
	if (review?.status !== "pending") return false;
	const expiresAtMs = review.expiresAt ? Date.parse(review.expiresAt) : NaN;
	return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
}

/** Read the agent review off a run's `homeDelegation` metadata, if any. */
export function readHomeDelegationAgentReview(
	delegation: Record<string, unknown> | null | undefined,
): HomeDelegationAgentReview | null {
	const raw = delegation?.agentReview;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const review = raw as Record<string, unknown>;
	if (
		typeof review.approverTediId !== "string" ||
		(review.status !== "pending" &&
			review.status !== "approved" &&
			review.status !== "rejected" &&
			review.status !== "unavailable")
	)
		return null;
	return review as unknown as HomeDelegationAgentReview;
}
