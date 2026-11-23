/**
 * Decision graph: typed, org-scoped edges that tell a Deck card how it
 * connects to earlier decisions, its source Work, people, systems,
 * credential metadata and other cards.
 *
 * Every read is bounded: at most DECISION_GRAPH_MAX_HOPS traversal rounds,
 * per-card frontiers and edge limits. Deck reads share one reachable snapshot.
 */

import {
	DECISION_GRAPH_EDGE_ENDPOINTS,
	DECISION_GRAPH_MAX_HOPS,
	type DecisionContext,
	type DecisionGraphChainStep,
	type DecisionGraphEdge,
	type DecisionGraphEdgeKind,
	type DecisionGraphLink,
	type DecisionGraphNode,
} from "@tedix/api-contract/schemas/decision-graph";
import {
	and,
	desc,
	eq,
	getColumns,
	inArray,
	notInArray,
	sql,
} from "drizzle-orm";
import { alias, union } from "drizzle-orm/sqlite-core";
import type { DbQueryClient } from "../query-client";
import { type DecisionEdgeRow, decisionEdges } from "../schema/decision-graph";
import { workItems } from "../schema/work-items";

/** Max edges per upsert call. */
export const DECISION_EDGE_UPSERT_LIMIT = 500;
/** 14 bound values per row; 6 rows keeps each statement under 100. */
const UPSERT_ROWS_PER_STATEMENT = 6;
/** Max ids bound into one `IN (...)` list. */
const FRONTIER_LIMIT = 50;
/** Max edges read per traversal round or lookup. */
const EDGE_READ_LIMIT = 50;
const NOTE_MAX_CHARS = 280;

/** Edge kinds followed outward when building a card's chain. */
const CHAIN_EDGE_KINDS: DecisionGraphEdgeKind[] = [
	"card_from_work",
	"card_answers",
	"decided_by",
	"evidence",
	"involves",
	"supersedes",
];
const DECISION_EDGE_KINDS: DecisionGraphEdgeKind[] = [
	"decided_by",
	"card_answers",
];

export type DecisionEdgeInput = {
	kind: DecisionGraphEdgeKind;
	from: DecisionGraphNode;
	to: DecisionGraphNode;
	/** Writer that recorded the fact, e.g. `deck`, `approval`, `backfill`. */
	source: string;
	/** 0..1, default 1. */
	confidence?: number;
	evidenceRef?: string | null;
	/** Short plain-English label for the target. Never a secret value. */
	note?: string | null;
	/** When the fact happened (ISO 8601); defaults to now. */
	occurredAt?: string;
};

export type UpsertDecisionEdgesResult = { written: number };

export type GetDecisionContextOptions = { maxHops?: number };

export class DecisionEdgeValidationError extends Error {
	override name = "DecisionEdgeValidationError";
}

function edgeKey(edge: DecisionEdgeInput) {
	return [
		edge.from.kind,
		edge.from.id,
		edge.kind,
		edge.to.kind,
		edge.to.id,
	].join("\u0000");
}

function toIso(value: string, label: string) {
	const time = Date.parse(value);
	if (!Number.isFinite(time)) {
		throw new DecisionEdgeValidationError(`${label} is not a valid date`);
	}
	return new Date(time).toISOString();
}

function validateEdge(edge: DecisionEdgeInput) {
	const endpoints = DECISION_GRAPH_EDGE_ENDPOINTS[edge.kind];
	if (!endpoints) {
		throw new DecisionEdgeValidationError(`Unknown edge kind ${edge.kind}`);
	}
	if (!endpoints.from.includes(edge.from.kind)) {
		throw new DecisionEdgeValidationError(
			`${edge.kind} cannot start at ${edge.from.kind}`,
		);
	}
	if (!endpoints.to.includes(edge.to.kind)) {
		throw new DecisionEdgeValidationError(
			`${edge.kind} cannot end at ${edge.to.kind}`,
		);
	}
	if (!edge.from.id || !edge.to.id) {
		throw new DecisionEdgeValidationError("Edge endpoints need ids");
	}
	if (edge.from.kind === edge.to.kind && edge.from.id === edge.to.id) {
		throw new DecisionEdgeValidationError("An edge cannot point at itself");
	}
	if (!edge.source.trim()) {
		throw new DecisionEdgeValidationError("Edge source is required");
	}
	const confidence = edge.confidence ?? 1;
	if (!(confidence >= 0 && confidence <= 1)) {
		throw new DecisionEdgeValidationError("Confidence must be within 0..1");
	}
}

