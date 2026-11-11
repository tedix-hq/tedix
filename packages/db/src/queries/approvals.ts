/**
 * Tedi Approval Request Query Helpers
 * CRUD operations for the tedi_approval_requests table
 *
 * Used by the approval flow and the Tedix OS Work management UI.
 */

import { STALE_OWNER_TOOL_RUN_MS } from "@tedix/api-contract/utils/owner-tool-execution";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	recordCardCreationEdges,
	recordDecisionResolutionEdges,
} from "./decision-graph-writers";
import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { kernelRuntimeRuns } from "../schema/cognitive-runtime";
import { apps } from "../schema/apps";
import { appTools } from "../schema/tools";
import type { KernelRuntimeRunUpdate } from "./kernel-runtime-runs";
import { osWorkspaceChildVisibleToPredicate } from "./os-workspaces/workspaces";
import {
	type ApprovalStatus,
	type TediApprovalRequest,
	type TediProvisionalOutcome,
	tediApprovalRequests,
	tediProvisionalOutcomes,
} from "../schema/approvals";
import { tedis } from "../schema/tedis";
import { tediApprovalDependencyEvents } from "../schema/approval-simulations";
import { getAffectedRows } from "../utils/d1-result";
import {
	buildInsertAuditEventStatement,
	type InsertAuditEventParams,
} from "./audit";

// ============================================================================
// Types
// ============================================================================

export interface CreateApprovalRequestParams {
	id: string;
	tediId: string;
	orgId: string;
	actionType: string;
	description: string;
	payload: Record<string, JsonValue>;
	createdAt: string;
	expiresAt: string;
	workflowId?: string;
	automaticApproval?: { tediId: string; reason: string };
}

export interface ListApprovalRequestsOptions {
	orgId?: string;
	viewerUserId?: string;
	tediId?: string;
	status?: ApprovalStatus;
	actionType?: string;
	executionAttentionOnly?: boolean;
	limit?: number;
	offset?: number;
}

export interface ResolveApprovalRequestParams {
	status: "approved" | "rejected" | "cancelled";
	resolvedBy: string;
	resolution?: string;
	/**
	 * Approver-edited payload, written in the same pending→approved update so
	 * the executor only ever sees the approved input.
	 */
	payload?: Record<string, JsonValue>;
}

export interface CreateProvisionalOutcomeParams {
	id: string;
	tediId: string;
	orgId: string;
	conversationId?: string;
	runId?: string;
	kind: "draft" | "configuration_proposal";
	title: string;
	payload: Record<string, JsonValue>;
	createdAt: string;
}

export interface TransitionProvisionalOutcomeParams {
	id: string;
	orgId: string;
	actorId: string;
	at: string;
}

export interface EnsureProvisionalPromotionApprovalParams {
	id: string;
	provisionalOutcomeId: string;
	provisionalOutcomeHash: string;
	tediId: string;
	orgId: string;
	description: string;
	createdAt: string;
	expiresAt: string;
	workflowId: string;
}

// ============================================================================
// Read Operations
// ============================================================================

/**
 * List approval requests with optional filters and pagination
 */
export async function listApprovalRequests(
	db: DbClient,
	options: ListApprovalRequestsOptions,
): Promise<{ data: TediApprovalRequest[]; total: number }> {
	const { orgId, limit = 50, offset = 0 } = options;

	const conditions: ReturnType<typeof eq>[] = [];
	if (orgId) {
		conditions.push(eq(tediApprovalRequests.orgId, orgId));
	}

	if (options.tediId) {
		conditions.push(eq(tediApprovalRequests.tediId, options.tediId));
	}
	if (options.status) {
		conditions.push(eq(tediApprovalRequests.status, options.status));
	}
	if (options.actionType) {
		conditions.push(eq(tediApprovalRequests.actionType, options.actionType));
	}
	if (options.executionAttentionOnly) {
		conditions.push(
			eq(tediApprovalRequests.status, "approved"),
			eq(tediApprovalRequests.actionType, "mcp.tool_call"),
			sql`json_extract(${tediApprovalRequests.payload}, '$.execution.status') IN ('queued', 'running', 'failed')`,
			sql`json_extract(${tediApprovalRequests.payload}, '$.execution.dismissedAt') IS NULL`,
			// A passed window can never run again; History keeps the row.
			gt(tediApprovalRequests.expiresAt, new Date().toISOString()),
		);
	}
	if (options.viewerUserId) {
		if (!orgId) return { data: [], total: 0 };
		const personId = options.viewerUserId;
		const conversationId = sql`COALESCE(json_extract(${tediApprovalRequests.payload}, '$.homeConversationId'), json_extract(${tediApprovalRequests.payload}, '$.conversationId'), (SELECT conversation_id FROM kernel_runtime_runs WHERE organization_id = ${tediApprovalRequests.orgId} AND id = json_extract(${tediApprovalRequests.payload}, '$.homeRunId')))`;
		const workspaceId = sql`COALESCE(json_extract(${tediApprovalRequests.payload}, '$.workspaceId'), (SELECT workspace_id FROM kernel_conversations WHERE organization_id = ${tediApprovalRequests.orgId} AND conversation_id = ${conversationId}))`;
		conditions.push(
			sql`NOT EXISTS (SELECT 1 FROM tedis AS personal WHERE personal.id = ${tediApprovalRequests.tediId} AND personal.organization_id = ${tediApprovalRequests.orgId} AND personal.scope = 'personal' AND (personal.owner_user_id IS NULL OR personal.owner_user_id <> ${personId}))`,
			sql`(NOT EXISTS (SELECT 1 FROM kernel_conversation_grants AS grants WHERE grants.organization_id = ${tediApprovalRequests.orgId} AND grants.conversation_id = ${conversationId}) OR EXISTS (SELECT 1 FROM kernel_conversation_grants AS mine WHERE mine.organization_id = ${tediApprovalRequests.orgId} AND mine.conversation_id = ${conversationId} AND mine.grantee_descope_user_id = ${personId}))`,
			osWorkspaceChildVisibleToPredicate(db, orgId, workspaceId, {
				userIds: [personId],
			}),
		);
	}

	const whereClause = and(...conditions);

	const data = await db
		.select()
		.from(tediApprovalRequests)
		.where(whereClause)
		.orderBy(desc(tediApprovalRequests.createdAt))
		.limit(limit)
		.offset(offset);

	const total = await db.$count(tediApprovalRequests, whereClause);

	return { data, total };
}

