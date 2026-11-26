import { chunkForBoundParams } from "../../utils/batch";
import { workDeferralWait } from "./deferral";
import { taskContractRefusal } from "./task-contract";
import {
	workAttemptLimitAvailable,
	workAttemptLimitReason,
} from "./attempt-limit";
import { inheritedChildAuthority } from "./child-delegation";
import { WorkControlError } from "./factory-validation";
import {
	hasOwnerWorkDelegation,
	matchesWorkApprovalVersion,
	ownerWorkApprovalIsCurrent,
	ownerWorkDelegation,
} from "./planning-approval";
import { ensureWorkRiskApproval } from "./approvals";
import { findSpentCreditBudget } from "./budgets";
import { and, desc, eq, inArray, lt, ne, or, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	type WorkItemReadiness,
	type WorkItem,
	type WorkItemKind,
	workAttempts,
	workItemRelations,
	workItems,
	workItemStoredColumns,
} from "../../schema/work-items";
import {
	workApprovalDecisions,
	workApprovalProposals,
	workBudgetEnvelopes,
	workCaseItems,
	workResourceRequirements,
	CREDIT_BUDGET_CURRENCY,
} from "../../schema/work-factory";
import { ACTIVE_ATTEMPT_STATES, getScopedWorkItem } from "./factory-state";
import { normalizeWorkItemRow } from "./normalization";
import {
	evaluateWorkAdmissionApprovals,
	evaluateWorkAdmissionEligibility,
	WORK_ADMISSION_APPROVAL_ACTION,
	type WorkAdmissionApprovalReceipt,
} from "./admission-approval-policy";
import { hasActivePurposeContext } from "./purpose";

export interface WorkItemReadinessReason {
	code: Exclude<WorkItemReadiness, "ready">;
	detail: string;
}
export type WorkItemReadinessGateName =
	| "disposition"
	| "purpose"
	| "dependencies"
	| "capabilities"
	| "approvals"
	| "risk"
	| "budget"
	| "task_contract"
	| "resources"
	| "attempt"
	| "not_before";
export interface WorkItemReadinessGate {
	gate: WorkItemReadinessGateName;
	evaluation: "passed" | "failed" | "unknown";
	detail: string;
}
export interface WorkItemReadinessResult {
	workItemId: string;
	state: WorkItemReadiness;
	ready: boolean;
	reasons: WorkItemReadinessReason[];
	derivedAt: string;
	gates: WorkItemReadinessGate[];
}

export interface WorkItemReadinessProjectionCursor {
	createdAt: string;
	id: string;
}

export type WorkItemReadinessProjectionSummary = Pick<
	WorkItem,
	| "id"
	| "title"
	| "disposition"
	| "workKind"
	| "riskLevel"
	| "priority"
	| "projectId"
	| "accountableOwnerType"
	| "accountableOwnerId"
	| "createdAt"
	| "updatedAt"
>;

export interface WorkItemReadinessProjectionRow {
	workItem: WorkItemReadinessProjectionSummary;
	readiness: WorkItemReadinessResult;
}

interface ReadinessFacts {
	deferralWait?: string;
	contractRefusal?: string;
	item: WorkItem;
	ownerDelegated: boolean;
	attemptLimitAvailable: boolean;
	inheritedAuthority?: boolean;
	derivedAt: string;
	activeAttemptId?: string;
	blockingDependencyId?: string;
	hasResourceRequirement: boolean;
	hasBudgetEnvelope: boolean;
	availableCapabilities?: string[];
	approvalReceipts?: readonly WorkAdmissionApprovalReceipt[];
	budgetAdmissible?: boolean;
	/** A stop-mode credit budget of this Work that is used up. */
	spentCreditBudget?: { scopeType: string; scopeId: string } | null;
	resourcesAvailable?: boolean;
}

/**
 * The Work's start date while it is still ahead: no runner is handed the Work
 * before it. A person, or an agent that found it has to wait for a date, sets it.
 */
function workNotBefore(
	item: Pick<WorkItem, "startAt">,
	now: string,
): string | undefined {
	return item.startAt && Date.parse(item.startAt) > Date.parse(now)
		? item.startAt
		: undefined;
}

function notBeforeDetail(startAt: string) {
	return `Waits for its start date, ${startAt}. No runner starts it earlier; clear or change the start date to start it sooner.`;
}