/**
 * Idempotent on (orgId, from, kind, to). A repeat write refreshes source,
 * confidence, evidence and note, and keeps the earliest `occurredAt`.
 */
export async function upsertDecisionEdges(
	db: DbQueryClient,
	orgId: string,
	edges: readonly DecisionEdgeInput[],
): Promise<UpsertDecisionEdgesResult> {
	if (edges.length > DECISION_EDGE_UPSERT_LIMIT) {
		throw new DecisionEdgeValidationError(
			`At most ${DECISION_EDGE_UPSERT_LIMIT} edges per call`,
		);
	}
	const unique = new Map<string, DecisionEdgeInput>();
	for (const edge of edges) {
		validateEdge(edge);
		unique.set(edgeKey(edge), edge);
	}
	if (unique.size === 0) return { written: 0 };

	const now = new Date().toISOString();
	const rows = [...unique.values()].map((edge) => ({
		id: crypto.randomUUID(),
		orgId,
		fromKind: edge.from.kind,
		fromId: edge.from.id,
		kind: edge.kind,
		toKind: edge.to.kind,
		toId: edge.to.id,
		source: edge.source.trim(),
		confidence: edge.confidence ?? 1,
		evidenceRef: edge.evidenceRef ?? null,
		note: edge.note?.trim().slice(0, NOTE_MAX_CHARS) || null,
		occurredAt: edge.occurredAt ? toIso(edge.occurredAt, "occurredAt") : now,
		createdAt: now,
		updatedAt: now,
	}));

	const statements = [];
	for (let i = 0; i < rows.length; i += UPSERT_ROWS_PER_STATEMENT) {
		statements.push(
			db
				.insert(decisionEdges)
				.values(rows.slice(i, i + UPSERT_ROWS_PER_STATEMENT))
				.onConflictDoUpdate({
					target: [
						decisionEdges.orgId,
						decisionEdges.fromId,
						decisionEdges.fromKind,
						decisionEdges.kind,
						decisionEdges.toId,
						decisionEdges.toKind,
					],
					set: {
						source: sql`excluded.source`,
						confidence: sql`excluded.confidence`,
						evidenceRef: sql`excluded.evidence_ref`,
						note: sql`excluded.note`,
						occurredAt: sql`min(${decisionEdges.occurredAt}, excluded.occurred_at)`,
						updatedAt: sql`excluded.updated_at`,
					},
				}),
		);
	}
	const [first, ...rest] = statements;
	await db.batch([first!, ...rest]);
	return { written: rows.length };
}

function toEdge(row: DecisionEdgeRow): DecisionGraphEdge {
	return {
		id: row.id,
		kind: row.kind,
		from: { kind: row.fromKind, id: row.fromId },
		to: { kind: row.toKind, id: row.toId },
		source: row.source,
		confidence: row.confidence,
		evidenceRef: row.evidenceRef,
		note: row.note,
		occurredAt: row.occurredAt,
		createdAt: row.createdAt,
	};
}

function selectEdges(db: DbQueryClient) {
	return db.select().from(decisionEdges);
}

function boundedIds(ids: readonly string[]) {
	return [...new Set(ids.filter(Boolean))].slice(0, FRONTIER_LIMIT);
}

/** One edge row for the graph projection drain; null once deleted. */
export async function getDecisionEdgeForProjection(
	db: DbQueryClient,
	input: { organizationId: string; edgeId: string },
): Promise<DecisionEdgeRow | null> {
	const [row] = await selectEdges(db)
		.where(
			and(
				eq(decisionEdges.id, input.edgeId),
				eq(decisionEdges.orgId, input.organizationId),
			),
		)
		.limit(1);
	return row ?? null;
}