/**
 * Get a single approval request by ID
 */
export async function getApprovalRequestById(
	db: DbClient,
	id: string,
	orgId?: string,
): Promise<TediApprovalRequest | undefined> {
	const results = await db
		.select()
		.from(tediApprovalRequests)
		.where(
			and(
				eq(tediApprovalRequests.id, id),
				orgId ? eq(tediApprovalRequests.orgId, orgId) : undefined,
			),
		);
	return results[0];
}

export async function listProvisionalOutcomes(
	db: DbClient,
	input: { orgId: string; tediId?: string; limit?: number },
): Promise<TediProvisionalOutcome[]> {
	const conditions = [eq(tediProvisionalOutcomes.orgId, input.orgId)];
	if (input.tediId) {
		conditions.push(eq(tediProvisionalOutcomes.tediId, input.tediId));
	}
	return db
		.select()
		.from(tediProvisionalOutcomes)
		.where(and(...conditions))
		.orderBy(desc(tediProvisionalOutcomes.createdAt))
		.limit(input.limit ?? 50);
}

export async function getProvisionalOutcomeById(
	db: DbClient,
	id: string,
): Promise<TediProvisionalOutcome | undefined> {
	const rows = await db
		.select()
		.from(tediProvisionalOutcomes)
		.where(eq(tediProvisionalOutcomes.id, id));
	return rows[0];
}

// ============================================================================
// Write Operations
// ============================================================================

/**
 * Create a new pending approval request
 */
export async function createApprovalRequest(
	db: DbClient,
	data: CreateApprovalRequestParams,
): Promise<TediApprovalRequest> {
	const results = await buildCreateApprovalRequestStatement(db, data);
	const created = results[0];
	if (!created)
		throw new Error(`Failed to create approval request: ${data.id}`);
	await recordApprovalCardCreation(db, created);
	return created;
}

/**
 * Create a pending approval request and its audit row in one D1 batch: both
 * land or neither does.
 */
export async function createApprovalRequestWithAudit(
	db: DbClient,
	data: CreateApprovalRequestParams,
	audit: InsertAuditEventParams,
): Promise<TediApprovalRequest> {
	const [results] = await db.batch([
		buildCreateApprovalRequestStatement(db, data),
		buildInsertAuditEventStatement(db, audit).statement,
	]);
	const created = results[0];
	if (!created)
		throw new Error(`Failed to create approval request: ${data.id}`);
	await recordApprovalCardCreation(db, created);
	return created;
}

async function recordApprovalCardCreation(
	db: DbClient,
	approval: TediApprovalRequest,
) {
	if (approval.status !== "pending") return;
	await recordCardCreationEdges(db, {
		id: `approval:${approval.id}`,
		orgId: approval.orgId,
		workItemId:
			typeof approval.payload.workItemId === "string"
				? approval.payload.workItemId
				: null,
		kind: "question",
		targetType: "user",
		subject: approval.description,
		prompt: approval.description,
		metadata: approval.payload,
		createdAt: approval.createdAt,
	});
}

/** Unexecuted pending-approval insert, for `db.batch()` composition. */
export function buildCreateApprovalRequestStatement(
	db: DbClient,
	data: CreateApprovalRequestParams,
) {
	return db
		.insert(tediApprovalRequests)
		.values({
			id: data.id,
			tediId: data.tediId,
			orgId: data.orgId,
			actionType: data.actionType,
			description: data.description,
			payload: data.payload,
			status: data.automaticApproval ? "approved" : "pending",
			resolvedBy: data.automaticApproval?.tediId ?? null,
			resolution: data.automaticApproval?.reason ?? null,
			resolvedAt: data.automaticApproval ? data.createdAt : null,
			createdAt: data.createdAt,
			expiresAt: data.expiresAt,
			workflowId: data.workflowId ?? null,
		})
		.returning();
}

