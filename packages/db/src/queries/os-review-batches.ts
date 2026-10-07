import { and, desc, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import {
	osReviewBatches,
	osReviewFeedback,
	osShareLinks,
	osShareSessions,
	type OsReviewBatchRow,
	type OsReviewFeedbackRow,
} from "../schema/os-shares";
import { osGadgets } from "../schema/os-workspaces";

export async function createOsReviewBatch(
	db: DbQueryClient,
	row: typeof osReviewBatches.$inferInsert,
	now: string,
) {
	const [batch] = await db
		.insert(osReviewBatches)
		.select(
			sql`select ${row.id},${row.organizationId},${row.shareLinkId},${row.sourceOutputId},${row.sourceRevisionId},${row.title},${row.cards},${row.accessEnvelope},${row.createdById},${row.createdAt} where exists(select 1 from ${osShareLinks} l join ${osGadgets} g on g.id=l.resource_id and g.organization_id=l.organization_id where l.id=${row.shareLinkId} and l.organization_id=${row.organizationId} and l.created_by_kind='user' and l.created_by_id=${row.createdById} and l.resource_type='gadget' and l.role='use' and (l.policy_max_role is null or l.policy_max_role='use') and l.revoked_at is null and (l.expires_at is null or l.expires_at>${now}) and g.status='active')`,
		)
		.onConflictDoNothing()
		.returning();
	return batch;
}
export async function getOsReviewBatch(
	db: DbQueryClient,
	organizationId: string,
	shareLinkId: string,
): Promise<OsReviewBatchRow | undefined> {
	const [row] = await db
		.select()
		.from(osReviewBatches)
		.where(
			and(
				eq(osReviewBatches.organizationId, organizationId),
				eq(osReviewBatches.shareLinkId, shareLinkId),
			),
		);
	return row;
}
/**
 * The newest batch bound to an active, review-only share link of this gadget.
 * Workspace members review the same batch recipients see; the share link is
 * the binding, so revoking or expiring it closes the review in both places.
 */
export async function getActiveOsReviewBatchForGadget(
	db: DbQueryClient,
	p: { organizationId: string; gadgetId: string; now: string },
): Promise<OsReviewBatchRow | undefined> {
	const [row] = await db
		.select()
		.from(osReviewBatches)
		.where(
			and(
				eq(osReviewBatches.organizationId, p.organizationId),
				sql`exists(select 1 from ${osShareLinks} l where l.id=${osReviewBatches.shareLinkId} and l.organization_id=${p.organizationId} and l.resource_type='gadget' and l.resource_id=${p.gadgetId} and l.role='use' and (l.policy_max_role is null or l.policy_max_role='use') and l.revoked_at is null and (l.expires_at is null or l.expires_at>${p.now}))`,
			),
		)
		.orderBy(desc(osReviewBatches.createdAt))
		.limit(1);
	return row;
}
export async function listOsReviewFeedback(
	db: DbQueryClient,
	organizationId: string,
	batchId: string,
	reviewerId?: string,
) {
	return db
		.select()
		.from(osReviewFeedback)
		.where(
			and(
				eq(osReviewFeedback.organizationId, organizationId),
				eq(osReviewFeedback.batchId, batchId),
				reviewerId ? eq(osReviewFeedback.reviewerId, reviewerId) : undefined,
			),
		);
}
/**
 * Who is writing: a share recipient proves a live redemption session; a
 * workspace member proves (in the router) workspace access to the bound gadget.
 */
export type OsReviewFeedbackAccess =
	| { kind: "share"; shareId: string; sessionHash: string }
	| { kind: "workspace"; gadgetId: string };
/** Session or gadget, link, tenant, card and gadget liveness are fenced in the write itself. */
export async function saveOsReviewFeedback(
	db: DbQueryClient,
	p: {
		organizationId: string;
		access: OsReviewFeedbackAccess;
		batchId: string;
		cardId: string;
		reviewerId: string;
		expectedRevision: number;
		decision: OsReviewFeedbackRow["decision"];
		editedReply: string;
		reason: string;
		now: string;
	},
) {
	const caller =
		p.access.kind === "share"
			? sql`l.id=${p.access.shareId} and exists(select 1 from ${osShareSessions} s where s.share_link_id=l.id and s.session_token_hash=${p.access.sessionHash} and s.revoked_at is null and s.expires_at>${p.now})`
			: sql`l.resource_id=${p.access.gadgetId}`;
	const active = sql`exists(select 1 from ${osReviewBatches} b
 join ${osShareLinks} l on l.id=b.share_link_id
 join ${osGadgets} g on g.id=l.resource_id and g.organization_id=l.organization_id
 where b.id=${p.batchId} and b.organization_id=${p.organizationId} and l.organization_id=${p.organizationId}
 and ${caller} and l.resource_type='gadget' and l.role='use'
 and (l.policy_max_role is null or l.policy_max_role='use')
 and l.revoked_at is null and (l.expires_at is null or l.expires_at>${p.now})
 and g.status='active' and exists(select 1 from json_each(b.cards) c where json_extract(c.value,'$.id')=${p.cardId}))`;
	const values = {
		organizationId: p.organizationId,
		batchId: p.batchId,
		cardId: p.cardId,
		reviewerId: p.reviewerId,
		decision: p.decision,
		editedReply: p.editedReply,
		reason: p.reason,
		updatedAt: p.now,
	};
	if (p.expectedRevision === 0) {
		// INSERT ... SELECT prevents inserting after revocation, unlike a preliminary read.
		const [row] = await db
			.insert(osReviewFeedback)
			.select(
				sql`select ${crypto.randomUUID()},${p.organizationId},${p.batchId},${p.cardId},${p.reviewerId},1,${p.decision},${p.editedReply},${p.reason},${p.now} where ${active}`,
			)
			.onConflictDoNothing()
			.returning();
		return row;
	}
	const [row] = await db
		.update(osReviewFeedback)
		.set({ ...values, revision: p.expectedRevision + 1 })
		.where(
			and(
				eq(osReviewFeedback.organizationId, p.organizationId),
				eq(osReviewFeedback.batchId, p.batchId),
				eq(osReviewFeedback.cardId, p.cardId),
				eq(osReviewFeedback.reviewerId, p.reviewerId),
				eq(osReviewFeedback.revision, p.expectedRevision),
				active,
			),
		)
		.returning();
	return row;
}
