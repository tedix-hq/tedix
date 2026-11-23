import {
	workAttemptLimitAvailable,
	workAttemptLimitReason,
} from "./attempt-limit";
import type { TaskContractTerms } from "@tedix/api-contract/schemas/task-contract-terms";
import { taskContractRefusal } from "./task-contract";
import { findSpentCreditBudget } from "./budgets";
import {
	workDelegationAncestors,
	inheritedChildAuthority,
	rootAttemptBudgetAvailable,
} from "./child-delegation";
import { capApprovalMode } from "@tedix/api-contract/schemas/workspace-agent-access";
import { WORK_DELEGATION_DEFAULTS } from "@tedix/api-contract/schemas/lane-execution";
import {
	hasOwnerWorkDelegation,
	matchesWorkApprovalVersion,
	ownerWorkApprovalIsCurrent,
} from "./planning-approval";
import {
	LaneExecutionPolicySchema,
	laneResourceKeys,
	type LaneExecutionPolicy,
} from "@tedix/api-contract/schemas/lane-execution";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { capabilityLinks, orgCapabilities } from "../../schema/capabilities";
import {
	workAttempts,
	workEvents,
	workItemRelations,
	workItems,
} from "../../schema/work-items";
import {
	workAdmissions,
	workApprovalDecisions,
	workApprovalProposals,
	workBudgetEnvelopes,
	workBudgetReservations,
	workCaseItems,
	workResourcePools,
	workResourceRequirements,
	workResourceReservations,
	type WorkAdmission,
	CREDIT_BUDGET_CURRENCY,
} from "../../schema/work-factory";
import {
	WorkControlError,
	requireActivePrincipal,
	requireExternalSession,
	requireWorkItem,
} from "./factory-validation";
import {
	evaluateWorkAdmissionApprovals,
	evaluateWorkAdmissionEligibility,
} from "./admission-approval-policy";
import { hasActivePurposeContext } from "./purpose";
import { findWorkToolApprovalWait } from "./tool-approval-wait";
import { chunkForBoundParams } from "../../utils/batch";
import {
	isSameCanonicalParty,
	resolveCanonicalWorkParties,
	workPartyKey,
} from "../external-agent-identity/canonical-party";

export type WorkAdmissionRejectionCode =
	| "not_accepted"
	| "purpose_blocked"
	| "dependencies_blocked"
	| "capability_blocked"
	| "approval_blocked"
	| "task_contract_blocked"
	| "resource_blocked"
	| "budget_blocked"
	| "already_running"
	| "evaluation_required"
	| "stale_specification";
export const WORK_ADMISSION_RESOURCE_REQUIREMENT_CAP = 500;
export const WORK_ADMISSION_BUDGET_ENVELOPE_CAP = 1000;
// A reservation row binds 12 parameters and D1 allows 100 per statement.
const RESERVATION_ROWS_PER_STATEMENT = 8;

type BoundedAdmissionFacts<TRow> = {
	rows: TRow[];
	truncated: boolean;
};
export class WorkAdmissionError extends WorkControlError {
	constructor(
		readonly rejectionCode: WorkAdmissionRejectionCode,
		message: string,
	) {
		super("NOT_ELIGIBLE", message);
		this.name = "WorkAdmissionError";
	}
}
/**
 * An admission specification that references resource keys with no enabled
 * pool in the organization. Pools are owner-registered; a specification never
 * creates one, so the caller gets the exact missing keys back.
 */
export class WorkAdmissionSpecificationError extends WorkControlError {
	constructor(readonly missingResourceKeys: string[]) {
		super(
			"NOT_ELIGIBLE",
			`No enabled resource pool for ${missingResourceKeys.join(", ")}`,
		);
		this.name = "WorkAdmissionSpecificationError";
	}
}
export interface EvaluateWorkAdmissionParams {
	id: string;
	orgId: string;
	workItemId: string;
	expectedWorkItemVersion: number;
	expectedAdmissionSpecRevision: string;
	executorType: "human" | "tedi" | "external_agent";
	executorId: string;
	executorSessionId?: string;
	externalSessionKey?: string;
	maxCostMicros?: number | null;
	leaseTtlMs: number;
	now: string;
}
export type PreviewWorkAdmissionParams = Omit<
	EvaluateWorkAdmissionParams,
	"id" | "leaseTtlMs"
>;

type Eligibility = {
	item: Awaited<ReturnType<typeof requireWorkItem>>;
	requirements: Awaited<ReturnType<typeof loadRequirements>>["rows"];
	envelopes: Awaited<ReturnType<typeof loadApplicableEnvelopes>>["rows"];
	rejection?: { code: WorkAdmissionRejectionCode; reason: string };
};