/** One immutable payment rejection may create only one human review request. */
export async function ensurePaymentBudgetOverrideRequest(
	db: DbClient,
	data: CreateApprovalRequestParams,
): Promise<{ request: TediApprovalRequest; created: boolean }> {
	if (
		data.actionType !== "payment_budget_override" ||
		data.payload.kind !== "payment_budget_override" ||
		typeof data.payload.rejectedEventId !== "string"
	) {
		throw new Error("Invalid payment budget override request");
	}
	const [created] = await db
		.insert(tediApprovalRequests)
		.values({
			...data,
			status: "pending",
			workflowId: data.workflowId ?? null,
		})
		.onConflictDoNothing({ target: tediApprovalRequests.id })
		.returning();
	if (created) {
		await recordApprovalCardCreation(db, created);
		return { request: created, created: true };
	}
	const existing = await getApprovalRequestById(db, data.id);
	if (
		!existing ||
		existing.orgId !== data.orgId ||
		existing.tediId !== data.tediId ||
		existing.actionType !== data.actionType ||
		existing.payload.kind !== data.payload.kind ||
		existing.payload.rejectedEventId !== data.payload.rejectedEventId
	) {
		throw new Error("Payment budget override request identity conflict");
	}
	return { request: existing, created: false };
}

/**
 * Idempotently creates the canonical, exact approval for one immutable
 * provisional outcome. A deterministic id is safe only because every bound
 * field is checked before an existing row is reused.
 */
export async function ensureProvisionalPromotionApprovalRequest(
	db: DbClient,
	data: EnsureProvisionalPromotionApprovalParams,
): Promise<{ request: TediApprovalRequest; created: boolean }> {
	const payload = {
		kind: "provisional_outcome_promotion_v2",
		provisionalOutcomeId: data.provisionalOutcomeId,
		provisionalOutcomeHash: data.provisionalOutcomeHash,
	};
	const rows = await db
		.insert(tediApprovalRequests)
		.values({
			id: data.id,
			tediId: data.tediId,
			orgId: data.orgId,
			actionType: "provisional_outcome_promotion",
			description: data.description,
			payload,
			status: "pending",
			createdAt: data.createdAt,
			expiresAt: data.expiresAt,
			workflowId: data.workflowId,
		})
		.onConflictDoNothing({ target: tediApprovalRequests.id })
		.returning();
	if (rows[0]) {
		await recordApprovalCardCreation(db, rows[0]);
		return { request: rows[0], created: true };
	}

	const existing = await getApprovalRequestById(db, data.id);
	if (
		!existing ||
		existing.tediId !== data.tediId ||
		existing.orgId !== data.orgId ||
		existing.actionType !== "provisional_outcome_promotion" ||
		existing.payload.kind !== payload.kind ||
		existing.payload.provisionalOutcomeId !== payload.provisionalOutcomeId ||
		existing.payload.provisionalOutcomeHash !== payload.provisionalOutcomeHash
	) {
		throw new Error(
			`Approval request ${data.id} already exists with different content`,
		);
	}
	return { request: existing, created: false };
}

export async function createProvisionalOutcome(
	db: DbClient,
	data: CreateProvisionalOutcomeParams,
): Promise<TediProvisionalOutcome> {
	const rows = await db
		.insert(tediProvisionalOutcomes)
		.values({
			...data,
			conversationId: data.conversationId ?? null,
			runId: data.runId ?? null,
		})
		.returning();
	const created = rows[0];
	if (!created)
		throw new Error(`Failed to create provisional outcome: ${data.id}`);
	return created;
}

export async function promoteProvisionalOutcome(
	db: DbClient,
	params: TransitionProvisionalOutcomeParams & { approvalRequestId: string },
): Promise<TediProvisionalOutcome | undefined> {
	const rows = await db
		.update(tediProvisionalOutcomes)
		.set({
			state: "promoted",
			promotionApprovalRequestId: params.approvalRequestId,
			promotedAt: params.at,
			promotedBy: params.actorId,
		})
		.where(
			and(
				eq(tediProvisionalOutcomes.id, params.id),
				eq(tediProvisionalOutcomes.orgId, params.orgId),
				eq(tediProvisionalOutcomes.state, "provisional"),
			),
		)
		.returning();
	return rows[0];
}

export async function rollbackProvisionalOutcome(
	db: DbClient,
	params: TransitionProvisionalOutcomeParams & { reason: string },
): Promise<TediProvisionalOutcome | undefined> {
	const rows = await db
		.update(tediProvisionalOutcomes)
		.set({
			state: "rolled_back",
			rolledBackAt: params.at,
			rolledBackBy: params.actorId,
			rollbackReason: params.reason,
		})
		.where(
			and(
				eq(tediProvisionalOutcomes.id, params.id),
				eq(tediProvisionalOutcomes.orgId, params.orgId),
				eq(tediProvisionalOutcomes.state, "promoted"),
			),
		)
		.returning();
	return rows[0];
}

/**
 * Resolve an approval request (approve or reject)
 */