/** Latest decision or owner instruction any subject was already decided by. */
export async function findPriorDecision(
	db: DbQueryClient,
	orgId: string,
	subjectNodeIds: readonly string[],
): Promise<DecisionGraphLink | null> {
	const subjects = boundedIds(subjectNodeIds);
	if (subjects.length === 0) return null;
	const [row] = await selectEdges(db)
		.where(
			and(
				eq(decisionEdges.orgId, orgId),
				inArray(decisionEdges.fromId, subjects),
				inArray(decisionEdges.kind, DECISION_EDGE_KINDS),
			),
		)
		.orderBy(desc(decisionEdges.occurredAt), desc(decisionEdges.confidence))
		.limit(1);
	if (!row) return null;
	const edge = toEdge(row);
	return { node: edge.to, edge };
}

/** The newest source Work item recorded for each card, read in bounded pages. */
export async function listCardSourceWork(
	db: DbQueryClient,
	orgId: string,
	cardIds: readonly string[],
) {
	const result = new Map<string, string>();
	const unique = [...new Set(cardIds)];
	for (let offset = 0; offset < unique.length; offset += FRONTIER_LIMIT) {
		const rows = await db
			.select({ cardId: decisionEdges.fromId, workId: decisionEdges.toId })
			.from(decisionEdges)
			.where(
				and(
					eq(decisionEdges.orgId, orgId),
					eq(decisionEdges.fromKind, "deck_card"),
					// bound-params: sliced to FRONTIER_LIMIT (50) ids per statement
					inArray(
						decisionEdges.fromId,
						unique.slice(offset, offset + FRONTIER_LIMIT),
					),
					eq(decisionEdges.kind, "card_from_work"),
					eq(decisionEdges.toKind, "work_item"),
				),
			)
			.orderBy(desc(decisionEdges.occurredAt), decisionEdges.id)
			.limit(FRONTIER_LIMIT * 4);
		for (const row of rows)
			if (!result.has(row.cardId)) result.set(row.cardId, row.workId);
	}
	return result;
}

/** Only same_as establishes duplicate identity; a shared Work is context. */
export async function findDuplicateCards(
	db: DbQueryClient,
	orgId: string,
	cardId: string,
): Promise<string[]> {
	const [outgoing, incoming] = await db.batch([
		selectEdges(db)
			.where(
				and(
					eq(decisionEdges.orgId, orgId),
					eq(decisionEdges.fromId, cardId),
					eq(decisionEdges.fromKind, "deck_card"),
					eq(decisionEdges.kind, "same_as"),
				),
			)
			.limit(EDGE_READ_LIMIT),
		selectEdges(db)
			.where(
				and(
					eq(decisionEdges.orgId, orgId),
					eq(decisionEdges.toId, cardId),
					eq(decisionEdges.kind, "same_as"),
					eq(decisionEdges.toKind, "deck_card"),
				),
			)
			.limit(EDGE_READ_LIMIT),
	]);
	const duplicates = new Set<string>();
	for (const row of outgoing) duplicates.add(row.toId);
	for (const row of incoming) duplicates.add(row.fromId);
	duplicates.delete(cardId);
	return [...duplicates].sort();
}

async function countBlockedFrom(
	db: DbQueryClient,
	orgId: string,
	nodeIds: readonly string[],
) {
	const ids = boundedIds(nodeIds);
	if (ids.length === 0) return 0;
	const [row] = await db
		.select({ blocked: sql<number>`count(distinct ${decisionEdges.toId})` })
		.from(decisionEdges)
		.innerJoin(
			workItems,
			and(
				eq(workItems.orgId, decisionEdges.orgId),
				eq(workItems.id, decisionEdges.toId),
			),
		)
		.where(
			and(
				eq(decisionEdges.orgId, orgId),
				// bound-params: boundedIds() caps the list at FRONTIER_LIMIT (50)
				inArray(decisionEdges.fromId, ids),
				eq(decisionEdges.kind, "blocks"),
				eq(decisionEdges.toKind, "work_item"),
				notInArray(workItems.disposition, ["completed", "cancelled"]),
			),
		)
		.limit(1);
	return Number(row?.blocked ?? 0);
}