function evaluateWorkItemReadiness(
	facts: ReadinessFacts,
): WorkItemReadinessResult {
	const {
		item,
		derivedAt,
		activeAttemptId,
		blockingDependencyId,
		hasBudgetEnvelope,
		hasResourceRequirement,
	} = facts;
	const terminal =
			item.disposition === "completed" || item.disposition === "cancelled",
		accepted = item.disposition === "accepted";
	const notBefore = workNotBefore(item, derivedAt);
	const missingCapability =
		facts.availableCapabilities === undefined
			? undefined
			: item.requiredCapabilities.find(
					(value) => !facts.availableCapabilities!.includes(value),
				);
	const approvalEvaluation =
		facts.approvalReceipts === undefined && !facts.inheritedAuthority
			? undefined
			: evaluateWorkAdmissionApprovals(
					item,
					facts.approvalReceipts ?? [],
					facts.inheritedAuthority,
				);
	const missingAuthority = approvalEvaluation?.missingAuthorities.find(
		(value) => item.requiredAuthorities.includes(value),
	);
	const needsApproval = item.requiredAuthorities.length > 0,
		elevatedRisk = item.riskLevel === "high" || item.riskLevel === "critical";
	const missingRiskApproval = elevatedRisk
		? approvalEvaluation?.missingAuthorities.includes(`risk:${item.riskLevel}`)
		: false;
	const eligibility = evaluateWorkAdmissionEligibility(item, {
		purposeActive: hasActivePurposeContext(
			item,
			derivedAt,
			facts.ownerDelegated,
		),
		activeAttemptId: activeAttemptId ?? null,
		blockingDependencyId: blockingDependencyId ?? null,
		missingCapability:
			item.requiredCapabilities.length === 0 ? null : missingCapability,
		approval:
			needsApproval || elevatedRisk
				? approvalEvaluation
				: evaluateWorkAdmissionApprovals(item, []),
		blockedResourceKey: !hasResourceRequirement
			? null
			: facts.resourcesAvailable === undefined
				? undefined
				: facts.resourcesAvailable
					? null
					: "required",
		budgetBlocked: facts.spentCreditBudget
			? true
			: !hasBudgetEnvelope
				? false
				: facts.budgetAdmissible === undefined
					? undefined
					: !facts.budgetAdmissible,
	});
	const gates: WorkItemReadinessGate[] = [
		{
			gate: "task_contract",
			evaluation: facts.contractRefusal ? "failed" : "passed",
			detail: facts.contractRefusal ?? "Task contract permits admission",
		},
		{
			gate: "disposition",
			evaluation: accepted ? "passed" : "failed",
			detail: accepted
				? "Work Item is accepted"
				: `Disposition is ${item.disposition}`,
		},
		{
			gate: "purpose",
			evaluation: hasActivePurposeContext(item, derivedAt, facts.ownerDelegated)
				? "passed"
				: "failed",
			detail: facts.ownerDelegated
				? "The owner delegated this Work specification"
				: hasActivePurposeContext(item, derivedAt)
					? "Work Item purpose context is active"
					: "Work Item purpose context is missing or expired",
		},
		{
			gate: "dependencies",
			evaluation: blockingDependencyId ? "failed" : "passed",
			detail: blockingDependencyId
				? `Blocked by ${blockingDependencyId}`
				: "No non-terminal blocking dependency",
		},
		{
			gate: "capabilities",
			evaluation:
				item.requiredCapabilities.length === 0
					? "passed"
					: facts.availableCapabilities === undefined
						? "unknown"
						: missingCapability
							? "failed"
							: "passed",
			detail:
				item.requiredCapabilities.length === 0
					? "No capabilities required"
					: facts.availableCapabilities === undefined
						? "Executor capabilities were not supplied"
						: missingCapability
							? `Missing capability ${missingCapability}`
							: "Required capabilities are available",
		},
		{
			gate: "approvals",
			evaluation: !needsApproval
				? "passed"
				: approvalEvaluation === undefined
					? "unknown"
					: missingAuthority
						? "failed"
						: "passed",
			detail: !needsApproval
				? "No explicit authorities required"
				: approvalEvaluation === undefined
					? "Approval receipts were not supplied"
					: missingAuthority
						? `Missing authority ${missingAuthority}`
						: "Required approvals are present",
		},
		{
			gate: "risk",
			evaluation: !elevatedRisk
				? "passed"
				: approvalEvaluation === undefined
					? "unknown"
					: missingRiskApproval
						? "failed"
						: "passed",
			detail: !elevatedRisk
				? `Risk level ${item.riskLevel} needs no elevated approval`
				: approvalEvaluation === undefined
					? `Risk approval for ${item.riskLevel} was not evaluated`
					: missingRiskApproval
						? `Risk ${item.riskLevel} is unapproved`
						: `Risk ${item.riskLevel} was approved`,
		},
		{
			gate: "budget",
			evaluation: facts.spentCreditBudget
				? "failed"
				: !hasBudgetEnvelope
					? "passed"
					: facts.budgetAdmissible === undefined
						? "unknown"
						: facts.budgetAdmissible
							? "passed"
							: "failed",
			detail: facts.spentCreditBudget
				? `The ${facts.spentCreditBudget.scopeType.replace("_", " ")} credit budget is used up; raise its limit to continue`
				: !hasBudgetEnvelope
					? "No credit budget is used up and no per-Attempt budget applies"
					: facts.budgetAdmissible === undefined
						? "Applicable budget envelope was not evaluated"
						: facts.budgetAdmissible
							? "Budget is admissible"
							: "Budget is inadmissible",
		},
		{
			gate: "resources",
			evaluation: !hasResourceRequirement
				? "passed"
				: facts.resourcesAvailable === undefined
					? "unknown"
					: facts.resourcesAvailable
						? "passed"
						: "failed",
			detail: !hasResourceRequirement
				? "No resources required"
				: facts.resourcesAvailable === undefined
					? "Required resources were not evaluated"
					: facts.resourcesAvailable
						? "Resources are available"
						: "Resources are unavailable",
		},
		{
			gate: "attempt",
			evaluation:
				activeAttemptId || !facts.attemptLimitAvailable ? "failed" : "passed",
			detail: activeAttemptId
				? `Active attempt ${activeAttemptId}`
				: !facts.attemptLimitAvailable
					? workAttemptLimitReason(item)
					: "No active attempt",
		},
		{
			gate: "not_before",
			evaluation: notBefore || facts.deferralWait ? "failed" : "passed",
			detail: notBefore
				? notBeforeDetail(notBefore)
				: (facts.deferralWait ??
					(item.startAt
						? `Start date ${item.startAt} has passed`
						: "No start date")),
		},
	];
	let state: WorkItemReadiness = "ready",
		detail: string | undefined;
	if (terminal) {
		state = "terminal";
		detail = `Disposition is ${item.disposition}`;
	} else if (!accepted) {
		state = "not_accepted";
		detail = "WorkSpec has not been accepted";
	} else if (facts.contractRefusal) {
		state = "task_contract_blocked";
		detail = facts.contractRefusal;
	} else if (!facts.attemptLimitAvailable) {
		state = "evaluation_required";
		detail = workAttemptLimitReason(item);
	} else if (!eligibility.eligible) {
		state = eligibility.blocker!;
		detail = eligibility.detail!;
	} else if (notBefore || facts.deferralWait) {
		state = "not_before";
		detail = notBefore ? notBeforeDetail(notBefore) : facts.deferralWait;
	}
	return {
		workItemId: item.id,
		state,
		ready: state === "ready",
		reasons: state === "ready" ? [] : [{ code: state, detail: detail! }],
		derivedAt,
		gates,
	};
}