async function loadRequirements(
	db: DbQueryClient,
	p: { orgId: string; workItemId: string; at: string },
) {
	const rows = await db
		.select({
			resourceKey: workResourceRequirements.resourceKey,
			quantity: workResourceRequirements.quantity,
			poolId: workResourcePools.id,
			poolVersion: workResourcePools.version,
			capacity: workResourcePools.capacity,
			reserved:
				sql<number>`COALESCE((SELECT SUM(r.quantity) FROM work_resource_reservations r WHERE r.org_id=${p.orgId} AND r.pool_id="work_resource_pools"."id" AND r.state='active' AND r.expires_at>${p.at}),0)`.as(
					"reserved",
				),
		})
		.from(workResourceRequirements)
		.leftJoin(
			workResourcePools,
			and(
				eq(workResourcePools.orgId, workResourceRequirements.orgId),
				eq(workResourcePools.resourceKey, workResourceRequirements.resourceKey),
				eq(workResourcePools.enabled, true),
			),
		)
		.where(
			and(
				eq(workResourceRequirements.orgId, p.orgId),
				eq(workResourceRequirements.workItemId, p.workItemId),
			),
		)
		.limit(WORK_ADMISSION_RESOURCE_REQUIREMENT_CAP + 1);
	return {
		rows: rows.slice(0, WORK_ADMISSION_RESOURCE_REQUIREMENT_CAP),
		truncated: rows.length > WORK_ADMISSION_RESOURCE_REQUIREMENT_CAP,
	} satisfies BoundedAdmissionFacts<(typeof rows)[number]>;
}
async function loadApplicableEnvelopes(
	db: DbQueryClient,
	p: {
		orgId: string;
		workItemId: string;
		ancestorIds?: string[];
		projectId: string | null;
		at: string;
	},
) {
	const rows = await db
		.select({
			id: workBudgetEnvelopes.id,
			version: workBudgetEnvelopes.version,
			scopeType: workBudgetEnvelopes.scopeType,
			scopeId: workBudgetEnvelopes.scopeId,
			limitMicros: workBudgetEnvelopes.limitMicros,
			reservationMicros: workBudgetEnvelopes.reservationMicros,
			committed:
				sql<number>`COALESCE((SELECT SUM(CASE WHEN r.state='consumed' THEN COALESCE(r.consumed_micros,r.amount_micros) ELSE r.amount_micros END) FROM work_budget_reservations r WHERE r.org_id=${p.orgId} AND r.envelope_id="work_budget_envelopes"."id" AND (r.state='consumed' OR (r.state='active' AND r.expires_at>${p.at}))),0)`.as(
					"committed",
				),
		})
		.from(workBudgetEnvelopes)
		.where(
			and(
				eq(workBudgetEnvelopes.orgId, p.orgId),
				eq(workBudgetEnvelopes.enabled, true),
				// Credit budgets are enforced by the organization wallet as credits are spent.
				ne(workBudgetEnvelopes.currency, CREDIT_BUDGET_CURRENCY),
				or(
					and(
						eq(workBudgetEnvelopes.scopeType, "organization"),
						eq(workBudgetEnvelopes.scopeId, p.orgId),
					),
					and(
						eq(workBudgetEnvelopes.scopeType, "work_item"),
						inArray(workBudgetEnvelopes.scopeId, [
							p.workItemId,
							...(p.ancestorIds ?? []),
						]),
					),
					p.projectId
						? and(
								eq(workBudgetEnvelopes.scopeType, "project"),
								eq(workBudgetEnvelopes.scopeId, p.projectId),
							)
						: undefined,
					and(
						eq(workBudgetEnvelopes.scopeType, "case"),
						sql`EXISTS (SELECT 1 FROM ${workCaseItems} admission_case WHERE admission_case.org_id=${p.orgId} AND admission_case.work_item_id=${p.workItemId} AND admission_case.case_id=${workBudgetEnvelopes.scopeId})`,
					),
				),
			),
		)
		.limit(WORK_ADMISSION_BUDGET_ENVELOPE_CAP + 1);
	return {
		rows: rows.slice(0, WORK_ADMISSION_BUDGET_ENVELOPE_CAP),
		truncated: rows.length > WORK_ADMISSION_BUDGET_ENVELOPE_CAP,
	} satisfies BoundedAdmissionFacts<(typeof rows)[number]>;
}

/** Parent links, not caller-declared depth, determine the delegation boundary. */
async function loadLanePolicy(
	db: DbQueryClient,
	item: Eligibility["item"],
): Promise<{ policy?: LaneExecutionPolicy; rejection?: string }> {
	type Node = Pick<
		Eligibility["item"],
		"id" | "parentWorkItemId" | "metadata" | "delegationDepth" | "maxAttempts"
	>;
	const nodes: Node[] = [item];
	const seen = new Set([item.id]);
	let parentId = item.parentWorkItemId;
	while (parentId) {
		if (seen.has(parentId))
			return { rejection: "Lane ancestry contains a cycle" };
		// The existing policy permits at most ten delegation edges.
		if (nodes.length > 10)
			return { rejection: "Lane ancestry exceeds the admission depth cap" };
		const parent = (
			await db
				.select({
					id: workItems.id,
					parentWorkItemId: workItems.parentWorkItemId,
					metadata: workItems.metadata,
					delegationDepth: workItems.delegationDepth,
					maxAttempts: workItems.maxAttempts,
				})
				.from(workItems)
				.where(and(eq(workItems.orgId, item.orgId), eq(workItems.id, parentId)))
				.limit(1)
		)[0];
		if (!parent)
			return { rejection: "Lane ancestor is missing from this organization" };
		nodes.push(parent);
		seen.add(parent.id);
		parentId = parent.parentWorkItemId;
	}
	let inherited: LaneExecutionPolicy | undefined;
	let depth = -1;
	for (const node of nodes.reverse()) {
		if (node.metadata?.laneExecution === undefined) {
			if (inherited)
				return {
					rejection: "Delegated Work must retain its ancestor lane policy",
				};
			continue;
		}
		const parsed = LaneExecutionPolicySchema.safeParse({
			...(node.metadata.laneExecution as object),
			delegationDepth: node.delegationDepth,
			maxAttempts: node.maxAttempts,
		});
		if (!parsed.success) return { rejection: "Invalid lane execution policy" };
		const policy = parsed.data;
		depth++;
		if (policy.delegationDepth !== depth || depth > policy.maxDelegationDepth)
			return {
				rejection:
					"Lane delegation depth does not match its ancestry or is exhausted",
			};
		if (
			inherited &&
			(policy.maxDelegationDepth > inherited.maxDelegationDepth ||
				policy.maxAttempts > inherited.maxAttempts ||
				(policy.maxDescendants ?? WORK_DELEGATION_DEFAULTS.maxDescendants) >
					(inherited.maxDescendants ??
						WORK_DELEGATION_DEFAULTS.maxDescendants) ||
				capApprovalMode(
					policy.approvalMode ?? "auto",
					inherited.approvalMode ?? "auto",
				) !== (policy.approvalMode ?? "auto") ||
				policy.executors.some(
					(e) =>
						!inherited!.executors.some(
							(allowed) =>
								allowed.principalType === e.principalType &&
								allowed.principalId === e.principalId &&
								allowed.resourceKey === e.resourceKey &&
								allowed.costMicros === e.costMicros &&
								e.capabilities.every((c) => allowed.capabilities.includes(c)),
						),
				) ||
				policy.makerResourceKey !== inherited.makerResourceKey ||
				policy.reservedSlots < inherited.reservedSlots ||
				inherited.sharedResourceKeys.some(
					(key) => !policy.sharedResourceKeys.includes(key),
				) ||
				inherited.budgetEnvelopeIds.some(
					(id) => !policy.budgetEnvelopeIds.includes(id),
				))
		)
			return { rejection: "Delegated Work weakens its ancestor lane controls" };
		inherited = policy;
	}
	return { policy: inherited };
}