/**
 * Which of these Work ids are completed or cancelled. The graph walk asks
 * this of D1, the canonical record, instead of trusting graph-side Work state.
 */
export async function terminalWorkItemIds(
	db: DbQueryClient,
	orgId: string,
	ids: readonly string[],
): Promise<Set<string>> {
	const unique = [...new Set(ids.filter(Boolean))];
	const terminal = new Set<string>();
	for (let offset = 0; offset < unique.length; offset += FRONTIER_LIMIT) {
		const rows = await db
			.select({ id: workItems.id })
			.from(workItems)
			.where(
				and(
					eq(workItems.orgId, orgId),
					// bound-params: chunked to FRONTIER_LIMIT (50) ids per query
					inArray(workItems.id, unique.slice(offset, offset + FRONTIER_LIMIT)),
					inArray(workItems.disposition, ["completed", "cancelled"]),
				),
			);
		for (const row of rows) terminal.add(row.id);
	}
	return terminal;
}

/** How many distinct Work items wait directly on this node. */
export async function countBlocked(
	db: DbQueryClient,
	orgId: string,
	nodeId: string,
): Promise<number> {
	return countBlockedFrom(db, orgId, [nodeId]);
}

/**
 * Everything the Deck needs to explain or retire a card: the outward chain
 * (Work, decisions, evidence, people, systems), the latest prior decision,
 * a newer replacing card, duplicates and how many items wait on it.
 */
export async function getDecisionContext(
	db: DbQueryClient,
	orgId: string,
	cardId: string,
	options: GetDecisionContextOptions = {},
): Promise<DecisionContext> {
	const maxHops = Math.max(
		1,
		Math.min(
			DECISION_GRAPH_MAX_HOPS,
			Math.trunc(options.maxHops ?? DECISION_GRAPH_MAX_HOPS),
		),
	);
	const chain: DecisionGraphChainStep[] = [];
	const seen = new Set<string>([`deck_card:${cardId}`]);
	let frontier: DecisionGraphNode[] = [{ kind: "deck_card", id: cardId }];

	for (let hop = 1; hop <= maxHops && frontier.length > 0; hop += 1) {
		const ids = boundedIds(frontier.map((node) => node.id));
		const kindsById = new Map<string, Set<string>>();
		for (const node of frontier) {
			const kinds = kindsById.get(node.id) ?? new Set<string>();
			kinds.add(node.kind);
			kindsById.set(node.id, kinds);
		}
		const rows = await selectEdges(db)
			.where(
				and(
					eq(decisionEdges.orgId, orgId),
					// bound-params: boundedIds() caps the list at FRONTIER_LIMIT (50)
					inArray(decisionEdges.fromId, ids),
					inArray(decisionEdges.kind, CHAIN_EDGE_KINDS),
				),
			)
			.orderBy(desc(decisionEdges.occurredAt), decisionEdges.id)
			.limit(EDGE_READ_LIMIT);
		const next: DecisionGraphNode[] = [];
		for (const row of rows) {
			if (!kindsById.get(row.fromId)?.has(row.fromKind)) continue;
			const edge = toEdge(row);
			const key = `${edge.to.kind}:${edge.to.id}`;
			if (seen.has(key)) continue;
			seen.add(key);
			chain.push({ node: edge.to, edge, hop });
			next.push(edge.to);
		}
		frontier = next;
	}

	const backfilledWork = chain.filter(
		(step) =>
			step.edge.kind === "card_from_work" && step.edge.source === "backfill",
	);
	const workIds = boundedIds(backfilledWork.map((step) => step.node.id));
	if (workIds.length) {
		const titles = new Map(
			(
				await db
					.select({ id: workItems.id, title: workItems.title })
					.from(workItems)
					.where(
						and(
							eq(workItems.orgId, orgId),
							// bound-params: boundedIds() caps workIds at FRONTIER_LIMIT (50).
							inArray(workItems.id, workIds),
						),
					)
					.limit(FRONTIER_LIMIT)
			).map((row) => [row.id, row.title]),
		);
		for (const step of backfilledWork)
			step.edge.note = titles.get(step.node.id) ?? null;
	}

	const subjects = [
		cardId,
		...chain
			.filter((step) => step.node.kind === "work_item")
			.map((step) => step.node.id),
	];
	const [priorDecision, supersededRows, duplicates, blocksCount] =
		await Promise.all([
			findPriorDecision(db, orgId, [cardId]),
			selectEdges(db)
				.where(
					and(
						eq(decisionEdges.orgId, orgId),
						eq(decisionEdges.toId, cardId),
						eq(decisionEdges.kind, "supersedes"),
						eq(decisionEdges.toKind, "deck_card"),
					),
				)
				.orderBy(desc(decisionEdges.occurredAt))
				.limit(1),
			findDuplicateCards(db, orgId, cardId),
			countBlockedFrom(db, orgId, subjects),
		]);
	const superseding = supersededRows[0] ? toEdge(supersededRows[0]) : null;

	return {
		cardId,
		chain,
		...(priorDecision ? { priorDecision } : {}),
		...(superseding
			? { supersededBy: { node: superseding.from, edge: superseding } }
			: {}),
		duplicates,
		blocksCount,
	};
}