async function readinessInheritedAuthority(
	db: DbQueryClient,
	item: WorkItem,
	now: string,
) {
	try {
		return await inheritedChildAuthority(db, item, undefined, now);
	} catch (error) {
		if (!(error instanceof WorkControlError)) throw error;
		return false;
	}
}

type ReadinessParams = Parameters<typeof deriveReadiness>[1];
interface ReadinessCapacity {
	activeAttemptId: string | null;
	hasResourceRequirement: boolean;
	hasBudgetEnvelope: boolean;
	hasSpentCreditBudget: boolean;
}

export async function deriveWorkItemReadiness(
	db: DbQueryClient,
	params: ReadinessParams,
): Promise<WorkItemReadinessResult> {
	return deriveReadiness(db, params);
}

/** Batch the fleet's repeated capacity reads; admission still rechecks live facts. */
export async function deriveWorkItemsReadiness(
	db: DbQueryClient,
	params: Omit<ReadinessParams, "workItemId"> & { workItemIds: string[] },
): Promise<WorkItemReadinessResult[]> {
	const derivedAt = params.derivedAt ?? new Date().toISOString();
	const results: WorkItemReadinessResult[] = [];
	for (const ids of chunkForBoundParams(params.workItemIds, 40)) {
		const rows = await db
			.select({
				id: workItems.id,
				// Nested SQL preserves outer-column qualification in SELECT projections.
				activeAttemptId: sql<string | null>`${sql`(
					SELECT a.id FROM ${workAttempts} a
					WHERE a.org_id=${params.orgId} AND a.work_item_id=${workItems.id}
						AND a.runtime_state IN ('queued','running','waiting','retrying')
						AND a.expires_at>${derivedAt} LIMIT 1
				)`}`.as("active_attempt_id"),
				hasResourceRequirement: sql<boolean>`${sql`EXISTS (
					SELECT 1 FROM ${workResourceRequirements} r
					WHERE r.org_id=${params.orgId} AND r.work_item_id=${workItems.id}
				)`}`.as("has_resource_requirement"),
				hasBudgetEnvelope: sql<boolean>`${sql`EXISTS (
					SELECT 1 FROM ${workBudgetEnvelopes} e
					WHERE e.org_id=${params.orgId} AND e.enabled=1 AND e.currency<>${CREDIT_BUDGET_CURRENCY}
						AND (
							(e.scope_type='organization' AND e.scope_id=${params.orgId})
							OR (e.scope_type='work_item' AND e.scope_id=${workItems.id})
							OR (e.scope_type='project' AND e.scope_id=${workItems.projectId})
							OR (e.scope_type='case' AND EXISTS (
								SELECT 1 FROM ${workCaseItems} ci
								WHERE ci.org_id=${params.orgId} AND ci.work_item_id=${workItems.id} AND ci.case_id=e.scope_id
							))
						)
				)`}`.as("has_budget_envelope"),
				hasSpentCreditBudget: sql<boolean>`${sql`EXISTS (
					SELECT 1 FROM ${workBudgetEnvelopes} e
					WHERE e.org_id=${params.orgId} AND e.enabled=1 AND e.currency=${CREDIT_BUDGET_CURRENCY}
						AND e.mode='stop' AND e.alerted_percent>=100
				)`}`.as("has_spent_credit_budget"),
			})
			.from(workItems)
			// bound-params: 40 Work IDs plus fixed org, currency and time predicates.
			.where(
				and(eq(workItems.orgId, params.orgId), inArray(workItems.id, ids)),
			);
		const facts = new Map(rows.map((row) => [row.id, row]));
		results.push(
			...(await Promise.all(
				ids.map((workItemId) =>
					deriveReadiness(
						db,
						{ ...params, workItemId, derivedAt },
						facts.get(workItemId),
					),
				),
			)),
		);
	}
	return results;
}