export async function resolveApprovalRequest(
	db: DbClient,
	id: string,
	params: ResolveApprovalRequestParams,
): Promise<TediApprovalRequest | undefined> {
	const resolvedAt = new Date().toISOString();
	const conditions = [
		eq(tediApprovalRequests.id, id),
		eq(tediApprovalRequests.status, "pending"),
	];
	if (params.status === "approved") {
		conditions.push(gt(tediApprovalRequests.expiresAt, resolvedAt));
		// No genuine baseline verifier is wired for dependency simulations yet.
		// Fail closed at the one shared approval CAS so every current caller
		// inherits the same authority boundary. Informational edges never block.
		conditions.push(sql`not exists (
			select 1
			from ${tediApprovalDependencyEvents} declared
			where declared.organization_id = ${tediApprovalRequests.orgId}
				and declared.dependent_approval_request_id = ${tediApprovalRequests.id}
				and declared.event_type = 'declared'
				and declared.dependency_kind = 'hard'
				and not exists (
					select 1
					from ${tediApprovalDependencyEvents} invalidated
					where invalidated.organization_id = declared.organization_id
						and invalidated.invalidates_event_id = declared.id
				)
		)`);
	}
	const results = await db
		.update(tediApprovalRequests)
		.set({
			status: params.status,
			resolvedBy: params.resolvedBy,
			resolvedAt,
			resolution: params.resolution ?? null,
			...(params.payload && params.status === "approved"
				? { payload: params.payload }
				: {}),
		})
		.where(and(...conditions))
		.returning();
	const resolved = results[0];
	if (
		resolved &&
		(resolved.status === "approved" || resolved.status === "rejected")
	)
		await recordDecisionResolutionEdges(db, {
			orgId: resolved.orgId,
			cardId: `approval:${resolved.id}`,
			decisionId: resolved.id,
			workItemId:
				typeof resolved.payload.workItemId === "string"
					? resolved.payload.workItemId
					: null,
			occurredAt: resolvedAt,
			source: "approval_resolution",
			evidenceRef: `approval:${resolved.id}`,
			note:
				resolved.resolution ?? `${resolved.status}: ${resolved.description}`,
		});
	return results[0];
}

export async function supersedeToolReviewApprovals(
	db: DbClient,
	input: { organizationId: string; appId: string },
) {
	return db
		.update(tediApprovalRequests)
		.set({
			status: "cancelled",
			resolvedAt: new Date().toISOString(),
			resolution:
				"Superseded: upstream tools changed. Review the latest card; no tools were approved.",
		})
		.where(
			and(
				eq(tediApprovalRequests.orgId, input.organizationId),
				eq(tediApprovalRequests.actionType, "mcp.tool_catalog_change"),
				eq(tediApprovalRequests.status, "pending"),
				sql`json_extract(${tediApprovalRequests.payload}, '$.appId') = ${input.appId}`,
				sql`not exists (select 1 from ${appTools} where ${appTools.appId} = ${input.appId} and ${appTools.reviewState} = 'pending')`,
			),
		)
		.returning();
}

/** Snapshot, re-batch and replace the app's queue in one D1 transaction. */
export async function reconcileToolReviewApproval(
	db: DbClient,
	input: {
		organizationId: string;
		appId: string;
		appName: string;
		tediId: string;
		createdAt: string;
		expiresAt: string;
	},
) {
	const id = crypto.randomUUID();
	const batchId = crypto.randomUUID();
	const ownedApp = sql`exists (select 1 from ${apps} where ${apps.id} = ${input.appId} and ${apps.organizationId} = ${input.organizationId})`;
	const pending = sql`pending.app_id = ${input.appId} and pending.review_state = 'pending'`;
	const count = sql<number>`(select count(*) from ${appTools} pending where ${pending})`;
	const [, , created] = await db.batch([
		db
			.update(appTools)
			.set({ reviewBatchId: batchId })
			.where(
				and(
					eq(appTools.appId, input.appId),
					eq(appTools.reviewState, "pending"),
					ownedApp,
				),
			),
		db
			.update(tediApprovalRequests)
			.set({
				status: "cancelled",
				resolvedAt: input.createdAt,
				resolution:
					"Superseded: upstream tools changed. Review the latest card; no tools were approved.",
				payload: sql`json_set(${tediApprovalRequests.payload}, '$.supersededBy', case when ${count} > 0 then ${id} else null end)`,
			})
			.where(
				and(
					eq(tediApprovalRequests.orgId, input.organizationId),
					eq(tediApprovalRequests.actionType, "mcp.tool_catalog_change"),
					eq(tediApprovalRequests.status, "pending"),
					sql`json_extract(${tediApprovalRequests.payload}, '$.appId') = ${input.appId}`,
					ownedApp,
				),
			),
		db
			.insert(tediApprovalRequests)
			.select(
				db
					.select({
						id: sql<string>`${id}`.as("id"),
						tediId: sql<string>`${input.tediId}`.as("tedi_id"),
						orgId: apps.organizationId,
						actionType: sql<string>`'mcp.tool_catalog_change'`.as(
							"action_type",
						),
						description:
							sql<string>`'Review ' || ${count} || ' upstream tool change' || case when ${count} = 1 then '' else 's' end || ' for ' || ${input.appName}`.as(
								"description",
							),
						payload: sql<
							Record<string, JsonValue>
						>`json_object('kind', 'mcp_tool_catalog_change', 'appId', ${input.appId}, 'reviewBatchId', ${batchId}, 'expectedCount', ${count}, 'changes', json((select json_group_array(json_object('rowId', pending.id, 'toolId', pending.tool_id, 'schemaSourceHash', pending.schema_source_hash, 'diff', json(pending.review_diff))) from ${appTools} pending where ${pending})))`.as(
							"payload",
						),
						status: sql<ApprovalStatus>`'pending'`.as("status"),
						createdAt: sql<string>`${input.createdAt}`.as("created_at"),
						expiresAt: sql<string>`${input.expiresAt}`.as("expires_at"),
					})
					.from(apps)
					.where(
						and(
							eq(apps.id, input.appId),
							eq(apps.organizationId, input.organizationId),
							sql`${count} > 0`,
						),
					),
			)
			.returning(),
	]);
	if (created[0]) await recordApprovalCardCreation(db, created[0]);
	return created;
}

