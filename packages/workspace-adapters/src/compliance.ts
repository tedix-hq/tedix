/**
 * The one decision function every ComplianceAdapter runs. An adapter gathers
 * facts from wherever it lives (D1 policy rows and rate limiters at the
 * gateway, an in-memory table in tests, a workspace object's own storage) and
 * hands them here, so the same facts always yield the same decision.
 *
 * Gate order mirrors the gateway's per-call sequence: scope, annotation
 * assertion, rate limit, policy disposition, destructive approval.
 */
import type {
	BudgetState,
	ComplianceDecision,
	PolicyDisposition,
	RateState,
	RiskTier,
	BlastRadius,
} from "./types";

/** Budgets per risk tier, mirroring the gateway's write and high-risk limiters. */
export const RISK_TIER_BUDGETS: Record<
	Exclude<RiskTier, "read">,
	BudgetState
> = {
	bounded_write: { limit: 30, windowSeconds: 60 },
	high_impact_write: { limit: 5, windowSeconds: 60 },
	external_side_effect: { limit: 5, windowSeconds: 60 },
};

export function budgetForTier(
	tier: RiskTier | undefined,
): BudgetState | undefined {
	return tier && tier !== "read" ? RISK_TIER_BUDGETS[tier] : undefined;
}

/** What an approval gate found for this call. */
export type ApprovalState =
	/** Nothing about the call asks for approval. */
	| "not_required"
	/** A valid receipt or auto-approval rule covers it. */
	| "granted"
	/** Approval was asked for and is still open. */
	| "pending"
	/** An approver or policy refused it. */
	| "denied";

export interface ComplianceFacts {
	riskTier?: RiskTier;
	blastRadius?: BlastRadius;
	/** Tenant policy rule effect, when a rule matched. */
	disposition?: PolicyDisposition;
	destructive?: boolean;
	/** The caller lacks the scope the tool requires. */
	scopeDenied?: boolean;
	/** The client's asserted annotations disagree with the stored ones. */
	annotationViolation?: boolean;
	/** Arguments matched a secret pattern on a public-egress tool. */
	secretEgress?: "deny" | "warn";
	rate?: RateState;
	approval: ApprovalState;
	/** Who decides a hold. Defaults to `human`. */
	approvalRoute?: "human" | "agent";
	/** Reason to audit when the approval gate decided; defaults are supplied. */
	approvalReason?: string;
}

export function evaluateCall(facts: ComplianceFacts): ComplianceDecision {
	const riskTier = facts.riskTier ?? "unclassified";
	const blastRadius = facts.blastRadius ?? "unclassified";
	const budget = budgetForTier(facts.riskTier);
	const base = {
		riskTier,
		blastRadius,
		...(budget ? { budget } : {}),
		...(facts.rate ? { rate: facts.rate } : {}),
	} as const;

	if (facts.scopeDenied) {
		return {
			...base,
			verdict: "deny",
			gate: "tool_scope",
			reason: "scope_denied",
		};
	}
	if (facts.secretEgress === "deny") {
		return {
			...base,
			verdict: "deny",
			gate: "secret_egress",
			reason: "secret_detected",
		};
	}
	if (facts.annotationViolation) {
		return {
			...base,
			verdict: "deny",
			gate: "annotation_assertion",
			reason: "annotation_violation",
		};
	}
	if (facts.rate?.limited) {
		return {
			...base,
			verdict: "deny",
			gate: "risk_rate_limit",
			reason: "tool_rate_limited",
		};
	}
	if (facts.disposition === "deny") {
		return {
			...base,
			verdict: "deny",
			gate: "destructive_approval",
			reason: "policy_denied",
		};
	}
	const approvalRoute = facts.approvalRoute ?? "human";
	switch (facts.approval) {
		case "denied":
			return {
				...base,
				verdict: "deny",
				gate: "destructive_approval",
				reason: facts.approvalReason ?? "destructive_denied",
			};
		case "pending":
			return {
				...base,
				verdict: "needs_approval",
				gate: "destructive_approval",
				reason: facts.approvalReason ?? "approval_pending",
				approvalRoute,
			};
		case "granted":
			return {
				...base,
				verdict: "allow",
				gate: "destructive_approval",
				reason: facts.approvalReason ?? "destructive_approved",
			};
		case "not_required":
			break;
	}
	// No approval gate ran, yet the call asks for one: hold it.
	if (facts.disposition === "ask" || facts.destructive) {
		return {
			...base,
			verdict: "needs_approval",
			gate: "destructive_approval",
			reason:
				facts.disposition === "ask" ? "policy_ask" : "destructive_unapproved",
			approvalRoute,
		};
	}
	return {
		...base,
		verdict: "allow",
		gate: facts.rate ? "risk_rate_limit" : "tool_scope",
		reason: facts.secretEgress === "warn" ? "secret_detected_warn" : "allowed",
	};
}
