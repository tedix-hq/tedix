import { and, eq, isNull } from "drizzle-orm";
import type { DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { anyIds } from "../core-store/dialect";
import { kernelHomeApprovalMirrors } from "../schema/index";

export type ActiveKernelApprovalMirror = Pick<
	typeof kernelHomeApprovalMirrors.$inferSelect,
	| "id"
	| "parentConversationId"
	| "childRunId"
	| "approvalRequestId"
	| "delegatedTediId"
	| "status"
	| "blockedAt"
	| "escalateAt"
	| "escalatedAt"
>;

export async function createKernelApprovalMirror(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		parentConversationId: string;
		childRunId: string;
		approvalRequestId: string;
		delegatedTediId?: string | null;
		blockedAt: string;
		escalateAt: number;
	},
): Promise<void> {
	const table = coreTable(db, kernelHomeApprovalMirrors);
	await db
		.insert(table)
		.values({ ...input, delegatedTediId: input.delegatedTediId ?? null })
		.onConflictDoNothing({ target: table.id });
}

/** A mirror row this call — and only this call — moved to `escalated`. */
export interface EscalatedKernelApprovalMirror {
	id: string;
	approvalRequestId: string;
}

/**
 * Move pending mirror rows to `escalated` and report which rows THIS call moved.
 *
 * The `status = 'pending' AND cleared_at IS NULL` predicate is already a CAS, so
 * `returning()` turns it into an exactly-once latch: a re-armed alarm, a second
 * DO activation, or a retry after a partial failure re-runs the update, matches
 * nothing, and returns `[]`. Callers that page a human off this result therefore
 * cannot double-notify. `approvalRequestId` is returned alongside the row id
 * because the mirror id is a `parentConversationId:childRunId:approvalRequestId`
 * join whose first segment itself contains colons (`home:main`) — it is not
 * safely parseable.
 */
export async function escalateKernelApprovalMirrors(
	db: DbClient,
	input: { ids: string[]; escalatedAt: string },
): Promise<EscalatedKernelApprovalMirror[]> {
	if (input.ids.length === 0) return [];
	const table = coreTable(db, kernelHomeApprovalMirrors);
	return db
		.update(table)
		.set({
			status: "escalated",
			escalatedAt: input.escalatedAt,
			updatedAt: input.escalatedAt,
		})
		.where(
			and(
				anyIds(db, table.id, [...new Set(input.ids)]),
				eq(table.status, "pending"),
				isNull(table.clearedAt),
			),
		)
		.returning({
			id: table.id,
			approvalRequestId: table.approvalRequestId,
		});
}

export async function clearKernelApprovalMirrors(
	db: DbClient,
	input: {
		organizationId: string;
		parentConversationId: string;
		childRunId: string;
		approvalRequestId?: string | null;
		clearedAt: string;
	},
): Promise<void> {
	const table = coreTable(db, kernelHomeApprovalMirrors);
	await db
		.update(table)
		.set({ clearedAt: input.clearedAt, updatedAt: input.clearedAt })
		.where(
			and(
				eq(table.organizationId, input.organizationId),
				eq(table.parentConversationId, input.parentConversationId),
				eq(table.childRunId, input.childRunId),
				...(input.approvalRequestId
					? [eq(table.approvalRequestId, input.approvalRequestId)]
					: []),
				isNull(table.clearedAt),
			),
		);
}

export async function listActiveKernelApprovalMirrors(
	db: DbClient,
	input: {
		organizationId: string;
		parentConversationId: string;
		limit?: number;
	},
): Promise<ActiveKernelApprovalMirror[]> {
	return db.query.kernelHomeApprovalMirrors.findMany({
		columns: {
			id: true,
			parentConversationId: true,
			childRunId: true,
			approvalRequestId: true,
			delegatedTediId: true,
			status: true,
			blockedAt: true,
			escalateAt: true,
			escalatedAt: true,
		},
		where: {
			organizationId: input.organizationId,
			parentConversationId: input.parentConversationId,
			clearedAt: { isNull: true },
			approvalRequest: {
				orgId: input.organizationId,
				status: "pending",
			},
		},
		orderBy: { blockedAt: "asc" },
		limit: input.limit ?? 100,
	});
}