async function evaluate(
	db: DbQueryClient,
	p: PreviewWorkAdmissionParams,
): Promise<Eligibility> {
	const item = await requireWorkItem(db, p.orgId, p.workItemId);
	const empty = { item, requirements: [], envelopes: [] };
	const contractRefusal = await taskContractRefusal(db, item, p.now);
	if (contractRefusal)
		return {
			...empty,
			rejection: { code: "task_contract_blocked", reason: contractRefusal },
		};

	if (
		item.version !== p.expectedWorkItemVersion ||
		item.admissionSpecRevision !== p.expectedAdmissionSpecRevision
	)
		return {
			...empty,
			rejection: {
				code: "stale_specification",
				reason: "Work Item specification changed",
			},
		};
	if (item.disposition !== "accepted")
		return {
			...empty,
			rejection: { code: "not_accepted", reason: "Work Item is not accepted" },
		};
	const [attemptLimit] = await db
		.select({
			available: workAttemptLimitAvailable().as("attempt_limit_available"),
		})
		.from(workItems)
		.where(and(eq(workItems.orgId, p.orgId), eq(workItems.id, item.id)))
		.limit(1);
	if (!attemptLimit?.available)
		return {
			...empty,
			rejection: {
				code: "evaluation_required",
				reason: workAttemptLimitReason(item),
			},
		};
	const lane = await loadLanePolicy(db, item);
	if (lane.rejection)
		return {
			...empty,
			rejection: { code: "evaluation_required", reason: lane.rejection },
		};
	const ancestors = await workDelegationAncestors(db, item);
	const root = ancestors.at(-1)!;
	let inheritedAuthority = false;
	try {
		inheritedAuthority = await inheritedChildAuthority(db, item, {
			type: p.executorType,
			id: p.executorId,
		});
	} catch (error) {
		if (!(error instanceof WorkControlError)) throw error;
		return {
			...empty,
			rejection: { code: "evaluation_required", reason: error.message },
		};
	}
	{
		const [budget] = await db
			.select({
				available: sql<boolean>`${rootAttemptBudgetAvailable(p.orgId, root.id)}`,
			})
			.from(workItems)
			.where(eq(workItems.id, root.id))
			.limit(1);
		if (!budget?.available)
			return {
				...empty,
				rejection: {
					code: "budget_blocked",
					reason: "Root Work attempt budget exhausted",
				},
			};
	}
	const running = (
		await db
			.select({ id: workAttempts.id })
			.from(workAttempts)
			.where(
				and(
					eq(workAttempts.orgId, p.orgId),
					eq(workAttempts.workItemId, p.workItemId),
					inArray(workAttempts.runtimeState, [
						"queued",
						"running",
						"waiting",
						"retrying",
					]),
					sql`${workAttempts.expiresAt}>${p.now}`,
				),
			)
			.limit(1)
	)[0];
	if (running)
		return {
			...empty,
			rejection: {
				code: "already_running",
				reason: "An active attempt already owns this Work Item",
			},
		};
	const approvalWait = await findWorkToolApprovalWait(db, {
		orgId: p.orgId,
		workItemId: item.id,
		workVersion: item.version,
		now: p.now,
	});
	if (approvalWait)
		return {
			...empty,
			rejection: {
				code: "approval_blocked",
				reason: `Waiting for exact-call approval ${approvalWait.id}`,
			},
		};
	const blocker = (
		await db
			.select({ id: workItemRelations.id })
			.from(workItemRelations)
			.innerJoin(workItems, eq(workItems.id, workItemRelations.fromWorkItemId))
			.where(
				and(
					eq(workItemRelations.orgId, p.orgId),
					eq(workItemRelations.toWorkItemId, p.workItemId),
					eq(workItemRelations.relationType, "blocks"),
					ne(workItems.disposition, "completed"),
					ne(workItems.disposition, "cancelled"),
				),
			)
			.limit(1)
	)[0];
	if (blocker)
		return {
			...empty,
			rejection: {
				code: "dependencies_blocked",
				reason: "A blocking dependency is non-terminal",
			},
		};
	const links = await db
		.select({ slug: orgCapabilities.slug, id: orgCapabilities.id })
		.from(capabilityLinks)
		.innerJoin(
			orgCapabilities,
			and(
				eq(orgCapabilities.id, capabilityLinks.capabilityId),
				eq(orgCapabilities.organizationId, p.orgId),
				eq(orgCapabilities.status, "active"),
			),
		)
		.where(
			and(
				eq(capabilityLinks.organizationId, p.orgId),
				p.executorType === "human"
					? sql`0`
					: eq(capabilityLinks.entityKind, p.executorType),
				eq(capabilityLinks.entityId, p.executorId),
			),
		)
		.limit(1000);
	const capabilitySet = new Set(links.flatMap((x) => [x.slug, x.id]));
	const missing = item.requiredCapabilities.find((x) => !capabilitySet.has(x));
	if (missing)
		return {
			...empty,
			rejection: {
				code: "capability_blocked",
				reason: `Executor lacks capability ${missing}`,
			},
		};
	const approvals = await db
		.select({
			workItemId: workApprovalProposals.workItemId,
			workItemVersion: workItems.version,
			authorityKey: workApprovalProposals.authorityKey,
			action: workApprovalProposals.action,
			deciderType: workApprovalDecisions.deciderType,
			deciderId: workApprovalDecisions.deciderId,
		})
		.from(workApprovalProposals)
		.innerJoin(
			workItems,
			and(
				eq(workItems.orgId, workApprovalProposals.orgId),
				eq(workItems.id, workApprovalProposals.workItemId),
				matchesWorkApprovalVersion(workItems),
				ownerWorkApprovalIsCurrent(workItems, p.now),
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
				eq(workApprovalProposals.orgId, p.orgId),
				eq(workApprovalProposals.workItemId, p.workItemId),
				eq(workApprovalProposals.status, "approved"),
				sql`(${workApprovalProposals.expiresAt} IS NULL OR ${workApprovalProposals.expiresAt}>${p.now})`,
			),
		)
		.limit(1000);
	// An approval counts only from a second party: not the executor itself
	// (such as a designated approval tedi admitting its own run), and not the
	// owner whose owner-host agent then executes the Work.
	const executor = {
		type: p.executorType === "human" ? "user" : p.executorType,
		id: p.executorId,
	};
	const parties =
		p.executorType === "external_agent"
			? await resolveCanonicalWorkParties(db, {
					organizationId: p.orgId,
					parties: [executor],
				})
			: new Map<string, string>();
	const ownerHostExecutor = parties.has(workPartyKey(executor));
	const ownerDelegated = await hasOwnerWorkDelegation(db, item, p.now);
	const independentApprovals = approvals.filter(
		(approval) =>
			(ownerDelegated &&
				approval.authorityKey === "risk:high" &&
				approval.deciderType === "user" &&
				approval.deciderId === item.accountableOwnerId) ||
			(!(
				approval.deciderType === executor.type &&
				approval.deciderId === executor.id
			) &&
				!(
					ownerHostExecutor &&
					isSameCanonicalParty(parties, executor, {
						type: approval.deciderType,
						id: approval.deciderId,
					})
				)),
	);
	const missingApproval = evaluateWorkAdmissionApprovals(
		item,
		independentApprovals,
	).missingAuthorities[0];
	if (missingApproval && !inheritedAuthority)
		return {
			...empty,
			rejection: {
				code: "approval_blocked",
				reason: `Approval ${missingApproval} is missing`,
			},
		};
	const requirementFacts = await loadRequirements(db, {
		orgId: p.orgId,
		workItemId: p.workItemId,
		at: p.now,
	});
	if (requirementFacts.truncated)
		return {
			...empty,
			rejection: {
				code: "evaluation_required",
				reason: `Resource requirements exceed the authoritative admission cap of ${WORK_ADMISSION_RESOURCE_REQUIREMENT_CAP}`,
			},
		};
	const requirements = requirementFacts.rows;
	const blockedResource = requirements.find(
		(x) =>
			!x.poolId || x.capacity === null || x.reserved + x.quantity > x.capacity,
	);
	if (blockedResource)
		return {
			item,
			requirements,
			envelopes: [],
			rejection: {
				code: "resource_blocked",
				reason: `Resource ${blockedResource.resourceKey} lacks capacity`,
			},
		};
	const envelopeFacts = await loadApplicableEnvelopes(db, {
		orgId: p.orgId,
		workItemId: p.workItemId,
		projectId: item.projectId,
		ancestorIds: item.metadata?.childDelegation
			? ancestors.slice(1).map((node) => node.id)
			: [],
		at: p.now,
	});
	if (envelopeFacts.truncated)
		return {
			...empty,
			rejection: {
				code: "evaluation_required",
				reason: `Applicable budget envelopes exceed the authoritative admission cap of ${WORK_ADMISSION_BUDGET_ENVELOPE_CAP}`,
			},
		};
	const envelopes = envelopeFacts.rows;
	if (lane.policy) {
		const reject = (reason: string): Eligibility => ({
			item,
			requirements,
			envelopes,
			rejection: { code: "evaluation_required", reason },
		});
		const policy = lane.policy;
		const makerPool = (
			await db
				.select({ capacity: workResourcePools.capacity })
				.from(workResourcePools)
				.where(
					and(
						eq(workResourcePools.orgId, p.orgId),
						eq(workResourcePools.resourceKey, policy.makerResourceKey),
						eq(workResourcePools.enabled, true),
					),
				)
				.limit(1)
		)[0];
		if (
			!makerPool ||
			policy.sharedResourceKeys.some((key) => {
				const shared = requirements.find((r) => r.resourceKey === key);
				return (
					!shared?.capacity ||
					makerPool.capacity + policy.reservedSlots > shared.capacity
				);
			})
		)
			return reject(
				"Lane maker pool must leave the configured verification and closure slots",
			);
		const executor = policy.executors.find(
			(e) =>
				e.principalType === p.executorType && e.principalId === p.executorId,
		);
		if (!executor || executor.costMicros === null)
			return reject("Lane executor or its pricing is unavailable");
		// A cancelled Attempt (a deferred or waiting run, or a revision during
		// preparation) did not execute the brief, so it spends no budget. Each
		// owner grant restores exactly one Attempt it names. A rejected Attempt is
		// a verifier's verdict, not a crash: it never reruns on the same Work
		// revision and a repaired revision starts without it counted.
		const verdict = (
			await db
				.select({ id: workAttempts.id })
				.from(workAttempts)
				.where(
					and(
						eq(workAttempts.orgId, p.orgId),
						eq(workAttempts.workItemId, p.workItemId),
						eq(workAttempts.outcome, "rejected"),
						sql`json_extract(${workAttempts.metadata}, '$.dispatchVersion') = ${item.version}`,
					),
				)
				.limit(1)
		)[0];
		if (verdict)
			return reject(
				"Lane verdict stands for this Work revision; revise the Work before retrying",
			);
		const used = await db
			.select({ id: workAttempts.id })
			.from(workAttempts)
			.where(
				and(
					eq(workAttempts.orgId, p.orgId),
					eq(workAttempts.workItemId, p.workItemId),
					sql`(${workAttempts.outcome} IS NULL OR ${workAttempts.outcome} NOT IN ('cancelled','rejected'))`,
				),
			);
		const granted = await db
			.select({ id: workEvents.id })
			.from(workEvents)
			.where(
				and(
					eq(workEvents.orgId, p.orgId),
					eq(workEvents.workItemId, p.workItemId),
					eq(workEvents.eventType, "lane.attempt_granted"),
				),
			);
		if (used.length >= policy.maxAttempts + granted.length)
			return reject("Lane retry budget exhausted");
		if (
			laneResourceKeys(policy, executor).some(
				(key) =>
					!requirements.some((r) => r.resourceKey === key && r.quantity === 1),
			)
		)
			return reject(
				"Lane shared, maker and executor reservations must be declared",
			);
		if (
			policy.budgetEnvelopeIds.some(
				(id) =>
					!envelopes.some(
						(e) => e.id === id && e.reservationMicros >= executor.costMicros!,
					),
			)
		)
			return reject(
				"Lane budget reservations must cover the known executor cost",
			);
		if (
			item.requiredCapabilities.some((c) => !executor.capabilities.includes(c))
		)
			return reject("Configured lane executor lacks a required capability");
	}
	const blockedBudget = envelopes.find(
		(x) => x.committed + x.reservationMicros > x.limitMicros,
	);
	if (blockedBudget)
		return {
			item,
			requirements,
			envelopes,
			rejection: {
				code: "budget_blocked",
				reason: `Budget ${blockedBudget.id} lacks capacity`,
			},
		};
	const spentCredits = await findSpentCreditBudget(db, {
		orgId: item.orgId,
		workItemId: item.id,
	});
	if (spentCredits)
		return {
			item,
			requirements,
			envelopes,
			rejection: {
				code: "budget_blocked",
				reason: `The ${spentCredits.scopeType.replace("_", " ")} credit budget is used up; raise its limit to continue`,
			},
		};
	const eligibility = evaluateWorkAdmissionEligibility(item, {
		purposeActive: hasActivePurposeContext(item, p.now, ownerDelegated),
		activeAttemptId: null,
		blockingDependencyId: null,
		missingCapability: null,
		approval: evaluateWorkAdmissionApprovals(
			item,
			independentApprovals,
			inheritedAuthority,
		),
		blockedResourceKey: null,
		budgetBlocked: false,
	});
	if (!eligibility.eligible)
		return {
			item,
			requirements,
			envelopes,
			rejection: {
				code: eligibility.blocker ?? "evaluation_required",
				reason:
					eligibility.detail ?? "Admission eligibility was not established",
			},
		};
	return { item, requirements, envelopes };
}