async function deriveReadiness(
	db: DbQueryClient,
	params: {
		orgId: string;
		workItemId: string;
		availableCapabilities?: string[];
		budgetAdmissible?: boolean;
		resourcesAvailable?: boolean;
		derivedAt?: string;
	},
	capacity?: ReadinessCapacity,
): Promise<WorkItemReadinessResult> {
	const derivedAt = params.derivedAt ?? new Date().toISOString();
	const item = await getScopedWorkItem(db, params.orgId, params.workItemId);
	const ownerDelegated = await hasOwnerWorkDelegation(db, item, derivedAt);
	const [attemptLimit] = await db
		.select({
			available: workAttemptLimitAvailable(db).as("attempt_limit_available"),
		})
		.from(workItems)
		.where(and(eq(workItems.orgId, params.orgId), eq(workItems.id, item.id)))
		.limit(1);
	await ensureWorkRiskApproval(db, item, derivedAt);
	const [
		activeAttemptId,
		dependency,
		hasResourceRequirement,
		hasBudgetEnvelope,
		approvalReceipts,
		spentCreditBudget,
	] = await Promise.all([
		capacity
			? Promise.resolve(capacity.activeAttemptId)
			: db
					.select({ id: workAttempts.id })
					.from(workAttempts)
					.where(
						and(
							eq(workAttempts.orgId, params.orgId),
							eq(workAttempts.workItemId, params.workItemId),
							inArray(workAttempts.runtimeState, ACTIVE_ATTEMPT_STATES),
							sql`${workAttempts.expiresAt}>${derivedAt}`,
						),
					)
					.limit(1)
					.then((rows) => rows[0]?.id ?? null),
		db
			.select({ id: workItems.id })
			.from(workItemRelations)
			.innerJoin(
				workItems,
				and(
					eq(workItems.orgId, params.orgId),
					eq(workItems.id, workItemRelations.fromWorkItemId),
				),
			)
			.where(
				and(
					eq(workItemRelations.orgId, params.orgId),
					eq(workItemRelations.toWorkItemId, params.workItemId),
					eq(workItemRelations.relationType, "blocks"),
					ne(workItems.disposition, "completed"),
					ne(workItems.disposition, "cancelled"),
				),
			)
			.limit(1),
		capacity
			? Promise.resolve(capacity.hasResourceRequirement)
			: db
					.select({ resourceKey: workResourceRequirements.resourceKey })
					.from(workResourceRequirements)
					.where(
						and(
							eq(workResourceRequirements.orgId, params.orgId),
							eq(workResourceRequirements.workItemId, params.workItemId),
						),
					)
					.limit(1)
					.then((rows) => Boolean(rows[0])),
		capacity
			? Promise.resolve(capacity.hasBudgetEnvelope)
			: db
					.select({ id: workBudgetEnvelopes.id })
					.from(workBudgetEnvelopes)
					.where(
						and(
							eq(workBudgetEnvelopes.orgId, params.orgId),
							eq(workBudgetEnvelopes.enabled, true),
							// Credit budgets are enforced by the organization wallet as credits are spent.
							ne(workBudgetEnvelopes.currency, CREDIT_BUDGET_CURRENCY),
							or(
								and(
									eq(workBudgetEnvelopes.scopeType, "organization"),
									eq(workBudgetEnvelopes.scopeId, params.orgId),
								),
								and(
									eq(workBudgetEnvelopes.scopeType, "work_item"),
									eq(workBudgetEnvelopes.scopeId, params.workItemId),
								),
								item.projectId
									? and(
											eq(workBudgetEnvelopes.scopeType, "project"),
											eq(workBudgetEnvelopes.scopeId, item.projectId),
										)
									: undefined,
								and(
									eq(workBudgetEnvelopes.scopeType, "case"),
									sql`EXISTS (SELECT 1 FROM ${workCaseItems} ci WHERE ci.org_id=${params.orgId} AND ci.work_item_id=${params.workItemId} AND ci.case_id=${workBudgetEnvelopes.scopeId})`,
								),
							),
						),
					)
					.limit(1)
					.then((rows) => Boolean(rows[0])),
		db
			.select({
				workItemId: workApprovalProposals.workItemId,
				workItemVersion: workItems.version,
				authorityKey: workApprovalProposals.authorityKey,
				action: workApprovalProposals.action,
			})
			.from(workApprovalProposals)
			.innerJoin(
				workItems,
				and(
					eq(workItems.orgId, workApprovalProposals.orgId),
					eq(workItems.id, workApprovalProposals.workItemId),
					matchesWorkApprovalVersion(db, workItems),
					ownerWorkApprovalIsCurrent(db, workItems, derivedAt),
				),
			)
			.innerJoin(
				workApprovalDecisions,
				and(
					eq(workApprovalDecisions.proposalId, workApprovalProposals.id),
					eq(workApprovalDecisions.decision, "approved"),
					eq(
						workApprovalDecisions.resolvedProposalVersion,
						workApprovalProposals.version,
					),
				),
			)
			.where(
				and(
					eq(workApprovalProposals.orgId, params.orgId),
					eq(workApprovalProposals.workItemId, params.workItemId),
					eq(workApprovalProposals.action, WORK_ADMISSION_APPROVAL_ACTION),
					eq(workApprovalProposals.status, "approved"),
					sql`${workApprovalProposals.expiresAt}>${derivedAt}`,
				),
			)
			.limit(1000),
		capacity && !capacity.hasSpentCreditBudget
			? Promise.resolve(null)
			: findSpentCreditBudget(db, {
					orgId: params.orgId,
					workItemId: params.workItemId,
				}),
	]);
	return evaluateWorkItemReadiness({
		deferralWait: await workDeferralWait(db, item, derivedAt),
		item,
		ownerDelegated,
		attemptLimitAvailable: Boolean(attemptLimit?.available),
		inheritedAuthority: await readinessInheritedAuthority(db, item, derivedAt),
		contractRefusal: await taskContractRefusal(db, item, derivedAt),
		derivedAt,
		activeAttemptId: activeAttemptId ?? undefined,
		blockingDependencyId: dependency[0]?.id,
		hasResourceRequirement,
		hasBudgetEnvelope,
		availableCapabilities: params.availableCapabilities,
		approvalReceipts,
		budgetAdmissible: params.budgetAdmissible,
		spentCreditBudget,
		resourcesAvailable: params.resourcesAvailable,
	});
}

