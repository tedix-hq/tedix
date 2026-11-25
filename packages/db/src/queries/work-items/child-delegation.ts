import { coreTable } from "../../core-store/client";
import {
	jsonRead,
	jsonType,
	jsonParameter,
	booleanValue,
	coreStore,
	anyIds,
} from "../../core-store/dialect";
import { and, eq, inArray, getColumns, sql, type SQL } from "drizzle-orm";
import { TaskContractTermsSchema } from "@tedix/api-contract/schemas/task-contract-terms";
import { assertChildTaskContract } from "@tedix/api-contract/utils/task-contract-terms";
import { getAdmittedTaskContract } from "./task-contract";
import {
	LaneExecutionPolicySchema,
	WORK_DELEGATION_DEFAULTS,
} from "@tedix/api-contract/schemas/lane-execution";
import {
	capApprovalMode,
	type ApprovalMode,
} from "@tedix/api-contract/schemas/workspace-agent-access";
import type { CreateWorkItemInput } from "@tedix/api-contract/schemas/work-items";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { DbQueryClient } from "../../query-client";
import {
	workAttemptMessages,
	workItemComments,
	workItemRelations,
	workAttempts,
	workEvents,
	workItems,
	workItemStoredColumns,
	type WorkItem,
} from "../../schema/work-items";
import {
	workAdmissions,
	workCaseItems,
	workResourceRequirements,
} from "../../schema/work-factory";
import { organizations } from "../../schema/organizations";
import { getWorkItemsByIds } from "./crud";
import type { WorkActor } from "./factory-state";
import { WorkControlError } from "./factory-validation";
import { normalizeWorkItemRow } from "./normalization";

function workTreeContains(orgId: string, rootId: string, itemId: SQL) {
	return sql`${itemId} IN (WITH RECURSIVE tree(id) AS (
		SELECT id FROM work_items WHERE org_id=${orgId} AND id=${rootId}
		UNION SELECT child.id FROM work_items child JOIN tree ON child.parent_work_item_id=tree.id WHERE child.org_id=${orgId}
	) SELECT id FROM tree)`;
}

export async function workDelegationAncestors(
	db: DbQueryClient,
	item: WorkItem,
) {
	const items = coreTable(db, workItems);
	const rows =
		item.parentWorkItemId && item.metadata?.childDelegation
			? await db
					.select(
						Object.fromEntries(
							Object.keys(workItemStoredColumns).map((key) => [
								key,
								getColumns(items)[key as keyof typeof workItemStoredColumns],
							]),
						) as typeof workItemStoredColumns,
					)
					.from(items)
					.where(
						and(
							eq(items.orgId, item.orgId),
							sql`${items.id} IN (
				WITH RECURSIVE ancestry(id, depth) AS (
					SELECT ${item.parentWorkItemId}, 1
					UNION ALL SELECT parent.parent_work_item_id, ancestry.depth + 1
					FROM work_items parent JOIN ancestry ON parent.id=ancestry.id
					WHERE parent.org_id=${item.orgId} AND ancestry.depth<=10 AND parent.parent_work_item_id IS NOT NULL
				) SELECT id FROM ancestry
			)`,
						),
					)
			: [];
	const byId = new Map(rows.map((row) => [row.id, normalizeWorkItemRow(row)]));
	const ancestors = [item];
	while (
		ancestors.at(-1)!.parentWorkItemId &&
		ancestors.at(-1)!.metadata?.childDelegation
	) {
		const parent = byId.get(ancestors.at(-1)!.parentWorkItemId!);
		if (
			!parent ||
			ancestors.some((node) => node.id === parent.id) ||
			ancestors.length > 10
		)
			throw new WorkControlError(
				"NOT_ELIGIBLE",
				"Invalid Work delegation ancestry",
			);
		ancestors.push(parent);
	}
	return ancestors;
}