/** Read current executor eligibility without creating admission or reservation records. */
export async function previewWorkAdmission(
	db: DbQueryClient,
	p: PreviewWorkAdmissionParams,
): Promise<Eligibility> {
	await requireActivePrincipal(db, {
		orgId: p.orgId,
		type: p.executorType === "human" ? "user" : p.executorType,
		id: p.executorId,
	});
	if (p.executorType === "external_agent") {
		if (!p.executorSessionId || !p.externalSessionKey)
			throw new WorkAdmissionError(
				"stale_specification",
				"External admission requires exact session key",
			);
		await requireExternalSession(db, {
			orgId: p.orgId,
			principalId: p.executorId,
			sessionId: p.executorSessionId,
			externalSessionKey: p.externalSessionKey,
		});
	}
	return evaluate(db, p);
}

function rejectionKey(
	p: EvaluateWorkAdmissionParams,
	code: WorkAdmissionRejectionCode,
) {
	const window = Math.floor(Date.parse(p.now) / 60_000);
	return `${p.orgId}:${p.workItemId}:${p.expectedAdmissionSpecRevision}:${p.executorType}:${p.executorId}:${code}:${window}`;
}
export async function evaluateAndRecordWorkAdmission(
	db: DbQueryClient,
	p: EvaluateWorkAdmissionParams,
): Promise<WorkAdmission> {
	if (
		!Number.isFinite(p.leaseTtlMs) ||
		p.leaseTtlMs < 1000 ||
		p.leaseTtlMs > 3_600_000
	)
		throw new WorkAdmissionError(
			"stale_specification",
			"leaseTtlMs must be 1000..3600000",
		);
	const eligibility = await previewWorkAdmission(db, p);
	if (eligibility.rejection) {
		const key = rejectionKey(p, eligibility.rejection.code);
		const rejectionExpiresAt = new Date(
			(Math.floor(Date.parse(p.now) / 60_000) + 1) * 60_000,
		).toISOString();
		try {
			return (
				await db
					.insert(workAdmissions)
					.values({
						id: p.id,
						orgId: p.orgId,
						workItemId: p.workItemId,
						workItemVersion: eligibility.item.version,
						admissionSpecRevision: eligibility.item.admissionSpecRevision,
						executorType: p.executorType,
						executorId: p.executorId,
						executorSessionId: p.executorSessionId,
						externalSessionKey: p.externalSessionKey,
						decision: "rejected",
						rejectionCode: eligibility.rejection.code,
						rejectionReason: eligibility.rejection.reason,
						rejectionKey: key,
						maxCostMicros: p.maxCostMicros,
						decidedAt: p.now,
						expiresAt: rejectionExpiresAt,
						createdAt: p.now,
					})
					.returning()
			)[0]!;
		} catch {
			const existing = (
				await db
					.select()
					.from(workAdmissions)
					.where(
						and(
							eq(workAdmissions.orgId, p.orgId),
							eq(workAdmissions.rejectionKey, key),
							eq(workAdmissions.decision, "rejected"),
							sql`${workAdmissions.expiresAt}>${p.now}`,
						),
					)
					.limit(1)
			)[0];
			if (existing) return existing;
			throw new WorkAdmissionError(
				eligibility.rejection.code,
				eligibility.rejection.reason,
			);
		}
	}
	const { statements } = buildWorkAdmissionStatements(db, p, eligibility);
	try {
		const results = await db.batch(statements);
		const admission = (results[0] as WorkAdmission[])[0];
		if (!admission) throw new Error("lost admission race");
		return admission;
	} catch (error) {
		// The reservation triggers are the last word: name the gate they hit
		// instead of reporting every batch failure as a resource race.
		const detail = describeCause(error);
		if (/budget exhausted/i.test(detail))
			throw new WorkAdmissionError(
				"budget_blocked",
				"Budget envelope lacks capacity for this reservation",
			);
		if (/resource capacity exhausted/i.test(detail))
			throw new WorkAdmissionError(
				"resource_blocked",
				"Resource pool lacks capacity for this reservation",
			);
		throw new WorkAdmissionError(
			"resource_blocked",
			"Admission lost an eligibility or reservation race",
		);
	}
}
/** Prepare the admission and reservations for the Attempt's atomic start batch. */
export async function prepareWorkAdmission(
	db: DbQueryClient,
	p: EvaluateWorkAdmissionParams,
) {
	if (
		!Number.isFinite(p.leaseTtlMs) ||
		p.leaseTtlMs < 1000 ||
		p.leaseTtlMs > 3_600_000
	)
		throw new WorkAdmissionError(
			"stale_specification",
			"leaseTtlMs must be 1000..3600000",
		);
	const eligibility = await previewWorkAdmission(db, p);
	if (eligibility.rejection)
		throw new WorkAdmissionError(
			eligibility.rejection.code,
			eligibility.rejection.reason,
		);
	return buildWorkAdmissionStatements(db, p, eligibility);
}

