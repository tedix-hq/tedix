import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DbClient } from "../client";
import { kernelHomeApprovalMirrors } from "../schema/index";
import { chunkForBoundParams } from "../utils/batch";

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
	await db
		.insert(kernelHomeApprovalMirrors)
		.values({ ...input, delegatedTediId: input.delegatedTediId ?? null })
		.onConflictDoNothing({ target: kernelHomeApprovalMirrors.id });
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
	const escalated: EscalatedKernelApprovalMirror[] = [];
	// D1 caps bound parameters at 100 per statement; chunk the id IN() list.
	for (const chunk of chunkForBoundParams([...new Set(input.ids)], 50)) {
		escalated.push(
			...(await db
				.update(kernelHomeApprovalMirrors)
				.set({
					status: "escalated",
					escalatedAt: input.escalatedAt,
					updatedAt: input.escalatedAt,
				})
				.where(
					and(
						inArray(kernelHomeApprovalMirrors.id, chunk),
						eq(kernelHomeApprovalMirrors.status, "pending"),
						isNull(kernelHomeApprovalMirrors.clearedAt),
					),
				)
				.returning({
					id: kernelHomeApprovalMirrors.id,
					approvalRequestId: kernelHomeApprovalMirrors.approvalRequestId,
				})),
		);
	}
	return escalated;
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
	await db
		.update(kernelHomeApprovalMirrors)
		.set({ clearedAt: input.clearedAt, updatedAt: input.clearedAt })
		.where(
			and(
				eq(kernelHomeApprovalMirrors.organizationId, input.organizationId),
				eq(
					kernelHomeApprovalMirrors.parentConversationId,
					input.parentConversationId,
				),
				eq(kernelHomeApprovalMirrors.childRunId, input.childRunId),
				...(input.approvalRequestId
					? [
							eq(
								kernelHomeApprovalMirrors.approvalRequestId,
								input.approvalRequestId,
							),
						]
					: []),
				isNull(kernelHomeApprovalMirrors.clearedAt),
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
