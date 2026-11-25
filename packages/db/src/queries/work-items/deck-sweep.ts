import { coreTable } from "../../core-store/client";
import {
	anyIds,
	coreStore,
	jsonRead,
	jsonWrite,
} from "../../core-store/dialect";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type {
	DeckPipelineConfig,
	DeckSweepReceipt,
} from "@tedix/api-contract/schemas/deck-pipeline";
import { DeckSweepReceiptSchema } from "@tedix/api-contract/schemas/deck-pipeline";
import type { DbQueryClient } from "../../query-client";
import { organizations as d1Organizations } from "../../schema/organizations";
import { organizationMembers as d1OrganizationMembers } from "../../schema/organization-members";
import { projects as d1Projects } from "../../schema/projects";
import { tediObjectives as d1TediObjectives } from "../../schema/tedi-objectives";
import { listCardSourceWork } from "../decision-graph";
import type { ServedObjective } from "@tedix/api-contract/schemas/organization-purpose";
import type { DeckSourceWorkFacts } from "@tedix/api-contract/schemas/deck-priority";
import { workInteractions as d1WorkInteractions } from "../../schema/work-factory";
import {
	workItems as d1WorkItems,
	workAttempts as d1WorkAttempts,
	workItemRelations as d1WorkItemRelations,
} from "../../schema/work-items";

/** Organizations that configured decision learning; a small table, bounded. */
export async function listDeckSweepOrganizations(
	db: DbQueryClient,
	limit = 50,
) {
	const organizations = coreTable(db, d1Organizations);
	const rows = await db
		.select({ id: organizations.id })
		.from(organizations)
		.where(
			sql`${jsonRead(db, organizations.metadata, ["decisionLearning"])} IS NOT NULL`,
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
	const organizationMembers = coreTable(db, d1OrganizationMembers);
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
	const workInteractions = coreTable(db, d1WorkInteractions);
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
	const workItems = coreTable(db, d1WorkItems);
	const workAttempts = coreTable(db, d1WorkAttempts);
	const workItemRelations = coreTable(db, d1WorkItemRelations);
	const result = new Map<string, string>();
	const unique = [...new Set(ids)];
	if (unique.length) {
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
					// Unary plus: prod statistics otherwise walk every Work item of the
					// organization through a covering org index (30k rows per page).
					coreStore(db) === "d1"
						? sql`+${workItems.orgId} = ${orgId}`
						: eq(workItems.orgId, orgId),
					anyIds(db, workItems.id, unique),
				),
			);
		for (const row of rows) result.set(row.id, row.state);
	}
	return result;
}

/**
 * The active objective each Work item serves: its own objective when it is
 * objective work, else its project's. `top` marks the organization's most
 * important active objective. Items without one are absent.
 */
export async function listDeckSourceObjectives(
	db: DbQueryClient,
	orgId: string,
	ids: readonly string[],
) {
	const projects = coreTable(db, d1Projects);
	const tediObjectives = coreTable(db, d1TediObjectives);
	const workItems = coreTable(db, d1WorkItems);
	const result = new Map<string, ServedObjective>();
	const unique = [...new Set(ids)];
	const top = db
		.select({ id: tediObjectives.id })
		.from(tediObjectives)
		.where(
			and(eq(tediObjectives.orgId, orgId), eq(tediObjectives.status, "active")),
		)
		.orderBy(tediObjectives.priority, tediObjectives.id)
		.limit(1);
	const served = sql<string>`coalesce(CASE WHEN ${workItems.workClass} = 'objective' THEN ${workItems.objectiveId} END, ${projects.objectiveId})`;
	if (unique.length) {
		const rows = await db
			.select({
				workItemId: workItems.id,
				// Aliased: work_items.id and tedi_objectives.id share an output name.
				objectiveId: sql<string>`${tediObjectives.id}`.as("objective_id"),
				title: tediObjectives.title,
				priority: tediObjectives.priority,
				top: sql<number>`${tediObjectives.id} = (${top})`.as("is_top"),
			})
			.from(workItems)
			.leftJoin(
				projects,
				and(
					eq(projects.orgId, workItems.orgId),
					eq(projects.id, workItems.projectId),
				),
			)
			.innerJoin(
				tediObjectives,
				and(
					eq(tediObjectives.orgId, workItems.orgId),
					eq(tediObjectives.id, served),
					eq(tediObjectives.status, "active"),
				),
			)
			.where(and(eq(workItems.orgId, orgId), anyIds(db, workItems.id, unique)));
		for (const row of rows)
			result.set(row.workItemId, {
				id: row.objectiveId,
				title: row.title,
				priority: row.priority,
				top: Boolean(row.top),
			});
	}
	return result;
}