export interface PreparedWorkAdmission {
	id: string;
	expiresAt: string;
	statements: Parameters<DbQueryClient["batch"]>[0];
}

function buildWorkAdmissionStatements(
	db: DbQueryClient,
	p: EvaluateWorkAdmissionParams,
	eligibility: Eligibility,
): PreparedWorkAdmission {
	const item = eligibility.item;
	const explicitTerms = item.acceptanceContract?.taskContract;
	// Default terms authorize no additional model usage. Owners can allocate it explicitly.
	const terms: TaskContractTerms = explicitTerms ?? {
		version: 2,
		goal: item.acceptanceContract?.doneLooksLike || item.title,
		successCriterion: [{ path: ["completed"], equals: true }],
		budget: { maxTokens: 0, maxCostUsd: 0 },
		remainingDepth: Math.max(
			0,
			WORK_DELEGATION_DEFAULTS.maxDelegationDepth - (item.delegationDepth ?? 0),
		),
		errorAllowance: Math.min(
			19,
			Math.max(
				0,
				(item.maxAttempts ?? WORK_DELEGATION_DEFAULTS.maxAttempts) - 1,
			),
		),
		returnFormat: {
			type: "object",
			properties: { completed: { type: "boolean" } },
			required: ["completed"],
			additionalProperties: false,
		},
		deadline: new Date(
			Math.min(
				Date.parse(p.now) + 24 * 60 * 60 * 1000,
				item.deadline ? Date.parse(item.deadline) : Infinity,
				item.purposeExceptionExpiresAt
					? Date.parse(item.purposeExceptionExpiresAt)
					: Infinity,
			),
		).toISOString(),
	};
	const expiresAt = new Date(
		Math.min(
			Date.parse(p.now) + p.leaseTtlMs,
			explicitTerms ? Date.parse(explicitTerms.deadline) : Infinity,
		),
	).toISOString();
	const admissionInsert = db
		.insert(workAdmissions)
		.values({
			id: p.id,
			orgId: p.orgId,
			workItemId: p.workItemId,
			workItemVersion: p.expectedWorkItemVersion,
			admissionSpecRevision: p.expectedAdmissionSpecRevision,
			executorType: p.executorType,
			executorId: p.executorId,
			executorSessionId: p.executorSessionId,
			externalSessionKey: p.externalSessionKey,
			decision: "admitted",
			maxCostMicros: p.maxCostMicros,
			decidedAt: p.now,
			expiresAt,
			createdAt: p.now,
		})
		.returning();
	const resourceInserts = chunkForBoundParams(
		eligibility.requirements,
		RESERVATION_ROWS_PER_STATEMENT,
	).map((rows) =>
		db
			.insert(workResourceReservations)
			.values(
				rows.map((r) => ({
					id: crypto.randomUUID(),
					orgId: p.orgId,
					admissionId: p.id,
					workItemId: p.workItemId,
					poolId: r.poolId!,
					poolVersion: r.poolVersion!,
					resourceKey: r.resourceKey,
					quantity: r.quantity,
					state: "active" as const,
					reservedAt: p.now,
					expiresAt,
					version: 1,
				})),
			)
			.returning({ id: workResourceReservations.id }),
	);
	const budgetInserts = chunkForBoundParams(
		eligibility.envelopes,
		RESERVATION_ROWS_PER_STATEMENT,
	).map((rows) =>
		db
			.insert(workBudgetReservations)
			.values(
				rows.map((e) => ({
					id: crypto.randomUUID(),
					orgId: p.orgId,
					admissionId: p.id,
					workItemId: p.workItemId,
					envelopeId: e.id,
					envelopeVersion: e.version,
					amountMicros: e.reservationMicros,
					consumedMicros: null,
					state: "active" as const,
					reservedAt: p.now,
					expiresAt,
					version: 1,
				})),
			)
			.returning({ id: workBudgetReservations.id }),
	);
	return {
		id: p.id,
		expiresAt,
		statements: [
			admissionInsert,
			db.insert(workEvents).values({
				id: p.id,
				orgId: p.orgId,
				workItemId: p.workItemId,
				eventType: "admission.task_contract",
				actorType: p.executorType === "human" ? "user" : p.executorType,
				actorId: p.executorId,
				payload: {
					taskContract: terms,
					defaulted: !explicitTerms,
					workVersion: p.expectedWorkItemVersion,
					admissionSpecRevision: p.expectedAdmissionSpecRevision,
				},
				occurredAt: p.now,
			}),
			...resourceInserts,
			...budgetInserts,
		] as const,
	};
}