/** Qualify a whole deck from one canonical, organization-scoped snapshot. */
export async function getDeckDecisionContexts(
	db: DbQueryClient,
	orgId: string,
	cards: readonly { id: string; workItemId?: string | null }[],
): Promise<Map<string, DecisionContext>> {
	const contexts = new Map<string, DecisionContext>();
	if (!cards.length) return contexts;
	// JSON binds the set once, including decks larger than D1's parameter limit.
	const input = db.$with("deck_cards").as(
		db
			.select({
				id: sql<string>`json_extract(value, '$.id')`.as("id"),
				workId: sql<string>`json_extract(value, '$.workItemId')`.as("work_id"),
			})
			.from(sql`json_each(${JSON.stringify(cards)})`),
	);
	const seed = db.$with<string>("deck_hop_0").as(
		db
			.selectDistinct({
				kind: sql<string>`'deck_card'`.as("kind"),
				id: sql<string>`${input.id}`.as("id"),
			})
			.from(input),
	);
	const hops = [seed];
	// Shared nodes are read once per depth, even when many cards reach them.
	for (let depth = 1; depth <= 4; depth++) {
		const previous = hops[depth - 1]!;
		hops.push(
			db.$with(`deck_hop_${depth}`).as(
				db
					.selectDistinct({
						kind: sql<string>`${decisionEdges.toKind}`.as("kind"),
						id: sql<string>`${decisionEdges.toId}`.as("id"),
					})
					.from(previous)
					// CROSS JOIN fixes the loop order: each hop node seeks its edges
					// instead of the planner scanning every edge in the organization.
					.crossJoin(decisionEdges)
					.where(
						and(
							eq(decisionEdges.orgId, orgId),
							eq(decisionEdges.fromId, previous.id),
							eq(decisionEdges.fromKind, previous.kind),
							inArray(decisionEdges.kind, CHAIN_EDGE_KINDS),
						),
					),
			),
		);
	}
	// D1 permits at most five SELECT terms in each compound statement.
	const reachable = db
		.$with("deck_reachable")
		.as(
			union(
				db.select({ id: seed.id }).from(seed),
				db.select({ id: hops[1]!.id }).from(hops[1]!),
				...hops.slice(2).map((hop) => db.select({ id: hop.id }).from(hop)),
			),
		);
	const subjects = db.$with("deck_subjects").as(
		union(
			db.select({ id: input.workId }).from(input),
			db
				.select({ id: decisionEdges.toId })
				.from(input)
				.crossJoin(decisionEdges)
				.where(
					and(
						eq(decisionEdges.orgId, orgId),
						eq(decisionEdges.fromId, input.id),
						eq(decisionEdges.fromKind, "deck_card"),
						eq(decisionEdges.kind, "same_as"),
					),
				),
			db
				.select({ id: decisionEdges.fromId })
				.from(input)
				.crossJoin(decisionEdges)
				.where(
					and(
						eq(decisionEdges.orgId, orgId),
						eq(decisionEdges.toId, input.id),
						eq(decisionEdges.toKind, "deck_card"),
						eq(decisionEdges.kind, "same_as"),
					),
				),
			db.select({ id: reachable.id }).from(reachable),
		),
	);
	const matched = alias(decisionEdges, "matched");
	const rows = await db
		.with(input, ...hops, reachable, subjects)
		.select({
			edge: getColumns(decisionEdges),
			workTitle: sql<string | null>`${workItems.title}`.as("work_title"),
			workDisposition: sql<string | null>`${workItems.disposition}`.as(
				"work_disposition",
			),
		})
		.from(decisionEdges)
		.leftJoin(
			workItems,
			and(
				eq(workItems.orgId, decisionEdges.orgId),
				eq(workItems.id, decisionEdges.toId),
				eq(decisionEdges.toKind, "work_item"),
			),
		)
		.where(
			and(
				// The id list below is already organization-scoped; the unary plus
				// keeps the planner on the primary key instead of the org prefix.
				sql`+${decisionEdges.orgId} = ${orgId}`,
				// One seek per subject and per card; an OR across from_id and to_id
				// made the planner scan every edge in the organization.
				// bound-params: CTE subquery; all card IDs use one JSON parameter.
				inArray(
					decisionEdges.id,
					union(
						db
							.select({ id: matched.id })
							.from(subjects)
							.crossJoin(matched)
							.where(
								and(eq(matched.orgId, orgId), eq(matched.fromId, subjects.id)),
							),
						db
							.select({ id: matched.id })
							.from(input)
							.crossJoin(matched)
							.where(
								and(
									eq(matched.orgId, orgId),
									eq(matched.toId, input.id),
									eq(matched.toKind, "deck_card"),
									inArray(matched.kind, ["same_as", "supersedes"]),
								),
							),
					),
				),
			),
		)
		.orderBy(desc(decisionEdges.occurredAt), decisionEdges.id);
	const outgoing = new Map<string, typeof rows>();
	const incoming = new Map<string, typeof rows>();
	for (const row of rows) {
		const from = outgoing.get(row.edge.fromId) ?? [];
		from.push(row);
		outgoing.set(row.edge.fromId, from);
		const to = incoming.get(row.edge.toId) ?? [];
		to.push(row);
		incoming.set(row.edge.toId, to);
	}
	const fromIds = (ids: readonly string[]) =>
		boundedIds(ids).flatMap((id) => outgoing.get(id) ?? []);
	const newest = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
		b.edge.occurredAt.localeCompare(a.edge.occurredAt) ||
		a.edge.id.localeCompare(b.edge.id);
	const blocked = (ids: readonly string[]) =>
		new Set(
			fromIds(ids)
				.filter(
					(row) =>
						row.edge.kind === "blocks" &&
						row.edge.toKind === "work_item" &&
						row.workDisposition !== null &&
						!["completed", "cancelled"].includes(row.workDisposition),
				)
				.map((row) => row.edge.toId),
		).size;
	for (const card of cards) {
		const chain: DecisionGraphChainStep[] = [];
		const seen = new Set([`deck_card:${card.id}`]);
		let frontier: DecisionGraphNode[] = [{ kind: "deck_card", id: card.id }];
		for (let hop = 1; hop <= 4 && frontier.length; hop++) {
			const keys = new Set(frontier.map((node) => `${node.kind}:${node.id}`));
			// Apply the original per-card row limit before endpoint-kind filtering.
			const candidates = fromIds(frontier.map((node) => node.id))
				.filter((row) => CHAIN_EDGE_KINDS.includes(row.edge.kind))
				.sort(newest)
				.slice(0, EDGE_READ_LIMIT);
			const next: DecisionGraphNode[] = [];
			for (const row of candidates) {
				if (!keys.has(`${row.edge.fromKind}:${row.edge.fromId}`)) continue;
				const edge = toEdge(row.edge);
				const key = `${edge.to.kind}:${edge.to.id}`;
				if (seen.has(key)) continue;
				seen.add(key);
				if (edge.kind === "card_from_work" && edge.source === "backfill")
					edge.note = row.workTitle;
				chain.push({ node: edge.to, edge, hop });
				next.push(edge.to);
			}
			frontier = next;
		}
		const direct = outgoing.get(card.id) ?? [];
		const reverse = incoming.get(card.id) ?? [];
		const duplicates = [
			...new Set([
				...direct
					.filter(
						(row) =>
							row.edge.kind === "same_as" && row.edge.fromKind === "deck_card",
					)
					.slice(0, EDGE_READ_LIMIT)
					.map((row) => row.edge.toId),
				...reverse
					.filter(
						(row) =>
							row.edge.kind === "same_as" && row.edge.toKind === "deck_card",
					)
					.slice(0, EDGE_READ_LIMIT)
					.map((row) => row.edge.fromId),
			]),
		]
			.filter((id) => id !== card.id)
			.sort();
		// Only explicit same_as identity inherits an answer, never a shared Work.
		const prior = fromIds([card.id, ...duplicates])
			.filter((row) => DECISION_EDGE_KINDS.includes(row.edge.kind))
			.sort(
				(a, b) =>
					b.edge.occurredAt.localeCompare(a.edge.occurredAt) ||
					b.edge.confidence - a.edge.confidence,
			)[0];
		const superseding = reverse.find(
			(row) =>
				row.edge.kind === "supersedes" && row.edge.toKind === "deck_card",
		);
		const subjects = [
			card.id,
			...chain
				.filter((step) => step.node.kind === "work_item")
				.map((step) => step.node.id),
		];
		contexts.set(card.id, {
			cardId: card.id,
			chain,
			duplicates,
			blocksCount: Math.max(
				blocked(subjects),
				card.workItemId ? blocked([card.workItemId]) : 0,
			),
			...(prior
				? {
						priorDecision: {
							node: toEdge(prior.edge).to,
							edge: toEdge(prior.edge),
						},
					}
				: {}),
			...(superseding
				? {
						supersededBy: {
							node: toEdge(superseding.edge).from,
							edge: toEdge(superseding.edge),
						},
					}
				: {}),
		});
	}
	return contexts;
}

