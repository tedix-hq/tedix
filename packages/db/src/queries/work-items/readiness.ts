import { chunkForBoundParams } from "../../utils/batch";
import {
	workDeferralWait,
	buildWorkDeferralHistoryStatement,
	evaluateWorkDeferralWait,
	workDeferralChangedAt,
} from "./deferral";
import { taskContractRefusal } from "./task-contract";
import {
	workAttemptLimitAvailable,
	workAttemptLimitReason,
} from "./attempt-limit";
import { inheritedChildAuthority } from "./child-delegation";
import { WorkControlError } from "./factory-validation";
import {
	matchesWorkApprovalVersion,
	ownerWorkApprovalIsCurrent,
	ownerWorkDelegation,
} from "./planning-approval";
import { ensureWorkRiskApproval } from "./approvals";
import { findSpentCreditBudget } from "./budgets";
import {
	and,
	desc,
	eq,
	getColumns,
	inArray,
	lt,
	ne,
	or,
	sql,
} from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { coreTable } from "../../core-store/client";
import { anyIds, coreStore } from "../../core-store/dialect";
import {
	type WorkItemReadiness,
	type WorkItem,
	type WorkItemKind,
	workAttempts as d1WorkAttempts,
	workItemRelations as d1WorkItemRelations,
	workItems as d1WorkItems,
	workItemStoredColumns,
} from "../../schema/work-items";
import {
	workApprovalDecisions as d1WorkApprovalDecisions,
	workApprovalProposals as d1WorkApprovalProposals,
	workBudgetEnvelopes as d1WorkBudgetEnvelopes,
	workCaseItems as d1WorkCaseItems,
	workResourceRequirements as d1WorkResourceRequirements,
	CREDIT_BUDGET_CURRENCY,
} from "../../schema/work-factory";
import { ACTIVE_ATTEMPT_STATES, WorkFactoryError } from "./factory-state";
import { normalizeWorkItemRow } from "./normalization";
import {
	evaluateWorkAdmissionApprovals,
	evaluateWorkAdmissionEligibility,
	WORK_ADMISSION_APPROVAL_ACTION,
	type WorkAdmissionApprovalReceipt,
} from "./admission-approval-policy";
import { hasActivePurposeContext } from "./purpose";

/** Stored-column selection rebound to whichever store `db` points at. */
function workItemSelection(db: DbQueryClient): typeof workItemStoredColumns {
	const columns = getColumns(coreTable(db, d1WorkItems));
	return Object.fromEntries(
		Object.keys(workItemStoredColumns).map((key) => [
			key,
			columns[key as keyof typeof columns],
		]),
	) as typeof workItemStoredColumns;
}

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
		facts.approvalReceipts === undefined &&
		!facts.inheritedAuthority &&
		!facts.ownerDelegated
			? undefined
			: evaluateWorkAdmissionApprovals(
					item,
					facts.approvalReceipts ?? [],
					facts.inheritedAuthority || facts.ownerDelegated,
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
	item: WorkItem;
	ownerDelegated: boolean;
	attemptLimitAvailable: boolean;
	blockingDependencyId: string | null;
	activeAttemptId: string | null;
	hasResourceRequirement: boolean;
	hasBudgetEnvelope: boolean;
	hasSpentCreditBudget: boolean;
	changedAt: string | null;
	approvalReceipts: WorkAdmissionApprovalReceipt[];
	history: Awaited<ReturnType<typeof buildWorkDeferralHistoryStatement>>;
}

export async function deriveWorkItemReadiness(
	db: DbQueryClient,
	params: ReadinessParams,
): Promise<WorkItemReadinessResult> {
	return (
		await deriveWorkItemsReadiness(db, {
			...params,
			workItemIds: [params.workItemId],
		})
	)[0]!;
}