/**
 * The objective each card serves through its Work: the card's own Work item
 * when it names one, else the Work it was made from in the decision graph.
 */
export async function listCardObjectives(
	db: DbQueryClient,
	orgId: string,
	cards: readonly { id: string; workItemId?: string | null }[],
) {
	const edges = await listCardSourceWork(
		db,
		orgId,
		cards.filter((card) => !card.workItemId).map((card) => card.id),
	);
	const work = new Map(
		cards.map((card) => [card.id, card.workItemId ?? edges.get(card.id)]),
	);
	const objectives = await listDeckSourceObjectives(
		db,
		orgId,
		[...work.values()].filter((id): id is string => Boolean(id)),
	);
	const result = new Map<string, ServedObjective>();
	for (const [cardId, workId] of work) {
		const objective = workId && objectives.get(workId);
		if (objective) result.set(cardId, objective);
	}
	return result;
}

/**
 * The Work facts that rank each card: its Work's due date, deadline and risk,
 * how many accepted Work items wait on it through a `blocks` relation, and
 * whether one of those has a live Attempt. Cards without Work are absent.
 */
export async function listCardSourceWorkFacts(
	db: DbQueryClient,
	orgId: string,
	cards: readonly { id: string; workItemId?: string | null }[],
) {
	const workItems = coreTable(db, d1WorkItems);
	const workAttempts = coreTable(db, d1WorkAttempts);
	const workItemRelations = coreTable(db, d1WorkItemRelations);
	const edges = await listCardSourceWork(
		db,
		orgId,
		cards.filter((card) => !card.workItemId).map((card) => card.id),
	);
	const work = new Map(
		cards.map((card) => [card.id, card.workItemId ?? edges.get(card.id)]),
	);
	const unique = [
		...new Set([...work.values()].filter((id): id is string => Boolean(id))),
	];
	const facts = new Map<string, DeckSourceWorkFacts>();
	const waiting = sql`FROM ${workItemRelations} r JOIN ${workItems} waiting ON waiting.id=r.to_work_item_id AND waiting.org_id=r.org_id WHERE r.org_id=${orgId} AND r.from_work_item_id=${workItems}.${sql.identifier("id")} AND r.relation_type='blocks' AND waiting.disposition='accepted'`;
	if (unique.length) {
		const rows = await db
			.select({
				id: workItems.id,
				dueDate: workItems.dueDate,
				deadline: workItems.deadline,
				riskLevel: workItems.riskLevel,
				blocksCount:
					sql<number>`(SELECT count(DISTINCT waiting.id) ${waiting})`.as(
						"blocks_count",
					),
				blocksRunning:
					sql<number>`EXISTS (SELECT 1 ${waiting} AND EXISTS (SELECT 1 FROM ${workAttempts} a WHERE a.org_id=r.org_id AND a.work_item_id=waiting.id AND a.runtime_state IN ('queued','running','waiting','retrying')))`.as(
						"blocks_running",
					),
			})
			.from(workItems)
			.where(and(eq(workItems.orgId, orgId), anyIds(db, workItems.id, unique)));
		for (const row of rows)
			facts.set(row.id, {
				dueDate: row.dueDate,
				deadline: row.deadline,
				riskLevel: row.riskLevel,
				blocksCount: Number(row.blocksCount ?? 0),
				blocksRunning: Boolean(row.blocksRunning),
			});
	}
	const result = new Map<string, DeckSourceWorkFacts>();
	for (const [cardId, workId] of work) {
		const fact = workId && facts.get(workId);
		if (fact) result.set(cardId, fact);
	}
	return result;
}