export function rethrowWorkAdmissionWriteError(error: unknown): never {
	const detail = describeCause(error);
	const gates: Array<[RegExp, WorkAdmissionRejectionCode, string]> = [
		[
			/budget (?:exhausted|reservation (?:missing|does not match))/i,
			"budget_blocked",
			"Budget reservation is no longer available",
		],
		[
			/resource (?:capacity exhausted|reservation (?:missing|does not match))/i,
			"resource_blocked",
			"Resource reservation is no longer available",
		],
		[
			/work already running|uniq_work_attempt_active|work_attempts.org_id, work_attempts.work_item_id/i,
			"already_running",
			"An active Attempt already owns this Work Item",
		],
		[
			/dependency blocked/i,
			"dependencies_blocked",
			"A blocking dependency is no longer complete",
		],
		[
			/capability (?:missing|revoked)/i,
			"capability_blocked",
			"Executor capability is no longer available",
		],
		[
			/approval (?:missing|expired|revoked)/i,
			"approval_blocked",
			"Required approval is no longer valid",
		],
		[
			/stale admission|admission receipt is not current|active admission|expired admission|inactive .*executor|NOT NULL constraint failed: work_events.org_id/i,
			"stale_specification",
			"Work or executor eligibility changed before Attempt start",
		],
		[
			/facts exceed admission cap/i,
			"evaluation_required",
			"Admission facts exceed the evaluation limit",
		],
	];
	for (const [pattern, code, reason] of gates)
		if (pattern.test(detail)) throw new WorkAdmissionError(code, reason);
	throw error;
}