/** Read each page's Work and capacity facts together; admission rechecks live facts. */
export async function deriveWorkItemsReadiness(
	db: DbQueryClient,
	params: Omit<ReadinessParams, "workItemId"> & { workItemIds: string[] },
): Promise<WorkItemReadinessResult[]> {
	const derivedAt = params.derivedAt ?? new Date().toISOString();
	const workItems = coreTable(db, d1WorkItems);
	const workAttempts = coreTable(db, d1WorkAttempts);
	const workItemRelations = coreTable(db, d1WorkItemRelations);
	const workResourceRequirements = coreTable(db, d1WorkResourceRequirements);
	const workBudgetEnvelopes = coreTable(db, d1WorkBudgetEnvelopes);
	const workCaseItems = coreTable(db, d1WorkCaseItems);
	const workApprovalProposals = coreTable(db, d1WorkApprovalProposals);
	const workApprovalDecisions = coreTable(db, d1WorkApprovalDecisions);
	// Postgres `enabled` is a real boolean; D1 stores it as 1/0.
	const enabledPredicate =
		coreStore(db) === "postgres" ? sql`e.enabled` : sql`e.enabled=1`;
	const results: WorkItemReadinessResult[] = [];
	for (const ids of chunkForBoundParams(params.workItemIds, 40)) {
		const approvalRows = db.$with("readiness_approvals").as(
			db
				.select({
					workItemId: workApprovalProposals.workItemId,
					workItemVersion: workItems.version,
					authorityKey: workApprovalProposals.authorityKey,
					action: workApprovalProposals.action,
					rank: sql<number>`row_number() OVER (PARTITION BY ${workApprovalProposals.workItemId})`.as(
						"approval_rank",
					),
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
						anyIds(db, workApprovalProposals.workItemId, ids),
						eq(workApprovalProposals.action, WORK_ADMISSION_APPROVAL_ACTION),
						eq(workApprovalProposals.status, "approved"),
						sql`${workApprovalProposals.expiresAt}>${derivedAt}`,
					),
				),
		);
		const historyRows = db
			.$with("readiness_history")
			.as(buildWorkDeferralHistoryStatement(db, params.orgId, ids));
		const jsonObject =
			coreStore(db) === "postgres" ? sql`jsonb_build_object` : sql`json_object`;
		const jsonArray =
			coreStore(db) === "postgres" ? sql`jsonb_agg` : sql`json_group_array`;
		// Postgres aggregates no rows to NULL, and Drizzle skips mapWith for NULL.
		const emptyArray =
			coreStore(db) === "postgres" ? sql`'[]'::jsonb` : sql`'[]'`;
		const rows = await db
			.with(approvalRows, historyRows)
			.select({
				...workItemSelection(db),
				approvalReceipts: sql<WorkAdmissionApprovalReceipt[]>`${sql`(
						SELECT coalesce(${jsonArray}(${jsonObject}(
							'workItemId', ${approvalRows.workItemId},
							'workItemVersion', ${approvalRows.workItemVersion},
							'authorityKey', ${approvalRows.authorityKey},
							'action', ${approvalRows.action}
						)), ${emptyArray}) FROM ${approvalRows}
						WHERE ${approvalRows.workItemId}=${workItems.id} AND ${approvalRows.rank}<=1000
					)`}`
					.mapWith(
						(value) =>
							(typeof value === "string" ? JSON.parse(value) : value) ?? [],
					)
					.as("approval_receipts"),
				history: sql<ReadinessCapacity["history"]>`${sql`(
						SELECT coalesce(${jsonArray}(${jsonObject}(
							'id', h.id, 'workItemId', h.work_item_id, 'rank', h.attempt_history_rank,
							'outcome', h.outcome, 'metadata', h.metadata,
							'startedAt', h.started_at, 'finishedAt', h.finished_at,
							'workItemVersion', h.work_item_version
						)), ${emptyArray}) FROM (SELECT * FROM ${historyRows}
							WHERE ${historyRows.workItemId}=${workItems.id}
							ORDER BY ${historyRows.rank}) h
					)`}`
					.mapWith((value) => {
						const history: ReadinessCapacity["history"] =
							(typeof value === "string" ? JSON.parse(value) : value) ?? [];
						return history.map((attempt) => ({
							...attempt,
							metadata:
								typeof attempt.metadata === "string"
									? JSON.parse(attempt.metadata)
									: attempt.metadata,
						}));
					})
					.as("deferral_history"),
				changedAt: workDeferralChangedAt(db, workItems).as(
					"deferral_change_at",
				),
				ownerDelegated: ownerWorkDelegation(db, workItems, derivedAt).as(
					"owner_delegated",
				),
				attemptLimitAvailable: workAttemptLimitAvailable(db).as(
					"attempt_limit_available",
				),
				blockingDependencyId: sql<string | null>`${sql`(
					SELECT blocker.id FROM ${workItemRelations} relation
					JOIN ${workItems} blocker ON blocker.org_id=${params.orgId} AND blocker.id=relation.from_work_item_id
					WHERE relation.org_id=${params.orgId} AND relation.to_work_item_id=${workItems.id}
						AND relation.relation_type='blocks' AND blocker.disposition NOT IN ('completed','cancelled')
					LIMIT 1
				)`}`.as("blocking_dependency_id"),
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
					WHERE e.org_id=${params.orgId} AND ${enabledPredicate} AND e.currency<>${CREDIT_BUDGET_CURRENCY}
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
					WHERE e.org_id=${params.orgId} AND ${enabledPredicate} AND e.currency=${CREDIT_BUDGET_CURRENCY}
						AND e.mode='stop' AND e.alerted_percent>=100
				)`}`.as("has_spent_credit_budget"),
			})
			.from(workItems)
			// bound-params: 40 Work IDs plus fixed org, currency and time predicates.
			.where(
				and(eq(workItems.orgId, params.orgId), anyIds(db, workItems.id, ids)),
			);
		const facts = new Map(
			rows.map((row) => [
				row.id,
				{
					...row,
					item: normalizeWorkItemRow(row),
					ownerDelegated: Boolean(row.ownerDelegated),
					attemptLimitAvailable: Boolean(row.attemptLimitAvailable),
				},
			]),
		);
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
	if (!capacity)
		throw new WorkFactoryError(
			"NOT_FOUND",
			`Work Item ${params.workItemId} was not found`,
		);
	const item = capacity.item;
	await ensureWorkRiskApproval(db, item, derivedAt);
	const spentCreditBudget = capacity.hasSpentCreditBudget
		? await findSpentCreditBudget(db, {
				orgId: params.orgId,
				workItemId: params.workItemId,
			})
		: null;
	return evaluateWorkItemReadiness({
		deferralWait: await evaluateWorkDeferralWait(
			item,
			derivedAt,
			capacity.history,
			async () => {
				// Risk approval creation can itself wake a deferred run after the batch.
				if (
					item.disposition === "accepted" &&
					(item.riskLevel === "critical" ||
						(item.riskLevel === "high" && !capacity.ownerDelegated))
				) {
					const [change] = await db
						.select({
							at: workDeferralChangedAt(db, item).as("deferral_change_at"),
						})
						.from(sql`(SELECT 1) AS deferral_change`);
					return change?.at ?? "";
				}
				return capacity.changedAt ?? "";
			},
		),
		item,
		ownerDelegated: capacity.ownerDelegated,
		attemptLimitAvailable: capacity.attemptLimitAvailable,
		inheritedAuthority: await readinessInheritedAuthority(db, item, derivedAt),
		contractRefusal: await taskContractRefusal(db, item, derivedAt),
		derivedAt,
		activeAttemptId: capacity.activeAttemptId ?? undefined,
		blockingDependencyId: capacity.blockingDependencyId ?? undefined,
		hasResourceRequirement: Boolean(capacity.hasResourceRequirement),
		hasBudgetEnvelope: Boolean(capacity.hasBudgetEnvelope),
		availableCapabilities: params.availableCapabilities,
		approvalReceipts: capacity.approvalReceipts,
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
	const workItems = coreTable(db, d1WorkItems);
	const workAttempts = coreTable(db, d1WorkAttempts);
	const workItemRelations = coreTable(db, d1WorkItemRelations);
	const workResourceRequirements = coreTable(db, d1WorkResourceRequirements);
	const workBudgetEnvelopes = coreTable(db, d1WorkBudgetEnvelopes);
	const workCaseItems = coreTable(db, d1WorkCaseItems);
	const workApprovalProposals = coreTable(db, d1WorkApprovalProposals);
	const workApprovalDecisions = coreTable(db, d1WorkApprovalDecisions);
	// Postgres `enabled` is a real boolean; D1 stores it as 1/0.
	const enabledPredicate =
		coreStore(db) === "postgres"
			? sql`envelope.enabled`
			: sql`envelope.enabled=1`;
	const rows = await db
		.select({
			...workItemSelection(db),
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
		.orderBy(
			sql`CASE ${workItems.priority} WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`,
			desc(workItems.createdAt),
			desc(workItems.id),
		)
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
						anyIds(db, workAttempts.workItemId, itemIds),
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
						anyIds(db, workItemRelations.toWorkItemId, itemIds),
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
						anyIds(db, workResourceRequirements.workItemId, itemIds),
					),
				),
			db
				.select({ workItemId: workItems.id })
				.from(workItems)
				.where(
					and(
						eq(workItems.orgId, params.orgId),
						// bound-params: itemIds is derived from this projection's max-50 page.
						anyIds(db, workItems.id, itemIds),
						sql`EXISTS (
							SELECT 1 FROM ${workBudgetEnvelopes} envelope
							WHERE envelope.org_id=${params.orgId}
								AND ${enabledPredicate}
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
						anyIds(db, workApprovalProposals.workItemId, itemIds),
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
