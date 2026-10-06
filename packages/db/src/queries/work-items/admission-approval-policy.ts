import type { WorkItem } from "../../schema/work-items";

export const WORK_ADMISSION_APPROVAL_ACTION = "admission" as const;

export interface WorkAdmissionApprovalReceipt {
	workItemId: string;
	workItemVersion: number;
	authorityKey: string;
	action: string;
}

export interface WorkAdmissionApprovalEvaluation {
	requiredAuthorities: string[];
	satisfiedAuthorities: string[];
	missingAuthorities: string[];
	satisfied: boolean;
}

export type WorkAdmissionEligibilityBlocker =
	| "not_accepted"
	| "purpose_blocked"
	| "already_running"
	| "dependencies_blocked"
	| "capability_blocked"
	| "approval_blocked"
	| "resource_blocked"
	| "budget_blocked"
	| "evaluation_required";

export type WorkAdmissionFactKind =
	| "attempts"
	| "dependencies"
	| "capabilities"
	| "approvals"
	| "resources"
	| "budgets"
	| "cases";

export interface WorkAdmissionEligibilityFacts {
	purposeActive?: boolean;
	activeAttemptId?: string | null;
	blockingDependencyId?: string | null;
	missingCapability?: string | null;
	approval?: WorkAdmissionApprovalEvaluation;
	blockedResourceKey?: string | null;
	budgetBlocked?: boolean;
	truncatedFacts?: readonly WorkAdmissionFactKind[];
}

export interface WorkAdmissionEligibilityEvaluation {
	eligible: boolean;
	blocker: WorkAdmissionEligibilityBlocker | null;
	detail: string | null;
}

export function requiredWorkAdmissionAuthorities(
	item: Pick<WorkItem, "requiredAuthorities" | "riskLevel">,
): string[] {
	const authorities = new Set(item.requiredAuthorities);
	if (item.riskLevel === "high") authorities.add("risk:high");
	if (item.riskLevel === "critical") authorities.add("risk:critical");
	return [...authorities];
}

export function evaluateWorkAdmissionApprovals(
	item: Pick<WorkItem, "id" | "version" | "requiredAuthorities" | "riskLevel">,
	receipts: readonly WorkAdmissionApprovalReceipt[],
): WorkAdmissionApprovalEvaluation {
	const requiredAuthorities = requiredWorkAdmissionAuthorities(item);
	const satisfied = new Set(
		receipts
			.filter(
				(receipt) =>
					receipt.workItemId === item.id &&
					receipt.workItemVersion === item.version &&
					receipt.action === WORK_ADMISSION_APPROVAL_ACTION,
			)
			.map((receipt) => receipt.authorityKey),
	);
	const satisfiedAuthorities = requiredAuthorities.filter((authority) =>
		satisfied.has(authority),
	);
	const missingAuthorities = requiredAuthorities.filter(
		(authority) => !satisfied.has(authority),
	);
	return {
		requiredAuthorities,
		satisfiedAuthorities,
		missingAuthorities,
		satisfied: missingAuthorities.length === 0,
	};
}

export function evaluateWorkAdmissionEligibility(
	item: Pick<WorkItem, "disposition">,
	facts: WorkAdmissionEligibilityFacts,
): WorkAdmissionEligibilityEvaluation {
	if (item.disposition !== "accepted")
		return {
			eligible: false,
			blocker: "not_accepted",
			detail: `Disposition is ${item.disposition}`,
		};
	if (facts.purposeActive === false)
		return {
			eligible: false,
			blocker: "purpose_blocked",
			detail: "Work Item purpose context is missing or expired",
		};
	if (facts.activeAttemptId)
		return {
			eligible: false,
			blocker: "already_running",
			detail: `Active attempt ${facts.activeAttemptId}`,
		};
	if (facts.blockingDependencyId)
		return {
			eligible: false,
			blocker: "dependencies_blocked",
			detail: `Blocked by ${facts.blockingDependencyId}`,
		};
	if (facts.missingCapability)
		return {
			eligible: false,
			blocker: "capability_blocked",
			detail: `Missing capability ${facts.missingCapability}`,
		};
	if (facts.approval && !facts.approval.satisfied)
		return {
			eligible: false,
			blocker: "approval_blocked",
			detail: `Missing approval ${facts.approval.missingAuthorities[0]}`,
		};
	if (facts.blockedResourceKey)
		return {
			eligible: false,
			blocker: "resource_blocked",
			detail: `Resource ${facts.blockedResourceKey} lacks capacity`,
		};
	if (facts.budgetBlocked)
		return {
			eligible: false,
			blocker: "budget_blocked",
			detail: "Applicable budget is inadmissible",
		};
	if (facts.truncatedFacts?.length)
		return {
			eligible: false,
			blocker: "evaluation_required",
			detail: `Eligibility facts were truncated: ${facts.truncatedFacts.join(", ")}`,
		};
	if (
		facts.purposeActive === undefined ||
		facts.activeAttemptId === undefined ||
		facts.blockingDependencyId === undefined ||
		facts.missingCapability === undefined ||
		facts.approval === undefined ||
		facts.blockedResourceKey === undefined ||
		facts.budgetBlocked === undefined
	)
		return {
			eligible: false,
			blocker: "evaluation_required",
			detail: "Eligibility requires current evaluated facts",
		};
	return { eligible: true, blocker: null, detail: null };
}