/** Resolve and activate one exact upstream-definition batch atomically. */
export async function resolveToolCatalogApprovalRequest(
	db: DbClient,
	id: string,
	params: Omit<ResolveApprovalRequestParams, "status"> & {
		status: "approved";
	},
): Promise<TediApprovalRequest | undefined> {
	const resolvedAt = new Date().toISOString();
	const resolutionStatement = db
		.update(tediApprovalRequests)
		.set({
			status: "approved",
			resolvedBy: params.resolvedBy,
			resolvedAt,
			resolution: params.resolution ?? null,
			...(params.payload ? { payload: params.payload } : {}),
		})
		.where(
			and(
				eq(tediApprovalRequests.id, id),
				eq(tediApprovalRequests.status, "pending"),
				eq(tediApprovalRequests.actionType, "mcp.tool_catalog_change"),
				gt(tediApprovalRequests.expiresAt, resolvedAt),
				sql`json_type(${tediApprovalRequests.payload}, '$.appId') = 'text'`,
				sql`json_type(${tediApprovalRequests.payload}, '$.reviewBatchId') = 'text'`,
				sql`json_type(${tediApprovalRequests.payload}, '$.expectedCount') = 'integer'`,
				sql`json_extract(${tediApprovalRequests.payload}, '$.expectedCount') > 0`,
				sql`exists (
					select 1 from ${apps}
					where ${apps.id} = json_extract(${tediApprovalRequests.payload}, '$.appId')
						and ${apps.organizationId} = ${tediApprovalRequests.orgId}
				)`,
				sql`(
					select count(*) from ${appTools} pending
					where pending.app_id = json_extract(${tediApprovalRequests.payload}, '$.appId')
						and pending.review_state = 'pending'
				) = json_extract(${tediApprovalRequests.payload}, '$.expectedCount')`,
				sql`not exists (
					select 1 from ${appTools} pending
					where pending.app_id = json_extract(${tediApprovalRequests.payload}, '$.appId')
						and pending.review_state = 'pending'
						and (pending.review_batch_id is not json_extract(${tediApprovalRequests.payload}, '$.reviewBatchId')
							or not exists (select 1 from json_each(${tediApprovalRequests.payload}, '$.changes') change
								where json_extract(change.value, '$.rowId') = pending.id
									and json_extract(change.value, '$.schemaSourceHash') = pending.schema_source_hash))
				)`,
			),
		)
		.returning();
	const [resolvedRows] = await db.batch([
		resolutionStatement,
		db
			.update(appTools)
			.set({
				reviewState: "live",
				reviewDiff: null,
				reviewBatchId: null,
				updatedAt: resolvedAt,
			})
			.where(
				and(
					eq(appTools.reviewState, "pending"),
					sql`${appTools.appId} = (select json_extract(approved.payload, '$.appId') from ${tediApprovalRequests} approved where approved.id = ${id} and approved.status = 'approved' and approved.resolved_at = ${resolvedAt})`,
					sql`${appTools.reviewBatchId} = (select json_extract(approved.payload, '$.reviewBatchId') from ${tediApprovalRequests} approved where approved.id = ${id} and approved.status = 'approved' and approved.resolved_at = ${resolvedAt})`,
				),
			)
			.returning({ id: appTools.id }),
	]);
	const resolved = resolvedRows[0];
	if (resolved)
		await recordDecisionResolutionEdges(db, {
			orgId: resolved.orgId,
			cardId: `approval:${resolved.id}`,
			decisionId: resolved.id,
			workItemId: null,
			occurredAt: resolvedAt,
			source: "approval_resolution",
			evidenceRef: `approval:${resolved.id}`,
			note: resolved.resolution ?? `approved: ${resolved.description}`,
		});
	return resolved;
}

/**
 * Mark expired pending requests as "expired", optionally for one organization.
 * An approval is expired when its expiresAt timestamp is in the past.
 */
