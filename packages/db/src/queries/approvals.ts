/**
 * Tedi Approval Request Query Helpers
 * CRUD operations for the tedi_approval_requests table
 *
 * Used by the approval flow and the Tedix OS Work management UI.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, desc, eq, gt, lt, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import {
	type ApprovalStatus,
	type TediApprovalRequest,
	type TediProvisionalOutcome,
	tediApprovalRequests,
	tediProvisionalOutcomes,
} from "../schema/approvals";
import { tediApprovalDependencyEvents } from "../schema/approval-simulations";
import { getAffectedRows } from "../utils/d1-result";

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
}

export interface ListApprovalRequestsOptions {
	orgId?: string;
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
): Promise<TediApprovalRequest | undefined> {
	const results = await db
		.select()
		.from(tediApprovalRequests)
		.where(eq(tediApprovalRequests.id, id));
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
	const results = await db
		.insert(tediApprovalRequests)
		.values({
			id: data.id,
			tediId: data.tediId,
			orgId: data.orgId,
			actionType: data.actionType,
			description: data.description,
			payload: data.payload,
			status: "pending",
			createdAt: data.createdAt,
			expiresAt: data.expiresAt,
			workflowId: data.workflowId ?? null,
		})
		.returning();
	const created = results[0];
	if (!created)
		throw new Error(`Failed to create approval request: ${data.id}`);
	return created;
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
	if (created) return { request: created, created: true };
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
	if (rows[0]) return { request: rows[0], created: true };

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
		})
		.where(and(...conditions))
		.returning();
	return results[0];
}

/**
 * Mark all expired pending requests as "expired".
 * An approval is expired when its expiresAt timestamp is in the past.
 */
export async function expireStaleApprovals(db: DbClient): Promise<number> {
	const now = new Date().toISOString();
	const result = await db
		.update(tediApprovalRequests)
		.set({
			status: "expired",
			resolvedAt: now,
		})
		.where(
			and(
				eq(tediApprovalRequests.status, "pending"),
				lt(tediApprovalRequests.expiresAt, now),
			),
		);
	return getAffectedRows(result);
}