const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

function formatDay(iso: string) {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "an earlier date";
	return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

function quote(note: string | null | undefined) {
	const text = note?.replace(/\s+/g, " ").replace(/"/g, "'").trim();
	if (!text) return null;
	return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

function plural(count: number, one: string, many: string) {
	return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

/** One plain-English line, e.g. `You decided this on 20 Oct: "…" → …`. */
export function explainChain(context: DecisionContext): string {
	const parts: string[] = [];
	if (context.priorDecision) {
		const { edge } = context.priorDecision;
		const note = quote(edge.note);
		const verb = edge.kind === "card_answers" ? "answered" : "decided";
		parts.push(
			`You ${verb} this on ${formatDay(edge.occurredAt)}${note ? `: "${note}"` : ""}`,
		);
	}
	const work = context.chain.find(
		(step) => step.edge.kind === "card_from_work",
	);
	if (work) {
		const note = quote(work.edge.note);
		parts.push(note ? `from Work "${note}"` : "from a Work item");
	}
	const objective = quote(context.objective?.title);
	if (objective) parts.push(`serves ${objective}`);
	const evidence = context.chain.find((step) => step.edge.kind === "evidence");
	if (evidence) parts.push(quote(evidence.edge.note) ?? "evidence attached");
	const involved = context.chain
		.filter((step) => step.edge.kind === "involves")
		.map((step) => quote(step.edge.note))
		.filter((note): note is string => Boolean(note))
		.slice(0, 2);
	if (involved.length > 0) parts.push(`involves ${involved.join(", ")}`);
	if (context.supersededBy) parts.push("replaced by a newer card");
	if (context.duplicates.length > 0) {
		parts.push(
			`same as ${plural(context.duplicates.length, "other card", "other cards")}`,
		);
	}
	const waiting = Math.max(context.blocksCount, context.blocksReach ?? 0);
	if (waiting > 0) {
		const line =
			waiting === 1 ? "1 item waits on this" : `${waiting} items wait on this`;
		parts.push(
			waiting > context.blocksCount
				? `${line} (${context.blocksCount} directly)`
				: line,
		);
	}
	if (parts.length === 0) return "No earlier decision or linked Work found.";
	const line = parts.join(" → ");
	return line.charAt(0).toUpperCase() + line.slice(1);
}