export async function expireStaleApprovals(
	db: DbClient,
	options: { organizationId?: string; resolvedBy?: string } = {},
): Promise<number> {
	const now = new Date().toISOString();
	const result = await db
		.update(tediApprovalRequests)
		.set({
			status: "expired",
			resolvedAt: now,
			...(options.resolvedBy
				? {
						resolvedBy: options.resolvedBy,
						resolution: "Expired: no one answered in time, so it did not run.",
					}
				: {}),
		})
		.where(
			and(
				eq(tediApprovalRequests.status, "pending"),
				lt(tediApprovalRequests.expiresAt, now),
				options.organizationId
					? eq(tediApprovalRequests.orgId, options.organizationId)
					: undefined,
			),
		);
	return getAffectedRows(result);
}

export interface AdmitKernelAutoWriteParams {
	approval: CreateApprovalRequestParams;
	requestedAudit: InsertAuditEventParams;
	approvedAudit: InsertAuditEventParams;
	runId: string;
	metadata: KernelRuntimeRunUpdate["metadata"];
	resolvedAt: string;
	resolution: string;
}

export async function admitKernelAutoWrite(
	db: DbClient,
	input: AdmitKernelAutoWriteParams,
): Promise<boolean> {
	if (input.approval.expiresAt <= input.resolvedAt)
		throw new Error("Auto approval expired before execution");
	// A strict approval PK insert is the replay fence. Never ignore a collision:
	// the whole batch must roll back before the caller can execute anything.
	const [, , , runs] = await db.batch([
		buildInsertAuditEventStatement(db, input.requestedAudit).statement,
		buildInsertAuditEventStatement(db, input.approvedAudit).statement,
		db
			.insert(tediApprovalRequests)
			.values({
				...input.approval,
				status: "approved",
				resolvedBy: "policy",
				resolvedAt: input.resolvedAt,
				resolution: input.resolution,
				workflowId: input.approval.workflowId ?? null,
			})
			.returning(),
		db
			.update(kernelRuntimeRuns)
			.set({ metadata: input.metadata, updatedAt: input.resolvedAt })
			.where(
				and(
					eq(kernelRuntimeRuns.id, input.runId),
					eq(kernelRuntimeRuns.organizationId, input.approval.orgId),
					eq(kernelRuntimeRuns.status, "running"),
					isNull(
						sql`json_extract(${kernelRuntimeRuns.metadata}, '$.kernelWriteExecutedAt')`,
					),
				),
			)
			.returning({ id: kernelRuntimeRuns.id }),
	]);
	return runs.length > 0;
}

/** The open request for this exact gateway call, so a retry never parks twice. */
export async function findPendingOwnerToolApproval(
	db: DbClient,
	input: { organizationId: string; fingerprint: string; now: string },
): Promise<{ id: string } | undefined> {
	const [row] = await db
		.select({ id: tediApprovalRequests.id })
		.from(tediApprovalRequests)
		.where(
			and(
				eq(tediApprovalRequests.orgId, input.organizationId),
				eq(tediApprovalRequests.status, "pending"),
				eq(tediApprovalRequests.actionType, "mcp.tool_call"),
				gt(tediApprovalRequests.expiresAt, input.now),
				sql`json_extract(${tediApprovalRequests.payload}, '$.fingerprint') = ${input.fingerprint}`,
			),
		)
		.orderBy(desc(tediApprovalRequests.createdAt))
		.limit(1);
	return row;
}

/** A single approved gateway call can be claimed once, before dispatch. */
export async function consumeOwnerToolApproval(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		fingerprint: string;
		now: string;
	},
): Promise<boolean> {
	const rows = await db
		.update(tediApprovalRequests)
		.set({
			payload: sql`CASE WHEN json_extract(${tediApprovalRequests.payload}, '$.execution.status') = 'failed' THEN json_set(${tediApprovalRequests.payload}, '$.consumedAt', ${input.now}, '$.execution.retryable', json('false')) ELSE json_set(${tediApprovalRequests.payload}, '$.consumedAt', ${input.now}) END`,
		})
		.where(
			and(
				eq(tediApprovalRequests.id, input.id),
				eq(tediApprovalRequests.orgId, input.organizationId),
				eq(tediApprovalRequests.status, "approved"),
				eq(tediApprovalRequests.actionType, "mcp.tool_call"),
				gt(tediApprovalRequests.expiresAt, input.now),
				sql`json_extract(${tediApprovalRequests.payload}, '$.fingerprint') = ${input.fingerprint}`,
				sql`json_extract(${tediApprovalRequests.payload}, '$.consumedAt') IS NULL`,
			),
		)
		.returning({ id: tediApprovalRequests.id });
	return rows.length === 1;
}

/** The recorded outcome of an approved gateway call the platform ran itself. */
export interface OwnerToolApprovalExecution {
	status: "queued" | "running" | "executed" | "failed";
	nextAttemptAt?: string;
	startedAt: string;
	finishedAt?: string;
	/** Plain-language result for people: "Client deleted", "Scope 'x' required". */
	summary?: string;
	error?: string;
	/**
	 * A failure the platform caused (catalog lookup, transport) rather than
	 * the target refusing or changing; an owner may try the call once more.
	 */
	retryable?: boolean;
	/** 2 on the first retry an owner or admin started, and so on; absent on the first run. */
	attempt?: number;
	retriedBy?: string;
	/** Only the requester can send it again (no provider call was made). */
	actionBy?: "requester";
	/** An owner or admin cleared it from the waiting list; it never runs again. */
	dismissedAt?: string;
	dismissedBy?: string;
}

