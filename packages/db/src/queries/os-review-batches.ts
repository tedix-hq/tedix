import { and, desc, eq, exists, gt, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
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

const l = alias(osShareLinks, "l");
const g = alias(osGadgets, "g");
const linkedGadget = and(
	eq(g.id, l.resourceId),
	eq(g.organizationId, l.organizationId),
);

/** A live `use` link to a gadget whose role policy still allows use. */
function usableGadgetLink(now: string) {
	return and(
		sql`${l.resourceType}='gadget'`,
		sql`${l.role}='use'`,
		or(isNull(l.policyMaxRole), sql`${l.policyMaxRole}='use'`),
		isNull(l.revokedAt),
		or(isNull(l.expiresAt), gt(l.expiresAt, now)),
	);
}

export async function createOsReviewBatch(
	db: DbQueryClient,
	row: typeof osReviewBatches.$inferInsert,
	now: string,
) {
	// l.id and g.id are primary keys: the join yields at most the one row the
	// former EXISTS checked for.
	const [batch] = await db
		.insert(osReviewBatches)
		.select(
			db
				.select({
					id: sql<string>`${row.id}`.as("id"),
					organizationId: sql<string>`${row.organizationId}`.as(
						"organization_id",
					),
					shareLinkId: sql<string>`${row.shareLinkId}`.as("share_link_id"),
					sourceOutputId: sql<string>`${row.sourceOutputId}`.as(
						"source_output_id",
					),
					sourceRevisionId: sql<string>`${row.sourceRevisionId}`.as(
						"source_revision_id",
					),
					title: sql<string>`${row.title}`.as("title"),
					cards: sql<string>`${row.cards}`.as("cards"),
					accessEnvelope: sql<string>`${row.accessEnvelope}`.as(
						"access_envelope",
					),
					createdById: sql<string>`${row.createdById}`.as("created_by_id"),
					createdAt: sql<string>`${row.createdAt}`.as("created_at"),
				})
				.from(l)
				.innerJoin(g, linkedGadget)
				.where(
					and(
						eq(l.id, row.shareLinkId),
						eq(l.organizationId, row.organizationId),
						sql`${l.createdByKind}='user'`,
						eq(l.createdById, row.createdById),
						usableGadgetLink(now),
						sql`${g.status}='active'`,
					),
				),
		)
		.onConflictDoNothing()
		.returning();
	return batch;
}
/** A link's current review round: its newest batch. Older rounds stay stored. */
export async function getOsReviewBatch(
	db: DbQueryClient,
	organizationId: string,
	shareLinkId: string,
	batchId?: string,
): Promise<OsReviewBatchRow | undefined> {
	const [row] = await db
		.select()
		.from(osReviewBatches)
		.where(
			and(
				eq(osReviewBatches.organizationId, organizationId),
				eq(osReviewBatches.shareLinkId, shareLinkId),
				batchId ? eq(osReviewBatches.id, batchId) : undefined,
			),
		)
		.orderBy(desc(osReviewBatches.createdAt), desc(osReviewBatches.id))
		.limit(1);
	return row;
}
/** Every round on a link, newest first, without card payloads. */
export async function listOsReviewBatchRounds(
	db: DbQueryClient,
	organizationId: string,
	shareLinkId: string,
) {
	return db
		.select({
			id: osReviewBatches.id,
			title: osReviewBatches.title,
			createdAt: osReviewBatches.createdAt,
		})
		.from(osReviewBatches)
		.where(
			and(
				eq(osReviewBatches.organizationId, organizationId),
				eq(osReviewBatches.shareLinkId, shareLinkId),
			),
		)
		.orderBy(desc(osReviewBatches.createdAt), desc(osReviewBatches.id))
		.limit(50);
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
		.orderBy(desc(osReviewBatches.createdAt), desc(osReviewBatches.id))
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
	const b = alias(osReviewBatches, "b");
	const caller =
		p.access.kind === "share"
			? sql`${l.id}=${p.access.shareId} and exists(select 1 from ${osShareSessions} s where s.share_link_id=${l.id} and s.session_token_hash=${p.access.sessionHash} and s.revoked_at is null and s.expires_at>${p.now})`
			: sql`${l.resourceId}=${p.access.gadgetId}`;
	// b.id, l.id and g.id are primary keys, so the join yields at most one row.
	const batchLink = eq(l.id, b.shareLinkId);
	const activeBatch = and(
		eq(b.id, p.batchId),
		eq(b.organizationId, p.organizationId),
		eq(l.organizationId, p.organizationId),
		caller,
		usableGadgetLink(p.now),
		sql`${g.status}='active'`,
		// json_each is a table-valued function; no builder form.
		sql`exists(select 1 from json_each(${b.cards}) c where json_extract(c.value,'$.id')=${p.cardId})`,
	);
	const active = exists(
		db
			.select({ one: sql`1` })
			.from(b)
			.innerJoin(l, batchLink)
			.innerJoin(g, linkedGadget)
			.where(activeBatch),
	);
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
				db
					.select({
						id: sql<string>`${crypto.randomUUID()}`.as("id"),
						organizationId: sql<string>`${p.organizationId}`.as(
							"organization_id",
						),
						batchId: sql<string>`${p.batchId}`.as("batch_id"),
						cardId: sql<string>`${p.cardId}`.as("card_id"),
						reviewerId: sql<string>`${p.reviewerId}`.as("reviewer_id"),
						revision: sql<number>`1`.as("revision"),
						decision: sql<string>`${p.decision}`.as("decision"),
						editedReply: sql<string>`${p.editedReply}`.as("edited_reply"),
						reason: sql<string>`${p.reason}`.as("reason"),
						updatedAt: sql<string>`${p.now}`.as("updated_at"),
					})
					.from(b)
					.innerJoin(l, batchLink)
					.innerJoin(g, linkedGadget)
					.where(activeBatch),
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