export async function createChildWorkItem(
	db: DbQueryClient,
	p: {
		input: CreateWorkItemInput;
		parent: WorkItem;
		actor: WorkActor;
		externalSessionKey?: string;
		now: string;
	},
): Promise<WorkItem | null> {
	const storeWorkAttempts = coreTable(db, workAttempts);
	const storeWorkAdmissions = coreTable(db, workAdmissions);
	const storeOrganizations = coreTable(db, organizations);
	const storeWorkItems = coreTable(db, workItems);
	const storeWorkResourceRequirements = coreTable(db, workResourceRequirements);
	const storeWorkCaseItems = coreTable(db, workCaseItems);
	const storeWorkItemRelations = coreTable(db, workItemRelations);
	const storeWorkEvents = coreTable(db, workEvents);

	if (p.actor.type !== "external_agent" && p.actor.type !== "tedi") return null;
	const parent = p.parent;
	const attempt = (
		await db
			.select()
			.from(storeWorkAttempts)
			.where(
				and(
					eq(storeWorkAttempts.orgId, parent.orgId),
					eq(storeWorkAttempts.workItemId, parent.id),
					eq(storeWorkAttempts.executorType, p.actor.type),
					eq(storeWorkAttempts.executorId, p.actor.id),
					p.actor.sessionId
						? eq(storeWorkAttempts.executorSessionId, p.actor.sessionId)
						: undefined,
					p.externalSessionKey
						? eq(storeWorkAttempts.externalSessionKey, p.externalSessionKey)
						: undefined,
					inArray(storeWorkAttempts.runtimeState, [
						"running",
						"waiting",
						"retrying",
					]),
					sql`${storeWorkAttempts.expiresAt}>${p.now}`,
				),
			)
			.limit(1)
	)[0];
	if (!attempt) return null;
	if (
		parent.disposition !== "accepted" ||
		!parent.acceptanceContract ||
		!attempt.admissionId
	)
		throw new WorkControlError(
			"NOT_ELIGIBLE",
			"Child Work requires an admitted parent Attempt",
		);
	const admission = (
		await db
			.select()
			.from(storeWorkAdmissions)
			.where(
				and(
					eq(storeWorkAdmissions.id, attempt.admissionId),
					eq(storeWorkAdmissions.orgId, parent.orgId),
					eq(storeWorkAdmissions.workItemId, parent.id),
					eq(
						storeWorkAdmissions.admissionSpecRevision,
						parent.admissionSpecRevision,
					),
					eq(storeWorkAdmissions.decision, "admitted"),
				),
			)
			.limit(1)
	)[0];
	if (!admission)
		throw new WorkControlError(
			"NOT_ELIGIBLE",
			"The parent's admitted specification changed",
		);
	const predecessors = [...new Set(p.input.blockedByWorkItemIds ?? [])];
	if (
		predecessors.length &&
		(await getWorkItemsByIds(db, { orgId: parent.orgId, ids: predecessors }))
			.length !== predecessors.length
	)
		throw new WorkControlError(
			"NOT_FOUND",
			"Child predecessor is outside this organization",
		);
	const ancestors = await workDelegationAncestors(db, parent);
	const parentContract = await getAdmittedTaskContract(db, attempt);
	if (!parentContract)
		throw new WorkControlError(
			"NOT_ELIGIBLE",
			"Parent has no admitted task contract",
		);
	const parsedContract = TaskContractTermsSchema.safeParse(
		p.input.taskContract,
	);
	if (!parsedContract.success)
		throw new WorkControlError(
			"NOT_ELIGIBLE",
			"task_contract_required: Child Work requires complete taskContract terms",
		);
	const childContract = parsedContract.data;
	try {
		assertChildTaskContract(parentContract, childContract);
	} catch (error) {
		throw new WorkControlError(
			"NOT_ELIGIBLE",
			error instanceof Error ? error.message : "Invalid child task contract",
		);
	}
	if (Date.parse(childContract.deadline) <= Date.parse(p.now))
		throw new WorkControlError("NOT_ELIGIBLE", "Task deadline elapsed");
	const root = ancestors.at(-1)!;
	const lane =
		parent.metadata?.laneExecution === undefined
			? undefined
			: LaneExecutionPolicySchema.parse({
					...(parent.metadata?.laneExecution as object),
					delegationDepth: parent.delegationDepth,
					maxAttempts: parent.maxAttempts,
				});
	const rootLane = root.metadata?.laneExecution as
		| {
				maxDelegationDepth?: number;
				maxDescendants?: number;
				approvalMode?: ApprovalMode;
		  }
		| undefined;
	const maxDepth =
		rootLane?.maxDelegationDepth ?? WORK_DELEGATION_DEFAULTS.maxDelegationDepth;
	const maxDescendants = Math.min(
		rootLane?.maxDescendants ?? WORK_DELEGATION_DEFAULTS.maxDescendants,
		lane?.maxDescendants ?? WORK_DELEGATION_DEFAULTS.maxDescendants,
	);
	if (
		ancestors.length > Math.min(maxDepth, lane?.maxDelegationDepth ?? maxDepth)
	)
		throw new WorkControlError(
			"NOT_ELIGIBLE",
			"Work delegation depth exhausted",
		);
	const input = p.input;
	if (
		input.requiredCapabilities.some(
			(c) => !parent.requiredCapabilities.includes(c),
		) ||
		input.requiredAuthorities.some(
			(c) => !parent.requiredAuthorities.includes(c),
		) ||
		(input.projectId && input.projectId !== parent.projectId) ||
		(input.accountableOwnerId &&
			input.accountableOwnerId !== parent.accountableOwnerId) ||
		(input.accountableOwnerType &&
			input.accountableOwnerType !== parent.accountableOwnerType)
	)
		throw new WorkControlError(
			"NOT_ELIGIBLE",
			"Child Work cannot exceed its parent's risk, capabilities, authorities or ownership",
		);
	const org = (
		await db
			.select({ metadata: storeOrganizations.metadata })
			.from(storeOrganizations)
			.where(eq(storeOrganizations.id, parent.orgId))
			.limit(1)
	)[0];
	const inheritedMode =
		(
			parent.metadata?.childDelegation as
				| { approvalMode?: ApprovalMode }
				| undefined
		)?.approvalMode ??
		lane?.approvalMode ??
		rootLane?.approvalMode ??
		WORK_DELEGATION_DEFAULTS.approvalMode;
	const mode = capApprovalMode(
		capApprovalMode(
			inheritedMode,
			lane?.approvalMode ?? WORK_DELEGATION_DEFAULTS.approvalMode,
		),
		org?.metadata?.workDelegation?.approvalMode ??
			WORK_DELEGATION_DEFAULTS.approvalMode,
	);
	const accepted = mode === "auto";
	const id = crypto.randomUUID();
	const metadata: Record<string, JsonValue> = {
		...input.metadata,
		...(lane
			? {
					laneExecution: {
						...(parent.metadata?.laneExecution as Record<string, JsonValue>),
						approvalMode: mode,
						executors: lane.executors.filter((e) => {
							const maker = lane.executors.find(
								(allowed) =>
									allowed.principalType === attempt.executorType &&
									allowed.principalId === attempt.executorId,
							);
							return (
								maker &&
								e.capabilities.every((c) => maker.capabilities.includes(c))
							);
						}),
					},
				}
			: {}),
		childDelegation: {
			parentAttemptId: attempt.id,
			parentRevision: parent.admissionSpecRevision,
			rootId: root.id,
			approvalMode: mode,
		},
	};
	delete metadata.executor;
	delete metadata.laneDispatch;
	const rootQuery = db
		.select({ id: storeWorkItems.id })
		.from(storeWorkItems)
		.where(
			and(
				eq(storeWorkItems.orgId, parent.orgId),
				eq(storeWorkItems.id, root.id),
			),
		);
	// PostgreSQL must serialize descendant allocations before the next statement reads their totals.
	const rootLock =
		coreStore(db) === "postgres"
			? (
					rootQuery as typeof rootQuery & {
						for(strength: "update"): typeof rootQuery;
					}
				).for("update")
			: rootQuery;
	const [, rows] = await db.batch([
		rootLock,
		db
			.insert(storeWorkItems)
			.values({
				id,
				orgId: parent.orgId,
				// The NOT NULL title makes a stale grant or concurrent descendant overflow roll back the entire batch.
				title: sql`CASE WHEN EXISTS (SELECT 1 FROM work_attempts a JOIN work_items p ON p.id=a.work_item_id AND p.org_id=a.org_id JOIN work_admissions grant_receipt ON grant_receipt.id=a.admission_id AND grant_receipt.admission_spec_revision=p.admission_spec_revision
				WHERE a.id=${attempt.id} AND a.expires_at>${p.now} AND a.runtime_state IN ('running','waiting','retrying') AND p.version=${parent.version} AND p.disposition='accepted')
				AND (SELECT count(*) FROM work_items WHERE ${workTreeContains(parent.orgId, root.id, sql`id`)}) <= ${maxDescendants}
				AND (SELECT coalesce(sum(${jsonRead(db, sql`allocation.payload`, ["taskContract", "budget", "maxTokens"], "number")}),0) FROM work_events allocation JOIN work_items child ON child.id=allocation.id AND child.org_id=allocation.org_id WHERE child.org_id=${parent.orgId} AND child.parent_work_item_id=${parent.id}) + ${childContract.budget.maxTokens} <= ${parentContract.budget.maxTokens}
				AND (SELECT coalesce(sum(${jsonRead(db, sql`allocation.payload`, ["taskContract", "budget", "maxCostUsd"], "number")}),0) FROM work_events allocation JOIN work_items child ON child.id=allocation.id AND child.org_id=allocation.org_id WHERE child.org_id=${parent.orgId} AND child.parent_work_item_id=${parent.id}) + ${childContract.budget.maxCostUsd} <= ${parentContract.budget.maxCostUsd}
				THEN ${input.title} ELSE NULL END`,
				description: input.description,
				workKind: input.workKind,
				riskLevel: parent.riskLevel,
				requiredCapabilities: parent.requiredCapabilities,
				requiredAuthorities: parent.requiredAuthorities,
				accountableOwnerType: parent.accountableOwnerType,
				accountableOwnerId: parent.accountableOwnerId,
				stewardType: parent.stewardType,
				stewardId: parent.stewardId,
				objectiveId: parent.objectiveId,
				workClass: parent.workClass,
				purposeExceptionExpiresAt: parent.purposeExceptionExpiresAt,
				projectId: parent.projectId,
				parentWorkItemId: parent.id,
				rootWorkItemId: root.id,
				executorType: input.executorReference?.type ?? parent.executorType,
				executorId: input.executorReference?.id ?? parent.executorId,
				dispatchState: "ready",
				delegationDepth: (parent.delegationDepth ?? 0) + 1,
				maxAttempts: parent.maxAttempts ?? WORK_DELEGATION_DEFAULTS.maxAttempts,
				priority: input.priority,
				disposition: accepted ? "accepted" : "proposed",
				acceptanceContract: {
					version: 1,
					doneLooksLike: childContract.goal,
					taskContract: childContract,
				},
				acceptedAt: accepted ? p.now : null,
				metadata,
				admissionSpecRevision: crypto.randomUUID(),
				createdAt: p.now,
				sourceIntentId: input.sourceIntentId,
				startAt: input.startAt,
			})
			.returning(
				Object.fromEntries(
					Object.keys(workItemStoredColumns).map((key) => [
						key,
						getColumns(storeWorkItems)[
							key as keyof typeof workItemStoredColumns
						],
					]),
				) as typeof workItemStoredColumns,
			),
		db.insert(storeWorkResourceRequirements).select(
			db
				.select({
					orgId: storeWorkResourceRequirements.orgId,
					workItemId: sql<string>`${id}`.as("work_item_id"),
					resourceKey: storeWorkResourceRequirements.resourceKey,
					quantity: storeWorkResourceRequirements.quantity,
					createdAt: sql<string>`${p.now}`.as("created_at"),
					updatedAt: sql<string>`${p.now}`.as("updated_at"),
				})
				.from(storeWorkResourceRequirements)
				.where(
					and(
						eq(storeWorkResourceRequirements.orgId, parent.orgId),
						eq(storeWorkResourceRequirements.workItemId, parent.id),
					),
				),
		),
		db.insert(storeWorkCaseItems).select(
			db
				.select({
					id: (coreStore(db) === "postgres"
						? sql<string>`gen_random_uuid()::text`
						: sql<string>`lower(hex(randomblob(16)))`
					).as("id"),
					orgId: storeWorkCaseItems.orgId,
					caseId: storeWorkCaseItems.caseId,
					workItemId: sql<string>`${id}`.as("work_item_id"),
					discoveredAt: sql<string>`${p.now}`.as("discovered_at"),
				})
				.from(storeWorkCaseItems)
				.where(
					and(
						eq(storeWorkCaseItems.orgId, parent.orgId),
						eq(storeWorkCaseItems.workItemId, parent.id),
					),
				),
		),
		...(input.blockedByWorkItemIds?.length
			? [
					db.insert(storeWorkItemRelations).values(
						[...new Set(input.blockedByWorkItemIds)].map((predecessor) => ({
							id: crypto.randomUUID(),
							orgId: parent.orgId,
							fromWorkItemId: predecessor,
							toWorkItemId: id,
							relationType: "blocks" as const,
							createdAt: p.now,
						})),
					),
				]
			: []),
		db.insert(storeWorkEvents).values({
			id,
			orgId: parent.orgId,
			workItemId: id,
			eventType: accepted ? "work.accepted" : "work.created",
			actorType: p.actor.type,
			actorId: p.actor.id,
			actorSessionId: p.actor.sessionId,
			payload: {
				parentAttemptId: attempt.id,
				rootId: root.id,
				taskContract: childContract,
			},
			occurredAt: p.now,
		}),
	]);
	return normalizeWorkItemRow(rows[0]!);
}