/**
 * Clear an approved call's unfinished or failed run from the waiting list.
 * Only a run nothing is working on can be dismissed: a failed run, or one
 * cut off longer than `staleBefore` ago. A queued or live run keeps going.
 * Dismissed runs are never retried, by a person or by the queue.
 */
export async function dismissOwnerToolApprovalExecution(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		now: string;
		dismissedBy: string;
		staleBefore: string;
	},
): Promise<boolean> {
	const rows = await db
		.update(tediApprovalRequests)
		.set({
			payload: sql`json_set(${tediApprovalRequests.payload}, '$.execution.dismissedAt', ${input.now}, '$.execution.dismissedBy', ${input.dismissedBy})`,
		})
		.where(
			and(
				eq(tediApprovalRequests.id, input.id),
				eq(tediApprovalRequests.orgId, input.organizationId),
				eq(tediApprovalRequests.status, "approved"),
				eq(tediApprovalRequests.actionType, "mcp.tool_call"),
				sql`json_extract(${tediApprovalRequests.payload}, '$.execution.dismissedAt') IS NULL`,
				sql`(
					json_extract(${tediApprovalRequests.payload}, '$.execution.status') = 'failed'
					OR (json_extract(${tediApprovalRequests.payload}, '$.execution.status') = 'running'
						AND json_extract(${tediApprovalRequests.payload}, '$.execution.startedAt') < ${input.staleBefore})
				)`,
			),
		)
		.returning({ id: tediApprovalRequests.id });
	return rows.length === 1;
}

/**
 * Claim a retry of a failed platform-side execution. Only an approved,
 * unexpired, unconsumed request wins, and only when its last run failed or
 * started before `staleBefore` and never finished (the request that ran it
 * was cut off before the gateway consumed the approval, so nothing happened).
 * The gateway's consumed receipt keeps the call to one run; the losing side
 * of any race never executes.
 */
export async function reclaimOwnerToolApprovalExecution(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		now: string;
		retriedBy: string;
		staleBefore: string;
		/** 2 for the first retry, one more for each later retry. */
		attempt: number;
	},
): Promise<boolean> {
	const execution: OwnerToolApprovalExecution = {
		status: "running",
		startedAt: input.now,
		attempt: input.attempt,
		retriedBy: input.retriedBy,
	};
	const rows = await db
		.update(tediApprovalRequests)
		.set({
			// Retain the deferral marker so a cut-off automatic retry can be recovered.
			payload: sql`json_set(${tediApprovalRequests.payload}, '$.execution', json(json_set(${JSON.stringify(execution)}, '$.nextAttemptAt', json_extract(${tediApprovalRequests.payload}, '$.execution.nextAttemptAt'))))`,
		})
		.where(
			and(
				eq(tediApprovalRequests.id, input.id),
				eq(tediApprovalRequests.orgId, input.organizationId),
				eq(tediApprovalRequests.status, "approved"),
				eq(tediApprovalRequests.actionType, "mcp.tool_call"),
				gt(tediApprovalRequests.expiresAt, input.now),
				sql`(
					json_extract(${tediApprovalRequests.payload}, '$.execution.status') = 'failed'
					OR (json_extract(${tediApprovalRequests.payload}, '$.execution.status') = 'queued'
						AND json_extract(${tediApprovalRequests.payload}, '$.execution.nextAttemptAt') <= ${input.now})
					OR (json_extract(${tediApprovalRequests.payload}, '$.execution.status') = 'running'
						AND json_extract(${tediApprovalRequests.payload}, '$.execution.startedAt') < ${input.staleBefore})
				)`,
				sql`json_extract(${tediApprovalRequests.payload}, '$.consumedAt') IS NULL`,
				sql`json_extract(${tediApprovalRequests.payload}, '$.execution.dismissedAt') IS NULL`,
			),
		)
		.returning({ id: tediApprovalRequests.id });
	return rows.length === 1;
}

/**
 * Claim the one platform-side execution of an approved gateway call. Only an
 * approved, unexpired, never-claimed request wins; a re-settle, a second
 * approval path or a cancel race loses the update and never executes.
 */