function describeCause(error: unknown): string {
	const parts: string[] = [];
	let current: unknown = error;
	for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
		parts.push(current.message);
		current = current.cause;
	}
	return parts.join(" | ");
}
export async function getWorkAdmissionSpecification(
	db: DbQueryClient,
	p: { orgId: string; workItemId: string },
) {
	const item = await requireWorkItem(db, p.orgId, p.workItemId);
	const [resources, budgets] = await Promise.all([
		db
			.select({
				resourceKey: workResourceRequirements.resourceKey,
				quantity: workResourceRequirements.quantity,
			})
			.from(workResourceRequirements)
			.where(
				and(
					eq(workResourceRequirements.orgId, p.orgId),
					eq(workResourceRequirements.workItemId, p.workItemId),
				),
			)
			.orderBy(workResourceRequirements.resourceKey),
		db
			.select()
			.from(workBudgetEnvelopes)
			.where(
				and(
					eq(workBudgetEnvelopes.orgId, p.orgId),
					eq(workBudgetEnvelopes.scopeType, "work_item"),
					eq(workBudgetEnvelopes.scopeId, p.workItemId),
				),
			)
			.limit(1),
	]);
	const budget = budgets[0];
	return {
		workItemId: p.workItemId,
		workItemVersion: item.version,
		admissionSpecRevision: item.admissionSpecRevision,
		resources,
		budget: budget
			? {
					limitMicros: budget.limitMicros,
					reservationMicros: budget.reservationMicros,
				}
			: null,
	};
}

