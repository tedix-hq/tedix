import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type {
	DeckPipelineConfig,
	DeckSweepReceipt,
} from "@tedix/api-contract/schemas/deck-pipeline";
import { DeckSweepReceiptSchema } from "@tedix/api-contract/schemas/deck-pipeline";
import type { DbQueryClient } from "../../query-client";
import { organizations } from "../../schema/organizations";
import { organizationMembers } from "../../schema/organization-members";
import { workInteractions } from "../../schema/work-factory";
import {
	workItems,
	workAttempts,
	workItemRelations,
} from "../../schema/work-items";

/** Organizations that configured decision learning; a small table, bounded. */
export async function listDeckSweepOrganizations(
	db: DbQueryClient,
	limit = 50,
) {
	const rows = await db
		.select({ id: organizations.id })
		.from(organizations)
		.where(
			sql`json_extract(${organizations.metadata}, '$.decisionLearning') IS NOT NULL`,
		)
		.orderBy(organizations.id)
		.limit(limit);
	return rows.map((row) => row.id);
}

/** Active human members, most recently active first; both id spellings a card may target. */
export async function listDeckSweepRecipients(
	db: DbQueryClient,
	orgId: string,
	limit: number,
) {
	const rows = await db
		.select({
			userId: organizationMembers.userId,
			descopeUserId: organizationMembers.descopeUserId,
		})
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.organizationId, orgId),
				eq(organizationMembers.status, "active"),
				eq(organizationMembers.kind, "human"),
			),
		)
		.orderBy(desc(organizationMembers.lastActiveAt))
		.limit(limit);
	return rows.map((row) => ({
		recipientIds: [
			...new Set([row.userId ?? row.descopeUserId, row.descopeUserId]),
		],
	}));
}

/** One recipient's cards in one state, newest first, on the target/status index. */
export async function listRecipientCards(
	db: DbQueryClient,
	p: {
		orgId: string;
		recipientId: string;
		status: "open" | "resolved" | "cancelled";
		limit: number;
	},
) {
	return db
		.select({
			id: workInteractions.id,
			kind: workInteractions.kind,
			status: workInteractions.status,
			subject: workInteractions.subject,
			prompt: workInteractions.prompt,
			creatorType: workInteractions.creatorType,
			creatorId: workInteractions.creatorId,
			workItemId: workInteractions.workItemId,
			dueAt: workInteractions.dueAt,
			expiresAt: workInteractions.expiresAt,
			createdAt: workInteractions.createdAt,
			resolvedAt: workInteractions.resolvedAt,
			cancelledAt: workInteractions.cancelledAt,
			version: workInteractions.version,
			metadata: workInteractions.metadata,
		})
		.from(workInteractions)
		.where(
			and(
				eq(workInteractions.orgId, p.orgId),
				eq(workInteractions.targetType, "user"),
				eq(workInteractions.targetId, p.recipientId),
				eq(workInteractions.status, p.status),
			),
		)
		.orderBy(desc(workInteractions.createdAt))
		.limit(Math.min(p.limit, 200));
}

/** Terminal Work wins; unresolved dependency edges and the latest expired Attempt withdraw old asks. */
export async function listDeckSourceStates(
	db: DbQueryClient,
	orgId: string,
	ids: readonly string[],
	now: Date,
) {
	const result = new Map<string, string>();
	const unique = [...new Set(ids)];
	for (let offset = 0; offset < unique.length; offset += 50) {
		const rows = await db
			.select({
				id: workItems.id,
				state: sql<string>`CASE
			WHEN ${workItems.disposition} IN ('completed','cancelled') THEN ${workItems.disposition}
			WHEN EXISTS (SELECT 1 FROM ${workItemRelations} r JOIN ${workItems} dependency ON dependency.id=r.from_work_item_id AND dependency.org_id=r.org_id WHERE r.org_id=${orgId} AND r.to_work_item_id=${workItems}.${sql.identifier("id")} AND r.relation_type='blocks' AND dependency.disposition NOT IN ('completed','cancelled')) THEN 'blocked'
			WHEN (SELECT CASE WHEN a.runtime_state='expired' OR (a.runtime_state IN ('running','queued','waiting','retrying') AND a.expires_at<=${now.toISOString()}) THEN 1 ELSE 0 END FROM ${workAttempts} a WHERE a.org_id=${orgId} AND a.work_item_id=${workItems}.${sql.identifier("id")} ORDER BY a.attempt_number DESC, a.id DESC LIMIT 1)=1 THEN 'expired'
			ELSE ${workItems.disposition} END`,
			})
			.from(workItems)
			.where(
				and(
					eq(workItems.orgId, orgId),
					inArray(workItems.id, unique.slice(offset, offset + 50)),
				),
			)
			.limit(50);
		for (const row of rows) result.set(row.id, row.state);
	}
	return result;
}

/** Current status of a bounded list of cards (undo detection). */
export async function listCardStatuses(
	db: DbQueryClient,
	orgId: string,
	ids: readonly string[],
) {
	const result = new Map<string, string>();
	const unique = [...new Set(ids)];
	for (let offset = 0; offset < unique.length; offset += 50) {
		const rows = await db
			.select({ id: workInteractions.id, status: workInteractions.status })
			.from(workInteractions)
			.where(
				and(
					eq(workInteractions.orgId, orgId),
					isNotNull(workInteractions.targetId),
					inArray(workInteractions.id, unique.slice(offset, offset + 50)),
				),
			);
		for (const row of rows) result.set(row.id, row.status);
	}
	return result;
}

export async function getDeckSweepReceipt(db: DbQueryClient, orgId: string) {
	const [row] = await db
		.select({
			receipt: sql<
				string | null
			>`json_extract(${organizations.metadata}, '$.deckSweep')`,
		})
		.from(organizations)
		.where(eq(organizations.id, orgId))
		.limit(1);
	if (!row?.receipt) return null;
	const parsed = DeckSweepReceiptSchema.safeParse(
		typeof row.receipt === "string" ? JSON.parse(row.receipt) : row.receipt,
	);
	return parsed.success ? parsed.data : null;
}

/** Narrow write: only the receipt path changes, never the rest of the metadata. */
export async function recordDeckSweepReceipt(
	db: DbQueryClient,
	orgId: string,
	receipt: DeckSweepReceipt,
) {
	const parsed = DeckSweepReceiptSchema.parse(receipt);
	await db
		.update(organizations)
		.set({
			metadata: sql`json_set(coalesce(${organizations.metadata}, '{}'), '$.deckSweep', json(${JSON.stringify(parsed)}))`,
		})
		.where(eq(organizations.id, orgId));
}

/** Narrow write of the learned parts of the Deck pipeline config. */
export async function setDeckPipelineLearned(
	db: DbQueryClient,
	orgId: string,
	learned: Pick<DeckPipelineConfig, "rules" | "hidingClasses">,
) {
	await db
		.update(organizations)
		.set({
			metadata: sql`json_set(coalesce(${organizations.metadata}, '{}'), '$.decisionLearning.deckPipeline.rules', json(${JSON.stringify(learned.rules)}), '$.decisionLearning.deckPipeline.hidingClasses', json(${JSON.stringify(learned.hidingClasses)}))`,
		})
		.where(eq(organizations.id, orgId));
}