export async function claimOwnerToolApprovalExecution(
	db: DbClient,
	input: { id: string; organizationId: string; now: string },
): Promise<boolean> {
	const execution: OwnerToolApprovalExecution = {
		status: "running",
		startedAt: input.now,
	};
	const rows = await db
		.update(tediApprovalRequests)
		.set({
			payload: sql`json_set(${tediApprovalRequests.payload}, '$.execution', json(${JSON.stringify(execution)}))`,
		})
		.where(
			and(
				eq(tediApprovalRequests.id, input.id),
				eq(tediApprovalRequests.orgId, input.organizationId),
				eq(tediApprovalRequests.status, "approved"),
				eq(tediApprovalRequests.actionType, "mcp.tool_call"),
				gt(tediApprovalRequests.expiresAt, input.now),
				sql`json_extract(${tediApprovalRequests.payload}, '$.kind') = 'mcp_tool_call'`,
				sql`json_extract(${tediApprovalRequests.payload}, '$.fingerprint') IS NOT NULL`,
				sql`json_extract(${tediApprovalRequests.payload}, '$.execution') IS NULL`,
				sql`json_extract(${tediApprovalRequests.payload}, '$.consumedAt') IS NULL`,
			),
		)
		.returning({ id: tediApprovalRequests.id });
	return rows.length === 1;
}

/** Record how the claimed execution ended, on the request itself. */
export async function recordOwnerToolApprovalExecution(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		execution: OwnerToolApprovalExecution;
	},
): Promise<OwnerToolApprovalExecution | null> {
	const rows = await db
		.update(tediApprovalRequests)
		.set({
			payload: sql`json_set(${tediApprovalRequests.payload}, '$.execution', json(CASE WHEN json_extract(${tediApprovalRequests.payload}, '$.consumedAt') IS NOT NULL THEN json_set(${JSON.stringify(input.execution)}, '$.retryable', json('false')) ELSE ${JSON.stringify(input.execution)} END))`,
		})
		.where(
			and(
				eq(tediApprovalRequests.id, input.id),
				eq(tediApprovalRequests.orgId, input.organizationId),
				eq(tediApprovalRequests.actionType, "mcp.tool_call"),
				sql`json_extract(${tediApprovalRequests.payload}, '$.execution.startedAt') = ${input.execution.startedAt}`,
			),
		)
		.returning({ payload: tediApprovalRequests.payload });
	const execution = rows[0]?.payload.execution;
	return execution && typeof execution === "object" && !Array.isArray(execution)
		? (execution as unknown as OwnerToolApprovalExecution)
		: null;
}

/**
 * An approved Home write authorizes one execution per approved call and
 * credential path: the slot is "<user|tenant>_<args digest>". The tenant slot
 * exists because a user-credential call that found no personal connection
 * reached no provider; its tenant fallback is the same approved call.
 */
export async function consumeHomeToolApprovalCall(
	db: DbClient,
	input: { id: string; organizationId: string; slot: string; now: string },
): Promise<boolean> {
	if (!/^(?:user|tenant)_[0-9a-f]{64}$/.test(input.slot))
		throw new Error("Invalid Home approval call slot");
	const path = `$.consumedCalls.${input.slot}`;
	const rows = await db
		.update(tediApprovalRequests)
		.set({
			payload: sql`json_set(${tediApprovalRequests.payload}, ${path}, ${input.now})`,
		})
		.where(
			and(
				eq(tediApprovalRequests.id, input.id),
				eq(tediApprovalRequests.orgId, input.organizationId),
				eq(tediApprovalRequests.status, "approved"),
				eq(tediApprovalRequests.actionType, "home.tool_write"),
				sql`json_extract(${tediApprovalRequests.payload}, ${path}) IS NULL`,
			),
		)
		.returning({ id: tediApprovalRequests.id });
	return rows.length === 1;
}

/** Bounded anchor lookup for the canonical approval queue's tedi foreign key. */
export async function getApprovalAnchor(
	db: DbClient,
	organizationId: string,
): Promise<{ id: string } | undefined> {
	const [row] = await db
		.select({ id: tedis.id })
		.from(tedis)
		.where(
			and(eq(tedis.organizationId, organizationId), isNull(tedis.retiredAt)),
		)
		.limit(1);
	return row;
}

/** Installation sweep: only explicitly deferred, unconsumed approved calls. */
export async function listDueOwnerToolApprovals(
	db: DbClient,
	now: string,
	limit = 100,
) {
	return db
		.select()
		.from(tediApprovalRequests)
		.where(
			and(
				eq(tediApprovalRequests.actionType, "mcp.tool_call"),
				eq(tediApprovalRequests.status, "approved"),
				sql`json_extract(${tediApprovalRequests.payload}, '$.kind') = 'mcp_tool_call'`,
				sql`(json_extract(${tediApprovalRequests.payload}, '$.execution.status') = 'queued' OR (json_extract(${tediApprovalRequests.payload}, '$.execution.status') = 'running' AND json_extract(${tediApprovalRequests.payload}, '$.execution.startedAt') < ${new Date(Date.parse(now) - STALE_OWNER_TOOL_RUN_MS).toISOString()}))`,
				sql`json_extract(${tediApprovalRequests.payload}, '$.execution.nextAttemptAt') <= ${now}`,
				sql`json_extract(${tediApprovalRequests.payload}, '$.consumedAt') IS NULL`,
				sql`json_extract(${tediApprovalRequests.payload}, '$.execution.dismissedAt') IS NULL`,
			),
		)
		.orderBy(
			sql`json_extract(${tediApprovalRequests.payload}, '$.execution.nextAttemptAt')`,
			tediApprovalRequests.id,
		)
		.limit(limit);
}