export async function replaceWorkAdmissionSpecification(
	db: DbQueryClient,
	p: {
		orgId: string;
		workItemId: string;
		expectedWorkItemVersion: number;
		expectedAdmissionSpecRevision: string;
		specification: {
			resources: Array<{ resourceKey: string; quantity: number }>;
			budget: { limitMicros: number; reservationMicros: number } | null;
		};
		now: string;
	},
) {
	const duplicate = new Set<string>();
	for (const resource of p.specification.resources) {
		if (duplicate.has(resource.resourceKey))
			throw new WorkControlError(
				"CONFLICT",
				`Duplicate resource ${resource.resourceKey}`,
			);
		duplicate.add(resource.resourceKey);
	}
	const requestedKeys = [...duplicate];
	const registered = new Set<string>();
	// D1 binds at most 100 parameters per statement; keep each chunk well under.
	for (let i = 0; i < requestedKeys.length; i += 50) {
		const chunk = requestedKeys.slice(i, i + 50);
		const pools = await db
			.select({ resourceKey: workResourcePools.resourceKey })
			.from(workResourcePools)
			.where(
				and(
					eq(workResourcePools.orgId, p.orgId),
					eq(workResourcePools.enabled, true),
					inArray(workResourcePools.resourceKey, chunk),
				),
			)
			.limit(chunk.length);
		for (const pool of pools) registered.add(pool.resourceKey);
	}
	const missing = requestedKeys.filter((key) => !registered.has(key));
	if (missing.length > 0) throw new WorkAdmissionSpecificationError(missing);
	const prior = await requireWorkItem(db, p.orgId, p.workItemId);
	if (
		prior.version !== p.expectedWorkItemVersion ||
		prior.admissionSpecRevision !== p.expectedAdmissionSpecRevision
	)
		throw new WorkControlError("CONFLICT", "Admission specification changed");
	const currentSpec = sql`EXISTS (SELECT 1 FROM work_items spec_item WHERE spec_item.org_id=${p.orgId} AND spec_item.id=${p.workItemId} AND spec_item.version=${p.expectedWorkItemVersion} AND spec_item.admission_spec_revision=${p.expectedAdmissionSpecRevision})`;
	const deleteRequirements = db
		.delete(workResourceRequirements)
		.where(
			and(
				eq(workResourceRequirements.orgId, p.orgId),
				eq(workResourceRequirements.workItemId, p.workItemId),
				currentSpec,
			),
		);
	// Keep a row for an unavailable pool: its NULL resource key violates the
	// requirement constraint and rolls back this entire batch, including deletion.
	const inserts = p.specification.resources.map((resource) =>
		db.insert(workResourceRequirements).select(
			db
				.select({
					orgId: workItems.orgId,
					workItemId: workItems.id,
					resourceKey: workResourcePools.resourceKey,
					quantity: sql<number>`${resource.quantity}`.as("quantity"),
					createdAt: sql<string>`${p.now}`.as("created_at"),
					updatedAt: sql<string>`${p.now}`.as("updated_at"),
				})
				.from(workItems)
				.leftJoin(
					workResourcePools,
					and(
						eq(workResourcePools.orgId, workItems.orgId),
						eq(workResourcePools.resourceKey, resource.resourceKey),
						eq(workResourcePools.enabled, true),
					),
				)
				.where(
					and(
						eq(workItems.orgId, p.orgId),
						eq(workItems.id, p.workItemId),
						eq(workItems.version, p.expectedWorkItemVersion),
						eq(
							workItems.admissionSpecRevision,
							p.expectedAdmissionSpecRevision,
						),
					),
				),
		),
	);
	const existingBudget = (
		await db
			.select()
			.from(workBudgetEnvelopes)
			.where(
				and(
					eq(workBudgetEnvelopes.orgId, p.orgId),
					eq(workBudgetEnvelopes.scopeType, "work_item"),
					eq(workBudgetEnvelopes.scopeId, p.workItemId),
				),
			)
			.limit(1)
	)[0];
	let budgetMutation;
	if (p.specification.budget) {
		budgetMutation = existingBudget
			? db
					.update(workBudgetEnvelopes)
					.set({
						limitMicros: p.specification.budget.limitMicros,
						reservationMicros: p.specification.budget.reservationMicros,
						enabled: true,
						updatedAt: p.now,
						version: sql`${workBudgetEnvelopes.version}+1`,
					})
					.where(
						and(
							eq(workBudgetEnvelopes.id, existingBudget.id),
							eq(workBudgetEnvelopes.version, existingBudget.version),
							currentSpec,
						),
					)
			: db.insert(workBudgetEnvelopes).select(
					db
						.select({
							id: sql<string>`${crypto.randomUUID()}`.as("id"),
							orgId: workItems.orgId,
							scopeType: sql<"work_item">`'work_item'`.as("scope_type"),
							scopeId: workItems.id,
							limitMicros:
								sql<number>`${p.specification.budget.limitMicros}`.as(
									"limit_micros",
								),
							reservationMicros:
								sql<number>`${p.specification.budget.reservationMicros}`.as(
									"reservation_micros",
								),
							currency: sql<"USD">`'USD'`.as("currency"),
							enabled: sql<boolean>`1`.as("enabled"),
							createdAt: sql<string>`${p.now}`.as("created_at"),
							updatedAt: sql<null>`NULL`.as("updated_at"),
							version: sql<number>`1`.as("version"),
						})
						.from(workItems)
						.where(
							and(
								eq(workItems.orgId, p.orgId),
								eq(workItems.id, p.workItemId),
								eq(workItems.version, p.expectedWorkItemVersion),
								eq(
									workItems.admissionSpecRevision,
									p.expectedAdmissionSpecRevision,
								),
							),
						),
				);
	} else
		budgetMutation = db
			.delete(workBudgetEnvelopes)
			.where(
				and(
					eq(workBudgetEnvelopes.orgId, p.orgId),
					eq(workBudgetEnvelopes.scopeType, "work_item"),
					eq(workBudgetEnvelopes.scopeId, p.workItemId),
					currentSpec,
				),
			);
	const bump = db
		.update(workItems)
		.set({
			admissionSpecRevision: sql`lower(hex(randomblob(16)))`,
			updatedAt: p.now,
			version: sql`${workItems.version}+1`,
		})
		.where(
			and(
				eq(workItems.orgId, p.orgId),
				eq(workItems.id, p.workItemId),
				eq(workItems.version, p.expectedWorkItemVersion),
				eq(workItems.admissionSpecRevision, p.expectedAdmissionSpecRevision),
			),
		)
		.returning({ id: workItems.id });
	try {
		const results = await db.batch([
			deleteRequirements,
			...inserts,
			budgetMutation,
			bump,
		]);
		const bumped = results.at(-1) as Array<{ id: string }>;
		if (!bumped[0]) throw new Error("stale");
	} catch {
		throw new WorkControlError(
			"CONFLICT",
			"Admission specification lost its update race or references an unavailable pool",
		);
	}
	return getWorkAdmissionSpecification(db, {
		orgId: p.orgId,
		workItemId: p.workItemId,
	});
}