/** Admission still checks the child's own executor, resources and money. Only acceptance authority descends. */
export async function inheritedChildAuthority(
	db: DbQueryClient,
	item: WorkItem,
	executor?: { type: string; id: string },
) {
	const storeWorkAttempts = coreTable(db, workAttempts);
	const storeOrganizations = coreTable(db, organizations);

	if (!item.metadata?.childDelegation) return false;
	const ancestors = await workDelegationAncestors(db, item);
	const attempts = await db
		.select()
		.from(storeWorkAttempts)
		.where(
			and(
				eq(storeWorkAttempts.orgId, item.orgId),
				anyIds(
					db,
					storeWorkAttempts.id,
					ancestors
						.slice(0, -1)
						.map(
							(child) =>
								(
									child.metadata?.childDelegation as
										| { parentAttemptId?: string }
										| undefined
								)?.parentAttemptId ?? "",
						),
				),
			),
		);
	for (let i = 0; i < ancestors.length - 1; i++) {
		const child = ancestors[i]!;
		const parent = ancestors[i + 1]!;
		const grant = child.metadata?.childDelegation as
			| {
					parentAttemptId?: string;
					parentRevision?: string;
					approvalMode?: ApprovalMode;
			  }
			| undefined;
		if (
			!grant ||
			grant.parentRevision !== parent.admissionSpecRevision ||
			!["accepted", "completed"].includes(parent.disposition)
		)
			throw new WorkControlError(
				"NOT_ELIGIBLE",
				"The parent's delegation grant changed",
			);
		const attempt = attempts.find(
			(row) => row.id === grant.parentAttemptId && row.workItemId === parent.id,
		);
		if (
			!attempt?.admissionId ||
			(executor &&
				parent.metadata?.laneExecution === undefined &&
				(attempt.executorType !== executor.type ||
					attempt.executorId !== executor.id))
		)
			throw new WorkControlError(
				"NOT_ELIGIBLE",
				"Child executor is outside the parent's admitted authority",
			);
		if (
			child.riskLevel !== parent.riskLevel ||
			child.requiredCapabilities.some(
				(c) => !parent.requiredCapabilities.includes(c),
			) ||
			parent.requiredAuthorities.some(
				(c) => !child.requiredAuthorities.includes(c),
			) ||
			child.requiredAuthorities.some(
				(c) => !parent.requiredAuthorities.includes(c),
			) ||
			parent.requiredCapabilities.some(
				(c) => !child.requiredCapabilities.includes(c),
			)
		)
			throw new WorkControlError(
				"NOT_ELIGIBLE",
				"Child Work exceeds its parent's authority",
			);
		if (grant.approvalMode !== "auto") return false;
	}
	const org = (
		await db
			.select({ metadata: storeOrganizations.metadata })
			.from(storeOrganizations)
			.where(eq(storeOrganizations.id, item.orgId))
			.limit(1)
	)[0];
	const root = ancestors.at(-1)!;
	const lane = root.metadata?.laneExecution as
		| { maxDelegationDepth?: number }
		| undefined;
	if (
		ancestors.length - 1 >
		(lane?.maxDelegationDepth ?? WORK_DELEGATION_DEFAULTS.maxDelegationDepth)
	)
		throw new WorkControlError(
			"NOT_ELIGIBLE",
			"Work delegation depth exhausted",
		);
	return (
		(org?.metadata?.workDelegation?.approvalMode ??
			WORK_DELEGATION_DEFAULTS.approvalMode) === "auto"
	);
}