/** Current status of a bounded list of cards (undo detection). */
export async function listCardStatuses(
	db: DbQueryClient,
	orgId: string,
	ids: readonly string[],
) {
	const workInteractions = coreTable(db, d1WorkInteractions);
	const result = new Map<string, string>();
	const unique = [...new Set(ids)];
	if (unique.length) {
		const rows = await db
			.select({ id: workInteractions.id, status: workInteractions.status })
			.from(workInteractions)
			.where(
				and(
					eq(workInteractions.orgId, orgId),
					isNotNull(workInteractions.targetId),
					anyIds(db, workInteractions.id, unique),
				),
			);
		for (const row of rows) result.set(row.id, row.status);
	}
	return result;
}

export async function getDeckSweepReceipt(db: DbQueryClient, orgId: string) {
	const organizations = coreTable(db, d1Organizations);
	const [row] = await db
		.select({
			receipt: jsonRead(db, organizations.metadata, ["deckSweep"], "json"),
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
	const organizations = coreTable(db, d1Organizations);
	const parsed = DeckSweepReceiptSchema.parse(receipt);
	await db
		.update(organizations)
		.set({
			metadata: jsonWrite(db, organizations.metadata, ["deckSweep"], parsed),
		})
		.where(eq(organizations.id, orgId));
}

/** Narrow write of the learned parts of the Deck pipeline config. */
export async function setDeckPipelineLearned(
	db: DbQueryClient,
	orgId: string,
	learned: Pick<DeckPipelineConfig, "rules" | "hidingClasses">,
) {
	const organizations = coreTable(db, d1Organizations);
	await db
		.update(organizations)
		.set({
			metadata: jsonWrite(
				db,
				jsonWrite(
					db,
					organizations.metadata,
					["decisionLearning", "deckPipeline", "rules"],
					learned.rules,
				),
				["decisionLearning", "deckPipeline", "hidingClasses"],
				learned.hidingClasses,
			),
		})
		.where(eq(organizations.id, orgId));
}

/**
 * The recipient's latest "not needed" answer to the same ask on the same Work
 * (or project, for a card without Work): a re-ask the person already refused.
 */
export async function findNotUsefulAnswer(
	db: DbQueryClient,
	p: {
		orgId: string;
		recipientId: string;
		subject: string;
		workItemId?: string | null;
		projectId?: string | null;
	},
) {
	const workInteractions = coreTable(db, d1WorkInteractions);
	if (!p.workItemId && !p.projectId) return null;
	const [row] = await db
		.select({
			id: workInteractions.id,
			reason: sql<
				string | null
			>`${jsonRead(db, workInteractions.metadata, ["curation", "notUseful", "reason"])}`.as(
				"not_useful_reason",
			),
			cancelledAt: workInteractions.cancelledAt,
		})
		.from(workInteractions)
		.where(
			and(
				eq(workInteractions.orgId, p.orgId),
				eq(workInteractions.targetType, "user"),
				eq(workInteractions.targetId, p.recipientId),
				eq(workInteractions.status, "cancelled"),
				p.workItemId
					? eq(workInteractions.workItemId, p.workItemId)
					: eq(workInteractions.projectId, p.projectId!),
				sql`lower(trim(${workInteractions.subject}))=${p.subject.trim().toLowerCase()}`,
				coreStore(db) === "postgres"
					? sql`jsonb_typeof(${jsonRead(db, workInteractions.metadata, ["curation", "notUseful"], "json")}) = 'object'`
					: sql`json_type(${workInteractions.metadata},'$.curation.notUseful')='object'`,
			),
		)
		.orderBy(desc(workInteractions.createdAt))
		.limit(1);
	return row ?? null;
}
