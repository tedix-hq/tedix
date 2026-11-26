import { and, desc, eq, exists, gt, isNull, or, sql } from "drizzle-orm";
import { alias as sqliteAlias } from "drizzle-orm/sqlite-core";
import { alias as pgAlias } from "drizzle-orm/pg-core";
import { coreTable } from "../core-store/client";
import { coreStore } from "../core-store/dialect";
import type { DbQueryClient } from "../query-client";
import {
	osReviewBatches as d1OsReviewBatches,
	osReviewFeedback as d1OsReviewFeedback,
	osShareLinks as d1OsShareLinks,
	osShareSessions as d1OsShareSessions,
	type OsReviewBatchRow,
	type OsReviewFeedbackRow,
} from "../schema/os-shares";
import { osGadgets as d1OsGadgets } from "../schema/os-workspaces";

/** Aliases must be built per client: the Postgres core store swaps table objects. */
function reviewAlias<T extends Parameters<typeof sqliteAlias>[0]>(
	db: DbQueryClient,
	table: T,
	name: string,
) {
	const core = coreTable(db, table);
	return coreStore(db) === "postgres"
		? (pgAlias as unknown as typeof sqliteAlias)(core, name)
		: sqliteAlias(core, name);
}

function reviewLinkTables(db: DbQueryClient) {
	const l = reviewAlias(db, d1OsShareLinks, "l");
	const g = reviewAlias(db, d1OsGadgets, "g");
	const linkedGadget = and(
		eq(g.id, l.resourceId),
		eq(g.organizationId, l.organizationId),
	);
	/** A live `use` link to a gadget whose role policy still allows use. */
	const usableGadgetLink = (now: string) =>
		and(
			sql`${l.resourceType}='gadget'`,
			sql`${l.role}='use'`,
			or(isNull(l.policyMaxRole), sql`${l.policyMaxRole}='use'`),
			isNull(l.revokedAt),
			or(isNull(l.expiresAt), gt(l.expiresAt, now)),
		);
	return { l, g, linkedGadget, usableGadgetLink };
}

export async function createOsReviewBatch(
	db: DbQueryClient,
	row: typeof d1OsReviewBatches.$inferInsert,
	now: string,
) {
	const osReviewBatches = coreTable(db, d1OsReviewBatches);
	const { l, g, linkedGadget, usableGadgetLink } = reviewLinkTables(db);
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
	const osReviewBatches = coreTable(db, d1OsReviewBatches);
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
	const osReviewBatches = coreTable(db, d1OsReviewBatches);
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
	const osReviewBatches = coreTable(db, d1OsReviewBatches);
	const osShareLinks = coreTable(db, d1OsShareLinks);
	const { usableGadgetLink } = reviewLinkTables(db);
	const [row] = await db
		.select()
		.from(osReviewBatches)
		.where(
			and(
				eq(osReviewBatches.organizationId, p.organizationId),
				sql`exists(select 1 from ${osShareLinks} l where l.id=${osReviewBatches.shareLinkId} and l.organization_id=${p.organizationId} and l.resource_id=${p.gadgetId} and ${usableGadgetLink(p.now)})`,
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
	const osReviewFeedback = coreTable(db, d1OsReviewFeedback);
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
	const osReviewBatches = coreTable(db, d1OsReviewBatches);
	const osReviewFeedback = coreTable(db, d1OsReviewFeedback);
	const osShareSessions = coreTable(db, d1OsShareSessions);
	const b = reviewAlias(db, d1OsReviewBatches, "b");
	const { l, g, linkedGadget, usableGadgetLink } = reviewLinkTables(db);
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
		// Table-valued JSON expansion has no builder form; the element shape is
		// a cards array in both stores.
		coreStore(db) === "postgres"
			? sql`exists(select 1 from jsonb_array_elements(case when jsonb_typeof(${b.cards}::jsonb)='array' then ${b.cards}::jsonb else '[]'::jsonb end) c where c.value->>'id'=${p.cardId})`
			: sql`exists(select 1 from json_each(${b.cards}) c where json_extract(c.value,'$.id')=${p.cardId})`,
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