export async function listWorkItemReadinessProjection(
	db: DbQueryClient,
	params: {
		orgId: string;
		projectId?: string;
		workKind?: WorkItemKind;
		cursor?: WorkItemReadinessProjectionCursor;
		limit?: number;
		observedAt?: string;
	},
): Promise<{
	data: WorkItemReadinessProjectionRow[];
	nextCursor: WorkItemReadinessProjectionCursor | null;
	hasMore: boolean;
	observedAt: string;
}> {
	const observedAt = params.observedAt ?? new Date().toISOString();
	const limit = Math.min(Math.max(1, Math.trunc(params.limit ?? 25)), 50);
	const rows = await db
		.select({
			...workItemStoredColumns,
			attemptLimitAvailable: workAttemptLimitAvailable(db).as(
				"attempt_limit_available",
			),
			ownerDelegated: ownerWorkDelegation(db, workItems, observedAt).as(
				"owner_delegated",
			),
		})
		.from(workItems)
		.where(
			and(
				eq(workItems.orgId, params.orgId),
				eq(workItems.disposition, "accepted"),
				params.projectId
					? eq(workItems.projectId, params.projectId)
					: undefined,
				params.workKind ? eq(workItems.workKind, params.workKind) : undefined,
				params.cursor
					? or(
							lt(workItems.createdAt, params.cursor.createdAt),
							and(
								eq(workItems.createdAt, params.cursor.createdAt),
								lt(workItems.id, params.cursor.id),
							),
						)
					: undefined,
			),
		)
		.orderBy(desc(workItems.createdAt), desc(workItems.id))
		.limit(limit + 1);
	const hasMore = rows.length > limit;
	const items = rows.slice(0, limit).map(normalizeWorkItemRow);
	if (items.length === 0)
		return { data: [], nextCursor: null, hasMore: false, observedAt };

	const itemIds = items.map((item) => item.id);
	const [attemptRows, blockerRows, requirementRows, budgetRows, approvalRows] =
		await Promise.all([
			db
				.select({ workItemId: workAttempts.workItemId, id: workAttempts.id })
				.from(workAttempts)
				.where(
					and(
						eq(workAttempts.orgId, params.orgId),
						// bound-params: itemIds is derived from this projection's max-50 page.
						inArray(workAttempts.workItemId, itemIds),
						inArray(workAttempts.runtimeState, ACTIVE_ATTEMPT_STATES),
						sql`${workAttempts.expiresAt}>${observedAt}`,
					),
				),
			db
				.select({
					workItemId: workItemRelations.toWorkItemId,
					blockingDependencyId: workItems.id,
				})
				.from(workItemRelations)
				.innerJoin(
					workItems,
					and(
						eq(workItems.orgId, workItemRelations.orgId),
						eq(workItems.id, workItemRelations.fromWorkItemId),
					),
				)
				.where(
					and(
						eq(workItemRelations.orgId, params.orgId),
						// bound-params: itemIds is derived from this projection's max-50 page.
						inArray(workItemRelations.toWorkItemId, itemIds),
						eq(workItemRelations.relationType, "blocks"),
						ne(workItems.disposition, "completed"),
						ne(workItems.disposition, "cancelled"),
					),
				),
			db
				.select({ workItemId: workResourceRequirements.workItemId })
				.from(workResourceRequirements)
				.where(
					and(
						eq(workResourceRequirements.orgId, params.orgId),
						// bound-params: itemIds is derived from this projection's max-50 page.
						inArray(workResourceRequirements.workItemId, itemIds),
					),
				),
			db
				.select({ workItemId: workItems.id })
				.from(workItems)
				.where(
					and(
						eq(workItems.orgId, params.orgId),
						// bound-params: itemIds is derived from this projection's max-50 page.
						inArray(workItems.id, itemIds),
						sql`EXISTS (
							SELECT 1 FROM ${workBudgetEnvelopes} envelope
							WHERE envelope.org_id=${params.orgId}
								AND envelope.enabled=1
								AND (
									(envelope.scope_type='organization' AND envelope.scope_id=${params.orgId})
									OR (envelope.scope_type='work_item' AND envelope.scope_id=${workItems.id})
									OR (envelope.scope_type='project' AND envelope.scope_id=${workItems.projectId})
									OR (envelope.scope_type='case' AND EXISTS (
										SELECT 1 FROM ${workCaseItems} case_item
										WHERE case_item.org_id=${params.orgId}
											AND case_item.work_item_id=${workItems.id}
											AND case_item.case_id=envelope.scope_id
									))
								)
						)`,
					),
				),
			db
				.select({
					workItemId: workApprovalProposals.workItemId,
					workItemVersion: workItems.version,
					authorityKey: workApprovalProposals.authorityKey,
					action: workApprovalProposals.action,
				})
				.from(workApprovalProposals)
				.innerJoin(
					workItems,
					and(
						eq(workItems.orgId, workApprovalProposals.orgId),
						eq(workItems.id, workApprovalProposals.workItemId),
						matchesWorkApprovalVersion(db, workItems),
						ownerWorkApprovalIsCurrent(db, workItems, observedAt),
					),
				)
				.innerJoin(
					workApprovalDecisions,
					and(
						eq(workApprovalDecisions.proposalId, workApprovalProposals.id),
						eq(workApprovalDecisions.decision, "approved"),
						eq(
							workApprovalDecisions.resolvedProposalVersion,
							workApprovalProposals.version,
						),
					),
				)
				.where(
					and(
						eq(workApprovalProposals.orgId, params.orgId),
						// bound-params: readiness pages cap itemIds at 50
						inArray(workApprovalProposals.workItemId, itemIds),
						eq(workApprovalProposals.action, WORK_ADMISSION_APPROVAL_ACTION),
						eq(workApprovalProposals.status, "approved"),
						sql`${workApprovalProposals.expiresAt}>${observedAt}`,
					),
				)
				.limit(5001),
		]);
	const activeAttempts = new Map(
		attemptRows.map((row) => [row.workItemId, row.id]),
	);
	const blockers = new Map(
		blockerRows.map((row) => [row.workItemId, row.blockingDependencyId]),
	);
	const requirements = new Set(requirementRows.map((row) => row.workItemId));
	const budgets = new Set(budgetRows.map((row) => row.workItemId));
	const boundedApprovalRows = approvalRows.length > 5000 ? [] : approvalRows;
	const data = await Promise.all(
		items.map(async (item, index): Promise<WorkItemReadinessProjectionRow> => ({
			workItem: {
				id: item.id,
				title: item.title,
				disposition: item.disposition,
				workKind: item.workKind,
				riskLevel: item.riskLevel,
				priority: item.priority,
				projectId: item.projectId,
				accountableOwnerType: item.accountableOwnerType,
				accountableOwnerId: item.accountableOwnerId,
				createdAt: item.createdAt,
				updatedAt: item.updatedAt,
			},
			readiness: evaluateWorkItemReadiness({
				deferralWait: await workDeferralWait(db, item, observedAt),
				item,
				ownerDelegated: Boolean(rows[index]?.ownerDelegated),
				attemptLimitAvailable: Boolean(rows[index]?.attemptLimitAvailable),
				inheritedAuthority: await readinessInheritedAuthority(
					db,
					item,
					observedAt,
				),
				contractRefusal: await taskContractRefusal(db, item, observedAt),
				derivedAt: observedAt,
				activeAttemptId: activeAttempts.get(item.id),
				blockingDependencyId: blockers.get(item.id),
				hasResourceRequirement: requirements.has(item.id),
				hasBudgetEnvelope: budgets.has(item.id),
				approvalReceipts: boundedApprovalRows,
			}),
		})),
	);
	const last = data.at(-1)?.workItem;
	return {
		data,
		hasMore,
		nextCursor:
			hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
		observedAt,
	};
}