export function rootAttemptBudgetAvailable(orgId: string, rootId: string) {
	return sql`((NOT EXISTS (SELECT 1 FROM work_items delegated WHERE delegated.org_id=${orgId} AND delegated.delegation_root_id=${rootId})) OR ((SELECT COUNT(*) FROM work_attempts root_attempt
		WHERE root_attempt.org_id=${orgId} AND ${workTreeContains(orgId, rootId, sql`root_attempt.work_item_id`)}
		AND (root_attempt.outcome IS NULL OR root_attempt.outcome NOT IN ('cancelled','rejected')))
		< COALESCE((SELECT max_attempts FROM work_items WHERE org_id=${orgId} AND id=${rootId}),${WORK_DELEGATION_DEFAULTS.maxAttempts})
		+ (SELECT COUNT(*) FROM work_events WHERE org_id=${orgId} AND work_item_id=${rootId} AND event_type='lane.attempt_granted')))`;
}

export function childReportStatements(
	db: DbQueryClient,
	p: {
		orgId: string;
		workItemId: string;
		attemptId: string;
		settledVersion: number;
		outcome: string;
		summary?: string;
		now: string;
	},
) {
	const storeWorkItems = coreTable(db, workItems);
	const storeWorkAttempts = coreTable(db, workAttempts);
	const storeWorkItemComments = coreTable(db, workItemComments);
	const storeWorkAttemptMessages = coreTable(db, workAttemptMessages);
	const body = `Child Work ${p.workItemId}: ${p.outcome}. ${p.summary ?? "No summary supplied."}`;
	const winner = and(
		eq(storeWorkItems.orgId, p.orgId),
		eq(storeWorkItems.id, p.workItemId),
		eq(storeWorkAttempts.id, p.attemptId),
		eq(storeWorkAttempts.version, p.settledVersion),
		sql`${jsonType(db, storeWorkItems.metadata, ["childDelegation", "parentAttemptId"])}='string'`,
	);
	return [
		db
			.insert(storeWorkItemComments)
			.select(
				db
					.select({
						id: sql<string>`${`child-report:${p.attemptId}`}`.as("id"),
						orgId: storeWorkItems.orgId,
						workItemId: sql<string>`${storeWorkItems.parentWorkItemId}`.as(
							"work_item_id",
						),
						authorType: sql<"system">`'system'`.as("author_type"),
						authorId: sql<string>`'child-work'`.as("author_id"),
						body: sql<string>`${body}`.as("body"),
						metadata: jsonParameter(db, {
							childWorkItemId: p.workItemId,
							childAttemptId: p.attemptId,
						}).as("metadata"),
						createdAt: sql<string>`${p.now}`.as("created_at"),
					})
					.from(storeWorkItems)
					.innerJoin(
						storeWorkAttempts,
						and(
							eq(storeWorkAttempts.orgId, storeWorkItems.orgId),
							eq(storeWorkAttempts.workItemId, storeWorkItems.id),
						),
					)
					.where(winner),
			)
			.onConflictDoNothing(),
		db
			.insert(storeWorkAttemptMessages)
			.select(
				db
					.select({
						id: sql<string>`${`child-report:${p.attemptId}`}`.as("id"),
						orgId: storeWorkItems.orgId,
						workItemId: sql<string>`${storeWorkItems.parentWorkItemId}`.as(
							"work_item_id",
						),
						attemptId: jsonRead(db, storeWorkItems.metadata, [
							"childDelegation",
							"parentAttemptId",
						]).as("attempt_id"),
						kind: sql<"follow_up">`'follow_up'`.as("kind"),
						body: sql<string>`${body}`.as("body"),
						senderType: storeWorkAttempts.executorType,
						senderId: storeWorkAttempts.executorId,
						interrupt: booleanValue(db, false).as("interrupt"),
						createdAt: sql<string>`${p.now}`.as("created_at"),
					})
					.from(storeWorkItems)
					.innerJoin(
						storeWorkAttempts,
						and(
							eq(storeWorkAttempts.orgId, storeWorkItems.orgId),
							eq(storeWorkAttempts.workItemId, storeWorkItems.id),
						),
					)
					.where(winner),
			)
			.onConflictDoNothing(),
	] as const;
}
