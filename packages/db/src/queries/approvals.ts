/**
 * Tedi Approval Request Query Helpers
 * CRUD operations for the tedi_approval_requests table
 *
 * Used by the approval flow and the Tedix OS Work management UI.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	recordCardCreationEdges,
	recordDecisionResolutionEdges,
} from "./decision-graph-writers";
import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { kernelRuntimeRuns } from "../schema/cognitive-runtime";
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
			payload: sql`json_set(${tediApprovalRequests.payload}, '$.consumedAt', ${input.now})`,
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
