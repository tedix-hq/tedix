/**
 * Decision graph: typed, org-scoped edges that tell a Deck card how it
 * connects to earlier decisions, its source Work, people, systems,
 * credential metadata and other cards.
 *
 * Every read is bounded: at most DECISION_GRAPH_MAX_HOPS traversal rounds,
 * at most FRONTIER_LIMIT ids per `IN (...)` and a LIMIT on every statement.
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
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
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
